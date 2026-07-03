const express = require('express');
const { google } = require('googleapis');

const app = express();
app.use(express.json({ limit: '2mb' }));

const PORT = process.env.PORT || 3000;

const SHEET_ID = process.env.SHEET_ID || '1wkP2CQZhzxeLNHDeQYdzGZwYHkfK-D1_qgBAVsO91qE';
const SHEET_NAME = process.env.SHEET_NAME || 'site';
const CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const PRIVATE_KEY = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

const COLUMNS = [
  'No', 'Address', 'Google Map Link', 'Picture', 'Size', 'Rate',
  'Lease Term', 'Lease Type', 'Frontage', 'Store Format', 'Nearest PG',
  'Competitors', 'Visited', 'Status', 'Remarks'
];

let cachedSheetGid = null;

function getSheetsClient() {
  if (!CLIENT_EMAIL || !PRIVATE_KEY) {
    throw new Error('Missing GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY environment variables');
  }
  const auth = new google.auth.GoogleAuth({
    credentials: { client_email: CLIENT_EMAIL, private_key: PRIVATE_KEY },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function getSheetGid(sheets) {
  if (cachedSheetGid !== null) return cachedSheetGid;
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: SHEET_ID,
    fields: 'sheets.properties',
  });
  const sheet = (meta.data.sheets || []).find((s) => s.properties.title === SHEET_NAME);
  if (!sheet) throw new Error('Sheet tab "' + SHEET_NAME + '" not found');
  cachedSheetGid = sheet.properties.sheetId;
  return cachedSheetGid;
}

function driveDirectUrl(url) {
  if (!url) return '';
  const trimmed = url.trim();
  if (trimmed.indexOf('data:') === 0) return trimmed;
  let match = trimmed.match(/drive\.google\.com\/file\/d\/([^/]+)/);
  if (match) return 'https://drive.google.com/uc?export=view&id=' + match[1];
  match = trimmed.match(/[?&]id=([^&]+)/);
  if (match && trimmed.includes('drive.google.com')) {
    return 'https://drive.google.com/uc?export=view&id=' + match[1];
  }
  return trimmed;
}

function recordToRow(rec) {
  return COLUMNS.map((c) => (rec[c] !== undefined && rec[c] !== null ? String(rec[c]) : ''));
}

app.get('/api/data', async (req, res) => {
  try {
    const sheets = getSheetsClient();
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: SHEET_NAME + '!A2:O',
    });
    const rows = result.data.values || [];
    const records = rows
      .filter((r) => r.some((c) => c && c.toString().trim() !== ''))
      .map((r, idx) => {
        const rec = {};
        COLUMNS.forEach((col, i) => {
          rec[col] = (r[i] || '').toString();
        });
        rec.Picture = driveDirectUrl(rec.Picture);
        rec._row = idx + 2;
        return rec;
      });
    res.json(records);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/data', async (req, res) => {
  try {
    const sheets = getSheetsClient();
    const result = await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: SHEET_NAME + '!A:O',
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [recordToRow(req.body || {})] },
    });
    const updatedRange = result.data.updates && result.data.updates.updatedRange;
    const m = updatedRange && updatedRange.match(/![A-Z]+(\d+)/);
    res.json({ success: true, row: m ? parseInt(m[1], 10) : null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/data/:row', async (req, res) => {
  try {
    const rowNum = parseInt(req.params.row, 10);
    if (!rowNum || rowNum < 2) return res.status(400).json({ error: 'Invalid row' });
    const sheets = getSheetsClient();
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: SHEET_NAME + '!A' + rowNum + ':O' + rowNum,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [recordToRow(req.body || {})] },
    });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/data/:row', async (req, res) => {
  try {
    const rowNum = parseInt(req.params.row, 10);
    if (!rowNum || rowNum < 2) return res.status(400).json({ error: 'Invalid row' });
    const sheets = getSheetsClient();
    const gid = await getSheetGid(sheets);
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: {
        requests: [{
          deleteDimension: {
            range: { sheetId: gid, dimension: 'ROWS', startIndex: rowNum - 1, endIndex: rowNum },
          },
        }],
      },
    });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => {
  res.type('html').send(HTML_PAGE);
});

app.listen(PORT, () => {
  console.log('CaMaNaVa Site Acquisition running on port ' + PORT);
});

const HTML_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>CaMaNaVa Site Acquisition</title>
<style>
  :root {
    --primary: #1a5d3a;
    --primary-light: #e8f3ec;
    --accent: #2563eb;
    --border: #d8dfe3;
    --text: #1f2937;
    --muted: #6b7280;
    --bg: #f5f7f8;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
    background: var(--bg);
    color: var(--text);
  }
  header {
    background: var(--primary);
    color: #fff;
    padding: 16px 24px;
  }
  header h1 { margin: 0; font-size: 20px; }
  header p { margin: 4px 0 0; font-size: 13px; opacity: 0.85; }
  nav.tabs {
    display: flex;
    background: #fff;
    border-bottom: 1px solid var(--border);
    padding: 0 24px;
  }
  nav.tabs button {
    border: none;
    background: none;
    padding: 14px 18px;
    font-size: 14px;
    cursor: pointer;
    color: var(--muted);
    border-bottom: 3px solid transparent;
  }
  nav.tabs button.active {
    color: var(--primary);
    border-bottom-color: var(--primary);
    font-weight: 600;
  }
  main { padding: 20px 24px; max-width: 1200px; margin: 0 auto; }
  .panel { display: none; }
  .panel.active { display: block; }

  /* Site Proposal view */
  .proposal-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
  .proposal-head h2 { margin: 0; font-size: 18px; }
  .btn { border: none; padding: 9px 16px; border-radius: 6px; cursor: pointer; font-size: 14px; }
  .btn-primary { background: var(--primary); color: #fff; }
  .btn-secondary { background: #fff; color: var(--text); border: 1px solid var(--border); }
  .btn-danger { background: #dc2626; color: #fff; }
  .btn-sm { padding: 5px 10px; font-size: 12px; }
  .table-wrap { overflow-x: auto; background: #fff; border: 1px solid var(--border); border-radius: 8px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { padding: 8px 10px; border-bottom: 1px solid var(--border); text-align: left; white-space: nowrap; }
  th { background: var(--primary-light); color: var(--primary); position: sticky; top: 0; }
  tr:hover td { background: #fafafa; }
  .badge { padding: 2px 8px; border-radius: 12px; font-size: 12px; font-weight: 600; }
  .badge-yes { background: #dcfce7; color: #166534; }
  .badge-no { background: #fee2e2; color: #991b1b; }
  .row-actions { display: flex; gap: 6px; }

  /* Carousel view */
  .carousel-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
  .carousel-head h2 { margin: 0; font-size: 18px; }
  .nav-btns { display: flex; gap: 8px; align-items: center; }
  .nav-btns button {
    background: var(--primary);
    color: #fff;
    border: none;
    padding: 8px 16px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 14px;
  }
  .nav-btns button:disabled { background: #a3a3a3; cursor: not-allowed; }
  .counter { font-size: 13px; color: var(--muted); min-width: 70px; text-align: center; }

  .card { background: #fff; border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
  .card-top { display: flex; flex-wrap: wrap; }
  .card-photo {
    flex: 1 1 380px;
    background: #eef1f2;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 320px;
  }
  .card-photo img { width: 100%; height: 100%; object-fit: cover; min-height: 320px; }
  .card-photo .no-photo { color: var(--muted); font-size: 14px; }
  .card-info { flex: 1 1 380px; padding: 20px 24px; }
  .card-info h3 { margin: 0 0 4px; font-size: 20px; color: var(--primary); }
  .card-info .address { color: var(--muted); margin-bottom: 16px; font-size: 14px; }
  .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 20px; }
  .info-item label { display: block; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin-bottom: 2px; }
  .info-item div.val { font-size: 14px; }
  .info-item.full { grid-column: 1 / -1; }
  .map-link {
    display: inline-block;
    margin-top: 16px;
    padding: 8px 14px;
    background: var(--accent);
    color: #fff;
    text-decoration: none;
    border-radius: 6px;
    font-size: 13px;
  }
  .map-link.disabled { background: #a3a3a3; pointer-events: none; }
  .card-map { border-top: 1px solid var(--border); }
  .card-map iframe { width: 100%; height: 340px; border: none; display: block; }
  .card-map .no-map { padding: 20px 24px; color: var(--muted); font-size: 14px; }
  .status-msg { padding: 40px; text-align: center; color: var(--muted); }

  /* Form modal */
  .overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,0.45);
    display: flex; align-items: flex-start; justify-content: center;
    padding: 30px 16px; overflow-y: auto; z-index: 50;
  }
  .overlay.hidden { display: none; }
  .modal { background: #fff; border-radius: 10px; width: 100%; max-width: 640px; padding: 24px; }
  .modal h3 { margin: 0 0 16px; color: var(--primary); }
  .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px 16px; }
  .form-item { display: flex; flex-direction: column; gap: 4px; }
  .form-item.full { grid-column: 1 / -1; }
  .form-item label { font-size: 12px; font-weight: 600; color: var(--muted); }
  .form-item input, .form-item select, .form-item textarea {
    padding: 8px 10px; border: 1px solid var(--border); border-radius: 6px; font-size: 14px; font-family: inherit;
  }
  .form-item textarea { resize: vertical; min-height: 60px; }
  .picture-input { display: flex; flex-direction: column; gap: 8px; }
  .picture-preview { max-width: 100%; max-height: 160px; border-radius: 6px; border: 1px solid var(--border); display: none; }
  .picture-btns { display: flex; gap: 8px; flex-wrap: wrap; }
  .file-btn {
    display: inline-block; padding: 7px 12px; border: 1px solid var(--border); border-radius: 6px;
    background: #fff; font-size: 12px; cursor: pointer; color: var(--text);
  }
  .picture-hint { font-size: 11px; color: var(--muted); }
  .form-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px; }
  .form-error { color: #dc2626; font-size: 13px; margin-top: 10px; display: none; }
</style>
</head>
<body>
  <header>
    <h1>CaMaNaVa Site Acquisition</h1>
    <p>Site acquisition monitoring</p>
  </header>
  <nav class="tabs">
    <button id="tab-btn-table" class="active">Site Proposal</button>
    <button id="tab-btn-carousel">Carousel View</button>
  </nav>
  <main>
    <section id="panel-table" class="panel active">
      <div class="proposal-head">
        <h2>Site Proposal</h2>
        <button class="btn btn-primary" id="btn-add-site">+ Add New Site</button>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr id="table-head"></tr></thead>
          <tbody id="table-body"><tr><td class="status-msg">Loading...</td></tr></tbody>
        </table>
      </div>
    </section>

    <section id="panel-carousel" class="panel">
      <div class="carousel-head">
        <h2 id="carousel-title">Site</h2>
        <div class="nav-btns">
          <button id="btn-prev">&#8592; Prev</button>
          <span class="counter" id="carousel-counter">0 / 0</span>
          <button id="btn-next">Next &#8594;</button>
        </div>
      </div>
      <div class="card" id="carousel-card">
        <div class="status-msg">Loading...</div>
      </div>
    </section>
  </main>

  <div class="overlay hidden" id="form-overlay">
    <div class="modal">
      <h3 id="form-title">Add Site</h3>
      <form id="site-form">
        <div class="form-grid">
          <div class="form-item"><label>No</label><input name="No" type="text" /></div>
          <div class="form-item">
            <label>Visited</label>
            <select name="Visited">
              <option value="">-</option>
              <option value="Yes">Yes</option>
              <option value="No">No</option>
            </select>
          </div>
          <div class="form-item full"><label>Address</label><input name="Address" type="text" /></div>
          <div class="form-item full"><label>Google Map Link</label><input name="Google Map Link" type="text" placeholder="Paste Google Maps link" /></div>
          <div class="form-item full">
            <label>Picture</label>
            <div class="picture-input">
              <img class="picture-preview" id="picture-preview" />
              <input name="Picture" id="picture-url" type="text" placeholder="Paste an image URL, or use a button below" />
              <div class="picture-btns">
                <label class="file-btn">Take Photo<input type="file" accept="image/*" capture="environment" id="picture-camera" hidden /></label>
                <label class="file-btn">Choose from Storage<input type="file" accept="image/*" id="picture-file" hidden /></label>
              </div>
              <div class="picture-hint" id="picture-hint"></div>
            </div>
          </div>
          <div class="form-item"><label>Size</label><input name="Size" type="text" /></div>
          <div class="form-item"><label>Rate</label><input name="Rate" type="text" /></div>
          <div class="form-item"><label>Lease Term</label><input name="Lease Term" type="text" /></div>
          <div class="form-item"><label>Lease Type</label><input name="Lease Type" type="text" /></div>
          <div class="form-item"><label>Frontage</label><input name="Frontage" type="text" /></div>
          <div class="form-item"><label>Store Format</label><input name="Store Format" type="text" /></div>
          <div class="form-item"><label>Nearest PG</label><input name="Nearest PG" type="text" /></div>
          <div class="form-item"><label>Competitors</label><input name="Competitors" type="text" /></div>
          <div class="form-item full"><label>Status</label><input name="Status" type="text" /></div>
          <div class="form-item full"><label>Remarks</label><textarea name="Remarks"></textarea></div>
        </div>
        <div class="form-error" id="form-error"></div>
        <div class="form-actions">
          <button type="button" class="btn btn-secondary" id="form-cancel">Cancel</button>
          <button type="submit" class="btn btn-primary" id="form-save">Save</button>
        </div>
      </form>
    </div>
  </div>

<script>
(function () {
  var COLUMNS = ['No','Address','Google Map Link','Picture','Size','Rate','Lease Term','Lease Type','Frontage','Store Format','Nearest PG','Competitors','Visited','Status','Remarks'];
  var data = [];
  var currentIndex = 0;
  var editingRow = null;
  var MAX_CELL_CHARS = 45000;

  var tabBtnTable = document.getElementById('tab-btn-table');
  var tabBtnCarousel = document.getElementById('tab-btn-carousel');
  var panelTable = document.getElementById('panel-table');
  var panelCarousel = document.getElementById('panel-carousel');

  tabBtnTable.addEventListener('click', function () { switchTab('table'); });
  tabBtnCarousel.addEventListener('click', function () { switchTab('carousel'); });

  function switchTab(name) {
    var isTable = name === 'table';
    tabBtnTable.classList.toggle('active', isTable);
    tabBtnCarousel.classList.toggle('active', !isTable);
    panelTable.classList.toggle('active', isTable);
    panelCarousel.classList.toggle('active', !isTable);
  }

  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function loadData() {
    return fetch('/api/data')
      .then(function (r) {
        if (!r.ok) return r.json().then(function (e) { throw new Error(e.error || 'Request failed'); });
        return r.json();
      })
      .then(function (records) {
        data = records;
        renderTable();
        renderCarousel();
      })
      .catch(function (err) {
        var msg = '<div class="status-msg">Failed to load data: ' + escapeHtml(err.message) + '</div>';
        document.getElementById('table-body').innerHTML = '<tr><td colspan="' + (COLUMNS.length + 1) + '">' + msg + '</td></tr>';
        document.getElementById('carousel-card').innerHTML = msg;
      });
  }

  function renderTable() {
    var head = document.getElementById('table-head');
    var body = document.getElementById('table-body');
    head.innerHTML = '';
    COLUMNS.forEach(function (col) {
      var th = document.createElement('th');
      th.textContent = col;
      head.appendChild(th);
    });
    var thActions = document.createElement('th');
    thActions.textContent = 'Actions';
    head.appendChild(thActions);

    if (!data.length) {
      body.innerHTML = '<tr><td class="status-msg" colspan="' + (COLUMNS.length + 1) + '">No records found.</td></tr>';
      return;
    }

    body.innerHTML = data.map(function (rec) {
      var cells = COLUMNS.map(function (col) {
        if (col === 'Visited') {
          var v = (rec[col] || '').toLowerCase();
          if (v === 'yes') return '<td><span class="badge badge-yes">Yes</span></td>';
          if (v === 'no') return '<td><span class="badge badge-no">No</span></td>';
          return '<td></td>';
        }
        if (col === 'Picture') {
          return '<td>' + (rec[col] ? '<a href="' + escapeHtml(rec[col]) + '" target="_blank" rel="noopener">photo</a>' : '') + '</td>';
        }
        if (col === 'Google Map Link') {
          return '<td>' + (rec[col] ? '<a href="' + escapeHtml(rec[col]) + '" target="_blank" rel="noopener">map</a>' : '') + '</td>';
        }
        return '<td>' + escapeHtml(rec[col]) + '</td>';
      }).join('');
      var actions = '<td class="row-actions">' +
        '<button class="btn btn-secondary btn-sm" data-action="edit" data-row="' + rec._row + '">Edit</button>' +
        '<button class="btn btn-danger btn-sm" data-action="delete" data-row="' + rec._row + '">Delete</button>' +
        '</td>';
      return '<tr>' + cells + actions + '</tr>';
    }).join('');
  }

  document.getElementById('table-body').addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-action]');
    if (!btn) return;
    var row = parseInt(btn.getAttribute('data-row'), 10);
    if (btn.getAttribute('data-action') === 'edit') {
      var rec = data.find(function (d) { return d._row === row; });
      if (rec) openForm(rec);
    } else if (btn.getAttribute('data-action') === 'delete') {
      deleteRecord(row);
    }
  });

  document.getElementById('btn-add-site').addEventListener('click', function () {
    openForm(null);
  });

  function nextNo() {
    var max = 0;
    data.forEach(function (d) {
      var n = parseInt(d['No'], 10);
      if (!isNaN(n) && n > max) max = n;
    });
    return String(max + 1);
  }

  function openForm(rec) {
    editingRow = rec ? rec._row : null;
    document.getElementById('form-title').textContent = rec ? 'Edit Site' : 'Add Site';
    document.getElementById('form-error').style.display = 'none';
    var form = document.getElementById('site-form');
    form.reset();
    COLUMNS.forEach(function (col) {
      var input = form.elements[col];
      if (input) input.value = rec ? (rec[col] || '') : '';
    });
    if (!rec) form.elements['No'].value = nextNo();
    updatePicturePreview(rec ? rec['Picture'] : '');
    document.getElementById('form-overlay').classList.remove('hidden');
  }

  function closeForm() {
    document.getElementById('form-overlay').classList.add('hidden');
  }

  document.getElementById('form-cancel').addEventListener('click', closeForm);

  function updatePicturePreview(url) {
    var img = document.getElementById('picture-preview');
    if (url) {
      img.src = url;
      img.style.display = 'block';
    } else {
      img.removeAttribute('src');
      img.style.display = 'none';
    }
  }

  document.getElementById('picture-url').addEventListener('input', function (e) {
    updatePicturePreview(e.target.value);
  });

  function compressImageFile(file) {
    var attempts = [
      { maxDim: 900, quality: 0.7 },
      { maxDim: 600, quality: 0.5 },
      { maxDim: 400, quality: 0.35 },
      { maxDim: 260, quality: 0.3 },
    ];
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error('Could not read file')); };
      reader.onload = function () {
        var img = new Image();
        img.onerror = function () { reject(new Error('Could not read image')); };
        img.onload = function () {
          var attemptIndex = 0;
          function tryAttempt() {
            var cfg = attempts[attemptIndex];
            var scale = Math.min(1, cfg.maxDim / Math.max(img.width, img.height));
            var canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(img.width * scale));
            canvas.height = Math.max(1, Math.round(img.height * scale));
            var ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            var dataUrl = canvas.toDataURL('image/jpeg', cfg.quality);
            if (dataUrl.length <= MAX_CELL_CHARS || attemptIndex === attempts.length - 1) {
              resolve({ dataUrl: dataUrl, tooLarge: dataUrl.length > MAX_CELL_CHARS });
            } else {
              attemptIndex += 1;
              tryAttempt();
            }
          }
          tryAttempt();
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function handleFileInput(inputEl) {
    inputEl.addEventListener('change', function () {
      var file = inputEl.files && inputEl.files[0];
      if (!file) return;
      var hint = document.getElementById('picture-hint');
      hint.textContent = 'Processing photo...';
      compressImageFile(file).then(function (result) {
        document.getElementById('picture-url').value = result.dataUrl;
        updatePicturePreview(result.dataUrl);
        hint.textContent = result.tooLarge
          ? 'Photo compressed but is still large; it may fail to save. Try a smaller photo.'
          : 'Photo attached.';
      }).catch(function (err) {
        hint.textContent = 'Failed to process photo: ' + err.message;
      });
      inputEl.value = '';
    });
  }
  handleFileInput(document.getElementById('picture-camera'));
  handleFileInput(document.getElementById('picture-file'));

  function deleteRecord(row) {
    if (!confirm('Delete this site record? This cannot be undone.')) return;
    fetch('/api/data/' + row, { method: 'DELETE' })
      .then(function (r) {
        if (!r.ok) return r.json().then(function (e) { throw new Error(e.error || 'Delete failed'); });
        return r.json();
      })
      .then(function () { loadData(); })
      .catch(function (err) { alert('Delete failed: ' + err.message); });
  }

  document.getElementById('site-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var form = e.target;
    var record = {};
    COLUMNS.forEach(function (col) {
      record[col] = form.elements[col] ? form.elements[col].value : '';
    });
    var errorEl = document.getElementById('form-error');
    errorEl.style.display = 'none';
    var saveBtn = document.getElementById('form-save');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';

    var request = editingRow
      ? fetch('/api/data/' + editingRow, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(record),
        })
      : fetch('/api/data', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(record),
        });

    request
      .then(function (r) {
        if (!r.ok) return r.json().then(function (e) { throw new Error(e.error || 'Save failed'); });
        return r.json();
      })
      .then(function () {
        closeForm();
        return loadData();
      })
      .catch(function (err) {
        errorEl.textContent = err.message;
        errorEl.style.display = 'block';
      })
      .finally(function () {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save';
      });
  });

  function mapEmbedSrc(rec) {
    var address = rec['Address'];
    if (address) {
      return 'https://www.google.com/maps?q=' + encodeURIComponent(address) + '&output=embed';
    }
    var link = rec['Google Map Link'];
    if (link) {
      return link + (link.indexOf('?') > -1 ? '&' : '?') + 'output=embed';
    }
    return '';
  }

  function renderCarousel() {
    var titleEl = document.getElementById('carousel-title');
    var counterEl = document.getElementById('carousel-counter');
    var cardEl = document.getElementById('carousel-card');
    var prevBtn = document.getElementById('btn-prev');
    var nextBtn = document.getElementById('btn-next');

    if (!data.length) {
      titleEl.textContent = 'Site';
      counterEl.textContent = '0 / 0';
      cardEl.innerHTML = '<div class="status-msg">No records found.</div>';
      prevBtn.disabled = true;
      nextBtn.disabled = true;
      return;
    }

    if (currentIndex < 0) currentIndex = 0;
    if (currentIndex > data.length - 1) currentIndex = data.length - 1;

    var rec = data[currentIndex];
    titleEl.textContent = 'Site #' + (rec['No'] || (currentIndex + 1));
    counterEl.textContent = (currentIndex + 1) + ' / ' + data.length;
    prevBtn.disabled = currentIndex === 0;
    nextBtn.disabled = currentIndex === data.length - 1;

    var infoFields = ['Size', 'Rate', 'Lease Term', 'Lease Type', 'Frontage', 'Store Format', 'Nearest PG', 'Competitors', 'Status'];
    var visited = (rec['Visited'] || '').toLowerCase();
    var visitedBadge = visited === 'yes'
      ? '<span class="badge badge-yes">Yes</span>'
      : (visited === 'no' ? '<span class="badge badge-no">No</span>' : '');

    var photoHtml = rec['Picture']
      ? '<img id="carousel-photo-img" src="' + escapeHtml(rec['Picture']) + '" alt="Site photo" />'
      : '';
    var noPhotoFallback = '<div class="no-photo" id="carousel-no-photo" ' + (rec['Picture'] ? 'style="display:none"' : '') + '>No photo available</div>';

    var infoItemsHtml = infoFields.map(function (f) {
      return '<div class="info-item"><label>' + escapeHtml(f) + '</label><div class="val">' + (escapeHtml(rec[f]) || '&mdash;') + '</div></div>';
    }).join('') + '<div class="info-item"><label>Visited</label><div class="val">' + (visitedBadge || '&mdash;') + '</div></div>';

    var remarksHtml = '<div class="info-item full"><label>Remarks</label><div class="val">' + (escapeHtml(rec['Remarks']) || '&mdash;') + '</div></div>';

    var mapSrc = mapEmbedSrc(rec);
    var mapHtml = mapSrc
      ? '<iframe src="' + escapeHtml(mapSrc) + '" loading="lazy" allowfullscreen></iframe>'
      : '<div class="no-map">No address or map link available for this site.</div>';

    var mapLinkHref = rec['Google Map Link'] || (rec['Address'] ? 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(rec['Address']) : '');

    cardEl.innerHTML =
      '<div class="card-top">' +
        '<div class="card-photo">' + photoHtml + noPhotoFallback + '</div>' +
        '<div class="card-info">' +
          '<h3>' + escapeHtml(rec['Address'] || 'No address') + '</h3>' +
          '<div class="address">No. ' + escapeHtml(rec['No']) + '</div>' +
          '<div class="info-grid">' + infoItemsHtml + remarksHtml + '</div>' +
          '<a class="map-link' + (mapLinkHref ? '' : ' disabled') + '" href="' + escapeHtml(mapLinkHref) + '" target="_blank" rel="noopener">Open in Google Maps</a>' +
        '</div>' +
      '</div>' +
      '<div class="card-map">' + mapHtml + '</div>';

    var photoImg = document.getElementById('carousel-photo-img');
    if (photoImg) {
      photoImg.addEventListener('error', function () {
        photoImg.style.display = 'none';
        var fallback = document.getElementById('carousel-no-photo');
        if (fallback) fallback.style.display = 'block';
      });
    }
  }

  document.getElementById('btn-prev').addEventListener('click', function () {
    currentIndex -= 1;
    renderCarousel();
  });
  document.getElementById('btn-next').addEventListener('click', function () {
    currentIndex += 1;
    renderCarousel();
  });

  loadData();
})();
</script>
</body>
</html>`;
