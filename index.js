const express = require('express');
const crypto = require('crypto');
const https = require('https');
const { google } = require('googleapis');

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;

const SHEET_ID = process.env.SHEET_ID || '1wkP2CQZhzxeLNHDeQYdzGZwYHkfK-D1_qgBAVsO91qE';
const SHEET_NAME = process.env.SHEET_NAME || 'site';
const USER_SHEET_NAME = process.env.USER_SHEET_NAME || 'User';
const CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const PRIVATE_KEY = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID || '';

const OAUTH_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID || '';
const OAUTH_CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET || '';
const OAUTH_REFRESH_TOKEN = process.env.GOOGLE_OAUTH_REFRESH_TOKEN || '';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';

const COLUMNS = [
  'No', 'Address', 'Google Map Link', 'Picture', 'Size', 'Rate',
  'Lease Term', 'Lease Type', 'Frontage', 'Store Format', 'Nearest PG',
  'Competitors', 'Visited', 'Lot Plan', 'Status', 'Remarks', 'Update'
];
const LAST_COL = 'Q';
const ADMIN_ONLY_FIELDS = ['Visited', 'Status'];

let cachedSheetGid = null;
const sessions = new Map();

function getSheetsAuth() {
  if (!CLIENT_EMAIL || !PRIVATE_KEY) {
    throw new Error('Missing GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY environment variables');
  }
  return new google.auth.GoogleAuth({
    credentials: { client_email: CLIENT_EMAIL, private_key: PRIVATE_KEY },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

function getSheetsClient() {
  return google.sheets({ version: 'v4', auth: getSheetsAuth() });
}

// ---- Native https for Google Drive/OAuth (googleapis has Premature-close bugs on Railway) ----
function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const opts = Object.assign({ family: 4 }, options);
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(new Error('Request to Google timed out')); });
    if (body) req.write(body);
    req.end();
  });
}

function oauthTokenRequest(params) {
  if (!OAUTH_CLIENT_ID || !OAUTH_CLIENT_SECRET) {
    throw new Error('Missing GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET environment variables');
  }
  const body = new URLSearchParams(params).toString();
  return httpsRequest({
    method: 'POST',
    hostname: 'oauth2.googleapis.com',
    path: '/token',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
    },
  }, body).then((r) => {
    const data = JSON.parse(r.body.toString() || '{}');
    if (r.status >= 400) {
      throw new Error(data.error_description || data.error || ('Token request failed (' + r.status + ')'));
    }
    return data;
  });
}

function exchangeCodeForTokens(code, redirectUri) {
  return oauthTokenRequest({
    code: code,
    client_id: OAUTH_CLIENT_ID,
    client_secret: OAUTH_CLIENT_SECRET,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
}

let accessTokenCache = { token: null, expiry: 0 };
async function getDriveAccessToken() {
  if (!OAUTH_REFRESH_TOKEN) {
    throw new Error('Photo storage is not set up yet. Open /oauth/setup to connect Google Drive.');
  }
  const now = Date.now();
  if (accessTokenCache.token && now < accessTokenCache.expiry - 60000) return accessTokenCache.token;
  let data;
  try {
    data = await oauthTokenRequest({
      client_id: OAUTH_CLIENT_ID,
      client_secret: OAUTH_CLIENT_SECRET,
      refresh_token: OAUTH_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    });
  } catch (err) {
    // invalid_grant = the refresh token expired or was revoked -> guide the user to reconnect.
    if (/invalid_grant|expired|revoked/i.test(err.message)) {
      throw new Error('Google Drive connection expired. Reconnect by opening /oauth/setup, then update GOOGLE_OAUTH_REFRESH_TOKEN. (Tip: set the OAuth consent screen to "In production" so it stops expiring.)');
    }
    throw err;
  }
  if (!data.access_token) throw new Error('Failed to refresh Google access token');
  accessTokenCache = { token: data.access_token, expiry: now + (data.expires_in || 3600) * 1000 };
  return data.access_token;
}

async function driveUpload(buffer, mime, name, folderId) {
  const token = await getDriveAccessToken();
  const boundary = '----camanava' + crypto.randomBytes(8).toString('hex');
  const metadata = { name: name };
  if (folderId) metadata.parents = [folderId];
  const pre = Buffer.from(
    '--' + boundary + '\r\n' +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(metadata) + '\r\n' +
    '--' + boundary + '\r\n' +
    'Content-Type: ' + mime + '\r\n\r\n'
  );
  const post = Buffer.from('\r\n--' + boundary + '--');
  const payload = Buffer.concat([pre, buffer, post]);
  const r = await httpsRequest({
    method: 'POST',
    hostname: 'www.googleapis.com',
    path: '/upload/drive/v3/files?uploadType=multipart&fields=id',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'multipart/related; boundary=' + boundary,
      'Content-Length': payload.length,
    },
  }, payload);
  const data = JSON.parse(r.body.toString() || '{}');
  if (r.status >= 400) throw new Error((data.error && data.error.message) || 'Drive upload failed');
  return data.id;
}

async function driveGetMeta(fileId) {
  const token = await getDriveAccessToken();
  const r = await httpsRequest({
    method: 'GET',
    hostname: 'www.googleapis.com',
    path: '/drive/v3/files/' + encodeURIComponent(fileId) + '?fields=name,mimeType',
    headers: { 'Authorization': 'Bearer ' + token },
  });
  const data = JSON.parse(r.body.toString() || '{}');
  if (r.status >= 400) throw new Error((data.error && data.error.message) || 'File not found');
  return data;
}

async function driveGetMedia(fileId) {
  const token = await getDriveAccessToken();
  const r = await httpsRequest({
    method: 'GET',
    hostname: 'www.googleapis.com',
    path: '/drive/v3/files/' + encodeURIComponent(fileId) + '?alt=media',
    headers: { 'Authorization': 'Bearer ' + token },
  });
  if (r.status >= 400) {
    let msg = 'Photo download failed';
    try { msg = JSON.parse(r.body.toString()).error.message; } catch (e) { /* binary body */ }
    throw new Error(msg);
  }
  return r.body;
}

function buildAuthUrl(redirectUri) {
  if (!OAUTH_CLIENT_ID) throw new Error('Missing GOOGLE_OAUTH_CLIENT_ID environment variable');
  const params = new URLSearchParams({
    client_id: OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    scope: DRIVE_SCOPE,
  });
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString();
}

function computeRedirectUri(req) {
  if (process.env.OAUTH_REDIRECT_URI) return process.env.OAUTH_REDIRECT_URI;
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return proto + '://' + host + '/oauth/callback';
}

function escapeHtmlServer(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function oauthPage(title, bodyHtml) {
  return '<!DOCTYPE html><html><head><meta charset="utf-8" />'
    + '<meta name="viewport" content="width=device-width, initial-scale=1" />'
    + '<title>' + escapeHtmlServer(title) + '</title>'
    + '<style>body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:640px;margin:40px auto;padding:0 16px;color:#1f2937;}'
    + 'h1{color:#1a5d3a;font-size:22px;}code{background:#eef1f2;padding:2px 5px;border-radius:4px;}'
    + 'a{color:#2563eb;}</style></head><body><h1>' + escapeHtmlServer(title) + '</h1>'
    + bodyHtml + '<p style="margin-top:24px;"><a href="/">&larr; Back to the app</a></p></body></html>';
}

async function getSheetGid(sheets) {
  if (cachedSheetGid !== null) return cachedSheetGid;
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: SHEET_ID,
    fields: 'sheets.properties',
  });
  const allSheets = meta.data.sheets || [];
  const target = SHEET_NAME.trim().toLowerCase();
  const sheet = allSheets.find((s) => s.properties.title === SHEET_NAME)
    || allSheets.find((s) => s.properties.title.trim().toLowerCase() === target);
  if (!sheet) {
    const available = allSheets.map((s) => s.properties.title).join(', ');
    throw new Error('Sheet tab "' + SHEET_NAME + '" not found. Available tabs: ' + available);
  }
  cachedSheetGid = sheet.properties.sheetId;
  return cachedSheetGid;
}

function driveDirectUrl(url) {
  if (!url) return '';
  const trimmed = url.trim();
  if (trimmed.indexOf('data:') === 0) return trimmed;
  if (trimmed.indexOf('/api/photo/') === 0) return trimmed;
  // Normalize any Google Drive link to our private, authenticated proxy path.
  let match = trimmed.match(/drive\.google\.com\/file\/d\/([^/]+)/);
  if (match) return '/api/photo/' + match[1];
  match = trimmed.match(/[?&]id=([^&]+)/);
  if (match && trimmed.includes('drive.google.com')) {
    return '/api/photo/' + match[1];
  }
  return trimmed;
}

function recordToRow(rec) {
  return COLUMNS.map((c) => {
    if (c === 'Picture' || c === 'Lot Plan') return rec[c] !== undefined && rec[c] !== null ? String(rec[c]) : '';
    return rec[c] !== undefined && rec[c] !== null ? String(rec[c]) : '';
  });
}

function getSessionFromReq(req) {
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(/(?:^|;\s*)sid=([^;]+)/);
  if (!match) return null;
  return sessions.get(match[1]) || null;
}

function requireAuth(req, res, next) {
  const session = getSessionFromReq(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  req.session = session;
  next();
}

// Visitors are read-only. Enforced on the server so hiding buttons isn't the only guard.
function requireEditor(req, res, next) {
  if ((req.session.level || '').trim().toLowerCase() === 'visitor') {
    return res.status(403).json({ error: 'Your account has view-only access.' });
  }
  next();
}

function setSessionCookie(res, token) {
  const secureFlag = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', 'sid=' + token + '; HttpOnly; Path=/; SameSite=Lax; Max-Age=43200' + secureFlag);
}

app.post('/api/login', async (req, res) => {
  try {
    const userId = ((req.body && req.body.userId) || '').toString().trim();
    const password = ((req.body && req.body.password) || '').toString();
    if (!userId || !password) return res.status(400).json({ error: 'User ID and password are required' });

    const sheets = getSheetsClient();
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: USER_SHEET_NAME + '!A2:D',
    });
    const rows = result.data.values || [];
    const match = rows.find((r) => (r[1] || '').toString().trim() === userId && (r[2] || '').toString() === password);
    if (!match) return res.status(401).json({ error: 'Invalid User ID or Password' });

    const userName = (match[0] || '').toString();
    const level = (match[3] || '').toString().trim().toLowerCase();
    const token = crypto.randomBytes(24).toString('hex');
    sessions.set(token, { userName: userName, userId: userId, level: level });
    setSessionCookie(res, token);
    res.json({ success: true, userName: userName, level: level });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/logout', (req, res) => {
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(/(?:^|;\s*)sid=([^;]+)/);
  if (match) sessions.delete(match[1]);
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; Max-Age=0');
  res.json({ success: true });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ userName: req.session.userName, level: req.session.level });
});

app.get('/api/data', requireAuth, async (req, res) => {
  try {
    const sheets = getSheetsClient();
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: SHEET_NAME + '!A2:' + LAST_COL,
    });
    const rows = result.data.values || [];
    const records = rows
      .filter((r) => r.some((c) => c && c.toString().trim() !== ''))
      .map((r, idx) => {
        const rec = {};
        COLUMNS.forEach((col, i) => {
          rec[col] = (r[i] || '').toString();
        });
        rec.Picture = rec.Picture
          .split('\n')
          .map((u) => driveDirectUrl(u.trim()))
          .filter(Boolean)
          .join('\n');
        rec['Lot Plan'] = rec['Lot Plan']
          .split('\n')
          .map((u) => driveDirectUrl(u.trim()))
          .filter(Boolean)
          .join('\n');
        rec._row = idx + 2;
        return rec;
      });
    res.json(records);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/data', requireAuth, requireEditor, async (req, res) => {
  try {
    const sheets = getSheetsClient();
    const record = Object.assign({}, req.body || {});
    if (req.session.level !== 'admin') {
      ADMIN_ONLY_FIELDS.forEach((f) => { record[f] = ''; });
    }
    const result = await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: SHEET_NAME + '!A:' + LAST_COL,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [recordToRow(record)] },
    });
    const updatedRange = result.data.updates && result.data.updates.updatedRange;
    const m = updatedRange && updatedRange.match(/![A-Z]+(\d+)/);
    res.json({ success: true, row: m ? parseInt(m[1], 10) : null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/data/:row', requireAuth, requireEditor, async (req, res) => {
  try {
    const rowNum = parseInt(req.params.row, 10);
    if (!rowNum || rowNum < 2) return res.status(400).json({ error: 'Invalid row' });
    const sheets = getSheetsClient();
    const record = Object.assign({}, req.body || {});

    if (req.session.level !== 'admin') {
      const existing = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: SHEET_NAME + '!A' + rowNum + ':' + LAST_COL + rowNum,
      });
      const existingRow = (existing.data.values && existing.data.values[0]) || [];
      const existingRec = {};
      COLUMNS.forEach((c, i) => { existingRec[c] = existingRow[i] || ''; });
      ADMIN_ONLY_FIELDS.forEach((f) => { record[f] = existingRec[f]; });
    }

    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: SHEET_NAME + '!A' + rowNum + ':' + LAST_COL + rowNum,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [recordToRow(record)] },
    });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/data/:row', requireAuth, requireEditor, async (req, res) => {
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

app.post('/api/upload', requireAuth, requireEditor, async (req, res) => {
  try {
    const dataUrl = (req.body && req.body.dataUrl) || '';
    const commaIdx = dataUrl.indexOf(',');
    if (dataUrl.indexOf('data:image/') !== 0 || commaIdx === -1) {
      return res.status(400).json({ error: 'Invalid image data' });
    }
    const meta = dataUrl.slice(5, commaIdx);
    const mime = meta.split(';')[0];
    const ext = mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1];
    const base64Data = dataUrl.slice(commaIdx + 1);
    const buffer = Buffer.from(base64Data, 'base64');

    const name = 'site-photo-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex') + '.' + ext;
    const fileId = await driveUpload(buffer, mime, name, DRIVE_FOLDER_ID);
    // Files stay private; they are served to logged-in users through /api/photo.
    res.json({ success: true, url: '/api/photo/' + fileId, fileId: fileId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/photo/:fileId', requireAuth, async (req, res) => {
  try {
    const fileId = req.params.fileId;
    const meta = await driveGetMeta(fileId);
    const media = await driveGetMedia(fileId);
    res.setHeader('Content-Type', meta.mimeType || 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    if (req.query.download) {
      res.setHeader('Content-Disposition', 'attachment; filename="' + (meta.name || 'photo') + '"');
    }
    res.send(media);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---- One-time Google Drive connection (OAuth) ----
app.get('/oauth/setup', requireAuth, (req, res) => {
  try {
    const redirectUri = computeRedirectUri(req);
    res.redirect(buildAuthUrl(redirectUri));
  } catch (err) {
    res.status(500).type('html').send(oauthPage('Setup error', escapeHtmlServer(err.message)
      + '<p>Make sure <code>GOOGLE_OAUTH_CLIENT_ID</code> and <code>GOOGLE_OAUTH_CLIENT_SECRET</code> are set in Railway.</p>'));
  }
});

app.get('/oauth/callback', requireAuth, async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) {
      const reason = req.query.error ? escapeHtmlServer(String(req.query.error)) : 'No authorization code returned.';
      return res.status(400).type('html').send(oauthPage('Connection cancelled', reason));
    }
    const redirectUri = computeRedirectUri(req);
    const tokens = await exchangeCodeForTokens(code, redirectUri);
    const refreshToken = tokens && tokens.refresh_token;
    if (!refreshToken) {
      return res.status(500).type('html').send(oauthPage('No refresh token received',
        'Google did not return a refresh token. Remove this app access at '
        + '<a href="https://myaccount.google.com/permissions" target="_blank" rel="noopener">Google Account permissions</a>, '
        + 'then visit <a href="/oauth/setup">/oauth/setup</a> again.'));
    }
    const body = '<p>Copy the value below and add it in Railway as an environment variable named '
      + '<code>GOOGLE_OAUTH_REFRESH_TOKEN</code>, then redeploy:</p>'
      + '<textarea readonly style="width:100%;height:90px;font-family:monospace;font-size:13px;padding:8px;">'
      + escapeHtmlServer(refreshToken) + '</textarea>'
      + '<p style="color:#991b1b;"><strong>Keep this secret</strong> &mdash; treat it like a password.</p>';
    res.type('html').send(oauthPage('Google Drive connected', body));
  } catch (err) {
    console.error(err);
    res.status(500).type('html').send(oauthPage('Callback error', escapeHtmlServer(err.message)));
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
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }
  header .title h1 { margin: 0; font-size: 20px; }
  header .title p { margin: 4px 0 0; font-size: 13px; opacity: 0.85; }
  .user-badge { display: flex; align-items: center; gap: 10px; font-size: 13px; }
  .user-badge .btn-logout {
    background: rgba(255,255,255,0.15); color: #fff; border: 1px solid rgba(255,255,255,0.4);
    padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 12px;
  }
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
  #app-shell.hidden { display: none; }

  /* Login */
  .login-wrap {
    min-height: 100vh; display: flex; align-items: center; justify-content: center;
    padding: 20px; background: var(--bg);
  }
  .login-wrap.hidden { display: none; }
  .login-card {
    background: #fff; border-radius: 10px; padding: 30px; width: 100%; max-width: 360px;
    border: 1px solid var(--border);
  }
  .login-card h2 { margin: 0 0 4px; color: var(--primary); }
  .login-card p.subtitle { margin: 0 0 20px; color: var(--muted); font-size: 13px; }
  .login-card label { display: block; font-size: 12px; font-weight: 600; color: var(--muted); margin-bottom: 4px; }
  .login-card input {
    width: 100%; padding: 9px 10px; border: 1px solid var(--border); border-radius: 6px;
    font-size: 15px; margin-bottom: 14px; font-family: inherit;
  }
  .login-card button {
    width: 100%; padding: 10px; background: var(--primary); color: #fff; border: none;
    border-radius: 6px; font-size: 14px; cursor: pointer;
  }
  .login-error { color: #dc2626; font-size: 13px; margin-bottom: 12px; display: none; }

  /* Site Proposal view */
  .proposal-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
  .proposal-head h2 { margin: 0; font-size: 18px; }
  .btn { border: none; padding: 9px 16px; border-radius: 6px; cursor: pointer; font-size: 14px; text-decoration: none; display: inline-block; font-family: inherit; }
  .btn-primary { background: var(--primary); color: #fff; }
  .btn-secondary { background: #fff; color: var(--text); border: 1px solid var(--border); }
  .btn-danger { background: #dc2626; color: #fff; }
  .btn-sm { padding: 5px 10px; font-size: 12px; }
  .table-wrap { overflow-x: auto; background: #fff; border: 1px solid var(--border); border-radius: 8px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { padding: 8px 10px; border-bottom: 1px solid var(--border); text-align: left; white-space: nowrap; }
  th { background: var(--primary-light); color: var(--primary); position: sticky; top: 0; z-index: 2; }
  tr:hover td { background: #fafafa; }
  .badge { padding: 2px 8px; border-radius: 12px; font-size: 12px; font-weight: 600; }
  .badge-yes { background: #dcfce7; color: #166534; }
  .badge-no { background: #fee2e2; color: #991b1b; }
  .row-actions { display: flex; gap: 6px; }
  .lock-hint { font-size: 11px; color: var(--muted); font-style: italic; margin-top: 2px; }

  /* Freeze panes: No + Address columns on the left, Actions column on the right */
  #panel-table th:nth-child(1), #panel-table td:nth-child(1) {
    position: sticky; left: 0; width: 56px; min-width: 56px; text-align: center;
    background: #fff; z-index: 1;
  }
  #panel-table th:nth-child(2), #panel-table td:nth-child(2) {
    position: sticky; left: 56px; width: 220px; min-width: 220px; white-space: normal;
    background: #fff; z-index: 1; box-shadow: 2px 0 4px rgba(0,0,0,0.06);
  }
  #panel-table th:nth-child(1), #panel-table th:nth-child(2) {
    background: var(--primary-light); z-index: 3;
  }
  #panel-table tr:hover td:nth-child(1), #panel-table tr:hover td:nth-child(2) { background: #fafafa; }
  #panel-table th:last-child, #panel-table td:last-child {
    position: sticky; right: 0; background: #fff; z-index: 1;
    box-shadow: -2px 0 4px rgba(0,0,0,0.06);
  }
  #panel-table th:last-child { background: var(--primary-light); z-index: 3; }
  #panel-table tr:hover td:last-child { background: #fafafa; }

  /* Carousel view */
  .carousel-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
  .carousel-head h2 { margin: 0; font-size: 18px; }
  .carousel-head-left { display: flex; align-items: center; gap: 12px; }
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
  .lotplan-btns { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 16px; }
  .lotplan-btn {
    display: inline-block;
    padding: 8px 14px;
    background: #fff;
    color: var(--primary);
    border: 1px solid var(--primary);
    text-decoration: none;
    border-radius: 6px;
    font-size: 13px;
    cursor: pointer;
    font-family: inherit;
  }
  .link-btn {
    background: none; border: none; padding: 0; margin: 0;
    color: var(--accent); text-decoration: underline; cursor: pointer;
    font-size: inherit; font-family: inherit;
  }
  .image-viewer {
    background: #111; border-radius: 8px; padding: 12px; max-width: 95vw;
    display: flex; flex-direction: column; align-items: flex-end; gap: 8px;
  }
  .image-viewer-actions { display: flex; gap: 8px; }
  .image-viewer img { max-width: 100%; max-height: 82vh; display: block; border-radius: 4px; }
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
  .modal { background: #fff; border-radius: 10px; width: 100%; max-width: 640px; padding: 24px; margin-bottom: 30px; }
  .modal h3 { margin: 0 0 16px; color: var(--primary); }
  .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px 16px; }
  .form-item { display: flex; flex-direction: column; gap: 4px; }
  .form-item.full { grid-column: 1 / -1; }
  .form-item label { font-size: 12px; font-weight: 600; color: var(--muted); }
  .form-item input, .form-item select, .form-item textarea {
    padding: 8px 10px; border: 1px solid var(--border); border-radius: 6px; font-size: 14px; font-family: inherit;
  }
  .form-item input:disabled, .form-item select:disabled {
    background: #f3f4f6; color: var(--muted); cursor: not-allowed;
  }
  .form-item textarea { resize: vertical; min-height: 60px; }
  .picture-input { display: flex; flex-direction: column; gap: 8px; }
  .picture-slot { border: 1px dashed var(--border); border-radius: 8px; padding: 10px; }
  .picture-slot + .picture-slot { margin-top: 10px; }
  .picture-slot-label { font-size: 12px; font-weight: 600; color: var(--muted); margin-bottom: 6px; }
  .picture-preview { max-width: 100%; max-height: 160px; border-radius: 6px; border: 1px solid var(--border); display: none; margin-bottom: 8px; }
  .picture-btns { display: flex; gap: 8px; flex-wrap: wrap; }
  .file-btn {
    display: inline-block; padding: 7px 12px; border: 1px solid var(--border); border-radius: 6px;
    background: #fff; font-size: 12px; cursor: pointer; color: var(--text);
  }
  .file-btn-remove { border-color: #f0b4b4; color: #b91c1c; }
  .file-btn-remove:hover { background: #fef2f2; }
  .file-btn-remove:disabled { opacity: .5; cursor: not-allowed; }
  .picture-hint { font-size: 11px; color: var(--muted); margin-top: 4px; }
  .form-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px; }
  .form-error { color: #dc2626; font-size: 13px; margin-top: 10px; display: none; }

  /* Mobile */
  @media (max-width: 640px) {
    header { padding: 12px 16px; }
    header .title h1 { font-size: 17px; }
    nav.tabs { padding: 0 12px; }
    nav.tabs button { padding: 12px 10px; font-size: 13px; }
    main { padding: 14px 12px; }
    .proposal-head { flex-wrap: wrap; gap: 10px; }
    .proposal-head h2 { font-size: 16px; }
    th, td { font-size: 12px; padding: 6px 8px; }
    /* Freeze panes get in the way on small screens - disable them so all data can scroll into view */
    #panel-table th:nth-child(1), #panel-table td:nth-child(1),
    #panel-table th:nth-child(2), #panel-table td:nth-child(2),
    #panel-table th:last-child, #panel-table td:last-child {
      position: static; left: auto; right: auto; box-shadow: none;
      width: auto; min-width: 110px;
    }
    .carousel-head { flex-wrap: wrap; gap: 10px; }
    .card-photo, .card-photo img { min-height: 220px; }
    .card-info { padding: 16px; }
    .info-grid { grid-template-columns: 1fr; }
    .overlay { padding: 0; align-items: flex-start; background: #fff; }
    .modal { max-width: 100%; min-height: 100vh; border-radius: 0; padding: 16px; margin-bottom: 0; }
    .form-grid { grid-template-columns: 1fr; }
    .form-item input, .form-item select, .form-item textarea { font-size: 16px; }
  }
</style>
</head>
<body>
  <div class="login-wrap" id="login-wrap">
    <div class="login-card">
      <h2>CaMaNaVa Site Acquisition</h2>
      <p class="subtitle">Sign in to continue</p>
      <form id="login-form">
        <label>User ID</label>
        <input type="text" id="login-userid" autocomplete="username" required />
        <label>Password</label>
        <input type="password" id="login-password" autocomplete="current-password" required />
        <div class="login-error" id="login-error"></div>
        <button type="submit" id="login-submit">Log In</button>
      </form>
    </div>
  </div>

  <div id="app-shell" class="hidden">
    <header>
      <div class="title">
        <h1>CaMaNaVa Site Acquisition</h1>
        <p>Site acquisition monitoring</p>
      </div>
      <div class="user-badge">
        <span id="user-badge-text"></span>
        <button class="btn-logout" id="btn-logout">Log Out</button>
      </div>
    </header>
    <nav class="tabs">
      <button id="tab-btn-table" class="active" data-tab="table">Site Proposal Summary Table</button>
      <button id="tab-btn-approval" data-tab="approval">Site For Approval</button>
      <button id="tab-btn-approved" data-tab="approved">Approved</button>
      <button id="tab-btn-disapproved" data-tab="disapproved">Disapproved</button>
    </nav>
    <main>
      <section id="panel-table" class="panel active">
        <div class="proposal-head">
          <h2>Site Proposal Summary Table</h2>
          <button class="btn btn-primary" id="btn-add-site">+ Add New Site</button>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr id="table-head"></tr></thead>
            <tbody id="table-body"><tr><td class="status-msg">Loading...</td></tr></tbody>
          </table>
        </div>
      </section>

      <section id="panel-approval" class="panel">
        <div class="carousel-head">
          <div class="carousel-head-left">
            <h2 id="approval-title">Site</h2>
            <button class="btn btn-secondary btn-sm carousel-edit-btn" data-carousel="approval" style="display:none">Edit</button>
          </div>
          <div class="nav-btns">
            <button class="carousel-prev" data-carousel="approval">&#8592; Prev</button>
            <span class="counter" id="approval-counter">0 / 0</span>
            <button class="carousel-next" data-carousel="approval">Next &#8594;</button>
          </div>
        </div>
        <div class="card" id="approval-card"><div class="status-msg">Loading...</div></div>
      </section>

      <section id="panel-approved" class="panel">
        <div class="carousel-head">
          <div class="carousel-head-left">
            <h2 id="approved-title">Site</h2>
            <button class="btn btn-secondary btn-sm carousel-edit-btn" data-carousel="approved" style="display:none">Edit</button>
          </div>
          <div class="nav-btns">
            <button class="carousel-prev" data-carousel="approved">&#8592; Prev</button>
            <span class="counter" id="approved-counter">0 / 0</span>
            <button class="carousel-next" data-carousel="approved">Next &#8594;</button>
          </div>
        </div>
        <div class="card" id="approved-card"><div class="status-msg">Loading...</div></div>
      </section>

      <section id="panel-disapproved" class="panel">
        <div class="carousel-head">
          <div class="carousel-head-left">
            <h2 id="disapproved-title">Site</h2>
            <button class="btn btn-secondary btn-sm carousel-edit-btn" data-carousel="disapproved" style="display:none">Edit</button>
          </div>
          <div class="nav-btns">
            <button class="carousel-prev" data-carousel="disapproved">&#8592; Prev</button>
            <span class="counter" id="disapproved-counter">0 / 0</span>
            <button class="carousel-next" data-carousel="disapproved">Next &#8594;</button>
          </div>
        </div>
        <div class="card" id="disapproved-card"><div class="status-msg">Loading...</div></div>
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
              <div class="lock-hint" id="visited-lock-hint"></div>
            </div>
            <div class="form-item full"><label>Address</label><input name="Address" type="text" /></div>
            <div class="form-item full"><label>Google Map Link</label><input name="Google Map Link" type="text" placeholder="Paste Google Maps link" /></div>
            <div class="form-item full">
              <label>Picture (up to 3 photos)</label>
              <div class="picture-slot">
                <div class="picture-slot-label">Photo 1</div>
                <div class="picture-input">
                  <img class="picture-preview" id="pic1-preview" />
                  <input id="pic1-url" type="text" placeholder="Paste an image URL, or use a button below" />
                  <div class="picture-btns">
                    <label class="file-btn">Take Photo<input type="file" accept="image/*" capture="environment" id="pic1-camera" hidden /></label>
                    <label class="file-btn">Choose from Storage<input type="file" accept="image/*" id="pic1-file" hidden /></label>
                    <button type="button" class="file-btn file-btn-remove" id="pic1-remove">Remove Photo</button>
                  </div>
                  <div class="picture-hint" id="pic1-hint"></div>
                </div>
              </div>
              <div class="picture-slot">
                <div class="picture-slot-label">Photo 2</div>
                <div class="picture-input">
                  <img class="picture-preview" id="pic2-preview" />
                  <input id="pic2-url" type="text" placeholder="Paste an image URL, or use a button below" />
                  <div class="picture-btns">
                    <label class="file-btn">Take Photo<input type="file" accept="image/*" capture="environment" id="pic2-camera" hidden /></label>
                    <label class="file-btn">Choose from Storage<input type="file" accept="image/*" id="pic2-file" hidden /></label>
                    <button type="button" class="file-btn file-btn-remove" id="pic2-remove">Remove Photo</button>
                  </div>
                  <div class="picture-hint" id="pic2-hint"></div>
                </div>
              </div>
              <div class="picture-slot">
                <div class="picture-slot-label">Photo 3</div>
                <div class="picture-input">
                  <img class="picture-preview" id="pic3-preview" />
                  <input id="pic3-url" type="text" placeholder="Paste an image URL, or use a button below" />
                  <div class="picture-btns">
                    <label class="file-btn">Take Photo<input type="file" accept="image/*" capture="environment" id="pic3-camera" hidden /></label>
                    <label class="file-btn">Choose from Storage<input type="file" accept="image/*" id="pic3-file" hidden /></label>
                    <button type="button" class="file-btn file-btn-remove" id="pic3-remove">Remove Photo</button>
                  </div>
                  <div class="picture-hint" id="pic3-hint"></div>
                </div>
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
            <div class="form-item full">
              <label>Lot Plan (up to 3 photos)</label>
              <div class="picture-slot">
                <div class="picture-slot-label">Photo 1</div>
                <div class="picture-input">
                  <img class="picture-preview" id="lot1-preview" />
                  <input id="lot1-url" type="text" placeholder="Paste an image URL, or use a button below" />
                  <div class="picture-btns">
                    <label class="file-btn">Take Photo<input type="file" accept="image/*" capture="environment" id="lot1-camera" hidden /></label>
                    <label class="file-btn">Choose from Storage<input type="file" accept="image/*" id="lot1-file" hidden /></label>
                    <button type="button" class="file-btn file-btn-remove" id="lot1-remove">Remove Photo</button>
                  </div>
                  <div class="picture-hint" id="lot1-hint"></div>
                </div>
              </div>
              <div class="picture-slot">
                <div class="picture-slot-label">Photo 2</div>
                <div class="picture-input">
                  <img class="picture-preview" id="lot2-preview" />
                  <input id="lot2-url" type="text" placeholder="Paste an image URL, or use a button below" />
                  <div class="picture-btns">
                    <label class="file-btn">Take Photo<input type="file" accept="image/*" capture="environment" id="lot2-camera" hidden /></label>
                    <label class="file-btn">Choose from Storage<input type="file" accept="image/*" id="lot2-file" hidden /></label>
                    <button type="button" class="file-btn file-btn-remove" id="lot2-remove">Remove Photo</button>
                  </div>
                  <div class="picture-hint" id="lot2-hint"></div>
                </div>
              </div>
              <div class="picture-slot">
                <div class="picture-slot-label">Photo 3</div>
                <div class="picture-input">
                  <img class="picture-preview" id="lot3-preview" />
                  <input id="lot3-url" type="text" placeholder="Paste an image URL, or use a button below" />
                  <div class="picture-btns">
                    <label class="file-btn">Take Photo<input type="file" accept="image/*" capture="environment" id="lot3-camera" hidden /></label>
                    <label class="file-btn">Choose from Storage<input type="file" accept="image/*" id="lot3-file" hidden /></label>
                    <button type="button" class="file-btn file-btn-remove" id="lot3-remove">Remove Photo</button>
                  </div>
                  <div class="picture-hint" id="lot3-hint"></div>
                </div>
              </div>
            </div>
            <div class="form-item full">
              <label>Status</label>
              <select name="Status">
                <option value="">-</option>
                <option value="Approved">Approved</option>
                <option value="Disapproved">Disapproved</option>
                <option value="Pending">Pending</option>
              </select>
              <div class="lock-hint" id="status-lock-hint"></div>
            </div>
            <div class="form-item full"><label>Remarks</label><textarea name="Remarks"></textarea></div>
            <div class="form-item full"><label>Update</label><textarea name="Update"></textarea></div>
          </div>
          <div class="form-error" id="form-error"></div>
          <div class="form-actions">
            <button type="button" class="btn btn-secondary" id="form-cancel">Cancel</button>
            <button type="submit" class="btn btn-primary" id="form-save">Save</button>
          </div>
        </form>
      </div>
    </div>

    <div class="overlay hidden" id="image-viewer-overlay">
      <div class="image-viewer">
        <div class="image-viewer-actions">
          <a class="btn btn-primary btn-sm" id="image-viewer-download" download="photo.jpg">Download</a>
          <button type="button" class="btn btn-secondary btn-sm" id="image-viewer-close">Close</button>
        </div>
        <img id="image-viewer-img" alt="Photo" />
      </div>
    </div>
  </div>

<script>
(function () {
  var COLUMNS = ['No','Address','Google Map Link','Picture','Size','Rate','Lease Term','Lease Type','Frontage','Store Format','Nearest PG','Competitors','Visited','Lot Plan','Status','Remarks','Update'];
  var ADMIN_ONLY_FIELDS = ['Visited', 'Status'];
  var PIC_SLOTS = ['pic1', 'pic2', 'pic3'];
  var LOT_SLOTS = ['lot1', 'lot2', 'lot3'];
  var data = [];
  var editingRow = null;
  var currentUser = null;

  // Three status-filtered carousels, each with its own position.
  var CAROUSELS = {
    approval: {
      index: 0,
      filter: function (r) { var s = (r['Status'] || '').trim().toLowerCase(); return s === '' || s === 'pending'; },
    },
    approved: {
      index: 0,
      filter: function (r) { return (r['Status'] || '').trim().toLowerCase() === 'approved'; },
    },
    disapproved: {
      index: 0,
      filter: function (r) { return (r['Status'] || '').trim().toLowerCase() === 'disapproved'; },
    },
  };
  function filteredFor(key) { return data.filter(CAROUSELS[key].filter); }

  var loginWrap = document.getElementById('login-wrap');
  var appShell = document.getElementById('app-shell');

  function isAdmin() {
    return !!currentUser && currentUser.level === 'admin';
  }

  function isVisitor() {
    return !!currentUser && (currentUser.level || '').trim().toLowerCase() === 'visitor';
  }

  function showApp(user) {
    currentUser = user;
    loginWrap.classList.add('hidden');
    appShell.classList.remove('hidden');
    document.getElementById('user-badge-text').textContent = user.userName + ' (' + (user.level || 'user') + ')';
    applyRoleUI();
    loadData();
  }

  // Visitors get a read-only view: no Summary Table tab, no Add/Edit buttons.
  function applyRoleUI() {
    var visitor = isVisitor();
    document.getElementById('tab-btn-table').style.display = visitor ? 'none' : '';
    document.getElementById('btn-add-site').style.display = visitor ? 'none' : '';
    if (visitor) switchTab('approval');
  }

  function showLogin() {
    currentUser = null;
    appShell.classList.add('hidden');
    loginWrap.classList.remove('hidden');
  }

  document.getElementById('login-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var userId = document.getElementById('login-userid').value.trim();
    var password = document.getElementById('login-password').value;
    var errorEl = document.getElementById('login-error');
    var submitBtn = document.getElementById('login-submit');
    errorEl.style.display = 'none';
    submitBtn.disabled = true;
    submitBtn.textContent = 'Signing in...';
    fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: userId, password: password }),
    })
      .then(function (r) {
        if (!r.ok) return r.json().then(function (e) { throw new Error(e.error || 'Login failed'); });
        return r.json();
      })
      .then(function (user) { showApp(user); })
      .catch(function (err) {
        errorEl.textContent = err.message;
        errorEl.style.display = 'block';
      })
      .finally(function () {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Log In';
      });
  });

  document.getElementById('btn-logout').addEventListener('click', function () {
    fetch('/api/logout', { method: 'POST' }).finally(function () { showLogin(); });
  });

  var TABS = ['table', 'approval', 'approved', 'disapproved'];
  TABS.forEach(function (name) {
    document.getElementById('tab-btn-' + name).addEventListener('click', function () { switchTab(name); });
  });

  function switchTab(name) {
    TABS.forEach(function (t) {
      document.getElementById('tab-btn-' + t).classList.toggle('active', t === name);
      document.getElementById('panel-' + t).classList.toggle('active', t === name);
    });
    if (name !== 'table') renderCarousel(name);
  }

  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function loadData() {
    return fetch('/api/data')
      .then(function (r) {
        if (r.status === 401) { showLogin(); throw new Error('Session expired'); }
        if (!r.ok) return r.json().then(function (e) { throw new Error(e.error || 'Request failed'); });
        return r.json();
      })
      .then(function (records) {
        data = records;
        renderTable();
        renderAllCarousels();
      })
      .catch(function (err) {
        var msg = '<div class="status-msg">Failed to load data: ' + escapeHtml(err.message) + '</div>';
        document.getElementById('table-body').innerHTML = '<tr><td colspan="' + (COLUMNS.length + 1) + '">' + msg + '</td></tr>';
        Object.keys(CAROUSELS).forEach(function (k) { document.getElementById(k + '-card').innerHTML = msg; });
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
        if (col === 'Picture' || col === 'Lot Plan') {
          var photos = (rec[col] || '').split('\\n').filter(Boolean);
          return '<td>' + photos.map(function (u, i) {
            return '<button type="button" class="link-btn" data-action="view-img" data-url="' + escapeHtml(u) + '">photo ' + (i + 1) + '</button>';
          }).join(' ') + '</td>';
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
    var action = btn.getAttribute('data-action');
    var row = parseInt(btn.getAttribute('data-row'), 10);
    if (action === 'edit') {
      var rec = data.find(function (d) { return d._row === row; });
      if (rec) openForm(rec);
    } else if (action === 'delete') {
      deleteRecord(row);
    }
  });

  document.body.addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-action="view-img"]');
    if (!btn) return;
    openImageViewer(btn.getAttribute('data-url'));
  });

  function openImageViewer(url) {
    if (!url) return;
    document.getElementById('image-viewer-img').src = url;
    var downloadLink = document.getElementById('image-viewer-download');
    if (url.indexOf('data:image/') === 0) {
      var ext = 'jpg';
      var afterPrefix = url.slice(11);
      var semiIdx = afterPrefix.indexOf(';');
      var mime = semiIdx > -1 ? afterPrefix.slice(0, semiIdx) : afterPrefix;
      if (mime) ext = mime === 'jpeg' ? 'jpg' : mime;
      downloadLink.href = url;
      downloadLink.setAttribute('download', 'photo.' + ext);
    } else if (url.indexOf('/api/photo/') === 0) {
      downloadLink.href = url + (url.indexOf('?') > -1 ? '&' : '?') + 'download=1';
      downloadLink.removeAttribute('download');
    } else {
      downloadLink.href = url;
      downloadLink.setAttribute('download', 'photo.jpg');
    }
    document.getElementById('image-viewer-overlay').classList.remove('hidden');
  }
  document.getElementById('image-viewer-close').addEventListener('click', function () {
    document.getElementById('image-viewer-overlay').classList.add('hidden');
    document.getElementById('image-viewer-img').src = '';
  });
  document.getElementById('image-viewer-overlay').addEventListener('click', function (e) {
    if (e.target.id === 'image-viewer-overlay') {
      document.getElementById('image-viewer-overlay').classList.add('hidden');
      document.getElementById('image-viewer-img').src = '';
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
    if (isVisitor()) return;
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

    var admin = isAdmin();
    ADMIN_ONLY_FIELDS.forEach(function (f) {
      var input = form.elements[f];
      if (input) input.disabled = !admin;
    });
    var lockMsg = admin ? '' : 'Admin only';
    document.getElementById('visited-lock-hint').textContent = lockMsg;
    document.getElementById('status-lock-hint').textContent = lockMsg;

    var picParts = rec ? (rec['Picture'] || '').split('\\n').filter(Boolean) : [];
    PIC_SLOTS.forEach(function (p, i) {
      document.getElementById(p + '-url').value = picParts[i] || '';
      updatePicturePreview(p + '-preview', picParts[i] || '');
      document.getElementById(p + '-hint').textContent = '';
    });

    var lotParts = rec ? (rec['Lot Plan'] || '').split('\\n').filter(Boolean) : [];
    LOT_SLOTS.forEach(function (p, i) {
      document.getElementById(p + '-url').value = lotParts[i] || '';
      updatePicturePreview(p + '-preview', lotParts[i] || '');
      document.getElementById(p + '-hint').textContent = '';
    });

    document.getElementById('form-overlay').classList.remove('hidden');
  }

  function closeForm() {
    document.getElementById('form-overlay').classList.add('hidden');
  }

  document.getElementById('form-cancel').addEventListener('click', closeForm);

  function updatePicturePreview(imgId, url) {
    var img = document.getElementById(imgId);
    if (url) {
      img.src = url;
      img.style.display = 'block';
    } else {
      img.removeAttribute('src');
      img.style.display = 'none';
    }
  }

  PIC_SLOTS.concat(LOT_SLOTS).forEach(function (p) {
    document.getElementById(p + '-url').addEventListener('input', function (e) {
      updatePicturePreview(p + '-preview', e.target.value);
    });
  });

  function compressImageFile(file) {
    var maxDim = 1800;
    var quality = 0.87;
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error('Could not read file')); };
      reader.onload = function () {
        var img = new Image();
        img.onerror = function () { reject(new Error('Could not read image')); };
        img.onload = function () {
          var scale = Math.min(1, maxDim / Math.max(img.width, img.height));
          var canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(img.width * scale));
          canvas.height = Math.max(1, Math.round(img.height * scale));
          var ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function handleFileInput(inputEl, urlInputId, previewId, hintId) {
    inputEl.addEventListener('change', function () {
      var file = inputEl.files && inputEl.files[0];
      if (!file) return;
      var hint = document.getElementById(hintId);
      hint.textContent = 'Compressing photo...';
      compressImageFile(file).then(function (dataUrl) {
        hint.textContent = 'Uploading photo...';
        return fetch('/api/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dataUrl: dataUrl }),
        }).then(function (r) {
          if (!r.ok) return r.json().then(function (e) { throw new Error(e.error || 'Upload failed'); });
          return r.json();
        });
      }).then(function (result) {
        document.getElementById(urlInputId).value = result.url;
        updatePicturePreview(previewId, result.url);
        hint.textContent = 'Photo uploaded.';
      }).catch(function (err) {
        hint.textContent = 'Failed to upload photo: ' + err.message;
      });
      inputEl.value = '';
    });
  }
  function wireSlot(p, label) {
    handleFileInput(document.getElementById(p + '-camera'), p + '-url', p + '-preview', p + '-hint');
    handleFileInput(document.getElementById(p + '-file'), p + '-url', p + '-preview', p + '-hint');
    document.getElementById(p + '-remove').addEventListener('click', function () {
      var input = document.getElementById(p + '-url');
      if (!input.value) {
        document.getElementById(p + '-hint').textContent = 'No ' + label + ' to remove.';
        return;
      }
      if (!confirm('Remove the ' + label + '? It will be cleared when you click Save.')) return;
      input.value = '';
      updatePicturePreview(p + '-preview', '');
      document.getElementById(p + '-hint').textContent = 'Photo removed. Click Save to apply.';
    });
  }
  PIC_SLOTS.forEach(function (p, i) { wireSlot(p, 'Picture Photo ' + (i + 1)); });
  LOT_SLOTS.forEach(function (p, i) { wireSlot(p, 'Lot Plan Photo ' + (i + 1)); });

  function deleteRecord(row) {
    if (!confirm('Delete this site record? This cannot be undone.')) return;
    fetch('/api/data/' + row, { method: 'DELETE' })
      .then(function (r) {
        if (r.status === 401) { showLogin(); throw new Error('Session expired'); }
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
    record['Picture'] = PIC_SLOTS.map(function (p) { return document.getElementById(p + '-url').value; })
      .filter(Boolean).join('\\n');
    record['Lot Plan'] = LOT_SLOTS.map(function (p) { return document.getElementById(p + '-url').value; })
      .filter(Boolean).join('\\n');

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
        if (r.status === 401) { showLogin(); throw new Error('Session expired'); }
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

  function renderAllCarousels() {
    Object.keys(CAROUSELS).forEach(renderCarousel);
  }

  function renderCarousel(key) {
    var state = CAROUSELS[key];
    var rows = filteredFor(key);
    var titleEl = document.getElementById(key + '-title');
    var counterEl = document.getElementById(key + '-counter');
    var cardEl = document.getElementById(key + '-card');
    var prevBtn = document.querySelector('.carousel-prev[data-carousel="' + key + '"]');
    var nextBtn = document.querySelector('.carousel-next[data-carousel="' + key + '"]');
    var editBtn = document.querySelector('.carousel-edit-btn[data-carousel="' + key + '"]');

    if (!rows.length) {
      titleEl.textContent = 'Site';
      counterEl.textContent = '0 / 0';
      cardEl.innerHTML = '<div class="status-msg">No sites in this list.</div>';
      prevBtn.disabled = true;
      nextBtn.disabled = true;
      editBtn.style.display = 'none';
      return;
    }
    editBtn.style.display = isVisitor() ? 'none' : '';

    if (state.index < 0) state.index = 0;
    if (state.index > rows.length - 1) state.index = rows.length - 1;

    var rec = rows[state.index];
    titleEl.textContent = 'Site #' + (rec['No'] || (state.index + 1));
    counterEl.textContent = (state.index + 1) + ' / ' + rows.length;
    prevBtn.disabled = state.index === 0;
    nextBtn.disabled = state.index === rows.length - 1;

    var infoFields = ['Size', 'Rate', 'Lease Term', 'Lease Type', 'Frontage', 'Store Format', 'Nearest PG', 'Competitors', 'Status'];
    var visited = (rec['Visited'] || '').toLowerCase();
    var visitedBadge = visited === 'yes'
      ? '<span class="badge badge-yes">Yes</span>'
      : (visited === 'no' ? '<span class="badge badge-no">No</span>' : '');

    var pics = (rec['Picture'] || '').split('\\n').filter(Boolean);
    var mainPic = pics[0] || '';
    var photoHtml = mainPic
      ? '<img class="carousel-photo-img" src="' + escapeHtml(mainPic) + '" alt="Site photo" data-action="view-img" data-url="' + escapeHtml(mainPic) + '" style="cursor:zoom-in" />'
      : '';
    var noPhotoFallback = '<div class="no-photo carousel-no-photo" ' + (mainPic ? 'style="display:none"' : '') + '>No photo available</div>';
    var picBtnsHtml = pics.length > 1
      ? '<div class="lotplan-btns">' + pics.map(function (u, i) {
          return '<button type="button" class="lotplan-btn" data-action="view-img" data-url="' + escapeHtml(u) + '">View Photo ' + (i + 1) + '</button>';
        }).join('') + '</div>'
      : '';

    var infoItemsHtml = infoFields.map(function (f) {
      return '<div class="info-item"><label>' + escapeHtml(f) + '</label><div class="val">' + (escapeHtml(rec[f]) || '&mdash;') + '</div></div>';
    }).join('') + '<div class="info-item"><label>Visited</label><div class="val">' + (visitedBadge || '&mdash;') + '</div></div>';

    var remarksHtml = '<div class="info-item full"><label>Remarks</label><div class="val">' + (escapeHtml(rec['Remarks']) || '&mdash;') + '</div></div>' +
      '<div class="info-item full"><label>Update</label><div class="val">' + (escapeHtml(rec['Update']) || '&mdash;') + '</div></div>';

    var mapSrc = mapEmbedSrc(rec);
    var mapHtml = mapSrc
      ? '<iframe src="' + escapeHtml(mapSrc) + '" loading="lazy" allowfullscreen></iframe>'
      : '<div class="no-map">No address or map link available for this site.</div>';

    var mapLinkHref = rec['Google Map Link'] || (rec['Address'] ? 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(rec['Address']) : '');

    var lotPlanUrls = (rec['Lot Plan'] || '').split('\\n').filter(Boolean).slice(0, 3);
    var lotPlanBtnsHtml = lotPlanUrls.length
      ? '<div class="lotplan-btns">' + lotPlanUrls.map(function (u, i) {
          return '<button type="button" class="lotplan-btn" data-action="view-img" data-url="' + escapeHtml(u) + '">View Lot Plan ' + (i + 1) + '</button>';
        }).join('') + '</div>'
      : '';

    cardEl.innerHTML =
      '<div class="card-top">' +
        '<div class="card-photo">' + photoHtml + noPhotoFallback + '</div>' +
        '<div class="card-info">' +
          '<h3>' + escapeHtml(rec['Address'] || 'No address') + '</h3>' +
          '<div class="address">No. ' + escapeHtml(rec['No']) + '</div>' +
          '<div class="info-grid">' + infoItemsHtml + remarksHtml + '</div>' +
          picBtnsHtml +
          lotPlanBtnsHtml +
          '<a class="map-link' + (mapLinkHref ? '' : ' disabled') + '" href="' + escapeHtml(mapLinkHref) + '" target="_blank" rel="noopener">Open in Google Maps</a>' +
        '</div>' +
      '</div>' +
      '<div class="card-map">' + mapHtml + '</div>';

    var photoImg = cardEl.querySelector('.carousel-photo-img');
    if (photoImg) {
      photoImg.addEventListener('error', function () {
        photoImg.style.display = 'none';
        var fallback = cardEl.querySelector('.carousel-no-photo');
        if (fallback) fallback.style.display = 'block';
      });
    }
  }

  document.addEventListener('click', function (e) {
    var prev = e.target.closest('.carousel-prev');
    var next = e.target.closest('.carousel-next');
    var edit = e.target.closest('.carousel-edit-btn');
    if (prev) { var k = prev.getAttribute('data-carousel'); CAROUSELS[k].index -= 1; renderCarousel(k); }
    else if (next) { var k2 = next.getAttribute('data-carousel'); CAROUSELS[k2].index += 1; renderCarousel(k2); }
    else if (edit) {
      var k3 = edit.getAttribute('data-carousel');
      var rows = filteredFor(k3);
      if (rows[CAROUSELS[k3].index]) openForm(rows[CAROUSELS[k3].index]);
    }
  });

  fetch('/api/me')
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (user) { if (user) showApp(user); else showLogin(); })
    .catch(function () { showLogin(); });
})();
</script>
</body>
</html>`;
