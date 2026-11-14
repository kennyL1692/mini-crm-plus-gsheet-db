/**
 * Mini CRM — Google Apps Script backend
 *
 * How to use:
 * 1. Open your Google Sheet → Extensions → Apps Script.
 * 2. Paste this whole file into Code.gs and save.
 * 3. Deploy → New deployment → Web app
 *      Execute as: Me
 *      Who has access: Anyone
 * 4. Copy the Web App URL into public/config.js (API_URL).
 * 5. Set the login password:
 *      Select the "setup" function at the top and click Run once.
 *      A "Settings" tab appears in your Sheet. Type your password in the
 *      cell next to APP_PASSWORD.
 *
 * To change the password later, just edit that cell (no redeploy needed).
 * Changing it logs everyone out straight away.
 * (Optional: if the Settings cell is empty, the APP_PASSWORD Script Property
 *  under Project Settings is used instead.)
 *
 * When you change this code later, use
 * Deploy → Manage deployments → Edit (pencil) → Version: New version
 * so the URL stays the same.
 */

const SHEET_NAME = 'Contacts';
const SETTINGS_SHEET = 'Settings';
const HEADERS = ['id', 'name', 'company', 'phone', 'email', 'status', 'source', 'notes', 'created_at', 'updated_at'];
const EDITABLE = ['name', 'company', 'phone', 'email', 'status', 'source', 'notes'];
const STATUSES = ['Lead', 'Prospect', 'Customer', 'Lost'];
const MAX_LEN = { notes: 2000, default: 200 };
const SESSION_SECONDS = 6 * 60 * 60; // 6 hours (the most CacheService allows)
const MAX_FAILS = 10;                 // wrong tries allowed...
const FAIL_WINDOW_SECONDS = 10 * 60;  // ...within 10 minutes

/* ---------- Entry points ---------- */

function doGet() {
  return json_({ ok: true, data: { service: 'Mini CRM API', status: 'running' } });
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'Bad request.' });
  }
  return handle_(body);
}

function handle_(body) {
  try {
    if (body.action === 'login') return json_({ ok: true, data: login_(body.password) });
    if (body.action === 'logout') {
      if (body.token) CacheService.getScriptCache().remove('sess_' + body.token);
      return json_({ ok: true, data: {} });
    }
    if (!checkSession_(body.token)) {
      return json_({ ok: false, code: 'AUTH', error: 'Please log in again.' });
    }

    const sheet = getSheet_();
    switch (body.action) {
      case 'list':
        return json_({ ok: true, data: listContacts_(sheet) });
      case 'create':
        return withLock_(() => json_({ ok: true, data: createContact_(sheet, body.contact || {}) }));
      case 'update':
        return withLock_(() => json_({ ok: true, data: updateContact_(sheet, body.contact || {}) }));
      case 'delete':
        return withLock_(() => json_({ ok: true, data: deleteContact_(sheet, body.id) }));
      default:
        return json_({ ok: false, error: 'Unknown action.' });
    }
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) });
  }
}

/* ---------- Setup + password ---------- */

// Run this once from the Apps Script editor to create the tabs.
function setup() {
  getSheet_();
  getSettingsSheet_();
}

function getSettingsSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SETTINGS_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(SETTINGS_SHEET);
    sheet.getRange(1, 1, 3, 3).setValues([
      ['setting', 'value', 'note'],
      ['APP_PASSWORD', '', 'Type your login password in column B. Changing it logs everyone out.'],
      ['', '', 'Anyone who can open this Sheet can see the password. Only share the Sheet with people you trust.'],
    ]);
    sheet.getRange('B:B').setNumberFormat('@'); // keep passwords like 001234 as typed
    sheet.getRange(1, 1, 1, 3).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// Password from the Settings tab first, then the Script Property as a backup.
function getPassword_() {
  const values = getSettingsSheet_().getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0]).trim() === 'APP_PASSWORD') {
      const v = String(values[i][1] == null ? '' : values[i][1]).trim();
      if (v) return v;
    }
  }
  return PropertiesService.getScriptProperties().getProperty('APP_PASSWORD') || '';
}

/* ---------- Login ---------- */

function login_(password) {
  const real = getPassword_();
  if (!real) {
    throw new Error('Password not set up yet. Open the Settings tab in your Google Sheet and type a password next to APP_PASSWORD.');
  }
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get('login_fails') || 0);
  if (fails >= MAX_FAILS) throw new Error('Too many wrong tries. Please wait 10 minutes.');

  if (!safeEqual_(String(password == null ? '' : password), real)) {
    cache.put('login_fails', String(fails + 1), FAIL_WINDOW_SECONDS);
    Utilities.sleep(800); // slow down guessing
    throw new Error('Wrong password.');
  }

  const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  cache.put('sess_' + token, fingerprint_(real), SESSION_SECONDS);
  return { token: token, expires_in: SESSION_SECONDS };
}

// Valid session? Each use extends it by another 6 hours.
// Sessions are tied to the current password, so changing APP_PASSWORD logs everyone out at once.
function checkSession_(token) {
  if (!token || typeof token !== 'string' || token.length > 100) return false;
  const real = getPassword_();
  if (!real) return false;
  const cache = CacheService.getScriptCache();
  const key = 'sess_' + token;
  const fp = fingerprint_(real);
  if (cache.get(key) !== fp) return false;
  cache.put(key, fp, SESSION_SECONDS);
  return true;
}

function fingerprint_(password) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, 'minicrm:' + password, Utilities.Charset.UTF_8);
  return bytes.slice(0, 12).map(b => ((b + 256) % 256).toString(16).padStart(2, '0')).join('');
}

// Compare passwords without leaking timing info.
function safeEqual_(a, b) {
  const ha = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, a, Utilities.Charset.UTF_8);
  const hb = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, b, Utilities.Charset.UTF_8);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha[i] ^ hb[i];
  return diff === 0;
}

/* ---------- CRUD ---------- */

function listContacts_(sheet) {
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const cols = colIndex_(values[0]);
  return values.slice(1)
    .filter(row => row[cols.id] !== '' && row[cols.id] != null)
    .map(row => rowToContact_(row, cols));
}

function createContact_(sheet, input) {
  const clean = validate_(input);
  const now = new Date().toISOString();
  const contact = Object.assign({ id: Utilities.getUuid(), created_at: now, updated_at: now }, clean);
  const cols = colIndex_(sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]);
  const row = new Array(sheet.getLastColumn()).fill('');
  HEADERS.forEach(h => { if (cols[h] != null) row[cols[h]] = toCell_(contact[h]); });
  sheet.appendRow(row);
  return contact;
}

function updateContact_(sheet, input) {
  if (!input.id) throw new Error('Missing contact id.');
  const found = findRow_(sheet, input.id);
  if (!found) throw new Error('Contact not found. It may have been deleted.');

  const current = rowToContact_(found.row, found.cols);
  if (input.updated_at && current.updated_at && input.updated_at !== current.updated_at) {
    throw new Error('Someone else changed this contact. Please refresh and try again.');
  }

  const clean = validate_(input);
  const updated = Object.assign({}, current, clean, { updated_at: new Date().toISOString() });
  const rowValues = found.row.slice();
  HEADERS.forEach(h => { if (found.cols[h] != null) rowValues[found.cols[h]] = toCell_(updated[h]); });
  sheet.getRange(found.rowNumber, 1, 1, rowValues.length).setValues([rowValues]);
  return updated;
}

function deleteContact_(sheet, id) {
  if (!id) throw new Error('Missing contact id.');
  const found = findRow_(sheet, id);
  if (!found) return { id: id }; // already gone — treat as success
  sheet.deleteRow(found.rowNumber);
  return { id: id };
}

/* ---------- Helpers ---------- */

function getSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
  }
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  // Make sure every expected column exists (read by header name, not position).
  const header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const missing = HEADERS.filter(h => header.indexOf(h) === -1);
  if (missing.length) {
    sheet.getRange(1, header.length + 1, 1, missing.length).setValues([missing]).setFontWeight('bold');
  }
  return sheet;
}

function colIndex_(headerRow) {
  const cols = {};
  headerRow.forEach((h, i) => { cols[String(h).trim()] = i; });
  return cols;
}

function rowToContact_(row, cols) {
  const c = {};
  HEADERS.forEach(h => {
    let v = cols[h] != null ? row[cols[h]] : '';
    if (v instanceof Date) v = v.toISOString();
    c[h] = v == null ? '' : String(v);
  });
  return c;
}

function findRow_(sheet, id) {
  const values = sheet.getDataRange().getValues();
  const cols = colIndex_(values[0]);
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][cols.id]) === String(id)) {
      return { rowNumber: i + 1, row: values[i], cols: cols };
    }
  }
  return null;
}

function validate_(input) {
  const out = {};
  EDITABLE.forEach(k => {
    const max = MAX_LEN[k] || MAX_LEN.default;
    out[k] = String(input[k] == null ? '' : input[k]).trim().slice(0, max);
  });
  if (!out.name) throw new Error('Name is required.');
  if (out.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email)) throw new Error('Email looks wrong.');
  if (STATUSES.indexOf(out.status) === -1) out.status = 'Lead';
  return out;
}

// Store everything as plain text: keeps leading zeros on phone numbers
// (e.g. 0123456789) and stops values like "=SUM(...)" running as formulas.
function toCell_(v) {
  const s = v == null ? '' : String(v);
  return s === '' ? '' : "'" + s;
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) throw new Error('Server is busy. Please try again.');
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
