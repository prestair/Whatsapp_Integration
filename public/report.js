const fromDate = document.getElementById('fromDate');
const toDate = document.getElementById('toDate');
const statusFilter = document.getElementById('statusFilter');
const sourceFilter = document.getElementById('sourceFilter');
const applyBtn = document.getElementById('applyBtn');
const resetBtn = document.getElementById('resetBtn');
const excelBtn = document.getElementById('excelBtn');
const printBtn = document.getElementById('printBtn');
const clearBtn = document.getElementById('clearBtn');
const reportBody = document.getElementById('reportBody');
const emptyMsg = document.getElementById('emptyMsg');
const cardTotal = document.getElementById('cardTotal');
const cardSent = document.getElementById('cardSent');
const cardFailed = document.getElementById('cardFailed');

let currentRecords = [];

async function loadHistory() {
  const params = new URLSearchParams();
  if (fromDate.value) params.append('from', fromDate.value);
  if (toDate.value) params.append('to', toDate.value);
  if (statusFilter.value) params.append('status', statusFilter.value);
  if (sourceFilter.value) params.append('source', sourceFilter.value);

  try {
    const res = await fetch('/api/history?' + params.toString());
    const data = await res.json();
    currentRecords = data.records || [];

    cardTotal.textContent = data.total || 0;
    cardSent.textContent = data.sent || 0;
    cardFailed.textContent = data.failed || 0;

    // print summary
    const pt = document.getElementById('printTotal');
    const ps = document.getElementById('printSent');
    const pf = document.getElementById('printFailed');
    if (pt) pt.textContent = data.total || 0;
    if (ps) ps.textContent = data.sent || 0;
    if (pf) pf.textContent = data.failed || 0;

    renderTable(currentRecords);
  } catch (err) {
    alert('Error loading history: ' + err.message);
  }
}

function renderTable(records) {
  reportBody.innerHTML = '';
  if (!records.length) {
    emptyMsg.style.display = 'block';
    return;
  }
  emptyMsg.style.display = 'none';

  records.forEach((r, i) => {
    const tr = document.createElement('tr');
    const statusClass = (r.status || '').toLowerCase() === 'sent' ? 'sent' : 'failed';
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td>${r.date || ''}</td>
      <td>${r.time || ''}</td>
      <td>${escapeHtml(r.sender || '')}</td>
      <td>${escapeHtml(r.name || '')}</td>
      <td>${escapeHtml(r.phone || '')}</td>
      <td><span class="badge-status ${statusClass}">${r.status || ''}</span></td>
      <td>${r.source || ''}</td>
      <td>${escapeHtml(r.error || '')}</td>
    `;
    reportBody.appendChild(tr);
  });
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Excel download - styled HTML table that Excel opens with formatting
function downloadExcel() {
  if (!currentRecords.length) {
    alert('No data to download!');
    return;
  }

  const total = currentRecords.length;
  const sent = currentRecords.filter(r => (r.status || '').toLowerCase() === 'sent').length;
  const failed = total - sent;
  const genDate = new Date().toLocaleString('en-IN');

  let rows = '';
  currentRecords.forEach((r, i) => {
    const isSent = (r.status || '').toLowerCase() === 'sent';
    const statusColor = isSent ? '#128C7E' : '#c0392b';
    const bg = i % 2 === 0 ? '#ffffff' : '#f7f9fb';
    rows += `<tr style="background:${bg}">
      <td style="text-align:center">${i + 1}</td>
      <td>${escapeHtml(r.date || '')}</td>
      <td>${escapeHtml(r.time || '')}</td>
      <td style="mso-number-format:'\\@';">${escapeHtml(r.sender || '')}</td>
      <td>${escapeHtml(r.name || '')}</td>
      <td style="mso-number-format:'\\@';">${escapeHtml(r.phone || '')}</td>
      <td style="color:${statusColor};font-weight:bold;text-align:center">${escapeHtml(r.status || '')}</td>
      <td style="text-align:center;text-transform:capitalize">${escapeHtml(r.source || '')}</td>
      <td>${escapeHtml(r.error || '')}</td>
    </tr>`;
  });

  const html = `
  <html xmlns:x="urn:schemas-microsoft-com:office:excel">
  <head><meta charset="UTF-8">
  <!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet>
  <x:Name>Message Report</x:Name><x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions>
  </x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]-->
  </head>
  <body>
    <table border="0" cellspacing="0" cellpadding="6" style="font-family:Calibri,Arial,sans-serif;font-size:13px">
      <tr><td colspan="9" style="font-size:18px;font-weight:bold;color:#128C7E">WhatsApp Message Report</td></tr>
      <tr><td colspan="9" style="font-size:11px;color:#666">Generated: ${genDate}</td></tr>
      <tr><td colspan="9"></td></tr>
      <tr>
        <td style="font-weight:bold;background:#e8f8ef">Total: ${total}</td>
        <td style="font-weight:bold;background:#e8f8ef;color:#128C7E">Sent: ${sent}</td>
        <td style="font-weight:bold;background:#fdecea;color:#c0392b">Failed: ${failed}</td>
        <td colspan="6"></td>
      </tr>
      <tr><td colspan="9"></td></tr>
    </table>
    <table border="1" cellspacing="0" cellpadding="6" style="border-collapse:collapse;font-family:Calibri,Arial,sans-serif;font-size:12px;border-color:#ccc">
      <thead>
        <tr style="background:#128C7E;color:#ffffff;font-weight:bold">
          <th>Sr</th><th>Date</th><th>Time</th><th>Sender</th><th>Name</th><th>Phone</th><th>Status</th><th>Source</th><th>Remark</th>
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

// Update the print-only header meta (filter info + count)
function updatePrintMeta() {
  const parts = [];
  if (fromDate.value || toDate.value) {
    parts.push(`Period: ${fromDate.value || 'start'} to ${toDate.value || 'today'}`);
  }
  if (statusFilter.value !== 'all') parts.push(`Status: ${statusFilter.value}`);
  if (sourceFilter.value !== 'all') parts.push(`Source: ${sourceFilter.value}`);
  parts.push(`Total: ${currentRecords.length}`);
  parts.push(`Printed: ${new Date().toLocaleString('en-IN')}`);
  document.getElementById('printMeta').textContent = parts.join('  |  ');
}

// Event listeners
applyBtn.addEventListener('click', loadHistory);
statusFilter.addEventListener('change', loadHistory);
sourceFilter.addEventListener('change', loadHistory);

resetBtn.addEventListener('click', () => {
  fromDate.value = '';
  toDate.value = '';
  statusFilter.value = 'all';
  sourceFilter.value = 'all';
  loadHistory();
});

excelBtn.addEventListener('click', downloadExcel);

// ===== Print with Page Setup =====
const pageSetupModal = document.getElementById('pageSetupModal');
const orientationSel = document.getElementById('orientationSel');
const pageSizeSel = document.getElementById('pageSizeSel');
const marginSel = document.getElementById('marginSel');
const cancelSetupBtn = document.getElementById('cancelSetupBtn');
const doPrintBtn = document.getElementById('doPrintBtn');

// Dynamic @page style element
let pageStyleEl = document.createElement('style');
document.head.appendChild(pageStyleEl);

printBtn.addEventListener('click', () => {
  if (!currentRecords.length) {
    alert('No data to print!');
    return;
  }
  pageSetupModal.classList.add('show');
});

cancelSetupBtn.addEventListener('click', () => {
  pageSetupModal.classList.remove('show');
});

pageSetupModal.addEventListener('click', (e) => {
  if (e.target === pageSetupModal) pageSetupModal.classList.remove('show');
});

doPrintBtn.addEventListener('click', () => {
  // Apply chosen page setup
  const size = pageSizeSel.value;
  const orientation = orientationSel.value;
  const margin = marginSel.value;
  pageStyleEl.textContent = `@page { size: ${size} ${orientation}; margin: ${margin}; }`;

  updatePrintMeta();
  pageSetupModal.classList.remove('show');

  // Give the browser a moment to apply styles, then open print preview
  setTimeout(() => window.print(), 200);
});

if (clearBtn) {
  clearBtn.addEventListener('click', async () => {
    if (!confirm('Delete the entire message history?\n\nThis data cannot be restored.')) return;
    try {
      await fetch('/api/history', { method: 'DELETE' });
      loadHistory();
    } catch (err) {
      alert('Error: ' + err.message);
    }
  });
}

// Delete history before a chosen date
const deleteBeforeDate = document.getElementById('deleteBeforeDate');
const deleteBeforeBtn = document.getElementById('deleteBeforeBtn');

deleteBeforeBtn.addEventListener('click', async () => {
  const date = deleteBeforeDate.value;
  if (!date) {
    alert('Please select a date first.');
    return;
  }

  const readable = new Date(date + 'T00:00:00').toLocaleDateString('en-IN', {
    day: '2-digit', month: 'long', year: 'numeric'
  });

  const confirmed = confirm(
    `All records before ${readable} will be permanently deleted.\n\n` +
    `This data cannot be restored. Do you want to continue?`
  );
  if (!confirmed) return;

  try {
    const res = await fetch('/api/history/before?date=' + encodeURIComponent(date), { method: 'DELETE' });
    const data = await res.json();
    if (data.success) {
      alert(`${data.deleted} record(s) deleted. ${data.remaining} record(s) remaining.`);
      deleteBeforeDate.value = '';
      loadHistory();
    } else {
      alert('Error: ' + (data.error || 'Unknown error'));
    }
  } catch (err) {
    alert('Error: ' + err.message);
  }
});

// Close button (X) in the ribbon
const closeReportBtn = document.getElementById('closeReportBtn');
if (closeReportBtn) {
  closeReportBtn.addEventListener('click', () => {
    if (window.self !== window.top) {
      // Inside dashboard modal -> ask parent to close
      window.parent.postMessage('closeReport', '*');
    } else {
      // Opened directly -> go to dashboard
      window.location.href = '/';
    }
  });
}

// Initial load
loadHistory();
