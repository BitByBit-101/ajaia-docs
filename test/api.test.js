'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../src/app');
const { Store } = require('../src/store');

let server;
let base;

before(async () => {
  const app = createApp({ store: new Store(null, { seedDemo: false }), secret: 'test-secret' });
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

async function loginAs(email) {
  const res = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  assert.equal(res.status, 200);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (method, url, body) => {
    const init = { method, headers: { cookie } };
    if (body instanceof FormData) init.body = body;
    else if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const r = await fetch(`${base}${url}`, init);
    return { status: r.status, body: r.status === 204 ? null : await r.json() };
  };
}

const delta = (text) => ({ ops: [{ insert: text, attributes: { bold: true } }, { insert: '\n', attributes: { header: 1 } }] });

test('rejects unauthenticated requests and unknown users', async () => {
  assert.equal((await fetch(`${base}/api/documents`)).status, 401);
  const res = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'mallory@evil.dev' }),
  });
  assert.equal(res.status, 401);
});

test('rejects a forged session cookie', async () => {
  const res = await fetch(`${base}/api/me`, { headers: { cookie: 'sid=u_alice.forged' } });
  assert.equal(res.status, 401);
});

test('create, rename, edit and reopen a document with formatting preserved', async () => {
  const alice = await loginAs('alice@ajaia.dev');
  const created = await alice('POST', '/api/documents', {});
  assert.equal(created.status, 201);
  const id = created.body.document.id;

  const renamed = await alice('PATCH', `/api/documents/${id}`, { title: '  Roadmap  ' });
  assert.equal(renamed.body.document.title, 'Roadmap');

  const saved = await alice('PATCH', `/api/documents/${id}`, {
    content: delta('Hello'),
    baseVersion: renamed.body.document.version,
  });
  assert.equal(saved.status, 200);

  const reopened = await alice('GET', `/api/documents/${id}`);
  assert.deepEqual(reopened.body.document.content, delta('Hello'));
  assert.equal(reopened.body.role, 'owner');
});

test('validates titles and content', async () => {
  const alice = await loginAs('alice@ajaia.dev');
  const { body } = await alice('POST', '/api/documents', {});
  const id = body.document.id;
  assert.equal((await alice('PATCH', `/api/documents/${id}`, { title: '   ' })).status, 400);
  assert.equal((await alice('PATCH', `/api/documents/${id}`, { content: '<script>' })).status, 400);
  assert.equal((await alice('PATCH', `/api/documents/${id}`, { content: { ops: [{ delete: 3 }] } })).status, 400);
  assert.equal((await alice('PATCH', `/api/documents/${id}`, {})).status, 400);
});

test('rejects stale saves with 409 (optimistic concurrency)', async () => {
  const alice = await loginAs('alice@ajaia.dev');
  const { body } = await alice('POST', '/api/documents', {});
  const { id, version } = body.document;
  assert.equal((await alice('PATCH', `/api/documents/${id}`, { content: delta('v2'), baseVersion: version })).status, 200);
  const stale = await alice('PATCH', `/api/documents/${id}`, { content: delta('stale'), baseVersion: version });
  assert.equal(stale.status, 409);
});

test('sharing: owner grants access, roles are enforced, shared docs are listed separately', async () => {
  const alice = await loginAs('alice@ajaia.dev');
  const bob = await loginAs('bob@ajaia.dev');
  const carol = await loginAs('carol@ajaia.dev');

  const { body } = await alice('POST', '/api/documents', { title: 'Team doc' });
  const id = body.document.id;

  // Before sharing, Bob can't see it (404, not 403, so ids can't be probed).
  assert.equal((await bob('GET', `/api/documents/${id}`)).status, 404);

  assert.equal((await alice('PUT', `/api/documents/${id}/shares`, { email: 'bob@ajaia.dev', role: 'editor' })).status, 200);
  assert.equal((await alice('PUT', `/api/documents/${id}/shares`, { email: 'carol@ajaia.dev', role: 'viewer' })).status, 200);

  const bobList = await bob('GET', '/api/documents');
  assert.ok(bobList.body.shared.some((d) => d.id === id && d.role === 'editor'));
  assert.ok(!bobList.body.owned.some((d) => d.id === id));

  assert.equal((await bob('PATCH', `/api/documents/${id}`, { content: delta('by bob') })).status, 200);
  assert.equal((await carol('GET', `/api/documents/${id}`)).body.role, 'viewer');
  assert.equal((await carol('PATCH', `/api/documents/${id}`, { content: delta('by carol') })).status, 403);

  // Only the owner manages sharing or deletes.
  assert.equal((await bob('PUT', `/api/documents/${id}/shares`, { email: 'carol@ajaia.dev', role: 'editor' })).status, 403);
  assert.equal((await bob('DELETE', `/api/documents/${id}`)).status, 403);

  // Bad share input.
  assert.equal((await alice('PUT', `/api/documents/${id}/shares`, { email: 'nobody@x.dev' })).status, 404);
  assert.equal((await alice('PUT', `/api/documents/${id}/shares`, { email: 'bob@ajaia.dev', role: 'admin' })).status, 400);
  assert.equal((await alice('PUT', `/api/documents/${id}/shares`, { email: 'alice@ajaia.dev' })).status, 400);

  // Revoking access removes it.
  assert.equal((await alice('DELETE', `/api/documents/${id}/shares/u_bob`)).status, 200);
  assert.equal((await bob('GET', `/api/documents/${id}`)).status, 404);
});

test('imports markdown into a new sanitized document and rejects unsupported files', async () => {
  const alice = await loginAs('alice@ajaia.dev');

  const md = new FormData();
  md.append('file', new Blob(['# Notes\n\n**bold** item\n\n- one\n- two\n\n<script>alert(1)</script>']), 'meeting-notes.md');
  const ok = await alice('POST', '/api/documents/import', md);
  assert.equal(ok.status, 201);
  assert.equal(ok.body.document.title, 'meeting-notes');
  assert.match(ok.body.document.importedHtml, /<h1>Notes<\/h1>/);
  assert.match(ok.body.document.importedHtml, /<strong>bold<\/strong>/);
  assert.match(ok.body.document.importedHtml, /<li>one<\/li>/);
  assert.doesNotMatch(ok.body.document.importedHtml, /script/);

  const pdf = new FormData();
  pdf.append('file', new Blob(['%PDF-1.4']), 'report.pdf');
  const bad = await alice('POST', '/api/documents/import', pdf);
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /Unsupported file type/);

  const fakeDocx = new FormData();
  fakeDocx.append('file', new Blob(['not a zip']), 'fake.docx');
  assert.equal((await alice('POST', '/api/documents/import', fakeDocx)).status, 400);
});

test('presence shows other active collaborators and the latest version', async () => {
  const alice = await loginAs('alice@ajaia.dev');
  const bob = await loginAs('bob@ajaia.dev');
  const carol = await loginAs('carol@ajaia.dev');
  const { body } = await alice('POST', '/api/documents', { title: 'Live doc' });
  const id = body.document.id;
  await alice('PUT', `/api/documents/${id}/shares`, { email: 'bob@ajaia.dev', role: 'editor' });

  assert.deepEqual((await alice('POST', `/api/documents/${id}/presence`)).body.active, []);
  await bob('POST', `/api/documents/${id}/presence`);
  await bob('PATCH', `/api/documents/${id}`, { content: delta('from bob') });

  const seen = await alice('POST', `/api/documents/${id}/presence`);
  assert.deepEqual(seen.body.active.map((a) => [a.user.id, a.role]), [['u_bob', 'editor']]);
  assert.equal(seen.body.version, body.document.version + 1);

  // Users without access can't see who is in a document.
  assert.equal((await carol('POST', `/api/documents/${id}/presence`)).status, 404);

  await bob('DELETE', `/api/documents/${id}/presence`);
  assert.deepEqual((await alice('POST', `/api/documents/${id}/presence`)).body.active, []);
});

test('store persists documents and shares to disk across restarts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ajaia-docs-'));
  const file = path.join(dir, 'db.json');
  try {
    const s1 = new Store(file, { seedDemo: false });
    const doc = s1.createDocument({ ownerId: 'u_alice', title: 'Persisted', content: delta('x') });
    s1.upsertShare(doc.id, 'u_bob', 'viewer');

    const s2 = new Store(file, { seedDemo: false });
    assert.deepEqual(s2.getDocument(doc.id).content, delta('x'));
    assert.equal(s2.getRole(s2.getDocument(doc.id), 'u_bob'), 'viewer');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
