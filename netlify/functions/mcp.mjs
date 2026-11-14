// MCP server for the Mini CRM — lets an AI assistant (Claude etc.) search, add,
// update and delete contacts in the Google Sheet, through the same Apps Script.
//
// Netlify environment variables (mark them as secret):
//   MCP_API_KEYS          who may connect, as name:key pairs, e.g. "kenny:abc...,aisyah:def..."
//   APPS_SCRIPT_URL       the Web App URL ending in /exec
//   APPS_SCRIPT_API_KEY   same value as API_KEY in the Sheet's Settings tab
//
// Clients send their key as "Authorization: Bearer <key>", or as ?key=<key> in
// the URL for apps that only let you paste a URL (e.g. claude.ai connectors).

import { createHash, timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createCrm } from '../lib/crm.mjs';
import { registerTools } from '../lib/tools.mjs';

const env = (k) => (globalThis.Netlify && globalThis.Netlify.env ? globalThis.Netlify.env.get(k) : process.env[k]);
const sha = (s) => createHash('sha256').update(String(s)).digest();

// Returns the person's name for a valid key, or null.
export function whoIsCalling(req, keysSetting = env('MCP_API_KEYS')) {
  const url = new URL(req.url);
  const bearer = (req.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
  const given = (bearer ? bearer[1] : url.searchParams.get('key') || '').trim();
  if (!given || given.length > 200 || !keysSetting) return null;
  const g = sha(given);
  let who = null;
  for (const pair of keysSetting.split(',')) {
    const i = pair.indexOf(':');
    const name = pair.slice(0, i).trim();
    const key = pair.slice(i + 1).trim();
    if (i < 1 || key.length < 24) continue; // ignore badly formatted or short keys
    if (timingSafeEqual(g, sha(key)) && !who) who = name; // compare all, constant time
  }
  return who;
}

export function buildServer({ who, crm, log }) {
  const server = new McpServer(
    { name: 'mini-crm', version: '1.0.0' },
    { instructions: 'Mini CRM on a Google Sheet. Statuses: Lead → Prospect → Customer, or Lost. Search first to get ids. Before delete_contact always show the contact and get a clear yes from the user. If several contacts match the user\'s words, ask which one.' },
  );
  registerTools(server, crm, { who, log });
  return server;
}

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export default async (req) => {
  const who = whoIsCalling(req);
  if (!who) return json(401, { error: 'Unauthorized: missing or wrong MCP key.' });

  // Stateless JSON-only server: POST in, JSON out. A GET would try to open a
  // never-ending event stream, which a serverless function cannot hold open.
  if (req.method !== 'POST') return json(405, { error: 'Use POST (MCP Streamable HTTP).' });

  const crm = createCrm({ url: env('APPS_SCRIPT_URL'), apiKey: env('APPS_SCRIPT_API_KEY'), actor: who });
  const log = (entry) => console.info(JSON.stringify(Object.assign({ at: new Date().toISOString() }, entry)));
  const server = buildServer({ who, crm, log });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(req);
};

export const config = {
  path: '/mcp',
  rateLimit: { windowSize: 60, windowLimit: 120, aggregateBy: ['ip', 'domain'] },
};
