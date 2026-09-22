const BACKEND_URL = (window.APP_CONFIG?.backendUrl || '').replace(/\/$/, '');
const apiFetch = (path, options) => fetch(`${BACKEND_URL}${path}`, options);
const socket = io(BACKEND_URL || undefined);

// ===== DOM Elements =====
const statusBadge = document.getElementById('statusBadge');
const statusDot = statusBadge.querySelector('.status-dot');
const statusText = document.getElementById('statusText');
const qrSection = document.getElementById('qrSection');
const qrContainer = document.getElementById('qrContainer');
const connectedSection = document.getElementById('connectedSection');
const logoutBtn = document.getElementById('logoutBtn');
const activeProfileName = document.getElementById('activeProfileName');
const switchProfileBtn = document.getElementById('switchProfileBtn');
const profileSection = document.getElementById('profileSection');
const newProfileName = document.getElementById('newProfileName');
const connectProfileBtn = document.getElementById('connectProfileBtn');
const profileList = document.getElementById('profileList');

// Manual Tab
const phoneNumbers = document.getElementById('phoneNumbers');
const phoneCount = document.getElementById('phoneCount');
const messageText = document.getElementById('messageText');
const imageInput = document.getElementById('imageInput');
const uploadArea = document.getElementById('uploadArea');
const uploadPlaceholder = document.getElementById('uploadPlaceholder');
const uploadPreview = document.getElementById('uploadPreview');
const previewImage = document.getElementById('previewImage');
const removeImage = document.getElementById('removeImage');
const sendBtn = document.getElementById('sendBtn');
const sendBtnText = document.getElementById('sendBtnText');
const sendBtnLoader = document.getElementById('sendBtnLoader');
const progressSection = document.getElementById('progressSection');
const progressBar = document.getElementById('progressBar');
const sentCount = document.getElementById('sentCount');
const failedCount = document.getElementById('failedCount');
const totalCount = document.getElementById('totalCount');
const logContainer = document.getElementById('logContainer');

// Sheet Tab
const sheetUrl = document.getElementById('sheetUrl');
const sheetTabName = document.getElementById('sheetTabName');
const appsScriptUrl = document.getElementById('appsScriptUrl');
const phoneColumn = document.getElementById('phoneColumn');
const nameColumn = document.getElementById('nameColumn');
const statusColumn = document.getElementById('statusColumn');
const dateColumn = document.getElementById('dateColumn');
const sheetMessage = document.getElementById('sheetMessage');
const sheetImageInput = document.getElementById('sheetImageInput');
const sheetUploadArea = document.getElementById('sheetUploadArea');
const sheetUploadPlaceholder = document.getElementById('sheetUploadPlaceholder');
const sheetUploadPreview = document.getElementById('sheetUploadPreview');
const sheetPreviewImage = document.getElementById('sheetPreviewImage');
const sheetRemoveImage = document.getElementById('sheetRemoveImage');
const intervalSeconds = document.getElementById('intervalSeconds');
const startMonitorBtn = document.getElementById('startMonitorBtn');
const stopMonitorBtn = document.getElementById('stopMonitorBtn');
const sheetStatusSection = document.getElementById('sheetStatusSection');
const sheetProcessed = document.getElementById('sheetProcessed');
const sheetNewSent = document.getElementById('sheetNewSent');
const sheetFailed = document.getElementById('sheetFailed');
const sheetLogContainer = document.getElementById('sheetLogContainer');

// State
let uploadedImagePath = null;
let sheetImagePath = null;
let isSending = false;
let sheetNewSentCount = 0;
let sheetFailedCount = 0;
let monitorSession = null;
let monitorHeartbeatTimer = null;

// ===== Tabs =====
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(tab.dataset.tab).classList.add('active');
  });
});

// ===== Socket Events =====

socket.on('qr', (qrData) => {
  updateStatus('connecting', 'Scan QR Code');
  qrSection.style.display = 'block';
  connectedSection.style.display = 'none';
  qrContainer.innerHTML = `<img src="${qrData}" alt="QR Code">`;
});

socket.on('ready', (data) => {
  updateStatus('connected', 'Connected');
  qrSection.style.display = 'none';
  connectedSection.style.display = 'flex';
  if (data && data.profile) activeProfileName.textContent = data.profile;
  const numEl = document.getElementById('loggedInNumber');
  if (numEl) numEl.textContent = (data && data.number) ? '(' + data.number + ')' : '';
  updateSendButton();
  loadProfiles();
});

socket.on('disconnected', () => {
  updateStatus('disconnected', 'Disconnected');
  qrSection.style.display = 'block';
  connectedSection.style.display = 'none';
  profileSection.style.display = 'none';
  qrContainer.innerHTML = `<div class="qr-placeholder"><div class="spinner"></div><small>Generating QR code...</small></div>`;
  updateSendButton();
});

// Manual send events
socket.on('message_sent', (data) => {
  sentCount.textContent = parseInt(sentCount.textContent) + 1;
  updateProgress(data.index + 1, parseInt(totalCount.textContent));
  addLog(`✓ Sent to ${data.phone}`, 'success', logContainer);
});

socket.on('message_failed', (data) => {
  failedCount.textContent = parseInt(failedCount.textContent) + 1;
  updateProgress(data.index + 1, parseInt(totalCount.textContent));
  addLog(`✗ Failed: ${data.phone} - ${data.error}`, 'error', logContainer);
});

function updateProcessedTotal() {
  sheetProcessed.textContent = sheetNewSentCount + sheetFailedCount;
}

// Sheet monitor events
socket.on('sheet_message_sent', (data) => {
  sheetNewSentCount++;
  sheetNewSent.textContent = sheetNewSentCount;
  updateProcessedTotal();
  addLog(`✓ Sent to ${data.phone}${data.name ? ' (' + data.name + ')' : ''}`, 'success', sheetLogContainer);
});

socket.on('sheet_message_failed', (data) => {
  sheetFailedCount++;
  sheetFailed.textContent = sheetFailedCount;
  updateProcessedTotal();
  addLog(`✗ Failed: ${data.phone} - ${data.error}`, 'error', sheetLogContainer);
});

socket.on('sheet_batch_wait', (data) => {
  addLog(`⏳ Batch complete. Waiting ${data.seconds}s before next batch...`, 'success', sheetLogContainer);
});

socket.on('sheet_check_complete', (data) => {
  if (data.processed > 0) {
    addLog(`--- Check: ${data.sent} sent, ${data.failed} failed ---`, 'success', sheetLogContainer);
  }
});

socket.on('sheet_error', (data) => {
  addLog(`⚠ Error: ${data.error}`, 'error', sheetLogContainer);
});

socket.on('sheet_status', (data) => {
  if (data.isMonitoring) {
    sheetStatusSection.style.display = 'block';
    startMonitorBtn.textContent = 'Running...';
    startMonitorBtn.disabled = true;
    intervalSeconds.disabled = true;
  }
});

// ===== UI Functions =====

function updateStatus(state, text) {
  statusDot.className = 'status-dot ' + state;
  statusText.textContent = text;
}

function updateSendButton() {
  const hasNumbers = getPhoneList().length > 0;
  const hasContent = messageText.value.trim() || uploadedImagePath;
  const isConnected = statusDot.classList.contains('connected');
  sendBtn.disabled = !hasNumbers || !hasContent || !isConnected || isSending;
}

function getPhoneList() {
  return phoneNumbers.value.split('\n').map(n => n.trim()).filter(n => n.length > 0);
}

function updateProgress(current, total) {
  progressBar.style.width = Math.round((current / total) * 100) + '%';
}

function addLog(message, type, container) {
  const entry = document.createElement('div');
  entry.className = 'log-entry ' + type;
  entry.textContent = message;
  container.appendChild(entry);
  container.scrollTop = container.scrollHeight;
}

// ===== Manual Tab Events =====

phoneNumbers.addEventListener('input', () => {
  phoneCount.textContent = getPhoneList().length;
  updateSendButton();
});

messageText.addEventListener('input', updateSendButton);

uploadArea.addEventListener('click', () => imageInput.click());

imageInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    previewImage.src = ev.target.result;
    uploadPlaceholder.style.display = 'none';
    uploadPreview.style.display = 'block';
  };
  reader.readAsDataURL(file);

  const formData = new FormData();
  formData.append('image', file);
  try {
    const res = await apiFetch('/api/upload', { method: 'POST', body: formData });
    const data = await res.json();
    if (data.success) { uploadedImagePath = data.path; updateSendButton(); }
    else alert('Upload failed: ' + (data.error || 'Unknown'));
  } catch (err) { alert('Upload error: ' + err.message); }
});

removeImage.addEventListener('click', (e) => {
  e.stopPropagation();
  uploadedImagePath = null;
  imageInput.value = '';
  previewImage.src = '';
  uploadPlaceholder.style.display = 'block';
  uploadPreview.style.display = 'none';
  updateSendButton();
});

sendBtn.addEventListener('click', async () => {
  const numbers = getPhoneList();
  const message = messageText.value.trim();
  if (!numbers.length) return alert('Please enter phone numbers.');
  if (!message && !uploadedImagePath) return alert('Please provide a message or an image.');
  if (!confirm(`Send message to ${numbers.length} number(s)?`)) return;

  isSending = true;
  sendBtn.disabled = true;
  sendBtnText.textContent = 'Sending...';
  sendBtnLoader.style.display = 'inline-block';
  progressSection.style.display = 'block';
  progressBar.style.width = '0%';
  sentCount.textContent = '0';
  failedCount.textContent = '0';
  totalCount.textContent = numbers.length;
  logContainer.innerHTML = '';

  try {
    const res = await apiFetch('/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phoneNumbers: numbers, message, imagePath: uploadedImagePath })
    });
    const data = await res.json();
    if (data.success) {
      addLog(`--- Done! Sent: ${data.summary.sent}, Failed: ${data.summary.failed} ---`, 'success', logContainer);
    } else {
      addLog('Error: ' + (data.error || 'Unknown'), 'error', logContainer);
    }
  } catch (err) {
    addLog('Network error: ' + err.message, 'error', logContainer);
  }

  isSending = false;
  sendBtnText.textContent = 'Send Messages';
  sendBtnLoader.style.display = 'none';
  updateSendButton();
});

// ===== Sheet Tab Events =====

sheetUploadArea.addEventListener('click', () => sheetImageInput.click());

sheetImageInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    sheetPreviewImage.src = ev.target.result;
    sheetUploadPlaceholder.style.display = 'none';
    sheetUploadPreview.style.display = 'block';
  };
  reader.readAsDataURL(file);

  const formData = new FormData();
  formData.append('image', file);
  try {
    const res = await apiFetch('/api/upload', { method: 'POST', body: formData });
    const data = await res.json();
    if (data.success) sheetImagePath = data.path;
    else alert('Upload failed: ' + (data.error || 'Unknown'));
  } catch (err) { alert('Upload error: ' + err.message); }
});

sheetRemoveImage.addEventListener('click', (e) => {
  e.stopPropagation();
  sheetImagePath = null;
  sheetImageInput.value = '';
  sheetPreviewImage.src = '';
  sheetUploadPlaceholder.style.display = 'block';
  sheetUploadPreview.style.display = 'none';
});

function stopMonitorHeartbeat() {
  if (monitorHeartbeatTimer) clearInterval(monitorHeartbeatTimer);
  monitorHeartbeatTimer = null;
}

function startMonitorHeartbeat() {
  stopMonitorHeartbeat();
  monitorHeartbeatTimer = setInterval(async () => {
    if (!monitorSession) return;
    try {
      const res = await apiFetch('/api/sheet/heartbeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(monitorSession)
      });
      if (!res.ok) {
        monitorSession = null;
        stopMonitorHeartbeat();
      }
    } catch (err) {
      console.warn('Monitor heartbeat failed:', err.message);
    }
  }, 15000);
}

function sendMonitorStopBeacon(reason) {
  if (!monitorSession) return;
  const body = JSON.stringify({ ...monitorSession, reason });
  const blob = new Blob([body], { type: 'application/json' });
  navigator.sendBeacon(`${BACKEND_URL}/api/sheet/stop`, blob);
  monitorSession = null;
  stopMonitorHeartbeat();
}

window.addEventListener('pagehide', () => sendMonitorStopBeacon('frontend-closed'));

// Start monitoring
startMonitorBtn.addEventListener('click', async () => {
  const url = sheetUrl.value.trim();
  const phoneCol = phoneColumn.value.trim();
  const msg = sheetMessage.value.trim();

  if (!url) return alert('Please enter the Google Sheet link.');
  if (!phoneCol) return alert('Please enter the phone column name.');
  if (!msg) return alert('Please enter a message.');

  startMonitorBtn.disabled = true;
  startMonitorBtn.textContent = 'Starting...';

  try {
    const res = await apiFetch('/api/sheet/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sheetUrl: url,
        sheetTab: sheetTabName.value.trim(),
        appsScriptUrl: appsScriptUrl.value.trim(),
        phoneColumn: phoneCol,
        nameColumn: nameColumn.value.trim(),
        statusColumn: statusColumn.value.trim(),
        dateColumn: dateColumn.value.trim(),
        message: msg,
        imagePath: sheetImagePath || '',
        intervalSeconds: parseInt(intervalSeconds.value) || 30
      })
    });
    const data = await res.json();

    if (data.success) {
      monitorSession = data.sessionId && data.leaseToken
        ? { sessionId: data.sessionId, leaseToken: data.leaseToken }
        : null;
      if (monitorSession) startMonitorHeartbeat();
      sheetNewSentCount = 0;
      sheetFailedCount = 0;
      sheetProcessed.textContent = '0';
      sheetNewSent.textContent = '0';
      sheetFailed.textContent = '0';
      sheetLogContainer.innerHTML = '';
      addLog(`✓ Monitoring started! Rows with a blank status will receive a message.`, 'success', sheetLogContainer);
      if (data.headers) {
        addLog(`Columns found: ${data.headers.join(', ')}`, 'success', sheetLogContainer);
      }
      startMonitorBtn.textContent = 'Running...';
      intervalSeconds.disabled = true; // lock interval while running
    } else {
      alert('Error: ' + data.error);
      startMonitorBtn.disabled = false;
      startMonitorBtn.textContent = 'Start Monitoring';
    }
  } catch (err) {
    alert('Network error: ' + err.message);
    startMonitorBtn.disabled = false;
    startMonitorBtn.textContent = 'Start Monitoring';
  }
});

// Stop monitoring
stopMonitorBtn.addEventListener('click', async () => {
  try {
    await apiFetch('/api/sheet/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(monitorSession || {})
    });
    monitorSession = null;
    stopMonitorHeartbeat();
    sheetStatusSection.style.display = 'none';
    startMonitorBtn.disabled = false;
    startMonitorBtn.textContent = 'Start Monitoring';
    intervalSeconds.disabled = false; // unlock interval when stopped
    addLog('--- Monitoring stopped ---', 'error', sheetLogContainer);
  } catch (err) {
    alert('Error: ' + err.message);
  }
});

// Logout
logoutBtn.addEventListener('click', async () => {
  if (confirm('Log out from WhatsApp?')) {
    try { await apiFetch('/api/logout', { method: 'POST' }); }
    catch (err) { console.error(err); }
  }
});

// ===== Profile Management =====

switchProfileBtn.addEventListener('click', () => {
  profileSection.style.display = profileSection.style.display === 'none' ? 'block' : 'none';
  loadProfiles();
});

connectProfileBtn.addEventListener('click', async () => {
  const name = newProfileName.value.trim();
  if (!name) return alert('Please enter a profile name.');

  connectProfileBtn.disabled = true;
  connectProfileBtn.textContent = 'Connecting...';

  try {
    const res = await apiFetch('/api/profiles/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileName: name })
    });
    const data = await res.json();
    if (data.success) {
      activeProfileName.textContent = name;
      profileSection.style.display = 'none';
      newProfileName.value = '';
    } else {
      alert('Error: ' + data.error);
    }
  } catch (err) {
    alert('Error: ' + err.message);
  }
  connectProfileBtn.disabled = false;
  connectProfileBtn.textContent = 'Connect';
});

async function loadProfiles() {
  try {
    const res = await apiFetch('/api/profiles');
    const data = await res.json();
    activeProfileName.textContent = data.activeProfile;

    profileList.innerHTML = '';
    data.profiles.forEach(p => {
      const isActive = p === data.activeProfile;
      const item = document.createElement('div');
      item.className = 'profile-item' + (isActive ? ' active' : '');
      item.innerHTML = `
        <span>${p}</span>
        ${isActive ? '<small>(active)</small>' : `<button class="switch-btn" data-name="${p}">Switch</button>`}
        ${!isActive ? `<button data-delete="${p}">&times;</button>` : ''}
      `;
      profileList.appendChild(item);
    });

    // Switch buttons
    profileList.querySelectorAll('.switch-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const name = btn.dataset.name;
        const res = await apiFetch('/api/profiles/connect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ profileName: name })
        });
        const d = await res.json();
        if (d.success) loadProfiles();
      });
    });

    // Delete buttons
    profileList.querySelectorAll('[data-delete]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const name = btn.dataset.delete;
        if (!confirm(`Delete profile "${name}"?`)) return;
        await apiFetch('/api/profiles/' + encodeURIComponent(name), { method: 'DELETE' });
        loadProfiles();
      });
    });
  } catch (err) {
    console.error('Load profiles error:', err);
  }
}

// Initial status
apiFetch('/api/status').then(r => r.json()).then(data => {
  if (data.connected) {
    updateStatus('connected', 'Connected');
    qrSection.style.display = 'none';
    connectedSection.style.display = 'flex';
    const numEl = document.getElementById('loggedInNumber');
    if (numEl) numEl.textContent = data.number ? '(' + data.number + ')' : '';
    loadProfiles();
  }
}).catch(() => {});

apiFetch('/api/sheet/status').then(r => r.json()).then(data => {
  // Prefill saved values
  if (data.sheetUrl) sheetUrl.value = data.sheetUrl;
  if (data.sheetTab) sheetTabName.value = data.sheetTab;
  if (data.appsScriptUrl) appsScriptUrl.value = data.appsScriptUrl;
  if (data.phoneColumn) phoneColumn.value = data.phoneColumn;
  if (data.nameColumn) nameColumn.value = data.nameColumn;
  if (data.statusColumn) statusColumn.value = data.statusColumn;
  if (data.dateColumn) dateColumn.value = data.dateColumn;
  if (data.message) sheetMessage.value = data.message;
  if (data.intervalSeconds) intervalSeconds.value = data.intervalSeconds;

  // Prefill saved image (so it doesn't need re-uploading)
  if (data.imagePath) {
    sheetImagePath = data.imagePath;
    // Build a browser URL from the stored server path (uploads/xxxx.png -> /uploads/xxxx.png)
    const fileName = data.imagePath.replace(/\\/g, '/').split('/').pop();
    sheetPreviewImage.src = `${BACKEND_URL}/uploads/${fileName}`;
    sheetUploadPlaceholder.style.display = 'none';
    sheetUploadPreview.style.display = 'block';
  }

  if (data.isMonitoring) {
    if (data.sessionId && data.leaseToken) {
      monitorSession = { sessionId: data.sessionId, leaseToken: data.leaseToken };
      startMonitorHeartbeat();
    }
    sheetStatusSection.style.display = 'block';
    startMonitorBtn.textContent = 'Running...';
    startMonitorBtn.disabled = true;
    intervalSeconds.disabled = true;
  }
}).catch(() => {});
