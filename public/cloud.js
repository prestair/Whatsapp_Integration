/* Supabase-driven shared cloud dashboard (Design 2A).
   Reads worker status/QR from Supabase, dispatches commands via monitor_commands,
   and shows live worker_events. No tunnel required. */

const CFG = window.APP_CONFIG || {};
const cpBadge = document.getElementById('cpBadge');
const cpText = document.getElementById('cpText');
const workerListEl = document.getElementById('workerList');
const noWorker = document.getElementById('noWorker');
const workerPanel = document.getElementById('workerPanel');
const panelTitle = document.getElementById('panelTitle');
const qrArea = document.getElementById('qrArea');
const qrImg = document.getElementById('qrImg');
const connectedArea = document.getElementById('connectedArea');
const waNumber = document.getElementById('waNumber');
const cloudLog = document.getElementById('cloudLog');

let supabase = null;
let selectedWorkerId = null;
let workers = [];
let eventsChannel = null;

function setBadge(state, text) {
  cpBadge.querySelector('.status-dot').className = 'status-dot ' + state;
  cpText.textContent = text;
}

function log(message, type = '') {
  const div = document.createElement('div');
  div.className = 'log-line ' + type;
  const time = new Date().toLocaleTimeString('en-IN', { hour12: true });
  div.textContent = `[${time}] ${message}`;
  cloudLog.prepend(div);
}

const loginScreen = document.getElementById('loginScreen');
const appArea = document.getElementById('appArea');
const logoutBtn = document.getElementById('logoutBtn');
let workersTimer = null;
let qrPollTimer = null;

function initSupabase() {
  if (!CFG.supabaseUrl || !CFG.supabaseAnonKey || !window.supabase) {
    document.getElementById('configError').style.display = 'block';
    setBadge('disconnected', 'Config missing');
    return false;
  }
  supabase = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true }
  });
  return true;
}

function showLogin() {
  loginScreen.style.display = 'block';
  appArea.style.display = 'none';
  logoutBtn.style.display = 'none';
  const reportLink = document.getElementById('reportLink');
  if (reportLink) reportLink.style.display = 'none';
  setBadge('disconnected', 'Signed out');
  if (workersTimer) { clearInterval(workersTimer); workersTimer = null; }
  if (qrPollTimer) { clearInterval(qrPollTimer); qrPollTimer = null; }
  if (eventsChannel) { supabase.removeChannel(eventsChannel); eventsChannel = null; }
}

function showApp() {
  loginScreen.style.display = 'none';
  appArea.style.display = 'block';
  logoutBtn.style.display = 'inline-block';
  const reportLink = document.getElementById('reportLink');
  if (reportLink) reportLink.style.display = 'inline-block';
  setBadge('connecting', 'Loading…');
  loadWorkers();
  if (!workersTimer) workersTimer = setInterval(loadWorkers, 10000);
}

async function doLogin() {
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  const errEl = document.getElementById('loginError');
  errEl.style.display = 'none';
  if (!email || !password) { errEl.textContent = 'Email aur password daalein.'; errEl.style.display = 'block'; return; }
  const btn = document.getElementById('loginBtn');
  btn.disabled = true; btn.textContent = 'Signing in…';
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  btn.disabled = false; btn.textContent = 'Sign in';
  if (error) { errEl.textContent = error.message; errEl.style.display = 'block'; return; }
  document.getElementById('loginPassword').value = '';
  // onAuthStateChange will switch to the app
}

async function initAuth() {
  const { data } = await supabase.auth.getSession();
  if (data.session) showApp(); else showLogin();

  supabase.auth.onAuthStateChange((_event, session) => {
    if (session) showApp(); else showLogin();
  });

  document.getElementById('loginBtn').addEventListener('click', doLogin);
  document.getElementById('loginPassword').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  logoutBtn.addEventListener('click', async () => { await supabase.auth.signOut(); });
}

async function loadWorkers() {
  const { data, error } = await supabase
    .from('worker_instances')
    .select('id, display_name, status, wa_connected, wa_number, qr_data, qr_updated_at, last_seen_at')
    .order('last_seen_at', { ascending: false });
  if (error) { setBadge('disconnected', 'Error'); log('Load devices failed: ' + error.message, 'error'); return; }
  workers = data || [];
  setBadge('connected', `${workers.length} device(s)`);
  renderWorkers();
  if (selectedWorkerId) renderPanel();
}

function isOnline(w) {
  // Treat a worker as online only if seen within the last 30 seconds.
  return w.status === 'online' && w.last_seen_at && (Date.now() - new Date(w.last_seen_at).getTime() < 30000);
}

function renderWorkers() {
  workerListEl.innerHTML = '';
  if (!workers.length) {
    workerListEl.innerHTML = '<small style="color:#667;">No devices yet.</small>';
    return;
  }
  workers.forEach(w => {
    const online = isOnline(w);
    const item = document.createElement('div');
    item.className = 'worker-item' + (w.id === selectedWorkerId ? ' active' : '');
    item.innerHTML = `
      <div>
        <div class="wname"><span class="dot ${online ? 'online' : 'offline'}"></span>${escapeHtml(w.display_name || w.id)}</div>
        <div class="wmeta">${w.wa_connected ? 'WhatsApp: ' + escapeHtml(w.wa_number || 'connected') : (online ? 'needs QR scan' : 'offline')}</div>
      </div>`;
    item.addEventListener('click', () => selectWorker(w.id));
    workerListEl.appendChild(item);
  });
}

function escapeHtml(t) { const d = document.createElement('div'); d.textContent = t == null ? '' : t; return d.innerHTML; }

function currentWorker() { return workers.find(w => w.id === selectedWorkerId); }

async function refreshSelectedWorker() {
  if (!selectedWorkerId) return;
  const { data, error } = await supabase
    .from('worker_instances')
    .select('id, display_name, status, wa_connected, wa_number, qr_data, qr_updated_at, last_seen_at')
    .eq('id', selectedWorkerId)
    .limit(1);
  if (error || !data || !data.length) return;
  const idx = workers.findIndex(x => x.id === selectedWorkerId);
  if (idx >= 0) workers[idx] = data[0]; else workers.push(data[0]);
  renderPanel();
}

function selectWorker(id) {
  selectedWorkerId = id;
  renderWorkers();
  renderPanel();
  subscribeEvents(id);
  loadWorkerConfig(id).catch(err => console.warn('Load config failed:', err.message));
  // Poll the selected device every 3s so QR/connection state stays fresh
  // even if a realtime UPDATE omits the large qr_data column.
  if (qrPollTimer) clearInterval(qrPollTimer);
  qrPollTimer = setInterval(refreshSelectedWorker, 3000);
  refreshSelectedWorker();
}

function renderPanel() {
  const w = currentWorker();
  if (!w) { noWorker.style.display = 'block'; workerPanel.style.display = 'none'; return; }
  noWorker.style.display = 'none';
  workerPanel.style.display = 'block';
  panelTitle.textContent = w.display_name || w.id;

  if (w.wa_connected) {
    connectedArea.style.display = 'block';
    waNumber.textContent = w.wa_number ? '(' + w.wa_number + ')' : '';
    qrArea.style.display = 'none';
  } else if (w.qr_data) {
    qrArea.style.display = 'block';
    qrImg.innerHTML = `<img src="${w.qr_data}" alt="QR" style="width:240px;height:240px;">`;
    connectedArea.style.display = 'none';
  } else {
    // Online but QR not fetched yet — show generating message and fetch it.
    qrArea.style.display = 'block';
    qrImg.innerHTML = '<div style="padding:40px;color:#667;">QR generate ho raha hai… (thodी der wait karein)</div>';
    connectedArea.style.display = 'none';
  }
}

function subscribeEvents(workerId) {
  if (eventsChannel) { supabase.removeChannel(eventsChannel); eventsChannel = null; }
  cloudLog.innerHTML = '';
  eventsChannel = supabase
    .channel('worker-' + workerId)
    .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'worker_events', filter: `worker_id=eq.${workerId}` },
      (payload) => {
        const e = payload.new;
        const p = e.payload || {};
        if (e.event_type === 'message_sent') log(`✓ Sent ${p.phone || ''} ${p.name ? '(' + p.name + ')' : ''}`, 'success');
        else if (e.event_type === 'message_failed') log(`✗ Failed ${p.phone || ''} - ${p.error || ''}`, 'error');
        else log(`${e.event_type}: ${JSON.stringify(p)}`);
      })
    .on('postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'worker_instances', filter: `id=eq.${workerId}` },
      (payload) => {
        // Merge, then re-fetch full row (realtime may omit the large qr_data column).
        const idx = workers.findIndex(x => x.id === workerId);
        if (idx >= 0) workers[idx] = { ...workers[idx], ...payload.new };
        renderWorkers();
        refreshSelectedWorker();
      })
    .subscribe();
}

async function sendCommand(commandType, payload) {
  const w = currentWorker();
  if (!w) return alert('Select a device first.');
  if (!isOnline(w)) return alert('Ye device abhi offline hai. Us computer par worker EXE chalu karein.');
  const { error } = await supabase.from('monitor_commands').insert({
    worker_id: w.id,
    command_type: commandType,
    payload
  });
  if (error) { log('Command failed: ' + error.message, 'error'); alert('Command failed: ' + error.message); }
  else log(`Command sent: ${commandType}`, 'success');
}

// ===== Image upload to Supabase Storage (private 'message-images' bucket) =====
let uploadedImagePath = '';
let manualUploadedImagePath = '';

async function uploadImage(file) {
  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
  const objectPath = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const { error } = await supabase.storage.from('message-images').upload(objectPath, file, {
    contentType: file.type || 'image/jpeg',
    upsert: false
  });
  if (error) throw error;
  return 'message-images/' + objectPath;
}

function wireImageInput({ inputId, boxId, previewId, removeId, statusId, setPath }) {
  const input = document.getElementById(inputId);
  const box = document.getElementById(boxId);
  const preview = document.getElementById(previewId);
  const removeBtn = document.getElementById(removeId);
  const statusEl = document.getElementById(statusId);

  input.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    statusEl.textContent = 'Uploading…';
    const reader = new FileReader();
    reader.onload = (ev) => { preview.src = ev.target.result; box.style.display = 'block'; };
    reader.readAsDataURL(file);
    try {
      const bucketPath = await uploadImage(file);
      setPath(bucketPath);
      statusEl.textContent = 'Image ready ✓';
    } catch (err) {
      statusEl.textContent = 'Upload failed: ' + err.message;
      setPath('');
    }
  });

  removeBtn.addEventListener('click', () => {
    input.value = '';
    preview.src = '';
    box.style.display = 'none';
    statusEl.textContent = '';
    setPath('');
  });

  return {
    setPreviewFromPath: async (bucketPath) => {
      if (!bucketPath) { box.style.display = 'none'; statusEl.textContent = ''; return; }
      const objectName = bucketPath.replace(/^message-images\//, '');
      const { data } = await supabase.storage.from('message-images').createSignedUrl(objectName, 3600);
      if (data?.signedUrl) { preview.src = data.signedUrl; box.style.display = 'block'; statusEl.textContent = 'Saved image ✓'; }
    }
  };
}

const sheetImageCtl = wireImageInput({
  inputId: 'c_imageInput', boxId: 'c_imagePreviewBox', previewId: 'c_imagePreview',
  removeId: 'c_imageRemoveBtn', statusId: 'c_imageStatus',
  setPath: (p) => { uploadedImagePath = p; }
});
const manualImageCtl = wireImageInput({
  inputId: 'c_manualImageInput', boxId: 'c_manualImagePreviewBox', previewId: 'c_manualImagePreview',
  removeId: 'c_manualImageRemoveBtn', statusId: 'c_manualImageStatus',
  setPath: (p) => { manualUploadedImagePath = p; }
});

// ===== Config persistence (worker_configs) so fields survive reload =====
async function loadWorkerConfig(workerId) {
  const { data } = await supabase.from('worker_configs').select('*').eq('worker_id', workerId).maybeSingle();
  if (!data) return;
  document.getElementById('c_sheetUrl').value = data.sheet_url || '';
  document.getElementById('c_sheetTab').value = data.sheet_tab || '';
  document.getElementById('c_appsUrl').value = data.apps_script_url || '';
  document.getElementById('c_phoneCol').value = data.phone_column || '';
  document.getElementById('c_nameCol').value = data.name_column || '';
  document.getElementById('c_statusCol').value = data.status_column || '';
  document.getElementById('c_dateCol').value = data.date_column || '';
  document.getElementById('c_message').value = data.message || '';
  document.getElementById('c_interval').value = data.interval_seconds || 120;
  document.getElementById('c_batchSize').value = data.batch_size || 5;
  document.getElementById('c_batchGap').value = data.batch_gap_seconds ?? 10;
  document.getElementById('c_manualMsg').value = data.manual_message || '';
  uploadedImagePath = data.image_path || '';
  manualUploadedImagePath = data.manual_image_path || '';
  await sheetImageCtl.setPreviewFromPath(uploadedImagePath);
  await manualImageCtl.setPreviewFromPath(manualUploadedImagePath);
}

async function saveWorkerConfig(workerId, fields) {
  await supabase.from('worker_configs').upsert({ worker_id: workerId, ...fields }, { onConflict: 'worker_id' });
}

// Tab switching within the panel
document.querySelectorAll('[data-ctab]').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('[data-ctab]').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(tab.dataset.ctab + 'Panel').classList.add('active');
  });
});

document.getElementById('c_startBtn').addEventListener('click', async () => {
  const w = currentWorker();
  const payload = {
    sheetUrl: val('c_sheetUrl'), sheetTab: val('c_sheetTab'), appsScriptUrl: val('c_appsUrl'),
    phoneColumn: val('c_phoneCol'), nameColumn: val('c_nameCol'),
    statusColumn: val('c_statusCol'), dateColumn: val('c_dateCol'),
    message: val('c_message'), imagePath: uploadedImagePath || '',
    intervalSeconds: parseInt(val('c_interval')) || 120,
    batchSize: parseInt(val('c_batchSize')) || 5,
    batchGapSeconds: val('c_batchGap') === '' ? 10 : parseInt(val('c_batchGap'))
  };
  if (!payload.sheetUrl) return alert('Sheet link daalein.');
  if (!payload.phoneColumn) return alert('Phone column daalein.');
  if (!payload.message) return alert('Message daalein.');
  if (w) {
    await saveWorkerConfig(w.id, {
      sheet_url: payload.sheetUrl, sheet_tab: payload.sheetTab, apps_script_url: payload.appsScriptUrl,
      phone_column: payload.phoneColumn, name_column: payload.nameColumn,
      status_column: payload.statusColumn, date_column: payload.dateColumn,
      message: payload.message, image_path: payload.imagePath, interval_seconds: payload.intervalSeconds,
      batch_size: payload.batchSize, batch_gap_seconds: payload.batchGapSeconds
    });
  }
  sendCommand('start_monitoring', payload);
});

document.getElementById('c_stopBtn').addEventListener('click', () => sendCommand('stop_monitoring', {}));

document.getElementById('c_sendBtn').addEventListener('click', async () => {
  const w = currentWorker();
  const numbers = val('c_numbers').split('\n').map(n => n.trim()).filter(Boolean);
  const message = val('c_manualMsg');
  if (!numbers.length) return alert('Phone numbers daalein.');
  if (!message) return alert('Message daalein.');
  if (!confirm(`Send to ${numbers.length} number(s)?`)) return;
  if (w) {
    await saveWorkerConfig(w.id, { manual_message: message, manual_image_path: manualUploadedImagePath || '' });
  }
  sendCommand('send_message', { phoneNumbers: numbers, message, imagePath: manualUploadedImagePath || '' });
});

function val(id) { return (document.getElementById(id).value || '').trim(); }

// Boot: initialize Supabase, then gate everything behind auth.
// Wrapped so any failure is visible on screen instead of hanging on "Connecting…".
function showBootError(msg) {
  const err = document.getElementById('configError');
  if (err) { err.style.display = 'block'; err.textContent = msg; }
  setBadge('disconnected', 'Error');
}

(async function boot() {
  try {
    if (!window.supabase || !window.supabase.createClient) {
      return showBootError('Supabase SDK load nahi hua (internet/CDN block?). Page refresh karein.');
    }
    if (!initSupabase()) return; // shows "Config missing"
    await initAuth();
  } catch (e) {
    showBootError('Startup error: ' + (e && e.message ? e.message : e));
    console.error('Boot error:', e);
  }
})();
