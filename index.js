const express = require('express');
const { google } = require('googleapis');

const app = express();
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

function getSheetsClient() {
  if (!CLIENT_EMAIL || !PRIVATE_KEY) {
    throw new Error('Missing GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY environment variables');
  }
  const auth = new google.auth.GoogleAuth({
    credentials: { client_email: CLIENT_EMAIL, private_key: PRIVATE_KEY },
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  return google.sheets({ version: 'v4', auth });
}

function driveDirectUrl(url) {
  if (!url) return '';
  const trimmed = url.trim();
  let match = trimmed.match(/drive\.google\.com\/file\/d\/([^/]+)/);
  if (match) return 'https://drive.google.com/uc?export=view&id=' + match[1];
  match = trimmed.match(/[?&]id=([^&]+)/);
  if (match && trimmed.includes('drive.google.com')) {
    return 'https://drive.google.com/uc?export=view&id=' + match[1];
  }
  return trimmed;
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

  /* Table view */
  .table-wrap { overflow-x: auto; background: #fff; border: 1px solid var(--border); border-radius: 8px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { padding: 8px 10px; border-bottom: 1px solid var(--border); text-align: left; white-space: nowrap; }
  th { background: var(--primary-light); color: var(--primary); position: sticky; top: 0; }
  tr:hover td { background: #fafafa; }
  .badge { padding: 2px 8px; border-radius: 12px; font-size: 12px; font-weight: 600; }
  .badge-yes { background: #dcfce7; color: #166534; }
  .badge-no { background: #fee2e2; color: #991b1b; }

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
</style>
</head>
<body>
  <header>
    <h1>CaMaNaVa Site Acquisition</h1>
    <p>Site acquisition monitoring</p>
  </header>
  <nav class="tabs">
    <button id="tab-btn-table" class="active">Data Table</button>
    <button id="tab-btn-carousel">Carousel View</button>
  </nav>
  <main>
    <section id="panel-table" class="panel active">
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

<script>
(function () {
  var COLUMNS = ['No','Address','Google Map Link','Picture','Size','Rate','Lease Term','Lease Type','Frontage','Store Format','Nearest PG','Competitors','Visited','Status','Remarks'];
  var data = [];
  var currentIndex = 0;

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

  function renderTable() {
    var head = document.getElementById('table-head');
    var body = document.getElementById('table-body');
    head.innerHTML = '';
    COLUMNS.forEach(function (col) {
      var th = document.createElement('th');
      th.textContent = col;
      head.appendChild(th);
    });

    if (!data.length) {
      body.innerHTML = '<tr><td class="status-msg" colspan="' + COLUMNS.length + '">No records found.</td></tr>';
      return;
    }

    body.innerHTML = data.map(function (rec) {
      return '<tr>' + COLUMNS.map(function (col) {
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
      }).join('') + '</tr>';
    }).join('');
  }

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
      ? '<img src="' + escapeHtml(rec['Picture']) + '" alt="Site photo" onerror="this.style.display=\\'none\\'; this.nextElementSibling.style.display=\\'block\\';" />'
      : '';
    var noPhotoFallback = '<div class="no-photo" ' + (rec['Picture'] ? 'style="display:none"' : '') + '>No photo available</div>';

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
  }

  document.getElementById('btn-prev').addEventListener('click', function () {
    currentIndex -= 1;
    renderCarousel();
  });
  document.getElementById('btn-next').addEventListener('click', function () {
    currentIndex += 1;
    renderCarousel();
  });

  fetch('/api/data')
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
      document.getElementById('table-body').innerHTML = '<tr><td colspan="' + COLUMNS.length + '">' + msg + '</td></tr>';
      document.getElementById('carousel-card').innerHTML = msg;
    });
})();
</script>
</body>
</html>`;
