'use strict';

const $ = (id) => document.getElementById(id);

const state = {
  user: null,
  users: [],
  quill: null,
  doc: null, // { id, version, role, ownerId }
  dirty: false,
  pendingTitle: null,
  saving: false,
  conflict: false,
  saveTimer: null,
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
  await flushSave();
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
    },
  });
  state.quill.on('text-change', (_delta, _old, source) => {
    if (source === 'user') scheduleSave();
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

function scheduleSave() {
  if (!state.doc || state.conflict) return;
  state.dirty = true;
  setStatus('Unsaved changes');
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(flushSave, 800);
}

// All writes go through one serialized path so version numbers never race.
async function flushSave() {
  clearTimeout(state.saveTimer);
  const doc = state.doc;
  if (!doc || state.saving || state.conflict) return;
  if (!state.dirty && state.pendingTitle === null) return;

  const body = {};
  if (state.dirty) {
    body.content = state.quill.getContents();
    body.baseVersion = doc.version;
  }
  if (state.pendingTitle !== null) body.title = state.pendingTitle;
  state.dirty = false;
  state.pendingTitle = null;
  state.saving = true;
  setStatus('Saving...');

  try {
    const { document: saved } = await api(`/api/documents/${encodeURIComponent(doc.id)}`, { method: 'PATCH', body });
    if (state.doc === doc) {
      doc.version = saved.version;
      setStatus('All changes saved');
      $('docMeta').textContent = metaText(doc.owner, saved.updatedAt);
    }
  } catch (e) {
    if (e.status === 409) {
      state.conflict = true;
      state.quill.enable(false);
      setStatus('Not saved', true);
      showBanner(e.message, { danger: true, action: { label: 'Reload latest', onClick: () => openDoc(doc.id) } });
    } else if (e.status === 400 && body.title !== undefined) {
      toast(e.message, true);
      $('titleInput').value = doc.title;
      if (body.content) state.dirty = true;
    } else {
      if (body.content) state.dirty = true;
      if (body.title !== undefined && state.pendingTitle === null) state.pendingTitle = body.title;
      setStatus(`Save failed: ${e.message} Retrying...`, true);
      state.saveTimer = setTimeout(flushSave, 3000);
    }
  } finally {
    state.saving = false;
  }
  if (state.doc === doc && (state.dirty || state.pendingTitle !== null) && !state.conflict) {
    state.saveTimer = setTimeout(flushSave, 300);
  }
}

function metaText(owner, updatedAt) {
  return `Owner: ${owner.name} · Last saved ${new Date(updatedAt).toLocaleString()}`;
}

async function openDoc(id) {
  await flushSave();
  showView('editorView');
  const quill = getQuill();
  state.doc = null;
  state.dirty = false;
  state.pendingTitle = null;
  state.conflict = false;
  $('banner').hidden = true;
  quill.setContents([], 'silent');
  quill.enable(false);
  setStatus('Loading...');

  let data;
  try {
    data = await api(`/api/documents/${encodeURIComponent(id)}`);
  } catch (e) {
    setStatus('');
    showBanner(e.message, { danger: true, action: { label: 'Back to documents', onClick: () => (location.hash = '#/') } });
    return;
  }

  const { document: doc, role, owner } = data;
  state.doc = { id: doc.id, version: doc.version, role, owner, title: doc.title };
  const canEdit = role !== 'viewer';

  $('titleInput').value = doc.title;
  $('titleInput').disabled = !canEdit;
  $('roleBadge').textContent = roleLabel[role];
  $('roleBadge').className = `badge ${role}`;
  $('shareBtn').hidden = role !== 'owner';
  $('deleteBtn').hidden = role !== 'owner';
  $('docMeta').textContent = metaText(owner, doc.updatedAt);
  quill.getModule('toolbar').container.hidden = !canEdit;

  if (doc.content) {
    quill.setContents(doc.content, 'silent');
  } else if (doc.importedHtml) {
    // Imported files arrive as sanitized HTML; convert once to a Delta and persist it.
    quill.setContents(quill.clipboard.convert({ html: doc.importedHtml }), 'silent');
    if (canEdit) scheduleSave();
  }
  quill.enable(canEdit);
  if (!canEdit) showBanner(`You have view-only access. Ask ${owner.name} for edit access.`);
  setStatus(canEdit ? 'All changes saved' : '');
  if (canEdit && quill.getLength() <= 1) quill.focus();
}

function commitTitle() {
  const input = $('titleInput');
  const doc = state.doc;
  if (!doc || doc.role === 'viewer') return;
  const title = input.value.trim();
  if (!title) {
    input.value = doc.title;
    return toast('Title cannot be empty.', true);
  }
  if (title === doc.title) return;
  doc.title = title;
  input.value = title;
  state.pendingTitle = title;
  flushSave();
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
  try {
    clearTimeout(state.saveTimer);
    state.doc = null;
    await api(`/api/documents/${encodeURIComponent(doc.id)}`, { method: 'DELETE' });
    toast('Document deleted');
    location.hash = '#/';
  } catch (e) {
    state.doc = doc;
    toast(e.message, true);
  }
});

window.addEventListener('beforeunload', (e) => {
  if (state.dirty || state.saving || state.pendingTitle !== null) {
    flushSave();
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
    const { shares } = await api(`/api/documents/${encodeURIComponent(state.doc.id)}/shares`, { method: 'PUT', body: { email, role } });
    renderShares(shares);
    toast('Sharing updated');
  } catch (e) {
    $('shareError').textContent = e.message;
    $('shareError').hidden = false;
  }
}

async function unshare(userId) {
  try {
    const { shares } = await api(`/api/documents/${encodeURIComponent(state.doc.id)}/shares/${encodeURIComponent(userId)}`, {
      method: 'DELETE',
    });
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
      api(`/api/documents/${encodeURIComponent(state.doc.id)}/shares`),
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
    await flushSave();
    state.doc = null;
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
