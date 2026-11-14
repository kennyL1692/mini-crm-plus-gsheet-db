(() => {
  'use strict';

  const API_URL = ((window.CRM_CONFIG && window.CRM_CONFIG.API_URL) || '').trim();
  const DEMO = !API_URL;
  const STATUSES = ['Lead', 'Prospect', 'Customer', 'Lost'];
  const STATUS_COLORS = { Lead: '#1a73e8', Prospect: '#f9ab00', Customer: '#1e8e3e', Lost: '#d93025' };
  const AVATAR_COLORS = ['#1a73e8', '#d93025', '#f9ab00', '#1e8e3e', '#9334e6', '#e8710a', '#12b5cb', '#e52592'];
  const CACHE_KEY = 'minicrm.cache.v1.' + (DEMO ? 'demo' : API_URL);
  const DEMO_KEY = 'minicrm.demo.v1';
  const UNDO_MS = 5000;
  const SESSION_KEY = 'minicrm.session.v1.' + (DEMO ? 'demo' : API_URL);
  const SESSION_MS = 6 * 60 * 60 * 1000;

  /* ---------- Small helpers ---------- */
  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
  };
  const initials = (name) => (name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  const colorFor = (s) => { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return AVATAR_COLORS[h % AVATAR_COLORS.length]; };
  const telHref = (p) => 'tel:' + String(p).replace(/[^\d+]/g, '');

  /* ---------- Session (login pass) ---------- */
  const session = {
    get() {
      const s = store.get(SESSION_KEY);
      return s && s.token && s.exp > Date.now() ? s : null;
    },
    token() { const s = this.get(); return s ? s.token : ''; },
    save(token) { store.set(SESSION_KEY, { token, exp: Date.now() + SESSION_MS }); },
    touch() { const s = this.get(); if (s) this.save(s.token); }, // server extends it on each use too
    clear() { try { localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ } },
  };

  class AuthError extends Error {}

  /* ---------- API: Apps Script or local demo ---------- */
  const remoteApi = {
    async call(action, payload) {
      let res;
      try {
        // text/plain avoids the CORS "preflight" that Apps Script cannot answer.
        res = await fetch(API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify(Object.assign({ action, token: session.token() }, payload)),
        });
      } catch {
        throw new Error('Cannot reach the server. Check your internet.');
      }
      let json;
      try { json = await res.json(); } catch { throw new Error('Server sent a bad reply. Check the Apps Script deployment.'); }
      if (!json.ok) {
        if (json.code === 'AUTH') throw new AuthError(json.error || 'Please log in again.');
        throw new Error(json.error || 'Something went wrong.');
      }
      if (action !== 'login' && action !== 'logout') session.touch();
      return json.data;
    },
    async login(password) { return this.call('login', { password }); },
    logout() { return this.call('logout').catch(() => {}); },
    list() { return this.call('list'); },
    create(contact) { return this.call('create', { contact }); },
    update(contact) { return this.call('update', { contact }); },
    remove(id) { return this.call('delete', { id }); },
  };

  const localApi = {
    wait() { return new Promise((r) => setTimeout(r, 250)); },
    read() {
      let data = store.get(DEMO_KEY);
      if (!Array.isArray(data)) { data = seedData(); store.set(DEMO_KEY, data); }
      return data;
    },
    async login(password) {
      await this.wait();
      if (password !== 'demo') throw new Error('Wrong password.');
      return { token: 'demo-token' };
    },
    async logout() {},
    async list() { await this.wait(); return this.read(); },
    async create(c) {
      await this.wait();
      if (!c.name || !c.name.trim()) throw new Error('Name is required.');
      const now = new Date().toISOString();
      const item = Object.assign({}, c, { id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()), created_at: now, updated_at: now });
      store.set(DEMO_KEY, [...this.read(), item]);
      return item;
    },
    async update(c) {
      await this.wait();
      const data = this.read();
      const i = data.findIndex((x) => x.id === c.id);
      if (i < 0) throw new Error('Contact not found.');
      data[i] = Object.assign({}, data[i], c, { updated_at: new Date().toISOString() });
      store.set(DEMO_KEY, data);
      return data[i];
    },
    async remove(id) {
      await this.wait();
      store.set(DEMO_KEY, this.read().filter((x) => x.id !== id));
      return { id };
    },
  };

  function seedData() {
    const d = (days) => new Date(Date.now() - days * 864e5).toISOString();
    const rows = [
      ['Aisyah Rahman', 'Bunga Florist Sdn Bhd', '012-345 6789', 'aisyah@bungaflorist.my', 'Customer', 'Instagram', 'Monthly order for office flowers.', 1],
      ['Tan Wei Ming', 'TWM Renovation', '016-228 9910', 'weiming@twmreno.my', 'Prospect', 'Facebook', 'Wants quote for 3 shop lots in Puchong.', 2],
      ['Priya Nair', 'Nair Dental Clinic', '03-7781 2234', 'priya@nairdental.my', 'Lead', 'Website', 'Asked about booking system.', 3],
      ['Hafiz Ismail', 'Kopi Hafiz', '019-887 1122', 'hafiz@kopihafiz.my', 'Customer', 'Referral', 'Referred by Aisyah. Pays on time.', 5],
      ['Lim Mei Ling', 'Mei Ling Bakery', '017-556 4433', 'meiling@mlbakery.my', 'Lead', 'TikTok', 'Saw our video. Call back Friday.', 6],
      ['Ravi Kumar', 'RK Logistics', '012-990 7788', 'ravi@rklogistics.my', 'Lost', 'Walk-in', 'Went with cheaper option.', 12],
    ];
    return rows.map((r, i) => ({
      id: 'demo-' + (i + 1), name: r[0], company: r[1], phone: r[2], email: r[3],
      status: r[4], source: r[5], notes: r[6], created_at: d(r[7] + 3), updated_at: d(r[7]),
    }));
  }

  const api = DEMO ? localApi : remoteApi;

  /* ---------- State ---------- */
  const state = {
    contacts: [],
    filter: 'All',
    query: '',
    pendingDeletes: new Map(), // id -> timeout
    editing: null,
    busy: 0,
    loaded: false, // true after the first successful load
    loading: false,
    epoch: 0,      // goes up on every log out, so late server replies are ignored
  };

  /* ---------- Rendering ---------- */
  function visibleContacts() {
    return state.contacts.filter((c) => !state.pendingDeletes.has(c.id));
  }

  function render() {
    const all = visibleContacts();
    const counts = { All: all.length };
    STATUSES.forEach((s) => { counts[s] = all.filter((c) => c.status === s).length; });

    $('#stats').innerHTML = STATUSES.map((s) => `
      <div class="stat" style="--c:${STATUS_COLORS[s]}">
        <div class="stat-label">${s}</div>
        <div class="stat-value">${counts[s]}</div>
      </div>`).join('');

    $('#chips').innerHTML = ['All', ...STATUSES].map((s) => {
      const on = state.filter === s;
      return `<button class="chip" role="tab" type="button" data-filter="${s}" aria-selected="${on}">
        ${on ? '<span class="material-symbols-rounded">check</span>' : ''}${s} <span class="chip-count">${counts[s]}</span>
      </button>`;
    }).join('');

    const q = state.query.toLowerCase();
    const rows = all
      .filter((c) => state.filter === 'All' || c.status === state.filter)
      .filter((c) => !q || [c.name, c.company, c.phone, c.email, c.notes].some((v) => String(v || '').toLowerCase().includes(q)))
      .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));

    if (!rows.length && !state.loaded && state.loading) {
      $('#list').innerHTML = `<ul class="cards skeleton" aria-label="Loading contacts">${'<li class="card"><div class="avatar"></div><div class="card-main"><div class="sk sk-1"></div><div class="sk sk-2"></div></div></li>'.repeat(4)}</ul>
        <p class="loading-text">Loading contacts…</p>`;
      return;
    }

    if (!rows.length) {
      const none = all.length === 0;
      $('#list').innerHTML = `<div class="empty">
        <span class="material-symbols-rounded">${none ? 'person_add' : 'search_off'}</span>
        <h3>${none ? 'No contacts yet' : 'No matching contacts'}</h3>
        <p>${none ? 'Tap “New contact” to add your first one.' : 'Try another search or filter.'}</p>
      </div>`;
      return;
    }

    const actions = (c) => `
      ${c.phone ? `<a class="icon-btn" href="${esc(telHref(c.phone))}" aria-label="Call ${esc(c.name)}" data-stop><span class="material-symbols-rounded">call</span></a>` : ''}
      ${c.email ? `<a class="icon-btn" href="mailto:${esc(c.email)}" aria-label="Email ${esc(c.name)}" data-stop><span class="material-symbols-rounded">mail</span></a>` : ''}`;

    const cards = rows.map((c) => `
      <li class="card${c._saving ? ' saving' : ''}" data-id="${esc(c.id)}" tabindex="0">
        <div class="avatar" style="--av:${colorFor(c.name)}">${esc(initials(c.name))}</div>
        <div class="card-main">
          <div class="card-name">${esc(c.name)}</div>
          <div class="card-sub">${esc(c.company || c.email || c.phone || '—')}</div>
          <div class="card-meta">
            <span class="status status-${esc(c.status)}">${esc(c.status)}</span>
            ${c.source ? `<span class="source">via ${esc(c.source)}</span>` : ''}
          </div>
        </div>
        <div class="card-actions">${actions(c)}</div>
      </li>`).join('');

    const tableRows = rows.map((c) => `
      <tr class="${c._saving ? 'saving' : ''}" data-id="${esc(c.id)}" tabindex="0">
        <td><div class="name-cell"><div class="avatar" style="--av:${colorFor(c.name)}">${esc(initials(c.name))}</div><span>${esc(c.name)}</span></div></td>
        <td class="muted">${esc(c.company)}</td>
        <td>${c.phone ? `<a href="${esc(telHref(c.phone))}" data-stop>${esc(c.phone)}</a>` : ''}</td>
        <td>${c.email ? `<a href="mailto:${esc(c.email)}" data-stop>${esc(c.email)}</a>` : ''}</td>
        <td><span class="status status-${esc(c.status)}">${esc(c.status)}</span></td>
        <td class="muted">${esc(c.source)}</td>
      </tr>`).join('');

    $('#list').innerHTML = `
      <ul class="cards">${cards}</ul>
      <div class="table-wrap"><table>
        <colgroup><col style="width:24%"><col style="width:20%"><col style="width:15%"><col style="width:22%"><col style="width:10%"><col style="width:9%"></colgroup>
        <thead><tr><th>Name</th><th>Company</th><th>Phone</th><th>Email</th><th>Status</th><th>Source</th></tr></thead>
        <tbody>${tableRows}</tbody>
      </table></div>`;
  }

  function setBusy(delta) {
    state.busy = Math.max(0, state.busy + delta);
    $('#progress').hidden = state.busy === 0;
  }

  function saveCache() {
    store.set(CACHE_KEY, state.contacts.filter((c) => !c._saving && !String(c.id).startsWith('tmp-')));
  }

  /* ---------- Snackbar ---------- */
  let snackTimer;
  function toast(text, actionLabel, onAction) {
    const bar = $('#snackbar');
    const btn = $('#snackbar-action');
    $('#snackbar-text').textContent = text;
    btn.hidden = !actionLabel;
    btn.textContent = actionLabel || '';
    btn.onclick = () => { hideToast(); onAction && onAction(); };
    bar.classList.add('show');
    clearTimeout(snackTimer);
    snackTimer = setTimeout(hideToast, actionLabel ? UNDO_MS : 3500);
  }
  function hideToast() { $('#snackbar').classList.remove('show'); }

  /* ---------- Data actions ---------- */
  async function load() {
    const epoch = state.epoch;
    setBusy(1);
    state.loading = true;
    render();
    try {
      const list = await api.list();
      if (epoch !== state.epoch) return; // logged out meanwhile
      state.contacts = list;
      state.loaded = true;
      saveCache();
      render();
    } catch (err) {
      if (epoch !== state.epoch) return;
      if (err instanceof AuthError) return expired();
      toast(err.message, 'Retry', load);
    } finally {
      setBusy(-1);
      if (epoch === state.epoch) {
        state.loading = false;
        render();
      }
    }
  }

  async function saveContact(data) {
    const existing = state.editing;
    const snapshot = state.contacts.slice();
    const now = new Date().toISOString();
    const tempId = 'tmp-' + Date.now();

    // Update the screen first, save in the background.
    if (existing) {
      state.contacts = state.contacts.map((c) => (c.id === existing.id ? Object.assign({}, c, data, { _saving: true, updated_at: now }) : c));
    } else {
      state.contacts = [Object.assign({ id: tempId, created_at: now, updated_at: now, _saving: true }, data), ...state.contacts];
    }
    closeDialog();
    render();
    setBusy(1);
    const epoch = state.epoch;

    try {
      const saved = existing
        ? await api.update(Object.assign({}, data, { id: existing.id, updated_at: existing.updated_at }))
        : await api.create(data);
      if (epoch !== state.epoch) return;
      const targetId = existing ? existing.id : tempId;
      state.contacts = state.contacts.map((c) => (c.id === targetId ? saved : c));
      saveCache();
      render();
      toast(existing ? 'Contact updated' : 'Contact added');
    } catch (err) {
      if (epoch !== state.epoch) return;
      state.contacts = snapshot;
      render();
      if (err instanceof AuthError) return expired();
      toast(err.message);
    } finally {
      setBusy(-1);
    }
  }

  function requestDelete(contact) {
    closeDialog();
    const timer = setTimeout(() => commitDelete(contact.id), UNDO_MS);
    state.pendingDeletes.set(contact.id, timer);
    render();
    toast(`Deleted ${contact.name}`, 'Undo', () => {
      clearTimeout(timer);
      state.pendingDeletes.delete(contact.id);
      render();
    });
  }

  async function commitDelete(id) {
    const epoch = state.epoch;
    setBusy(1);
    try {
      await api.remove(id);
      if (epoch !== state.epoch) return;
      state.contacts = state.contacts.filter((c) => c.id !== id);
      saveCache();
    } catch (err) {
      if (epoch !== state.epoch) return;
      if (err instanceof AuthError) expired();
      else toast(err.message);
    } finally {
      state.pendingDeletes.delete(id);
      setBusy(-1);
      render();
    }
  }

  // If the page closes during the "Undo" window, still send the delete.
  window.addEventListener('pagehide', () => {
    state.pendingDeletes.forEach((timer, id) => {
      clearTimeout(timer);
      if (DEMO) {
        store.set(DEMO_KEY, localApi.read().filter((x) => x.id !== id));
      } else if (navigator.sendBeacon) {
        navigator.sendBeacon(API_URL, new Blob([JSON.stringify({ action: 'delete', id, token: session.token() })], { type: 'text/plain;charset=utf-8' }));
      }
    });
  });

  /* ---------- Dialog ---------- */
  const dialog = $('#dialog');
  const form = $('#contact-form');

  function openDialog(contact) {
    state.editing = contact || null;
    form.reset();
    $('#form-error').hidden = true;
    form.querySelectorAll('.field.invalid').forEach((f) => f.classList.remove('invalid'));
    $('#dialog-title').textContent = contact ? 'Edit contact' : 'New contact';
    $('#delete-btn').hidden = !contact;
    if (contact) {
      ['name', 'company', 'phone', 'email', 'status', 'source', 'notes'].forEach((k) => { form.elements[k].value = contact[k] || ''; });
      if (!form.elements.status.value) form.elements.status.value = 'Lead';
    }
    dialog.showModal();
    if (!contact) form.elements.name.focus();
  }

  function closeDialog() {
    if (dialog.open) dialog.close();
    state.editing = null;
  }

  function showFormError(msg, fieldName) {
    const el = $('#form-error');
    el.textContent = msg;
    el.hidden = false;
    if (fieldName) {
      form.elements[fieldName].closest('.field').classList.add('invalid');
      form.elements[fieldName].focus();
    }
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    form.querySelectorAll('.field.invalid').forEach((f) => f.classList.remove('invalid'));
    const data = {};
    ['name', 'company', 'phone', 'email', 'status', 'source', 'notes'].forEach((k) => { data[k] = form.elements[k].value.trim(); });
    if (!data.name) return showFormError('Please enter a name.', 'name');
    if (data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) return showFormError('That email looks wrong.', 'email');
    saveContact(data);
  });

  // Clear the error as soon as the user starts fixing it.
  form.addEventListener('input', (e) => {
    const f = e.target.closest('.field');
    if (f && f.classList.contains('invalid')) {
      f.classList.remove('invalid');
      $('#form-error').hidden = true;
    }
  });

  dialog.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) closeDialog();
    else if (e.target === dialog) closeDialog(); // click on backdrop
  });
  dialog.addEventListener('close', () => { state.editing = null; });
  $('#delete-btn').addEventListener('click', () => { if (state.editing) requestDelete(state.editing); });

  /* ---------- Events ---------- */
  $('#fab').addEventListener('click', () => openDialog(null));
  $('#refresh-btn').addEventListener('click', load);

  let searchTimer;
  $('#search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.query = e.target.value.trim(); render(); }, 120);
  });

  $('#chips').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-filter]');
    if (!chip) return;
    state.filter = chip.dataset.filter;
    render();
  });

  const openFromList = (e) => {
    if (e.target.closest('[data-stop]')) return; // let call/email links work
    const row = e.target.closest('[data-id]');
    if (!row) return;
    const c = state.contacts.find((x) => x.id === row.dataset.id);
    if (c && !c._saving) openDialog(c);
  };
  $('#list').addEventListener('click', openFromList);
  $('#list').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.target.closest('a')) return;
    e.preventDefault(); // stop this Enter from also "clicking" a button inside the form
    openFromList(e);
  });

  /* ---------- Login / logout ---------- */
  function showLogin(message) {
    document.body.classList.add('logged-out');
    $('#login-view').hidden = false;
    $('#demo-hint').hidden = !DEMO;
    const err = $('#login-error');
    err.hidden = !message;
    err.textContent = message || '';
    $('#password').value = '';
    setTimeout(() => $('#password').focus(), 50);
  }

  function showApp() {
    document.body.classList.remove('logged-out');
    $('#login-view').hidden = true;
    state.contacts = store.get(CACHE_KEY) || [];
    render();
    load();
  }

  function clearLocalData() {
    state.epoch += 1;
    state.loading = false;
    session.clear();
    try { localStorage.removeItem(CACHE_KEY); } catch { /* ignore */ }
    state.contacts = [];
    state.loaded = false;
    state.pendingDeletes.forEach((t) => clearTimeout(t));
    state.pendingDeletes.clear();
    closeDialog();
    hideToast();
  }

  function expired() {
    clearLocalData();
    showLogin('Your session ended. Please sign in again.');
  }

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pw = $('#password').value;
    const err = $('#login-error');
    const btn = $('#login-btn');
    if (!pw) { err.textContent = 'Please enter the password.'; err.hidden = false; return; }
    btn.disabled = true;
    btn.textContent = 'Signing in…';
    err.hidden = true;
    try {
      const res = await api.login(pw);
      session.save(res.token);
      showApp();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
      $('#password').select();
    } finally {
      btn.disabled = false;
      btn.textContent = 'Sign in';
    }
  });

  $('#toggle-pw').addEventListener('click', () => {
    const input = $('#password');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    $('#toggle-pw').setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    $('#toggle-pw .material-symbols-rounded').textContent = show ? 'visibility_off' : 'visibility';
    input.focus();
  });

  $('#logout-btn').addEventListener('click', async () => {
    // Finish any waiting deletes first so they are not lost.
    const waiting = [];
    state.pendingDeletes.forEach((timer, id) => { clearTimeout(timer); waiting.push(commitDelete(id)); });
    hideToast();
    await Promise.all(waiting);
    api.logout();
    clearLocalData();
    showLogin();
  });

  /* ---------- Start ---------- */
  $('#demo-banner').hidden = !DEMO;
  if (session.get()) showApp();
  else showLogin();
})();
