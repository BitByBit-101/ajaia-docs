'use strict';

const $ = (id) => document.getElementById(id);
const Delta = Quill.import('delta');

const state = {
  user: null,
  users: [],
  quill: null,
  // Live editing session for the open document; see "real-time sync" below.
  session: null,
  openSeq: 0,
  listSeq: 0,
  userEvents: null,
  clientId: Math.random().toString(36).slice(2) + Date.now().toString(36),
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
  toastTimer = setTimeout(() => (t.hidden = true), isError ? 5000 : 3500);
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
  leaveDoc();
  disconnectUserEvents();
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
  connectUserEvents();
}

$('logoutBtn').addEventListener('click', async () => {
  leaveDoc();
  disconnectUserEvents();
  await api('/api/logout', { method: 'POST' });
  location.hash = '#/';
  showLogin();
});

// Dashboard-level pushes: shared with you, access removed, renamed, deleted.
function connectUserEvents() {
  disconnectUserEvents();
  const es = new EventSource('/api/events');
  state.userEvents = es;
  es.addEventListener('docs', (e) => {
    const { message } = JSON.parse(e.data);
    if (message) toast(message);
    if (!$('listView').hidden) showList({ quiet: true });
  });
}

function disconnectUserEvents() {
  if (state.userEvents) state.userEvents.close();
  state.userEvents = null;
}

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

async function showList({ quiet = false } = {}) {
  showView('listView');
  const seq = ++state.listSeq;
  if (!quiet) {
    for (const id of ['ownedList', 'sharedList']) $(id).replaceChildren(el('li', { class: 'empty' }, 'Loading...'));
  }
  try {
    const { owned, shared } = await api('/api/documents');
    if (seq !== state.listSeq) return;
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
    renderCursors();
  });
  state.quill.on('selection-change', (range) => {
    if (range && state.session) scheduleCursor(state.session);
  });
  window.addEventListener('resize', renderCursors);
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

const backAction = { label: 'Back to documents', onClick: () => (location.hash = '#/') };

function metaText(owner, updatedAt) {
  return `Owner: ${owner.name} · Last saved ${new Date(updatedAt).toLocaleString()}`;
}

function refreshStatus() {
  const s = state.session;
  if (!s || s.broken || s.doc.role === 'viewer') return;
  if (!s.ot.idle) setStatus('Saving...');
  else {
    setStatus('All changes saved');
    $('docMeta').textContent = metaText(s.doc.owner, new Date().toISOString());
  }
}

// ---------- real-time sync (OT client) ----------
// A session owns one document's OT state and event stream. Leaving a document detaches the
// session from the UI immediately; it lives on in the background only until unsent edits land.

const isActive = (s) => s === state.session;

function onLocalChange(delta) {
  const s = state.session;
  if (!s || s.broken || s.doc.role === 'viewer') return;
  s.ot.applyLocal(delta);
  shiftCursors(delta);
  refreshStatus();
  scheduleSend(s, 60);
  scheduleCursor(s);
}

function scheduleSend(s, ms) {
  if (!s.sendTimer && !s.closed) s.sendTimer = setTimeout(() => sendBuffer(s), ms);
}

async function sendBuffer(s) {
  s.sendTimer = null;
  if (s.closed || s.broken || !s.ot.takeSend()) return maybeClose(s);
  await postPending(s);
}

// The ack arrives over the event stream (keeps ordering); the POST only reports errors.
async function postPending(s) {
  try {
    await api(docUrl(s.doc.id, '/ops'), { method: 'POST', body: s.ot.outgoing() });
  } catch (e) {
    if (s.closed) return;
    if (e.status === 0 || e.status >= 500) {
      // Same seq on retry, so the server ignores it if the first attempt actually landed.
      if (isActive(s)) setStatus('Connection lost. Retrying...', true);
      setTimeout(() => !s.closed && s.ot.pending && postPending(s), 2000);
    } else if (isActive(s)) {
      resync(e.status === 403 ? 'Your access changed.' : e.message);
    } else {
      closeSession(s);
    }
  }
}

function onServerOp(s, entry) {
  if (s.broken) return;
  const result = s.ot.receive(entry);
  if (result.type === 'gap') return isActive(s) ? resync('Fell out of sync.') : closeSession(s);
  if (result.type === 'ack' && s.ot.buffer) scheduleSend(s, 0);
  if (result.type === 'remote' && isActive(s)) {
    state.quill.updateContents(result.delta, 'api');
    shiftCursors(result.delta);
  }
  if (result.type !== 'ignore' && isActive(s) && s.ot.idle) refreshStatus();
  if (s.ot.idle && s.cursorDirty) scheduleCursor(s);
  maybeClose(s);
}

// ---------- remote cursors ----------
// Our cursor is only sent when we have no unacknowledged edits, so its position is in server
// coordinates; the server then shifts it through any edits it hasn't been through yet.

function scheduleCursor(s) {
  if (s.cursorTimer || s.closed || !isActive(s)) return;
  s.cursorTimer = setTimeout(() => {
    s.cursorTimer = null;
    sendCursor(s);
  }, 80);
}

function sendCursor(s) {
  const range = isActive(s) && state.quill.getSelection();
  if (!range || s.closed) return;
  if (!s.ot.idle) {
    s.cursorDirty = true;
    return;
  }
  s.cursorDirty = false;
  api(docUrl(s.doc.id, '/cursor'), {
    method: 'POST',
    body: { clientId: state.clientId, version: s.ot.version, index: range.index, length: range.length },
  }).catch(() => {});
}

const remoteCursors = new Map(); // clientId -> { user, index, length, movedAt }

function shiftRange(c, delta) {
  const end = delta.transformPosition(c.index + c.length);
  c.index = delta.transformPosition(c.index);
  c.length = Math.max(0, end - c.index);
}

function shiftCursors(delta) {
  for (const c of remoteCursors.values()) shiftRange(c, delta);
  renderCursors();
}

function onRemoteCursor(s, data) {
  if (data.clientId === state.clientId || !isActive(s)) return;
  const c = { user: data.user, index: data.index, length: data.length, movedAt: Date.now() };
  // Server coordinates -> our view, which also contains our unacknowledged edits.
  if (s.ot.pending) shiftRange(c, s.ot.pending);
  if (s.ot.buffer) shiftRange(c, s.ot.buffer);
  remoteCursors.set(data.clientId, c);
  renderCursors();
  setTimeout(renderCursors, 3100);
}

function cursorLayer() {
  let layer = state.quill.container.querySelector('.cursor-layer');
  if (!layer) {
    layer = el('div', { class: 'cursor-layer', 'aria-hidden': 'true' });
    state.quill.container.append(layer);
  }
  return layer;
}

function renderCursors() {
  if (!state.quill) return;
  const quill = state.quill;
  const max = Math.max(0, quill.getLength() - 1);
  const nodes = [];
  for (const c of remoteCursors.values()) {
    const color = colorFor(c.user.id);
    const index = Math.min(c.index, max);
    const length = Math.min(c.length, max - index);
    if (length > 0) {
      for (const line of quill.getLines(index, length)) {
        const start = Math.max(index, quill.getIndex(line));
        const end = Math.min(index + length, quill.getIndex(line) + line.length() - 1);
        if (end <= start) continue;
        const b = quill.getBounds(start, end - start);
        if (b) nodes.push(el('div', { class: 'remote-selection', style: `left:${b.left}px;top:${b.top}px;width:${b.width}px;height:${b.height}px;background:${color}` }));
      }
    }
    const b = quill.getBounds(index + length, 0);
    if (!b) continue;
    const recent = Date.now() - c.movedAt < 3000;
    nodes.push(
      el(
        'div',
        { class: 'remote-caret', style: `left:${b.left}px;top:${b.top}px;height:${b.height}px;background:${color}` },
        el('span', { class: `remote-label${recent ? '' : ' faded'}`, style: `background:${color}` }, c.user.name.split(' ')[0]),
      ),
    );
  }
  cursorLayer().replaceChildren(...nodes);
}

function clearCursors() {
  remoteCursors.clear();
  if (state.quill) cursorLayer().replaceChildren();
}

function connectEvents(s) {
  const es = new EventSource(docUrl(s.doc.id, `/events?since=${s.ot.version}&clientId=${encodeURIComponent(state.clientId)}`));
  s.events = es;
  const on = (name, fn) => es.addEventListener(name, (e) => !s.closed && fn(JSON.parse(e.data)));
  on('op', (entry) => onServerOp(s, entry));
  on('cursor', (data) => onRemoteCursor(s, data));
  on('cursor-leave', ({ clientId }) => {
    if (!isActive(s)) return;
    remoteCursors.delete(clientId);
    renderCursors();
  });
  on('presence', ({ users }) => isActive(s) && renderPresence(users));
  on('title', ({ title }) => {
    s.doc.title = title;
    if (isActive(s) && document.activeElement !== $('titleInput')) $('titleInput').value = title;
  });
  on('resync', () => (isActive(s) ? resync('The document was replaced.') : closeSession(s)));
  on('reload', () => (isActive(s) ? resync('Your access changed.') : closeSession(s)));
  on('gone', () => {
    closeSession(s);
    if (!isActive(s)) return;
    s.broken = true;
    state.quill.enable(false);
    renderPresence([]);
    showBanner('You no longer have access to this document.', { danger: true, action: backAction });
  });
  es.onopen = () => isActive(s) && refreshStatus();
  es.onerror = () => {
    if (s.closed || !isActive(s)) return;
    if (es.readyState === EventSource.CLOSED) resync('Lost connection.');
    else setStatus('Reconnecting...', true);
  };
}

function maybeClose(s) {
  if (s.closing && s.ot.idle) closeSession(s);
}

function closeSession(s) {
  if (!s || s.closed) return;
  s.closed = true;
  if (s.events) s.events.close();
  clearTimeout(s.sendTimer);
}

/** Detach the open document from the UI without waiting; unsent edits finish in the background. */
function leaveDoc() {
  const s = state.session;
  if (!s) return;
  state.session = null;
  s.closing = true;
  if (s.ot.buffer && !s.ot.pending) sendBuffer(s);
  maybeClose(s);
  setTimeout(() => closeSession(s), 15000);
}

function resync(reason) {
  const s = state.session;
  if (!s || s.broken) return;
  const lost = !s.ot.idle;
  s.broken = true;
  closeSession(s);
  state.session = null;
  toast(`${reason} Reloaded the latest version${lost ? '; your last few keystrokes may be missing' : ''}.`, !!lost);
  openDoc(s.doc.id);
}

// ---------- presence ----------

const AVATAR_COLORS = ['#2563eb', '#db2777', '#059669', '#d97706', '#7c3aed'];
const colorFor = (userId) => AVATAR_COLORS[[...userId].reduce((a, c) => a + c.charCodeAt(0), 0) % AVATAR_COLORS.length];

function renderPresence(users) {
  const others = users.filter((p) => !state.user || p.user.id !== state.user.id);
  $('presence').replaceChildren(
    ...others.map(({ user, role, editing }) => {
      const initials = user.name.split(' ').map((p) => p[0]).join('').slice(0, 2);
      const color = colorFor(user.id);
      const status = editing ? 'editing' : role === 'viewer' ? 'viewing' : 'here';
      const label = `${user.name} is ${status === 'here' ? 'here' : status} (${roleLabel[role] || role})`;
      return el(
        'span',
        { class: `presence-chip${editing ? ' editing' : ''}`, title: label, 'aria-label': label },
        el('span', { class: 'avatar', style: `background:${color}` }, initials),
        el('span', { class: 'presence-name' }, user.name.split(' ')[0]),
        el('span', { class: 'presence-status' }, status),
      );
    }),
  );
}

// ---------- open document ----------

function resetEditorUi() {
  const quill = getQuill();
  $('titleInput').value = '';
  $('titleInput').disabled = true;
  $('roleBadge').hidden = true;
  $('shareBtn').hidden = true;
  $('deleteBtn').hidden = true;
  $('docMeta').textContent = 'Loading...';
  $('banner').hidden = true;
  $('presence').replaceChildren();
  clearCursors();
  setStatus('');
  quill.getModule('toolbar').container.hidden = true;
  quill.setContents([], 'silent');
  quill.history.clear();
  quill.enable(false);
}

async function openDoc(id) {
  leaveDoc();
  const seq = ++state.openSeq;
  showView('editorView');
  resetEditorUi();
  const quill = state.quill;

  let data;
  try {
    data = await api(docUrl(id));
  } catch (e) {
    if (seq !== state.openSeq) return;
    $('docMeta').textContent = '';
    showBanner(e.message, { danger: true, action: backAction });
    return;
  }
  if (seq !== state.openSeq) return;

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
    if (seq !== state.openSeq) return;
  }

  const s = {
    doc: { id: doc.id, role, owner, title: doc.title },
    ot: new OTClient({ Delta, version: doc.version, clientId: state.clientId }),
    events: null,
    sendTimer: null,
    broken: false,
    closing: false,
    closed: false,
  };
  state.session = s;

  $('titleInput').value = doc.title;
  $('titleInput').disabled = !canEdit;
  $('roleBadge').textContent = roleLabel[role];
  $('roleBadge').className = `badge ${role}`;
  $('roleBadge').hidden = false;
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
  connectEvents(s);
  scheduleCursor(s);
}

// ---------- title ----------

async function commitTitle() {
  const input = $('titleInput');
  const s = state.session;
  if (!s || s.doc.role === 'viewer') return;
  const title = input.value.trim();
  if (!title) {
    input.value = s.doc.title;
    return toast('Title cannot be empty.', true);
  }
  if (title === s.doc.title) return;
  const previous = s.doc.title;
  s.doc.title = title;
  input.value = title;
  try {
    await api(docUrl(s.doc.id), { method: 'PATCH', body: { title } });
  } catch (e) {
    if (!isActive(s)) return;
    s.doc.title = previous;
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
    e.target.value = state.session ? state.session.doc.title : '';
    e.target.blur();
  }
});

$('deleteBtn').addEventListener('click', async () => {
  const s = state.session;
  if (!s || !confirm(`Delete "${s.doc.title}"? This cannot be undone.`)) return;
  closeSession(s);
  state.session = null;
  try {
    await api(docUrl(s.doc.id), { method: 'DELETE' });
    toast('Document deleted');
    location.hash = '#/';
  } catch (e) {
    toast(e.message, true);
    openDoc(s.doc.id);
  }
});

window.addEventListener('beforeunload', (e) => {
  const s = state.session;
  if (s && !s.ot.idle) {
    sendBuffer(s);
    e.preventDefault();
    e.returnValue = '';
  }
});

// ---------- sharing ----------

function renderShares(shares) {
  const { owner } = state.session.doc;
  const list = $('shareList');
  list.replaceChildren(el('li', {}, el('span', { class: 'who' }, `${owner.name} (${owner.email})`), el('span', { class: 'badge owner' }, 'Owner')));
  for (const sh of shares) {
    const roleSelect = el(
      'select',
      { 'aria-label': `Role for ${sh.user.name}`, onchange: (e) => share(sh.user.email, e.target.value) },
      el('option', { value: 'editor' }, 'Can edit'),
      el('option', { value: 'viewer' }, 'Can view'),
    );
    roleSelect.value = sh.role;
    list.append(
      el(
        'li',
        {},
        el('span', { class: 'who' }, `${sh.user.name} (${sh.user.email})`),
        roleSelect,
        el('button', { class: 'btn btn-danger-ghost', onclick: () => unshare(sh.user.id) }, 'Remove'),
      ),
    );
  }

  const taken = new Set([owner.id, ...shares.map((sh) => sh.user.id)]);
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
    const { shares } = await api(docUrl(state.session.doc.id, '/shares'), { method: 'PUT', body: { email, role } });
    renderShares(shares);
    toast('Sharing updated');
  } catch (e) {
    $('shareError').textContent = e.message;
    $('shareError').hidden = false;
  }
}

async function unshare(userId) {
  try {
    const { shares } = await api(docUrl(state.session.doc.id, `/shares/${encodeURIComponent(userId)}`), { method: 'DELETE' });
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
      api(docUrl(state.session.doc.id, '/shares')),
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

function route() {
  if (!state.user) return;
  const m = location.hash.match(/^#\/doc\/(.+)$/);
  if (m) {
    openDoc(decodeURIComponent(m[1]));
  } else {
    leaveDoc();
    state.openSeq++;
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
