/* Cloud message report — reads public.message_history from Supabase.
   Requires an authenticated session (same login as /cloud). */

const CFG = window.APP_CONFIG || {};
let supabase = null;
let currentRecords = [];
let workerNames = {}; // worker_id -> display_name

const fromDate = document.getElementById('fromDate');
const toDate = document.getElementById('toDate');
const statusFilter = document.getElementById('statusFilter');
const sourceFilter = document.getElementById('sourceFilter');
const deviceFilter = document.getElementById('deviceFilter');
const applyBtn = document.getElementById('applyBtn');
const resetBtn = document.getElementById('resetBtn');
const excelBtn = document.getElementById('excelBtn');
const printBtn = document.getElementById('printBtn');
const reportBody = document.getElementById('reportBody');
const emptyMsg = document.getElementById('emptyMsg');
const cardTotal = document.getElementById('cardTotal');
const cardSent = document.getElementById('cardSent');
const cardFailed = document.getElementById('cardFailed');

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text == null ? '' : text;
  return div.innerHTML;
}

function fmtDate(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' });
}
function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString('en-IN', { hour12: true });
}

async function loadDevices() {
  const { data } = await supabase.from('worker_instances').select('id, display_name');
  (data || []).forEach(w => { workerNames[w.id] = w.display_name || w.id; });
  deviceFilter.innerHTML = '<option value="all">All devices</option>' +
    (data || []).map(w => `<option value="${w.id}">${escapeHtml(w.display_name || w.id)}</option>`).join('');
}

async function loadHistory() {
  let query = supabase.from('message_history').select('*').order('timestamp', { ascending: false }).limit(1000);

  if (fromDate.value) query = query.gte('timestamp', fromDate.value + 'T00:00:00');
  if (toDate.value) query = query.lte('timestamp', toDate.value + 'T23:59:59');
  if (statusFilter.value !== 'all') query = query.ilike('status', statusFilter.value);
  if (sourceFilter.value !== 'all') query = query.ilike('source', sourceFilter.value);
  if (deviceFilter.value !== 'all') query = query.eq('worker_id', deviceFilter.value);

  const { data, error } = await query;
  if (error) { alert('Error loading history: ' + error.message); return; }

  currentRecords = data || [];
  const total = currentRecords.length;
  const sent = currentRecords.filter(r => (r.status || '').toLowerCase() === 'sent').length;
  const failed = total - sent;

  cardTotal.textContent = total;
  cardSent.textContent = sent;
  cardFailed.textContent = failed;
  document.getElementById('printTotal').textContent = total;
  document.getElementById('printSent').textContent = sent;
  document.getElementById('printFailed').textContent = failed;

  renderTable(currentRecords);
}

function renderTable(records) {
  reportBody.innerHTML = '';
  if (!records.length) { emptyMsg.style.display = 'block'; return; }
  emptyMsg.style.display = 'none';

  records.forEach((r, i) => {
    const statusClass = (r.status || '').toLowerCase() === 'sent' ? 'sent' : 'failed';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td>${fmtDate(r.timestamp)}</td>
      <td>${fmtTime(r.timestamp)}</td>
      <td>${escapeHtml(workerNames[r.worker_id] || r.worker_id || '')}</td>
      <td>${escapeHtml(r.sender || '')}</td>
      <td>${escapeHtml(r.name || '')}</td>
      <td>${escapeHtml(r.phone || '')}</td>
      <td><span class="badge-status ${statusClass}">${escapeHtml(r.status || '')}</span></td>
      <td>${escapeHtml(r.source || '')}</td>
      <td>${escapeHtml(r.error || '')}</td>
    `;
    reportBody.appendChild(tr);
  });
}

function downloadExcel() {
  if (!currentRecords.length) return alert('No data to download!');
  const genDate = new Date().toLocaleString('en-IN');
  let rows = '';
  currentRecords.forEach((r, i) => {
    const isSent = (r.status || '').toLowerCase() === 'sent';
    const color = isSent ? '#128C7E' : '#c0392b';
    const bg = i % 2 === 0 ? '#ffffff' : '#f7f9fb';
    rows += `<tr style="background:${bg}">
      <td style="text-align:center">${i + 1}</td>
      <td>${escapeHtml(fmtDate(r.timestamp))}</td>
      <td>${escapeHtml(fmtTime(r.timestamp))}</td>
      <td>${escapeHtml(workerNames[r.worker_id] || r.worker_id || '')}</td>
      <td style="mso-number-format:'\\@';">${escapeHtml(r.sender || '')}</td>
      <td>${escapeHtml(r.name || '')}</td>
      <td style="mso-number-format:'\\@';">${escapeHtml(r.phone || '')}</td>
      <td style="color:${color};font-weight:bold;text-align:center">${escapeHtml(r.status || '')}</td>
      <td style="text-align:center;text-transform:capitalize">${escapeHtml(r.source || '')}</td>
      <td>${escapeHtml(r.error || '')}</td>
    </tr>`;
  });
  const total = currentRecords.length;
  const sent = currentRecords.filter(r => (r.status || '').toLowerCase() === 'sent').length;
  const failed = total - sent;
  const html = `
  <html xmlns:x="urn:schemas-microsoft-com:office:excel">
  <head><meta charset="UTF-8">
  <!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet>
  <x:Name>Message Report</x:Name><x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions>
  </x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]-->
  </head>
  <body>
    <table border="0" cellspacing="0" cellpadding="6" style="font-family:Calibri,Arial,sans-serif;font-size:13px">
      <tr><td colspan="10" style="font-size:18px;font-weight:bold;color:#128C7E">WhatsApp Message Report</td></tr>
      <tr><td colspan="10" style="font-size:11px;color:#666">Generated: ${genDate}</td></tr>
      <tr><td colspan="10"></td></tr>
      <tr>
        <td style="font-weight:bold;background:#e8f8ef">Total: ${total}</td>
        <td style="font-weight:bold;background:#e8f8ef;color:#128C7E">Sent: ${sent}</td>
        <td style="font-weight:bold;background:#fdecea;color:#c0392b">Failed: ${failed}</td>
        <td colspan="7"></td>
      </tr>
      <tr><td colspan="10"></td></tr>
    </table>
    <table border="1" cellspacing="0" cellpadding="6" style="border-collapse:collapse;font-family:Calibri,Arial,sans-serif;font-size:12px;border-color:#ccc">
      <thead>
        <tr style="background:#128C7E;color:#ffffff;font-weight:bold">
          <th>Sr</th><th>Date</th><th>Time</th><th>Device</th><th>Sender Number</th><th>Name</th><th>Receiver Number</th><th>Status</th><th>Source</th><th>Remark</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </body></html>`;
  const blob = new Blob(['\ufeff' + html], { type: 'application/vnd.ms-excel;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `message_report_${stamp}.xls`;
  a.click();
  URL.revokeObjectURL(url);
}

function updatePrintMeta() {
  const parts = [];
  if (fromDate.value || toDate.value) parts.push(`Period: ${fromDate.value || 'start'} to ${toDate.value || 'today'}`);
  if (statusFilter.value !== 'all') parts.push(`Status: ${statusFilter.value}`);
  if (sourceFilter.value !== 'all') parts.push(`Source: ${sourceFilter.value}`);
  if (deviceFilter.value !== 'all') parts.push(`Device: ${workerNames[deviceFilter.value] || deviceFilter.value}`);
  parts.push(`Total: ${currentRecords.length}`);
  parts.push(`Printed: ${new Date().toLocaleString('en-IN')}`);
  document.getElementById('printMeta').textContent = parts.join('  |  ');
}

applyBtn.addEventListener('click', loadHistory);
statusFilter.addEventListener('change', loadHistory);
sourceFilter.addEventListener('change', loadHistory);
deviceFilter.addEventListener('change', loadHistory);

resetBtn.addEventListener('click', () => {
  fromDate.value = '';
  toDate.value = '';
  statusFilter.value = 'all';
  sourceFilter.value = 'all';
  deviceFilter.value = 'all';
  loadHistory();
});

excelBtn.addEventListener('click', downloadExcel);

printBtn.addEventListener('click', () => {
  if (!currentRecords.length) return alert('No data to print!');
  updatePrintMeta();
  setTimeout(() => window.print(), 100);
});

document.getElementById('closeReportBtn').addEventListener('click', () => {
  window.location.href = 'cloud.html';
});

async function boot() {
  if (!CFG.supabaseUrl || !CFG.supabaseAnonKey || !window.supabase) {
    document.body.innerHTML = '<p style="padding:20px;color:#c0392b;">Supabase config missing.</p>';
    return;
  }
  supabase = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true }
  });
  const { data } = await supabase.auth.getSession();
  if (!data.session) {
    window.location.href = 'cloud.html';
    return;
  }
  await loadDevices();
  await loadHistory();
}

boot().catch(err => {
  console.error('Report boot error:', err);
  alert('Startup error: ' + err.message);
});
