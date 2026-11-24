'use strict';

const $ = (id) => document.getElementById(id);
const Delta = Quill.import('delta');

const state = {
  user: null,
  users: [],
  quill: null,
  // Open document: { id, version, role, owner, title }. `version` is the last server op applied locally.
  doc: null,
  ot: null, // OTClient for the open document
  sendTimer: null,
  events: null,
  broken: false,
  clientId: Math.random().toString(36).slice(2) + Date.now().toString(36),
  presenceTimer: null,
};

// ---------- helpers ----------

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) node.setAttribute(k, v);
  }
  for (const c of children) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return node;
}

async function api(path, { method = 'GET', body, form } = {}) {
  const opts = { method, headers: {} };
  if (form) opts.body = form;
  else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, opts);
  } catch {
    throw Object.assign(new Error('Network error. Check your connection.'), { status: 0 });
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && path !== '/api/me') showLogin();
    throw Object.assign(new Error((data && data.error) || `Request failed (${res.status})`), { status: res.status, data });
  }
  return data;
}

let toastTimer;
function toast(msg, isError = false) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('error', isError);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), isError ? 5000 : 2500);
}

function timeAgo(iso) {
  const s = Math.round((Date.now() - new Date(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

const roleLabel = { owner: 'Owner', editor: 'Can edit', viewer: 'View only' };
const docUrl = (id, suffix = '') => `/api/documents/${encodeURIComponent(id)}${suffix}`;

function showView(id) {
  for (const v of ['loginView', 'listView', 'editorView']) $(v).hidden = v !== id;
}

// ---------- auth ----------

async function showLogin() {
  state.user = null;
  $('userbox').hidden = true;
  showView('loginView');
  const box = $('demoUsers');
  box.replaceChildren();
  const { users } = await api('/api/users');
  for (const u of users) {
    box.append(
      el('button', { class: 'btn demo-user', onclick: () => login(u.email) }, el('strong', {}, u.name), el('span', { class: 'muted small' }, u.email)),
    );
  }
}

async function login(email) {
  try {
    const { user } = await api('/api/login', { method: 'POST', body: { email } });
    setUser(user);
    location.hash = '#/';
    route();
  } catch (e) {
    toast(e.message, true);
  }
}

function setUser(user) {
  state.user = user;
  $('userName').textContent = `${user.name} (${user.email})`;
  $('userbox').hidden = false;
}

$('logoutBtn').addEventListener('click', async () => {
  await leaveDoc();
  await api('/api/logout', { method: 'POST' });
  location.hash = '#/';
  showLogin();
});

// ---------- document list ----------

function renderList(ul, docs, emptyText) {
  ul.replaceChildren();
  if (!docs.length) {
    ul.append(el('li', { class: 'empty' }, emptyText));
    return;
  }
  for (const d of docs) {
    const meta = d.role === 'owner' ? `Edited ${timeAgo(d.updatedAt)}` : `Owner: ${d.owner.name} · Edited ${timeAgo(d.updatedAt)}`;
    ul.append(
      el(
        'li',
        {},
        el(
          'a',
          { href: `#/doc/${encodeURIComponent(d.id)}` },
          el('span', { class: 'doc-title' }, d.title),
          el('span', { class: 'muted small' }, meta),
          el('span', { class: `badge ${d.role}` }, roleLabel[d.role]),
        ),
      ),
    );
  }
}

async function showList() {
  showView('listView');
  try {
    const { owned, shared } = await api('/api/documents');
    renderList($('ownedList'), owned, 'No documents yet. Create one or import a file.');
    renderList($('sharedList'), shared, 'Nothing has been shared with you yet.');
  } catch (e) {
    toast(e.message, true);
  }
}

$('newDocBtn').addEventListener('click', async () => {
  try {
    const { document: doc } = await api('/api/documents', { method: 'POST', body: {} });
    location.hash = `#/doc/${doc.id}`;
  } catch (e) {
    toast(e.message, true);
  }
});

$('importInput').addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) return toast('File too large (max 2 MB).', true);
  const form = new FormData();
  form.append('file', file);
  try {
    const { document: doc } = await api('/api/documents/import', { method: 'POST', form });
    toast(`Imported "${doc.title}"`);
    location.hash = `#/doc/${doc.id}`;
  } catch (e) {
    toast(e.message, true);
  }
});

// ---------- editor ----------

function getQuill() {
  if (state.quill) return state.quill;
  state.quill = new Quill('#editor', {
    theme: 'snow',
    placeholder: 'Start writing...',
    modules: {
      toolbar: [
        [{ header: [1, 2, 3, false] }],
        ['bold', 'italic', 'underline', 'strike'],
        [{ list: 'ordered' }, { list: 'bullet' }],
        ['blockquote', 'link'],
        ['clean'],
      ],
      // Undo only your own edits, never a collaborator's.
      history: { userOnly: true },
    },
  });
  state.quill.on('text-change', (delta, _old, source) => {
    if (source === 'user') onLocalChange(delta);
  });
  return state.quill;
}

function setStatus(text, isError = false) {
  const s = $('saveStatus');
  s.textContent = text;
  s.classList.toggle('error', isError);
}

function showBanner(text, { danger = false, action } = {}) {
  const b = $('banner');
  b.replaceChildren(el('span', {}, text));
  if (action) b.append(el('button', { class: 'btn btn-secondary', onclick: action.onClick }, action.label));
  b.classList.toggle('danger', danger);
  b.hidden = false;
}

function metaText(owner, updatedAt) {
  return `Owner: ${owner.name} · Last saved ${new Date(updatedAt).toLocaleString()}`;
}

function refreshStatus() {
  if (state.broken || !state.doc || state.doc.role === 'viewer') return;
  if (!state.ot.idle) setStatus('Saving...');
  else {
    setStatus('All changes saved');
    $('docMeta').textContent = metaText(state.doc.owner, new Date().toISOString());
  }
}

// ---------- real-time sync (OT client) ----------

function onLocalChange(delta) {
  if (!state.doc || state.broken) return;
  state.ot.applyLocal(delta);
  refreshStatus();
  scheduleSend(100);
}

function scheduleSend(ms) {
  if (!state.sendTimer) state.sendTimer = setTimeout(sendBuffer, ms);
}

async function sendBuffer() {
  state.sendTimer = null;
  const doc = state.doc;
  if (!doc || state.broken || !state.ot.takeSend()) return;
  await postPending(doc);
}

// The ack arrives over the event stream (keeps ordering); the POST only reports errors.
async function postPending(doc) {
  const ot = state.ot;
  try {
    await api(docUrl(doc.id, '/ops'), { method: 'POST', body: ot.outgoing() });
  } catch (e) {
    if (state.doc !== doc) return;
    if (e.status === 0 || e.status >= 500) {
      // Same seq on retry, so the server ignores it if the first attempt actually landed.
      setStatus('Connection lost. Retrying...', true);
      setTimeout(() => state.ot === ot && ot.pending && postPending(doc), 2000);
    } else if (e.status === 403) {
      resync('Your access changed.');
    } else {
      resync(e.message);
    }
  }
}

function onServerOp(entry) {
  if (!state.doc || state.broken) return;
  const result = state.ot.receive(entry);
  if (result.type === 'gap') return resync('Fell out of sync.');
  if (result.type === 'ack' && state.ot.buffer) scheduleSend(0);
  if (result.type === 'remote') state.quill.updateContents(result.delta, 'api');
  if (result.type !== 'ignore' && state.ot.idle) refreshStatus();
}

function connectEvents(doc) {
  const es = new EventSource(docUrl(doc.id, `/events?since=${state.ot.version}`));
  state.events = es;
  const live = () => state.events === es && state.doc === doc;
  es.addEventListener('op', (e) => live() && onServerOp(JSON.parse(e.data)));
  es.addEventListener('title', (e) => {
    if (!live()) return;
    const { title } = JSON.parse(e.data);
    doc.title = title;
    if (document.activeElement !== $('titleInput')) $('titleInput').value = title;
  });
  es.addEventListener('resync', () => live() && resync('The document was replaced.'));
  es.addEventListener('reload', () => live() && resync('Your access changed.'));
  es.addEventListener('gone', () => {
    if (!live()) return;
    disconnect();
    state.broken = true;
    state.quill.enable(false);
    stopPresence();
    showBanner('You no longer have access to this document.', {
      danger: true,
      action: { label: 'Back to documents', onClick: () => (location.hash = '#/') },
    });
  });
  es.onopen = () => live() && refreshStatus();
  es.onerror = () => {
    if (!live()) return;
    if (es.readyState === EventSource.CLOSED) resync('Lost connection.');
    else setStatus('Reconnecting...', true);
  };
}

function disconnect() {
  if (state.events) state.events.close();
  state.events = null;
  clearTimeout(state.sendTimer);
  state.sendTimer = null;
}

function resync(reason) {
  const doc = state.doc;
  if (!doc || state.broken) return;
  const lost = !state.ot.idle;
  state.broken = true;
  disconnect();
  toast(`${reason} Reloaded the latest version${lost ? '; your last few keystrokes may be missing' : ''}.`, !!lost);
  openDoc(doc.id);
}

/** Wait (briefly) for unsent edits to reach the server before leaving a document. */
async function drain(timeoutMs = 2500) {
  if (state.ot.buffer && !state.ot.pending) await sendBuffer();
  const start = Date.now();
  while (!state.ot.idle && !state.broken && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

// ---------- presence ----------

const AVATAR_COLORS = ['#2563eb', '#db2777', '#059669', '#d97706', '#7c3aed'];

function renderPresence(active) {
  $('presence').replaceChildren(
    ...active.map(({ user, role }) => {
      const initials = user.name.split(' ').map((p) => p[0]).join('').slice(0, 2);
      const color = AVATAR_COLORS[[...user.id].reduce((a, c) => a + c.charCodeAt(0), 0) % AVATAR_COLORS.length];
      const label = `${user.name} is here (${roleLabel[role] || role})`;
      return el('span', { class: 'avatar', title: label, 'aria-label': label, style: `background:${color}` }, initials);
    }),
  );
}

function stopPresence() {
  clearInterval(state.presenceTimer);
  state.presenceTimer = null;
  $('presence').replaceChildren();
}

async function heartbeat() {
  const doc = state.doc;
  if (!doc) return;
  try {
    const data = await api(docUrl(doc.id, '/presence'), { method: 'POST' });
    if (state.doc === doc) renderPresence(data.active);
  } catch {
    // Presence is best-effort; the event stream reports real access problems.
  }
}

function startPresence() {
  stopPresence();
  heartbeat();
  state.presenceTimer = setInterval(heartbeat, 4000);
}

async function leaveDoc() {
  const doc = state.doc;
  if (!doc) return;
  await drain();
  disconnect();
  stopPresence();
  state.doc = null;
  fetch(docUrl(doc.id, '/presence'), { method: 'DELETE', keepalive: true }).catch(() => {});
}

// ---------- open document ----------

async function openDoc(id) {
  if (state.doc && state.doc.id !== id) await leaveDoc();
  disconnect();
  showView('editorView');
  const quill = getQuill();
  Object.assign(state, { doc: null, broken: false });
  $('banner').hidden = true;
  quill.setContents([], 'silent');
  quill.history.clear();
  quill.enable(false);
  setStatus('Loading...');

  let data;
  try {
    data = await api(docUrl(id));
  } catch (e) {
    setStatus('');
    showBanner(e.message, { danger: true, action: { label: 'Back to documents', onClick: () => (location.hash = '#/') } });
    return;
  }

  let { document: doc, role, owner } = data;
  const canEdit = role !== 'viewer';

  if (!doc.content && doc.importedHtml && canEdit) {
    // Imported files arrive as sanitized HTML; convert once to a Delta and persist it.
    const content = quill.clipboard.convert({ html: doc.importedHtml });
    try {
      ({ document: doc } = await api(docUrl(id), { method: 'PATCH', body: { content, baseVersion: doc.version } }));
    } catch (e) {
      toast(`Could not save imported content: ${e.message}`, true);
      doc = { ...doc, content };
    }
  }

  state.doc = { id: doc.id, role, owner, title: doc.title };
  state.ot = new OTClient({ Delta, version: doc.version, clientId: state.clientId });
  $('titleInput').value = doc.title;
  $('titleInput').disabled = !canEdit;
  $('roleBadge').textContent = roleLabel[role];
  $('roleBadge').className = `badge ${role}`;
  $('shareBtn').hidden = role !== 'owner';
  $('deleteBtn').hidden = role !== 'owner';
  $('docMeta').textContent = metaText(owner, doc.updatedAt);
  quill.getModule('toolbar').container.hidden = !canEdit;

  quill.setContents(doc.content || [{ insert: '\n' }], 'silent');
  quill.history.clear();
  quill.enable(canEdit);
  if (!canEdit) showBanner(`You have view-only access. Ask ${owner.name} for edit access. Changes by others appear live.`);
  setStatus(canEdit ? 'All changes saved' : '');
  if (canEdit && quill.getLength() <= 1) quill.focus();
  connectEvents(state.doc);
  startPresence();
}

// ---------- title ----------

async function commitTitle() {
  const input = $('titleInput');
  const doc = state.doc;
  if (!doc || doc.role === 'viewer') return;
  const title = input.value.trim();
  if (!title) {
    input.value = doc.title;
    return toast('Title cannot be empty.', true);
  }
  if (title === doc.title) return;
  const previous = doc.title;
  doc.title = title;
  input.value = title;
  try {
    await api(docUrl(doc.id), { method: 'PATCH', body: { title } });
  } catch (e) {
    if (state.doc !== doc) return;
    doc.title = previous;
    input.value = previous;
    toast(`Rename failed: ${e.message}`, true);
  }
}

$('titleInput').addEventListener('blur', commitTitle);
$('titleInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    e.target.blur();
  } else if (e.key === 'Escape') {
    e.target.value = state.doc ? state.doc.title : '';
    e.target.blur();
  }
});

$('deleteBtn').addEventListener('click', async () => {
  const doc = state.doc;
  if (!doc || !confirm(`Delete "${doc.title}"? This cannot be undone.`)) return;
  disconnect();
  stopPresence();
  state.doc = null;
  try {
    await api(docUrl(doc.id), { method: 'DELETE' });
    toast('Document deleted');
    location.hash = '#/';
  } catch (e) {
    toast(e.message, true);
    openDoc(doc.id);
  }
});

window.addEventListener('beforeunload', (e) => {
  if (state.ot && !state.ot.idle) {
    sendBuffer();
    e.preventDefault();
    e.returnValue = '';
  }
});

// ---------- sharing ----------

function renderShares(shares) {
  const doc = state.doc;
  const list = $('shareList');
  list.replaceChildren(
    el('li', {}, el('span', { class: 'who' }, `${doc.owner.name} (${doc.owner.email})`), el('span', { class: 'badge owner' }, 'Owner')),
  );
  for (const s of shares) {
    const roleSelect = el(
      'select',
      { 'aria-label': `Role for ${s.user.name}`, onchange: (e) => share(s.user.email, e.target.value) },
      el('option', { value: 'editor' }, 'Can edit'),
      el('option', { value: 'viewer' }, 'Can view'),
    );
    roleSelect.value = s.role;
    list.append(
      el(
        'li',
        {},
        el('span', { class: 'who' }, `${s.user.name} (${s.user.email})`),
        roleSelect,
        el('button', { class: 'btn btn-danger-ghost', onclick: () => unshare(s.user.id) }, 'Remove'),
      ),
    );
  }

  const taken = new Set([doc.owner.id, ...shares.map((s) => s.user.id)]);
  const available = state.users.filter((u) => !taken.has(u.id));
  const select = $('shareUser');
  select.replaceChildren(
    ...(available.length
      ? available.map((u) => el('option', { value: u.email }, `${u.name} (${u.email})`))
      : [el('option', { value: '' }, 'Everyone already has access')]),
  );
  select.disabled = !available.length;
  $('shareForm').querySelector('button').disabled = !available.length;
}

async function share(email, role) {
  $('shareError').hidden = true;
  try {
    const { shares } = await api(docUrl(state.doc.id, '/shares'), { method: 'PUT', body: { email, role } });
    renderShares(shares);
    toast('Sharing updated');
  } catch (e) {
    $('shareError').textContent = e.message;
    $('shareError').hidden = false;
  }
}

async function unshare(userId) {
  try {
    const { shares } = await api(docUrl(state.doc.id, `/shares/${encodeURIComponent(userId)}`), { method: 'DELETE' });
    renderShares(shares);
    toast('Access removed');
  } catch (e) {
    toast(e.message, true);
  }
}

$('shareBtn').addEventListener('click', async () => {
  $('shareError').hidden = true;
  try {
    const [{ users }, { shares }] = await Promise.all([
      state.users.length ? { users: state.users } : api('/api/users'),
      api(docUrl(state.doc.id, '/shares')),
    ]);
    state.users = users;
    renderShares(shares);
    $('shareDialog').showModal();
  } catch (e) {
    toast(e.message, true);
  }
});

$('shareForm').addEventListener('submit', (e) => {
  e.preventDefault();
  share($('shareUser').value, $('shareRole').value);
});

// ---------- routing ----------

async function route() {
  if (!state.user) return;
  const m = location.hash.match(/^#\/doc\/(.+)$/);
  if (m) {
    openDoc(decodeURIComponent(m[1]));
  } else {
    await leaveDoc();
    showList();
  }
}

window.addEventListener('hashchange', route);

(async function init() {
  try {
    const { user } = await api('/api/me');
    setUser(user);
    route();
  } catch {
    showLogin();
  }
})();
