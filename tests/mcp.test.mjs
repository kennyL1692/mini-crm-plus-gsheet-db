// End-to-end: real MCP client → MCP function → Apps Script code (in a fake Sheet).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createAppsScript } from './helpers/apps-script-mock.mjs';

const KEY_KENNY = 'k'.repeat(10) + '-kenny-test-key-1234567890';
const KEY_STAFF = 's'.repeat(10) + '-staff-test-key-1234567890';
const SHEET_KEY = 'sheet-api-key-0123456789abcdef';
const SCRIPT_URL = 'https://script.example/macros/s/test/exec';
const MCP_URL = 'https://crm.example/mcp';

let gas, handler, whoIsCalling;

before(async () => {
  gas = createAppsScript();
  gas.setSetting('APP_PASSWORD', 'web-pass');
  gas.setSetting('API_KEY', SHEET_KEY);
  process.env.MCP_API_KEYS = `kenny:${KEY_KENNY}, staff:${KEY_STAFF}, short:abc`;
  process.env.APPS_SCRIPT_URL = SCRIPT_URL;
  process.env.APPS_SCRIPT_API_KEY = SHEET_KEY;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => (String(url).startsWith('https://script.example') ? gas.fetchImpl(url, opts) : realFetch(url, opts));
  ({ default: handler, whoIsCalling } = await import('../netlify/functions/mcp.mjs'));
  // seed a few contacts through the web-style API
  const token = gas.post({ action: 'login', password: 'web-pass' }).data.token;
  for (const c of [
    { name: 'Aisyah Rahman', company: 'Bunga Florist', phone: '012-345 6789', email: 'aisyah@bunga.my', status: 'Customer', source: 'Instagram' },
    { name: 'Tan Wei Ming', company: 'TWM Reno', phone: '016-228 9910', status: 'Prospect', source: 'Facebook' },
    { name: 'Ali Hassan', company: 'Ali Motors', phone: '019-111 2222', status: 'Lead', source: 'TikTok' },
    { name: 'Ali Bakar', company: 'Bakar Catering', phone: '017-333 4444', status: 'Lead', source: 'Facebook' },
  ]) gas.post({ action: 'create', token, contact: c });
  // make one Lead look 30 days old
  const g = gas.sheets.Contacts.grid; const col = g[0].indexOf('updated_at');
  g[3][col] = new Date(Date.now() - 30 * 864e5).toISOString();
});

async function connect(key = KEY_KENNY, { inUrl = false } = {}) {
  const url = new URL(MCP_URL); if (inUrl) url.searchParams.set('key', key);
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: inUrl ? {} : { headers: { Authorization: `Bearer ${key}` } },
    fetch: (u, init) => handler(new Request(u, init)),
  });
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(transport);
  return client;
}
const call = async (client, name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { error: !!r.isError, text: r.content[0].text, data: (() => { try { return JSON.parse(r.content[0].text); } catch { return null; } })() };
};

test('rejects missing, wrong and too-short keys', async () => {
  const req = (h = {}, q = '') => new Request(MCP_URL + q, { method: 'POST', headers: h, body: '{}' });
  assert.equal((await handler(req())).status, 401);
  assert.equal((await handler(req({ Authorization: 'Bearer nope-nope-nope-nope-nope-nope' }))).status, 401);
  assert.equal((await handler(req({}, '?key=abc'))).status, 401, 'short keys are ignored');
  assert.equal(whoIsCalling(req({ Authorization: `Bearer ${KEY_STAFF}` })), 'staff');
  assert.equal((await handler(new Request(MCP_URL, { method: 'GET', headers: { Authorization: `Bearer ${KEY_KENNY}` } }))).status, 405);
});

test('lists the 6 tools with correct safety hints', async () => {
  const c = await connect();
  const { tools } = await c.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['add_contact', 'delete_contact', 'get_contact', 'pipeline_summary', 'search_contacts', 'update_contact']);
  const del = tools.find((t) => t.name === 'delete_contact');
  assert.equal(del.annotations.destructiveHint, true);
  assert.match(del.description, /confirm/i);
  assert.equal(tools.find((t) => t.name === 'search_contacts').annotations.readOnlyHint, true);
});

test('key in URL (?key=) works for URL-only clients', async () => {
  const c = await connect(KEY_STAFF, { inUrl: true });
  const r = await call(c, 'search_contacts', { query: 'aisyah' });
  assert.equal(r.data.total_matches, 1);
});

test('search: by text, phone digits, status, source and follow-up age', async () => {
  const c = await connect();
  assert.equal((await call(c, 'search_contacts', { query: 'ali' })).data.total_matches, 2);
  assert.equal((await call(c, 'search_contacts', { query: '0123456789' })).data.contacts[0].name, 'Aisyah Rahman');
  assert.equal((await call(c, 'search_contacts', { query: '+60 12-345 6789' })).data.total_matches, 1);
  assert.equal((await call(c, 'search_contacts', { status: 'Lead' })).data.total_matches, 2);
  assert.equal((await call(c, 'search_contacts', { source: 'facebook' })).data.total_matches, 2);
  const stale = await call(c, 'search_contacts', { not_updated_days: 14 });
  assert.equal(stale.data.total_matches, 1);
  assert.equal((await call(c, 'search_contacts', { limit: 1 })).data.showing, 1);
});

test('add: saves, and blocks duplicates unless confirmed', async () => {
  const c = await connect();
  const a = await call(c, 'add_contact', { name: 'Siti Nur', company: 'Kedai Bunga', phone: '012-888 1234', source: 'TikTok' });
  assert.equal(a.data.saved, true);
  assert.equal(a.data.contact.status, 'Lead');
  assert.equal(a.data.contact.phone, '012-888 1234', 'phone keeps its leading zero');
  const dup = await call(c, 'add_contact', { name: 'Siti N.', phone: '+60 12 888 1234' });
  assert.equal(dup.data.saved, false);
  assert.equal(dup.data.possible_duplicates[0].name, 'Siti Nur');
  const forced = await call(c, 'add_contact', { name: 'Siti N.', phone: '+60 12 888 1234', allow_duplicate: true });
  assert.equal(forced.data.saved, true);
  const bad = await call(c, 'add_contact', { name: 'X', email: 'not-an-email' });
  assert.equal(bad.error, true);
});

test('update: changes only given fields, appends dated notes', async () => {
  const c = await connect();
  const id = (await call(c, 'search_contacts', { query: 'Tan Wei' })).data.contacts[0].id;
  const u = await call(c, 'update_contact', { id, status: 'Customer', append_note: 'Paid deposit RM500' });
  assert.equal(u.data.saved, true);
  assert.deepEqual(u.data.changed_fields.sort(), ['notes', 'status']);
  assert.match(u.data.contact.notes, /^\[\d{4}-\d{2}-\d{2}\] Paid deposit RM500$/);
  assert.equal(u.data.contact.company, 'TWM Reno', 'other fields untouched');
  const u2 = await call(c, 'update_contact', { id, append_note: 'Second visit' });
  assert.equal(u2.data.contact.notes.split('\n').length, 2, 'old note kept');
  const same = await call(c, 'update_contact', { id, status: 'Customer' });
  assert.equal(same.data.saved, false);
  assert.equal((await call(c, 'update_contact', { id: 'nope', status: 'Lost' })).error, true);
});

test('delete: refuses wrong name, moves to Deleted tab with who did it', async () => {
  const c = await connect();
  const id = (await call(c, 'search_contacts', { query: 'Ali Bakar' })).data.contacts[0].id;
  const wrong = await call(c, 'delete_contact', { id, confirm_name: 'Ali Hassan' });
  assert.equal(wrong.error, true);
  assert.match(wrong.text, /Not deleted/);
  assert.equal((await call(c, 'search_contacts', { query: 'Ali Bakar' })).data.total_matches, 1, 'still there');
  const del = await call(c, 'delete_contact', { id, confirm_name: '  ali bakar ' });
  assert.equal(del.data.deleted, true);
  assert.equal((await call(c, 'search_contacts', { query: 'Ali Bakar' })).data.total_matches, 0);
  const bin = gas.sheets.Deleted.grid;
  assert.deepEqual(bin[0].slice(-2), ['deleted_at', 'deleted_by']);
  const row = bin.find((r) => r[1] === 'Ali Bakar');
  assert.ok(row, 'row is in the Deleted tab');
  assert.equal(row[row.length - 1], 'ai:kenny');
  assert.equal(row[3], '017-333 4444');
  assert.equal((await call(c, 'delete_contact', { id, confirm_name: 'Ali Bakar' })).error, true, 'second delete says already gone');
});

test('pipeline summary adds up', async () => {
  const c = await connect();
  const s = (await call(c, 'pipeline_summary')).data;
  const total = Object.values(s.by_status).reduce((a, b) => a + b, 0);
  assert.equal(total, s.total_contacts);
  assert.equal(s.needs_follow_up.count, 1);
  assert.equal(s.needs_follow_up.oldest_first[0].name, 'Ali Hassan');
  assert.ok(s.needs_follow_up.oldest_first[0].days_since_update >= 29);
});

test('website delete also goes to the Deleted tab', () => {
  const token = gas.post({ action: 'login', password: 'web-pass' }).data.token;
  const id = gas.post({ action: 'list', token }).data.find((c) => c.name === 'Siti N.').id;
  assert.equal(gas.post({ action: 'delete', token, id }).ok, true);
  const row = gas.sheets.Deleted.grid.find((r) => r[1] === 'Siti N.');
  assert.equal(row[row.length - 1], 'web');
});

test('changing the web password does not break the AI connection', async () => {
  gas.setSetting('APP_PASSWORD', 'brand-new-password');
  const c = await connect();
  assert.equal((await call(c, 'search_contacts', {})).error, false);
  gas.setSetting('APP_PASSWORD', 'web-pass');
});

test('Sheet API key: wrong or empty switches AI access off with a clear message', async () => {
  const c = await connect();
  gas.setSetting('API_KEY', 'a-different-key-0123456789abc');
  let r = await call(c, 'search_contacts', {});
  assert.equal(r.error, true);
  assert.match(r.text, /API key/);
  gas.setSetting('API_KEY', '');
  r = await call(c, 'pipeline_summary');
  assert.equal(r.error, true);
  gas.setSetting('API_KEY', 'too-short');
  assert.equal((await call(c, 'search_contacts', {})).error, true, 'keys under 24 chars are refused');
  gas.setSetting('API_KEY', SHEET_KEY);
  assert.equal((await call(c, 'search_contacts', {})).error, false);
});

test('API key cannot be used to log in to the website and vice versa', () => {
  assert.equal(gas.post({ action: 'login', password: SHEET_KEY }).ok, false);
  assert.equal(gas.post({ action: 'list', api_key: 'web-pass' }).code, 'AUTH');
});

test('missing Netlify settings give a clear setup message', async () => {
  const saved = process.env.APPS_SCRIPT_URL;
  delete process.env.APPS_SCRIPT_URL;
  const c = await connect();
  const r = await call(c, 'search_contacts', {});
  assert.equal(r.error, true);
  assert.match(r.text, /APPS_SCRIPT_URL/);
  process.env.APPS_SCRIPT_URL = saved;
});
