// Load .env from the executable's folder when packaged (pkg), else the project.
try {
  const _path = require('path');
  const _envDir = (typeof process.pkg !== 'undefined')
    ? _path.dirname(process.execPath)
    : __dirname;
  require('dotenv').config({ path: _path.join(_envDir, '.env') });
} catch (e) { /* dotenv optional; ignore if absent */ }
const express = require('express');
// Baileys v7+ is ESM-only. We bundle the whole app into a single CommonJS file
// with esbuild before packaging, so a normal require works here and esbuild
// converts Baileys to CJS in the bundle. loadBaileys() stays as a thin async
// shim so the rest of the code doesn't change.
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
async function loadBaileys() { /* no-op: bundled statically */ }
const QRCode = require('qrcode');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { Server } = require('socket.io');
const pino = require('pino');
const { createControlPlane } = require('./control-plane');
const { resolveWorkerIdentity } = require('./worker-identity');
// jimp is pure-JavaScript (no native binary), so it works inside the packaged
// EXE where sharp's native module is unavailable. We use it to pre-generate the
// image thumbnail ourselves so Baileys never needs sharp during media upload.
let Jimp = null;
try { Jimp = require('jimp').Jimp; } catch (e) { /* optional */ }

async function makeJpegThumbnail(buffer) {
  if (!Jimp) return undefined;
  try {
    const img = await Jimp.read(buffer);
    img.resize({ w: 72 });
    // jimp v1 returns a base64 data URL from getBase64; we need raw base64.
    const b64 = await img.getBase64('image/jpeg');
    return b64.split(',')[1];
  } catch (e) {
    return undefined;
  }
}

const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: CORS_ORIGIN === '*' ? true : CORS_ORIGIN.split(',').map(value => value.trim()),
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS']
  }
});

// ===== Data directory (works both as node script and as packaged EXE) =====
// When packaged with pkg, files must be written next to the EXE, not inside the
// read-only snapshot. process.pkg is set when running as an EXE.
const IS_PKG = typeof process.pkg !== 'undefined';
// DATA_DIR priority:
//   1. DATA_DIR env var  -> used on hosts like Railway where a persistent
//      volume is mounted (e.g. /data). Keeps WhatsApp auth + history alive
//      across restarts/redeploys.
//   2. next to the EXE when packaged with pkg
//   3. project folder when run as a plain node script
const DATA_DIR = process.env.DATA_DIR
  ? process.env.DATA_DIR
  : (IS_PKG ? path.dirname(process.execPath) : __dirname);
// public folder: bundled inside snapshot when pkg, else local folder
const PUBLIC_DIR = path.join(__dirname, 'public');

// Absolute paths for all writable data
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const PROFILES_DIR = path.join(DATA_DIR, 'profiles');

// Middleware
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowed = CORS_ORIGIN === '*' || !origin || CORS_ORIGIN.split(',').map(value => value.trim()).includes(origin);
  if (allowed) {
    res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN === '*' ? '*' : origin || CORS_ORIGIN);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(PUBLIC_DIR));
app.use('/uploads', express.static(UPLOADS_DIR));

// Ensure directories exist
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(PROFILES_DIR)) fs.mkdirSync(PROFILES_DIR, { recursive: true });

// Baileys writes an encrypted temp file (via os.tmpdir()) before uploading media.
// In some packaged-EXE / restricted environments the system temp dir is not
// reliably writable, which surfaces as "Media upload failed on all hosts".
// Point temp at a guaranteed-writable folder next to our data directory.
const TMP_DIR = path.join(DATA_DIR, 'tmp');
try {
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
  process.env.TMPDIR = TMP_DIR;
  process.env.TMP = TMP_DIR;
  process.env.TEMP = TMP_DIR;
} catch (e) { /* fall back to system temp */ }

// Multer config
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => cb(null, 'image_' + Date.now() + path.extname(file.originalname))
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|webp/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    cb(null, extname && mimetype);
  },
  limits: { fileSize: 5 * 1024 * 1024 }
});

// ===== WhatsApp State =====
let sock = null;
let isConnected = false;
let qrCodeData = null;
let activeProfile = null;
let loggedInNumber = ''; // the WhatsApp number currently logged in

// ===== Profile Management =====
function getProfileList() {
  const dir = PROFILES_DIR;
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => fs.statSync(path.join(dir, f)).isDirectory());
}

function getProfileAuthDir(profileName) {
  const dir = path.join(PROFILES_DIR, profileName);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ===== Google Sheet Monitor State =====
let sheetConfig = {
  sheetUrl: '',
  sheetTab: '',
  appsScriptUrl: '',
  phoneColumn: '',
  nameColumn: '',
  statusColumn: '',
  dateColumn: '',
  message: '',
  imagePath: '',
  isMonitoring: false,
  intervalSeconds: 30,
  processedRows: new Set()
};
let monitorInterval = null;
let isChecking = false;
let activeMonitorSession = null;
let monitorLeaseTimer = null;

const workerIdentity = resolveWorkerIdentity(DATA_DIR);
console.log(`[Worker] Identity: ${workerIdentity.name} (${workerIdentity.id})`);

const controlPlane = createControlPlane({
  workerId: workerIdentity.id,
  workerName: workerIdentity.name,
  onCommand: async (command) => {
    const payload = command.payload || {};
    if (command.command_type === 'start_monitoring') {
      // Cloud dashboard commands are one-shot (no continuous heartbeat like
      // the local browser sends), so this session must not be lease-expired.
      // It only stops on an explicit stop_monitoring command.
      await startMonitoring(payload, {
        ownerId: command.owner_id || payload.ownerId || 'supabase',
        noLease: true
      });
    } else if (command.command_type === 'stop_monitoring') {
      await stopMonitoring('control-plane-command');
    } else if (command.command_type === 'send_message') {
      await sendBulk({
        phoneNumbers: payload.phoneNumbers || [],
        message: payload.message || '',
        imagePath: payload.imagePath || ''
      });
    }
  },
  onLeaseExpired: async () => {
    console.log('[Monitor] Supabase lease expired; stopping monitoring');
    await stopMonitoring('lease-expired');
  }
});

// ===== Message History Logging =====
const HISTORY_FILE = path.join(DATA_DIR, 'message_history.json');

function appendHistory(entry) {
  try {
    let history = [];
    if (fs.existsSync(HISTORY_FILE)) {
      history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    }
    const now = new Date();
    history.push({
      timestamp: now.toISOString(),
      date: now.toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' }),
      time: now.toLocaleTimeString('en-IN', { hour12: true }),
      sender: loggedInNumber || '',
      name: entry.name || '',
      phone: entry.phone || '',
      status: entry.status || '',
      source: entry.source || 'sheet',
      error: entry.error || ''
    });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
  } catch (err) {
    console.error('[History] Failed to log:', err.message);
  }
  // Mirror to Supabase for the shared dashboard (no-op when control plane disabled)
  try {
    controlPlane.recordHistory({
      sender: loggedInNumber || '',
      name: entry.name || '',
      phone: entry.phone || '',
      status: entry.status || '',
      source: entry.source || 'sheet',
      error: entry.error || ''
    });
    controlPlane.logEvent(
      entry.status && entry.status.toLowerCase() === 'sent' ? 'message_sent' : 'message_failed',
      { name: entry.name || '', phone: entry.phone || '', status: entry.status || '', source: entry.source || '', error: entry.error || '' }
    );
  } catch (e) { /* control plane optional */ }
}

function readHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('[History] Failed to read:', err.message);
  }
  return [];
}

// Load saved config from file
const CONFIG_FILE = path.join(DATA_DIR, 'sheet_config.json');

function loadSavedConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      sheetConfig.sheetUrl = saved.sheetUrl || '';
      sheetConfig.sheetTab = saved.sheetTab || '';
      sheetConfig.appsScriptUrl = saved.appsScriptUrl || '';
      sheetConfig.phoneColumn = saved.phoneColumn || '';
      sheetConfig.nameColumn = saved.nameColumn || '';
      sheetConfig.statusColumn = saved.statusColumn || '';
      sheetConfig.dateColumn = saved.dateColumn || '';
      sheetConfig.message = saved.message || '';
      sheetConfig.imagePath = saved.imagePath || '';
      sheetConfig.intervalSeconds = saved.intervalSeconds || 30;
      console.log('[Config] Saved config loaded');
    }
  } catch (err) {
    console.error('[Config] Failed to load:', err.message);
  }
}

function saveConfig() {
  try {
    const toSave = {
      sheetUrl: sheetConfig.sheetUrl,
      sheetTab: sheetConfig.sheetTab,
      appsScriptUrl: sheetConfig.appsScriptUrl,
      phoneColumn: sheetConfig.phoneColumn,
      nameColumn: sheetConfig.nameColumn,
      statusColumn: sheetConfig.statusColumn,
      dateColumn: sheetConfig.dateColumn,
      message: sheetConfig.message,
      imagePath: sheetConfig.imagePath,
      intervalSeconds: sheetConfig.intervalSeconds,
      batchSize: sheetConfig.batchSize,
      batchGapSeconds: sheetConfig.batchGapSeconds
    };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(toSave, null, 2));
  } catch (err) {
    console.error('[Config] Failed to save:', err.message);
  }
}

loadSavedConfig();

// ===== Google Sheets Update via Apps Script =====

async function updateSheetRow(rowIndex, statusColIndex, dateColIndex, phone, phoneColIndex, name, statusValue) {
  statusValue = statusValue || 'Sent';
  console.log(`[Sheet] updateSheetRow: phone=${phone}, status=${statusValue}, phoneCol=${phoneColIndex}`);
  if (!sheetConfig.appsScriptUrl || !sheetConfig.sheetUrl) {
    console.log(`[Sheet] SKIPPED - no appsScriptUrl or sheetUrl`);
    return;
  }

  const sheetId = extractSheetId(sheetConfig.sheetUrl);
  if (!sheetId) return;

  const tabName = sheetConfig.sheetTab || 'Sheet1';
  const today = new Date().toLocaleDateString('en-IN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  });

  const statusCol = statusColIndex + 1;
  const dateCol = dateColIndex + 1;
  const phoneColNum = phoneColIndex + 1;

  try {
    const response = await fetch(sheetConfig.appsScriptUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sheetId,
        tabName,
        phone,
        phoneColNum,
        statusCol,
        dateCol,
        statusValue: statusValue,
        dateValue: today
      }),
      redirect: 'follow'
    });

    if (response.ok) {
      const text = await response.text();
      console.log(`[Sheet] Updated (phone ${phone}, status ${statusValue}): ${text}`);
      io.emit('sheet_row_updated', { phone, status: statusValue, date: today });
    } else {
      console.error(`[Sheet] Update failed: ${response.status}`);
    }
  } catch (err) {
    console.error(`[Sheet] Update error:`, err.message);
  }
}

// Update using the RAW cell text (exact string match) - used for invalid numbers
async function updateSheetRowRaw(rowIndex, statusColIndex, dateColIndex, rawPhone, phoneColIndex, name, statusValue) {
  statusValue = statusValue || 'Failed';
  if (!sheetConfig.appsScriptUrl || !sheetConfig.sheetUrl) return;

  const sheetId = extractSheetId(sheetConfig.sheetUrl);
  if (!sheetId) return;

  const tabName = sheetConfig.sheetTab || 'Sheet1';
  const today = new Date().toLocaleDateString('en-IN', {
    day: '2-digit', month: '2-digit', year: 'numeric'
  });

  try {
    const response = await fetch(sheetConfig.appsScriptUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sheetId,
        tabName,
        phone: rawPhone,
        phoneColNum: phoneColIndex + 1,
        rawMatch: true, // tell Apps Script to match exact cell text
        statusCol: statusColIndex + 1,
        dateCol: dateColIndex + 1,
        statusValue: statusValue,
        dateValue: today
      }),
      redirect: 'follow'
    });
    if (response.ok) {
      const text = await response.text();
      console.log(`[Sheet] Raw-updated (${rawPhone}, ${statusValue}): ${text}`);
    }
  } catch (err) {
    console.error(`[Sheet] Raw update error:`, err.message);
  }
}

function columnLetter(index) {
  let letter = '';
  while (index >= 0) {
    letter = String.fromCharCode((index % 26) + 65) + letter;
    index = Math.floor(index / 26) - 1;
  }
  return letter;
}

// ===== WhatsApp Connection =====
async function connectWhatsApp(profileName) {
  // Ensure the ESM Baileys module is loaded before we use it
  await loadBaileys();

  // Disconnect existing if any
  if (sock) {
    try { sock.end(); } catch (e) {}
    sock = null;
    isConnected = false;
  }

  if (!profileName) profileName = 'default';
  activeProfile = profileName;

  const authDir = getProfileAuthDir(profileName);
  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    // 'warn' surfaces Baileys' per-host media upload warnings so we can see the
    // real reason behind "Media upload failed on all hosts". Set LOG_LEVEL to
    // change (e.g. 'silent' for quiet, 'debug' for verbose).
    logger: pino({ level: process.env.LOG_LEVEL || 'warn' })
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log(`[${profileName}] QR Code received`);
      qrCodeData = await QRCode.toDataURL(qr);
      io.emit('qr', qrCodeData);
      controlPlane.publishQr(qrCodeData).catch(() => {});
    }

    if (connection === 'close') {
      isConnected = false;
      qrCodeData = null;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`[${profileName}] Connection closed. Status:`, statusCode);
      controlPlane.publishStatus('offline', { profile: profileName, reason: statusCode }).catch(() => {});
      controlPlane.updateWaConnection(false, '').catch(() => {});
      io.emit('disconnected', { message: 'Disconnected' });
      if (shouldReconnect) {
        console.log(`[${profileName}] Reconnecting...`);
        setTimeout(() => connectWhatsApp(profileName), 3000);
      }
    }

    if (connection === 'open') {
      // Capture the logged-in WhatsApp number (format: 919xxxx:xx@s.whatsapp.net)
      try {
        const rawId = sock?.user?.id || '';
        loggedInNumber = rawId.split(':')[0].split('@')[0] || '';
      } catch (e) {
        loggedInNumber = '';
      }
      console.log(`[${profileName}] WhatsApp connected! Number: ${loggedInNumber}`);
      isConnected = true;
      qrCodeData = null;
      controlPlane.publishStatus('online', { profile: profileName, number: loggedInNumber }).catch(() => {});
      controlPlane.updateWaConnection(true, loggedInNumber).catch(() => {});
      io.emit('ready', { message: 'WhatsApp connected!', profile: profileName, number: loggedInNumber });
    }
  });
}

// Auto-connect last used profile or default
const profiles = getProfileList();
if (profiles.length > 0) {
  connectWhatsApp(profiles[0]);
} else {
  connectWhatsApp('default');
}

// ===== Google Sheet Functions =====

function extractSheetId(url) {
  // Supports formats:
  // https://docs.google.com/spreadsheets/d/SHEET_ID/...
  const match = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : null;
}

async function fetchSheetData(sheetUrl, sheetTab) {
  const sheetId = extractSheetId(sheetUrl);
  if (!sheetId) throw new Error('Invalid Google Sheet URL');

  // Build CSV export URL with optional sheet/tab name
  let csvUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv`;
  if (sheetTab && sheetTab.trim()) {
    csvUrl += `&sheet=${encodeURIComponent(sheetTab.trim())}`;
  }

  const response = await fetch(csvUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch sheet: ${response.status} - Make sure sheet is publicly accessible and tab name "${sheetTab}" is correct`);
  }

  const csvText = await response.text();
  return parseCSV(csvText);
}

function parseCSV(csvText) {
  // Do NOT filter empty lines - we need actual row positions to map to sheet rows
  const lines = csvText.split('\n');
  // Remove trailing empty lines only
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (lines.length < 2) return { headers: [], rows: [] };

  // Parse header
  const headers = parseCSVLine(lines[0]);

  // Parse rows - keep _rowIndex as actual CSV line position (matches sheet row)
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    const row = {};
    headers.forEach((h, idx) => {
      row[h.trim().toLowerCase()] = (values[idx] || '').trim();
    });
    // _rowIndex is the actual sheet row number (line 0 = header = sheet row 1,
    // so line i = sheet row i+1)
    row._rowIndex = i + 1;
    rows.push(row);
  }

  return { headers: headers.map(h => h.trim()), rows };
}

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

async function checkForNewEntries() {
  if (!sheetConfig.isMonitoring || !sheetConfig.sheetUrl || !isConnected) return;

  // Prevent overlapping checks - if a previous batch run is still going, skip
  if (isChecking) {
    console.log('[Sheet] Previous check still running, skipping this cycle');
    return;
  }
  isChecking = true;

  try {
    const { headers, rows } = await fetchSheetData(sheetConfig.sheetUrl, sheetConfig.sheetTab);
    const phoneCol = sheetConfig.phoneColumn.trim().toLowerCase();
    const nameCol = sheetConfig.nameColumn.trim().toLowerCase();
    const statusCol = sheetConfig.statusColumn.trim().toLowerCase();
    const dateCol = sheetConfig.dateColumn.trim().toLowerCase();

    // Find column indices for status and date
    const headersLower = headers.map(h => h.toLowerCase());
    const statusColIndex = headersLower.indexOf(statusCol);
    const dateColIndex = headersLower.indexOf(dateCol);
    const phoneColIndex = headersLower.indexOf(phoneCol);

    let sentThisCheck = 0;
    let failedThisCheck = 0;

    // STEP 1: Collect all rows that need a message (blank status).
    // The sheet's Status column is the FINAL authority:
    //   - blank  = needs message (even if it was sent before and cleared)
    //   - anything (Sent/Failed/etc) = skip
    // The isChecking lock prevents overlapping runs, so no double-sends.
    const toProcess = [];
    for (const row of rows) {
      const rawPhone = (row[phoneCol] || '').toString().trim();
      const currentStatus = statusCol && row[statusCol] ? row[statusCol].toString().trim() : '';

      // Non-blank status = already handled, skip silently (not counted)
      if (currentStatus !== '') continue;

      // Blank rows with no phone at all are ignored
      if (!rawPhone) continue;

      // Remove common valid prefixes/symbols to check what's left.
      // Valid phone value may contain: digits, +, spaces, -, (), and a "p:" prefix.
      // If ANY letter (a-z) remains after removing "p" prefix, it's an invalid number.
      const withoutPrefix = rawPhone.replace(/^p\s*:?\s*/i, ''); // strip leading "p:" / "p"
      const hasInvalidChar = /[a-zA-Z]/.test(withoutPrefix); // any letter left = bad

      const phone = rawPhone.replace(/[^0-9]/g, '');
      const name = row[nameCol] || '';

      // Invalid number (contains letters like X/Z) -> mark Failed.
      // IMPORTANT: send the RAW phone value (with letters) to Apps Script so it
      // matches the exact cell text, NOT the cleaned digits (which could match
      // a different valid row that happens to have the same digits).
      if (hasInvalidChar || !phone || phone.length < 10 || phone.length > 15) {
        console.log(`[Sheet] Invalid phone "${rawPhone}" - marking Failed`);
        failedThisCheck++;
        appendHistory({ name, phone: rawPhone, status: 'Failed', source: 'sheet', error: 'Invalid number' });
        io.emit('sheet_message_failed', { phone: rawPhone, name, error: 'Invalid number' });
        if (statusColIndex >= 0 && dateColIndex >= 0) {
          await updateSheetRowRaw(row._rowIndex, statusColIndex, dateColIndex, rawPhone, phoneColIndex, name, 'Failed');
        }
        continue;
      }

      toProcess.push({ row, phone, name });
    }

    // STEP 2: Process in configurable batches, with a configurable gap between batches
    const BATCH_SIZE = Math.max(1, Number(sheetConfig.batchSize) || 5);
    const BATCH_GAP_MS = Math.max(0, Number(sheetConfig.batchGapSeconds) ?? 10) * 1000;

    for (let b = 0; b < toProcess.length; b += BATCH_SIZE) {
      const batch = toProcess.slice(b, b + BATCH_SIZE);
      console.log(`[Sheet] Processing batch ${Math.floor(b / BATCH_SIZE) + 1} (${batch.length} numbers)`);

      for (const item of batch) {
        const { row, phone, name } = item;

        let messageToSend = sheetConfig.message
          .replace(/\{name\}/gi, name)
          .replace(/\{phone\}/gi, phone);

        for (const [key, val] of Object.entries(row)) {
          if (key !== '_rowIndex') {
            messageToSend = messageToSend.replace(new RegExp(`\\{${key}\\}`, 'gi'), val);
          }
        }

        try {
          // Verify the number exists on WhatsApp before sending
          const [result] = await sock.onWhatsApp(phone);
          if (!result || !result.exists) {
            console.log(`[Sheet] Number ${phone} not on WhatsApp - marking failed`);
            failedThisCheck++;
            appendHistory({ name, phone, status: 'Failed', source: 'sheet', error: 'Number not on WhatsApp' });
            io.emit('sheet_message_failed', { phone, name, error: 'Number not on WhatsApp' });
            if (statusColIndex >= 0 && dateColIndex >= 0) {
              await updateSheetRow(row._rowIndex, statusColIndex, dateColIndex, phone, phoneColIndex, name, 'Failed');
            }
            continue;
          }

          const jid = result.jid;

          if (sheetConfig.imagePath) {
            const img = await resolveImageBuffer(sheetConfig.imagePath);
            if (img) {
              const jpegThumbnail = await makeJpegThumbnail(img.buffer);
              await sendMessageWithRetry(jid, { image: img.buffer, mimetype: img.mimetype, caption: messageToSend, jpegThumbnail });
            } else {
              await sock.sendMessage(jid, { text: messageToSend });
            }
          } else {
            await sock.sendMessage(jid, { text: messageToSend });
          }

          console.log(`[Sheet] Sent to ${phone}`);
          sentThisCheck++;
          appendHistory({ name, phone, status: 'Sent', source: 'sheet' });
          io.emit('sheet_message_sent', { phone, name, rowIndex: row._rowIndex });

          if (statusColIndex >= 0 && dateColIndex >= 0) {
            await updateSheetRow(row._rowIndex, statusColIndex, dateColIndex, phone, phoneColIndex, name, 'Sent');
          }

          // Small delay between messages within a batch (2 sec)
          await new Promise(resolve => setTimeout(resolve, 2000));

        } catch (err) {
          console.error(`[Sheet] Failed to send to ${phone}:`, err.message);
          failedThisCheck++;
          appendHistory({ name, phone, status: 'Failed', source: 'sheet', error: err.message });
          io.emit('sheet_message_failed', { phone, name, error: err.message });
        }
      }

      // Wait 10 sec before next batch (only if more batches remain)
      if (b + BATCH_SIZE < toProcess.length) {
        console.log(`[Sheet] Batch done. Waiting ${BATCH_GAP_MS / 1000}s before next batch...`);
        io.emit('sheet_batch_wait', { seconds: BATCH_GAP_MS / 1000 });
        await new Promise(resolve => setTimeout(resolve, BATCH_GAP_MS));
      }
    }

    const processedThisCheck = sentThisCheck + failedThisCheck;
    if (processedThisCheck > 0) {
      console.log(`[Sheet] This check - processed: ${processedThisCheck}, sent: ${sentThisCheck}, failed: ${failedThisCheck}`);
    }

    io.emit('sheet_check_complete', {
      processed: processedThisCheck,
      sent: sentThisCheck,
      failed: failedThisCheck
    });

  } catch (err) {
    console.error('[Sheet] Error:', err.message);
    io.emit('sheet_error', { error: err.message });
  } finally {
    isChecking = false;
  }
}

async function startMonitoring(config, sessionMeta = {}) {
  const {
    sheetUrl, sheetTab, appsScriptUrl, phoneColumn, nameColumn,
    statusColumn, dateColumn, message, imagePath, intervalSeconds,
    batchSize, batchGapSeconds
  } = config;

  if (!sheetUrl) throw new Error('Sheet URL required');
  if (!phoneColumn) throw new Error('Phone column name required');
  if (!message) throw new Error('Message required');
  if (!isConnected) throw new Error('WhatsApp not connected');

  const sheetId = extractSheetId(sheetUrl);
  if (!sheetId) throw new Error('Invalid Google Sheet URL');

  const data = await fetchSheetData(sheetUrl, sheetTab);
  const phoneCol = phoneColumn.trim().toLowerCase();
  const hasPhoneCol = data.headers.some(h => h.toLowerCase() === phoneCol);
  if (!hasPhoneCol) {
    throw new Error(`Column "${phoneColumn}" not found. Available: ${data.headers.join(', ')}`);
  }

  if (sheetConfig.isMonitoring) await stopMonitoring('replaced');

  sheetConfig.processedRows = new Set();
  sheetConfig.sheetUrl = sheetUrl;
  sheetConfig.sheetTab = sheetTab || '';
  sheetConfig.appsScriptUrl = appsScriptUrl || '';
  sheetConfig.phoneColumn = phoneColumn;
  sheetConfig.nameColumn = nameColumn || '';
  sheetConfig.statusColumn = statusColumn || '';
  sheetConfig.dateColumn = dateColumn || '';
  sheetConfig.message = message;
  sheetConfig.imagePath = imagePath || '';
  sheetConfig.intervalSeconds = Math.max(5, Number(intervalSeconds) || 30);
  sheetConfig.batchSize = Math.max(1, Number(batchSize) || 5);
  sheetConfig.batchGapSeconds = Math.max(0, Number(batchGapSeconds) ?? 10);
  sheetConfig.isMonitoring = true;

  const session = sessionMeta.sessionId && sessionMeta.leaseToken
    ? { sessionId: sessionMeta.sessionId, leaseToken: sessionMeta.leaseToken, ownerId: sessionMeta.ownerId || 'local' }
    : await controlPlane.createSession({
        ownerId: sessionMeta.ownerId || 'local',
        config: { ...config, intervalSeconds: sheetConfig.intervalSeconds },
        noLease: !!sessionMeta.noLease
      });
  activeMonitorSession = { ...session, lastClientSeenAt: Date.now(), noLease: !!sessionMeta.noLease };

  if (monitorInterval) clearInterval(monitorInterval);
  setTimeout(checkForNewEntries, 500);
  monitorInterval = setInterval(checkForNewEntries, sheetConfig.intervalSeconds * 1000);
  if (!monitorLeaseTimer) {
    monitorLeaseTimer = setInterval(async () => {
      if (!activeMonitorSession || !sheetConfig.isMonitoring) return;
      if (!controlPlane.enabled && Date.now() - activeMonitorSession.lastClientSeenAt > controlPlane.leaseMs) {
        await stopMonitoring('lease-expired');
      }
    }, 10000);
  }

  saveConfig();
  await controlPlane.updateSessionState('running', { intervalSeconds: sheetConfig.intervalSeconds });
  io.emit('sheet_status', { isMonitoring: true, sessionId: session.sessionId });
  console.log(`[Sheet] Monitoring started. ${data.rows.length} existing rows marked. Checking every ${sheetConfig.intervalSeconds}s`);

  return {
    success: true,
    message: `Monitoring started! ${data.rows.length} existing entries skipped. New entries will get WhatsApp message.`,
    existingRows: data.rows.length,
    headers: data.headers,
    sessionId: session.sessionId,
    leaseToken: session.leaseToken
  };
}

async function stopMonitoring(reason = 'manual') {
  sheetConfig.isMonitoring = false;
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
  }
  const session = activeMonitorSession;
  activeMonitorSession = null;
  if (session) {
    await controlPlane.updateSessionState('stopped', { reason });
    await controlPlane.stopSession(session.sessionId, session.leaseToken, reason);
  }
  io.emit('sheet_status', { isMonitoring: false, reason });
  console.log(`[Sheet] Monitoring stopped (${reason})`);
}

// ===== Socket.IO =====
io.on('connection', (socket) => {
  console.log('Dashboard connected');
  if (isConnected) {
    socket.emit('ready', { message: 'WhatsApp is connected', profile: activeProfile });
  } else if (qrCodeData) {
    socket.emit('qr', qrCodeData);
  }

  // Send current sheet monitor status
  socket.emit('sheet_status', {
    isMonitoring: sheetConfig.isMonitoring,
    sheetUrl: sheetConfig.sheetUrl,
    sheetTab: sheetConfig.sheetTab,
    phoneColumn: sheetConfig.phoneColumn,
    nameColumn: sheetConfig.nameColumn,
    statusColumn: sheetConfig.statusColumn,
    dateColumn: sheetConfig.dateColumn,
    message: sheetConfig.message,
    imagePath: sheetConfig.imagePath,
    intervalSeconds: sheetConfig.intervalSeconds,
    batchSize: sheetConfig.batchSize,
    batchGapSeconds: sheetConfig.batchGapSeconds,
    processedCount: sheetConfig.processedRows.size,
    sessionId: activeMonitorSession?.sessionId || null
  });
});

// ===== API Routes =====

app.get('/api/status', (req, res) => {
  res.json({ connected: isConnected, hasQR: !!qrCodeData, number: loggedInNumber });
});

app.post('/api/upload', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
  res.json({ success: true, filename: req.file.filename, path: req.file.path });
});

// Resolve an image reference to a Buffer. Supports:
//  - Local filesystem path (legacy: images uploaded via /api/upload)
//  - Supabase Storage public/signed URL (https://...supabase.co/storage/v1/object/...)
//  - Supabase Storage bucket path "message-images/<file>" (downloaded via service key)
//
// Returns { buffer, mimetype } or null. Baileys' media upload is much more
// reliable when given an explicit mimetype instead of relying on magic-byte
// sniffing, so we always derive one from the file extension.
function mimetypeForPath(p) {
  const ext = (p.split('.').pop() || '').toLowerCase().split(/[?#]/)[0];
  const map = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
  return map[ext] || 'image/jpeg';
}

async function resolveImageBuffer(imagePath) {
  if (!imagePath) return null;
  const mimetype = mimetypeForPath(imagePath);

  // Supabase Storage bucket-relative path, e.g. "message-images/abc.jpg"
  if (imagePath.startsWith('message-images/') && controlPlane.enabled) {
    const supaUrl = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const objectPath = imagePath.replace(/^message-images\//, '');
    const res = await fetch(`${supaUrl}/storage/v1/object/message-images/${encodeURI(objectPath)}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` }
    });
    if (!res.ok) throw new Error(`Image download failed: ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    if (!buffer.length) throw new Error('Downloaded image is empty');
    return { buffer, mimetype };
  }

  // Any absolute Supabase/HTTP(S) URL (e.g. a signed URL from the dashboard)
  if (/^https?:\/\//i.test(imagePath)) {
    const res = await fetch(imagePath);
    if (!res.ok) throw new Error(`Image download failed: ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    if (!buffer.length) throw new Error('Downloaded image is empty');
    return { buffer, mimetype };
  }

  // Legacy local filesystem path
  const fullPath = path.resolve(imagePath);
  if (fs.existsSync(fullPath)) {
    const buffer = fs.readFileSync(fullPath);
    return { buffer, mimetype: mimetypeForPath(fullPath) };
  }
  return null;
}

// Send a WhatsApp message with automatic retry for transient media-upload
// failures ("Media upload failed on all hosts"), which are usually temporary
// network/timeout issues with WhatsApp's media servers.
async function sendMessageWithRetry(jid, content, attempts = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await sock.sendMessage(jid, content);
    } catch (err) {
      lastErr = err;
      const msg = (err && err.message) || '';
      // Detailed diagnostics so we can see the REAL cause behind "failed on all hosts".
      console.log(`[Send][diag] attempt ${attempt} error: ${msg}`);
      if (err?.stack) console.log(`[Send][diag] stack: ${err.stack.split('\n').slice(0, 4).join(' | ')}`);
      if (err?.output) { try { console.log(`[Send][diag] output: ${JSON.stringify(err.output)}`); } catch (e) {} }
      const isMediaHostFail = /Media upload failed|failed on all hosts|Timed Out|timeout/i.test(msg);
      if (!isMediaHostFail || attempt === attempts) throw err;
      console.log(`[Send] Media upload attempt ${attempt} failed (${msg}); retrying in 3s...`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  throw lastErr;
}

// Reusable manual bulk send (used by HTTP /api/send and Supabase send_message)
async function sendBulk({ phoneNumbers, message, imagePath }) {
  if (!isConnected) throw new Error('WhatsApp not connected.');
  if (!phoneNumbers || phoneNumbers.length === 0) throw new Error('No phone numbers');
  if (!message && !imagePath) throw new Error('Provide message or image');

  const results = [];
  for (let i = 0; i < phoneNumbers.length; i++) {
    const phone = String(phoneNumbers[i]).trim().replace(/[^0-9]/g, '');
    const jid = phone + '@s.whatsapp.net';
    try {
      if (imagePath) {
        const img = await resolveImageBuffer(imagePath);
        if (img) {
          const jpegThumbnail = await makeJpegThumbnail(img.buffer);
          await sendMessageWithRetry(jid, { image: img.buffer, mimetype: img.mimetype, caption: message || '', jpegThumbnail });
        } else if (message) {
          await sock.sendMessage(jid, { text: message });
        }
      } else {
        await sock.sendMessage(jid, { text: message });
      }
      results.push({ phone, success: true });
      appendHistory({ name: '', phone, status: 'Sent', source: 'manual' });
      io.emit('message_sent', { phone, index: i, total: phoneNumbers.length });
      const delay = Math.floor(Math.random() * 3000) + 2000;
      await new Promise(resolve => setTimeout(resolve, delay));
    } catch (err) {
      results.push({ phone, success: false, error: err.message });
      appendHistory({ name: '', phone, status: 'Failed', source: 'manual', error: err.message });
      io.emit('message_failed', { phone, index: i, error: err.message });
    }
  }
  const sent = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  return { success: true, summary: { total: phoneNumbers.length, sent, failed }, results };
}

// Manual bulk send
app.post('/api/send', async (req, res) => {
  try {
    const result = await sendBulk(req.body || {});
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ===== Sheet Monitor API =====

// Start monitoring
app.post('/api/sheet/start', async (req, res) => {
  try {
    const result = await startMonitoring(req.body, {
      ownerId: req.body.ownerId || 'local'
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Refresh the browser-owned monitor lease. Closing the page triggers a
// best-effort stop, while this heartbeat handles normal long-running sessions.
app.post('/api/sheet/heartbeat', async (req, res) => {
  const { sessionId, leaseToken } = req.body || {};
  if (!activeMonitorSession || activeMonitorSession.sessionId !== sessionId || activeMonitorSession.leaseToken !== leaseToken) {
    return res.status(409).json({ error: 'Monitor session is no longer active' });
  }
  const accepted = await controlPlane.heartbeat(sessionId, leaseToken);
  if (!accepted) return res.status(409).json({ error: 'Monitor lease is invalid or expired' });
  activeMonitorSession.lastClientSeenAt = Date.now();
  res.json({ success: true });
});

// Stop monitoring
app.post('/api/sheet/stop', async (req, res) => {
  const { sessionId, leaseToken } = req.body || {};
  if (sessionId && activeMonitorSession && (sessionId !== activeMonitorSession.sessionId || leaseToken !== activeMonitorSession.leaseToken)) {
    return res.status(409).json({ error: 'Monitor session does not belong to this client' });
  }
  await stopMonitoring(req.body?.reason || 'manual');
  res.json({ success: true, message: 'Monitoring stopped' });
});

// Get sheet status
app.get('/api/sheet/status', (req, res) => {
  res.json({
    isMonitoring: sheetConfig.isMonitoring,
    sheetUrl: sheetConfig.sheetUrl,
    sheetTab: sheetConfig.sheetTab,
    appsScriptUrl: sheetConfig.appsScriptUrl,
    phoneColumn: sheetConfig.phoneColumn,
    nameColumn: sheetConfig.nameColumn,
    statusColumn: sheetConfig.statusColumn,
    dateColumn: sheetConfig.dateColumn,
    message: sheetConfig.message,
    imagePath: sheetConfig.imagePath,
    intervalSeconds: sheetConfig.intervalSeconds,
    batchSize: sheetConfig.batchSize,
    batchGapSeconds: sheetConfig.batchGapSeconds,
    processedCount: sheetConfig.processedRows.size,
    sessionId: activeMonitorSession?.sessionId || null
  });
});

// ===== History / Report API =====

// Get history with optional date-range filter (?from=YYYY-MM-DD&to=YYYY-MM-DD&status=Sent)
app.get('/api/history', (req, res) => {
  let history = readHistory();
  const { from, to, status, source } = req.query;

  if (from) {
    const fromDate = new Date(from + 'T00:00:00');
    history = history.filter(h => new Date(h.timestamp) >= fromDate);
  }
  if (to) {
    const toDate = new Date(to + 'T23:59:59');
    history = history.filter(h => new Date(h.timestamp) <= toDate);
  }
  if (status && status !== 'all') {
    history = history.filter(h => (h.status || '').toLowerCase() === status.toLowerCase());
  }
  if (source && source !== 'all') {
    history = history.filter(h => (h.source || '').toLowerCase() === source.toLowerCase());
  }

  // Newest first
  history.reverse();

  const sent = history.filter(h => (h.status || '').toLowerCase() === 'sent').length;
  const failed = history.filter(h => (h.status || '').toLowerCase() === 'failed').length;

  res.json({ total: history.length, sent, failed, records: history });
});

// Clear all history
app.delete('/api/history', (req, res) => {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify([], null, 2));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete history BEFORE a given date (keeps records on/after that date)
app.delete('/api/history/before', (req, res) => {
  const { date } = req.query; // YYYY-MM-DD
  if (!date) return res.status(400).json({ error: 'Date required' });

  try {
    const cutoff = new Date(date + 'T00:00:00');
    if (isNaN(cutoff.getTime())) return res.status(400).json({ error: 'Invalid date' });

    let history = readHistory();
    const before = history.length;
    // Keep records whose timestamp is >= cutoff (on/after the date)
    const kept = history.filter(h => new Date(h.timestamp) >= cutoff);
    const deleted = before - kept.length;

    fs.writeFileSync(HISTORY_FILE, JSON.stringify(kept, null, 2));
    res.json({ success: true, deleted, remaining: kept.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Logout
app.post('/api/logout', async (req, res) => {
  const profileToRelogin = activeProfile || 'default';
  try {
    // Try a clean logout, then close the socket
    if (sock) {
      try { await sock.logout(); } catch (e) { /* ignore */ }
      try { sock.end(); } catch (e) { /* ignore */ }
      sock = null;
    }
    isConnected = false;
    qrCodeData = null;
    loggedInNumber = '';

    // Delete current profile auth so a fresh QR is generated
    const authDir = getProfileAuthDir(profileToRelogin);
    if (fs.existsSync(authDir)) {
      fs.rmSync(authDir, { recursive: true, force: true });
    }

    io.emit('disconnected', { message: 'Logged out' });

    // Start a fresh connection to generate a new QR code
    setTimeout(() => connectWhatsApp(profileToRelogin), 1500);

    res.json({ success: true });
  } catch (err) {
    // Even on error, try to restart connection for QR
    setTimeout(() => connectWhatsApp(profileToRelogin), 1500);
    res.status(500).json({ error: err.message });
  }
});

// ===== Profile API =====

// Get all profiles
app.get('/api/profiles', (req, res) => {
  const profiles = getProfileList();
  res.json({
    profiles,
    activeProfile: activeProfile || 'default'
  });
});

// Connect with a specific profile (existing or new)
app.post('/api/profiles/connect', async (req, res) => {
  const { profileName } = req.body;
  if (!profileName || !profileName.trim()) {
    return res.status(400).json({ error: 'Profile name required' });
  }

  const name = profileName.trim().replace(/[^a-zA-Z0-9_\- ]/g, '');
  if (!name) return res.status(400).json({ error: 'Invalid profile name' });

  try {
    await connectWhatsApp(name);
    res.json({ success: true, profile: name, message: `Connecting as "${name}"...` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a profile
app.delete('/api/profiles/:name', (req, res) => {
  const name = req.params.name;
  const dir = path.join(PROFILES_DIR, name);

  if (name === activeProfile) {
    return res.status(400).json({ error: 'Cannot delete active profile. Switch first.' });
  }

  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    res.json({ success: true, message: `Profile "${name}" deleted` });
  } else {
    res.status(404).json({ error: 'Profile not found' });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  controlPlane.start();
  const localUrl = `http://localhost:${PORT}`;
  console.log(`Server running on ${localUrl}`);

  // Which page to open in the browser on startup.
  // For worker EXEs we open the shared cloud dashboard (Vercel) instead of the
  // local page, so users control everything from one place. Override with the
  // DASHBOARD_URL env var if the deployment URL changes.
  const DASHBOARD_URL = process.env.DASHBOARD_URL
    || 'https://whatsapp-integration-wine.vercel.app/cloud';
  const openUrl = IS_PKG ? DASHBOARD_URL : localUrl;

  // Only auto-open a browser on a local desktop/EXE run (not on a hosted server).
  const isHosted = !!process.env.DATA_DIR || (!!process.env.PORT && !IS_PKG && process.platform !== 'win32');
  if (!isHosted) {
    console.log('Opening dashboard in your browser: ' + openUrl);
    try {
      const { exec } = require('child_process');
      if (process.platform === 'win32') exec(`start "" "${openUrl}"`);
      else if (process.platform === 'darwin') exec(`open "${openUrl}"`);
      else exec(`xdg-open "${openUrl}"`);
    } catch (e) { /* ignore - user can open manually */ }
  }
});

// On app shutdown: stop monitoring, log out of WhatsApp (ends the session),
// delete local auth files, and remove this worker from the dashboard list.
// Because the session is logged out, the next launch will require a fresh QR scan.
let isShuttingDown = false;
async function gracefulShutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log('[Shutdown] Cleaning up: stopping monitoring, logging out WhatsApp, removing device...');
  try { await stopMonitoring('process-shutdown'); } catch (e) {}

  // Full WhatsApp logout so the session is invalidated (Option B).
  try {
    if (sock) {
      try { await sock.logout(); } catch (e) { /* ignore */ }
      try { sock.end(); } catch (e) { /* ignore */ }
      sock = null;
    }
  } catch (e) {}

  // Delete local auth files for the active profile so no stale session remains.
  try {
    const authDir = getProfileAuthDir(activeProfile || 'default');
    if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true });
  } catch (e) {}

  // Remove this worker's record from Supabase so it disappears from the dashboard.
  try { await controlPlane.stop({ removeWorker: true }); } catch (e) {}

  process.exit(0);
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
process.on('SIGHUP', gracefulShutdown);
process.on('SIGBREAK', gracefulShutdown); // Windows: console window close / Ctrl+Break