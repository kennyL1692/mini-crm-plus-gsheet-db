import { z } from 'zod';

export const STATUSES = ['Lead', 'Prospect', 'Customer', 'Lost'];
const FIELDS = ['name', 'company', 'phone', 'email', 'status', 'source', 'notes'];

/* ---------- helpers ---------- */

const ok = (data) => ({ content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] });
const fail = (msg) => ({ content: [{ type: 'text', text: msg }], isError: true });
const digits = (s) => String(s || '').replace(/\D/g, '');
const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const daysAgo = (iso, now) => (now - Date.parse(iso)) / 864e5;
const brief = (c) => ({ id: c.id, name: c.name, company: c.company, phone: c.phone, email: c.email, status: c.status, source: c.source, notes: c.notes, updated_at: c.updated_at });

// Phone match ignores spaces/dashes and a leading +60 / 60 country code.
function samePhone(a, b) {
  const x = digits(a).replace(/^60/, '0');
  const y = digits(b).replace(/^60/, '0');
  return x.length >= 7 && x === y;
}

function findDuplicates(all, c) {
  return all.filter((x) =>
    (c.phone && samePhone(x.phone, c.phone)) ||
    (c.email && norm(x.email) === norm(c.email)) ||
    (norm(x.name) === norm(c.name) && norm(x.company) === norm(c.company)));
}

async function findById(crm, id) {
  const all = await crm.list();
  return all.find((c) => c.id === id) || null;
}

/* ---------- tools ---------- */

export function registerTools(server, crm, { who = 'mcp', log = () => {} } = {}) {
  const wrap = (name, fn) => async (args) => {
    try {
      const out = await fn(args || {});
      log({ tool: name, who, id: args && args.id, ok: !out.isError });
      return out;
    } catch (err) {
      log({ tool: name, who, id: args && args.id, ok: false, error: err.message });
      return fail(err.message);
    }
  };

  server.registerTool('search_contacts', {
    title: 'Search contacts',
    description: 'Find contacts in the CRM. All filters are optional and combine with AND. Use this first to get a contact\'s id before updating or deleting. Returns the newest-updated first.',
    inputSchema: {
      query: z.string().max(200).optional().describe('Text to match in name, company, phone, email or notes (not case-sensitive). Phone digits match ignoring spaces/dashes.'),
      status: z.enum(STATUSES).optional().describe('Only contacts with this status.'),
      source: z.string().max(50).optional().describe('Only contacts from this source, e.g. Facebook, Instagram, TikTok, WhatsApp, Website, Referral, Walk-in, Other.'),
      not_updated_days: z.number().int().min(1).max(3650).optional().describe('Only contacts NOT updated in at least this many days (for follow-ups).'),
      limit: z.number().int().min(1).max(100).optional().describe('Max results to return (default 20).'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, wrap('search_contacts', async ({ query, status, source, not_updated_days, limit = 20 }) => {
    const all = await crm.list();
    const now = Date.now();
    const q = norm(query);
    const qd = digits(query);
    const rows = all
      .filter((c) => !status || c.status === status)
      .filter((c) => !source || norm(c.source) === norm(source))
      .filter((c) => !not_updated_days || !c.updated_at || daysAgo(c.updated_at, now) >= not_updated_days)
      .filter((c) => !q || [c.name, c.company, c.email, c.notes, c.phone].some((v) => norm(v).includes(q)) || (qd.length >= 4 && samePhoneContains(c.phone, qd)))
      .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    return ok({ total_matches: rows.length, showing: Math.min(rows.length, limit), contacts: rows.slice(0, limit).map(brief) });
  }));

  server.registerTool('get_contact', {
    title: 'Get one contact',
    description: 'Get the full details of one contact by its id (from search_contacts).',
    inputSchema: { id: z.string().min(1).max(100).describe('The contact id.') },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, wrap('get_contact', async ({ id }) => {
    const c = await findById(crm, id);
    return c ? ok(c) : fail(`No contact with id ${id}. Use search_contacts to find the right id.`);
  }));

  server.registerTool('add_contact', {
    title: 'Add contact',
    description: 'Add a new contact (lead) to the CRM. Checks for duplicates by phone, email, or same name + company. If a possible duplicate is found nothing is saved: show the match to the user and ask whether to update the existing contact instead, or add anyway with allow_duplicate=true.',
    inputSchema: {
      name: z.string().trim().min(1).max(200).describe('Person\'s full name (required).'),
      company: z.string().max(200).optional(),
      phone: z.string().max(50).optional().describe('Phone as the user gave it, e.g. 012-345 6789.'),
      email: z.string().max(200).optional(),
      status: z.enum(STATUSES).optional().describe('Defaults to Lead.'),
      source: z.string().max(50).optional().describe('Where they came from: Facebook, Instagram, TikTok, WhatsApp, Website, Referral, Walk-in, Other.'),
      notes: z.string().max(2000).optional(),
      allow_duplicate: z.boolean().optional().describe('Set true only after the user confirms they want a second entry.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, wrap('add_contact', async (args) => {
    const contact = {};
    FIELDS.forEach((k) => { if (args[k] != null) contact[k] = String(args[k]).trim(); });
    contact.status = contact.status || 'Lead';
    if (contact.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email)) return fail('That email looks wrong. Ask the user to check it.');
    if (!args.allow_duplicate) {
      const dups = findDuplicates(await crm.list(), contact);
      if (dups.length) {
        return ok({ saved: false, reason: 'Possible duplicate. Nothing was saved. Ask the user: update the existing contact, or add anyway (allow_duplicate=true)?', possible_duplicates: dups.slice(0, 5).map(brief) });
      }
    }
    const saved = await crm.create(contact);
    return ok({ saved: true, contact: saved });
  }));

  server.registerTool('update_contact', {
    title: 'Update contact',
    description: 'Change details of an existing contact. Only the fields you pass are changed. Use append_note to add a dated note without losing old notes; use notes only to replace all notes. If several contacts could match the user\'s words, ask which one first.',
    inputSchema: {
      id: z.string().min(1).max(100).describe('The contact id (from search_contacts).'),
      name: z.string().trim().min(1).max(200).optional(),
      company: z.string().max(200).optional(),
      phone: z.string().max(50).optional(),
      email: z.string().max(200).optional(),
      status: z.enum(STATUSES).optional(),
      source: z.string().max(50).optional(),
      notes: z.string().max(2000).optional().describe('Replaces ALL existing notes.'),
      append_note: z.string().min(1).max(500).optional().describe('Adds a new line "[YYYY-MM-DD] text" to the end of the notes.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, wrap('update_contact', async (args) => {
    const current = await findById(crm, args.id);
    if (!current) return fail(`No contact with id ${args.id}. Use search_contacts to find the right id.`);
    const next = { id: current.id, updated_at: current.updated_at };
    FIELDS.forEach((k) => { next[k] = current[k] || ''; });
    const changed = [];
    FIELDS.forEach((k) => {
      if (args[k] != null && String(args[k]).trim() !== String(current[k] || '')) { next[k] = String(args[k]).trim(); changed.push(k); }
    });
    if (args.append_note) {
      const line = `[${new Date().toISOString().slice(0, 10)}] ${args.append_note.trim()}`;
      next.notes = (next.notes ? next.notes + '\n' : '') + line;
      if (next.notes.length > 2000) return fail('Notes would be longer than 2,000 characters. Ask the user to shorten or replace the old notes.');
      if (!changed.includes('notes')) changed.push('notes');
    }
    if (next.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next.email)) return fail('That email looks wrong. Ask the user to check it.');
    if (!changed.length) return ok({ saved: false, reason: 'Nothing to change: the values are already the same.', contact: current });
    const saved = await crm.update(next);
    return ok({ saved: true, changed_fields: changed, contact: saved });
  }));

  server.registerTool('delete_contact', {
    title: 'Delete contact',
    description: 'Delete a contact from the CRM. BEFORE calling: show the user the contact\'s name, company and phone, and ask them to confirm the delete. Only call after the user clearly says yes. confirm_name must be the contact\'s exact name as stored, or nothing is deleted. The contact is moved to the "Deleted" tab of the Google Sheet, so the owner can restore it by hand if needed.',
    inputSchema: {
      id: z.string().min(1).max(100).describe('The contact id (from search_contacts).'),
      confirm_name: z.string().min(1).max(200).describe('The contact\'s name exactly as stored. A safety check against deleting the wrong person.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, wrap('delete_contact', async ({ id, confirm_name }) => {
    const current = await findById(crm, id);
    if (!current) return fail(`No contact with id ${id}. It may already be deleted.`);
    if (norm(confirm_name) !== norm(current.name)) {
      return fail(`Not deleted: confirm_name "${confirm_name}" does not match the stored name "${current.name}". Check with the user that this is the right person.`);
    }
    const removed = await crm.remove(id);
    return ok({ deleted: true, moved_to: 'Deleted tab in the Google Sheet', contact: brief(removed && removed.name ? removed : current) });
  }));

  server.registerTool('pipeline_summary', {
    title: 'Pipeline summary',
    description: 'Overview of the CRM: totals by status and by source, new contacts in the last 7 and 30 days, and Leads/Prospects that need a follow-up (not updated for stale_days).',
    inputSchema: {
      stale_days: z.number().int().min(1).max(365).optional().describe('Days without an update before a Lead/Prospect counts as needing follow-up (default 14).'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, wrap('pipeline_summary', async ({ stale_days = 14 }) => {
    const all = await crm.list();
    const now = Date.now();
    const count = (key) => all.reduce((m, c) => { const k = c[key] || '(none)'; m[k] = (m[k] || 0) + 1; return m; }, {});
    const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    Object.assign(byStatus, count('status'));
    const stale = all
      .filter((c) => (c.status === 'Lead' || c.status === 'Prospect') && c.updated_at && daysAgo(c.updated_at, now) >= stale_days)
      .sort((a, b) => String(a.updated_at).localeCompare(String(b.updated_at)));
    const closed = byStatus.Customer + byStatus.Lost;
    return ok({
      total_contacts: all.length,
      by_status: byStatus,
      by_source: count('source'),
      win_rate_of_closed: closed ? `${Math.round((byStatus.Customer / closed) * 100)}%` : 'n/a',
      new_last_7_days: all.filter((c) => c.created_at && daysAgo(c.created_at, now) <= 7).length,
      new_last_30_days: all.filter((c) => c.created_at && daysAgo(c.created_at, now) <= 30).length,
      needs_follow_up: { count: stale.length, stale_days, oldest_first: stale.slice(0, 15).map((c) => ({ id: c.id, name: c.name, company: c.company, status: c.status, days_since_update: Math.floor(daysAgo(c.updated_at, now)) })) },
    });
  }));
}

function samePhoneContains(phone, qd) {
  const p = digits(phone).replace(/^60/, '0');
  const q = qd.replace(/^60/, '0');
  return p.includes(q);
}
