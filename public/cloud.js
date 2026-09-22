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
  setBadge('disconnected', 'Signed out');
  if (workersTimer) { clearInterval(workersTimer); workersTimer = null; }
  if (eventsChannel) { supabase.removeChannel(eventsChannel); eventsChannel = null; }
}

function showApp() {
  loginScreen.style.display = 'none';
  appArea.style.display = 'block';
  logoutBtn.style.display = 'inline-block';
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

function selectWorker(id) {
  selectedWorkerId = id;
  renderWorkers();
  renderPanel();
  subscribeEvents(id);
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
    qrImg.innerHTML = `<img src="${w.qr_data}" alt="QR">`;
    connectedArea.style.display = 'none';
  } else {
    qrArea.style.display = 'none';
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
        const idx = workers.findIndex(x => x.id === workerId);
        if (idx >= 0) workers[idx] = { ...workers[idx], ...payload.new };
        renderWorkers();
        renderPanel();
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

// Tab switching within the panel
document.querySelectorAll('[data-ctab]').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('[data-ctab]').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(tab.dataset.ctab + 'Panel').classList.add('active');
  });
});

document.getElementById('c_startBtn').addEventListener('click', () => {
  const payload = {
    sheetUrl: val('c_sheetUrl'), sheetTab: val('c_sheetTab'), appsScriptUrl: val('c_appsUrl'),
    phoneColumn: val('c_phoneCol'), nameColumn: val('c_nameCol'),
    statusColumn: val('c_statusCol'), dateColumn: val('c_dateCol'),
    message: val('c_message'), imagePath: '', intervalSeconds: parseInt(val('c_interval')) || 120
  };
  if (!payload.sheetUrl) return alert('Sheet link daalein.');
  if (!payload.phoneColumn) return alert('Phone column daalein.');
  if (!payload.message) return alert('Message daalein.');
  sendCommand('start_monitoring', payload);
});

document.getElementById('c_stopBtn').addEventListener('click', () => sendCommand('stop_monitoring', {}));

document.getElementById('c_sendBtn').addEventListener('click', () => {
  const numbers = val('c_numbers').split('\n').map(n => n.trim()).filter(Boolean);
  const message = val('c_manualMsg');
  if (!numbers.length) return alert('Phone numbers daalein.');
  if (!message) return alert('Message daalein.');
  if (!confirm(`Send to ${numbers.length} number(s)?`)) return;
  sendCommand('send_message', { phoneNumbers: numbers, message, imagePath: '' });
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
