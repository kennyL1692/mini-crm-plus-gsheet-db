// Runs the real apps-script/Code.gs inside a fake Google Apps Script world,
// so tests exercise the same code that runs in Google.
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';

const strip = (v) => (typeof v === 'string' && v.startsWith("'") ? v.slice(1) : v);

function mkSheet() {
  const grid = [];
  return {
    grid,
    getLastRow: () => grid.length,
    getLastColumn: () => (grid[0] ? grid[0].length : 0),
    getRange: (r, c, nr, nc) => ({
      setValues(v) { v.forEach((row, i) => { grid[r - 1 + i] = grid[r - 1 + i] || []; row.forEach((x, j) => { grid[r - 1 + i][c - 1 + j] = strip(x); }); }); return this; },
      setFontWeight() { return this; },
      setNumberFormat() { return this; },
      getValues() { return grid.slice(r - 1, r - 1 + nr).map((row) => row.slice(c - 1, c - 1 + nc)); },
    }),
    getDataRange: () => ({ getValues: () => grid.map((r) => r.slice()) }),
    appendRow: (row) => grid.push(row.map(strip)),
    deleteRow: (n) => grid.splice(n - 1, 1),
    setFrozenRows() {},
  };
}

export function createAppsScript(codePath = new URL('../../apps-script/Code.gs', import.meta.url)) {
  const sheets = {};
  const cache = {};
  let uid = 0;
  const ctx = {
    console,
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: (n) => sheets[n] || null, insertSheet: (n) => (sheets[n] = mkSheet()) }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
    CacheService: { getScriptCache: () => ({ get: (k) => cache[k] || null, put: (k, v) => { cache[k] = v; }, remove: (k) => { delete cache[k]; } }) },
    Utilities: {
      getUuid: () => `00000000-0000-4000-8000-${String(++uid).padStart(12, '0')}`,
      sleep() {},
      DigestAlgorithm: { SHA_256: 1 },
      Charset: { UTF_8: 1 },
      computeDigest: (a, v) => [...crypto.createHash('sha256').update(v).digest()].map((b) => (b > 127 ? b - 256 : b)),
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (s) => ({ setMimeType() { return s; } }) },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(codePath, 'utf8'), ctx);
  ctx.setup();

  const setSetting = (key, value) => {
    const g = sheets.Settings.grid;
    const row = g.find((r) => r[0] === key);
    if (row) row[1] = value; else g.push([key, value, '']);
  };
  const post = (body) => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(body) } }));

  // A fetch() look-alike for the Web App URL.
  const fetchImpl = async (_url, opts) => new Response(ctx.doPost({ postData: { contents: opts.body } }), { headers: { 'content-type': 'application/json' } });

  return { sheets, setSetting, post, fetchImpl };
}
