'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Delta = require('quill-delta');
const OTClient = require('../public/ot-client');
const { CollabHub } = require('../src/collab');
const { Store } = require('../src/store');

function prng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

function randomEdit(doc, rnd) {
  const len = doc.length(); // includes the trailing newline, which must survive
  const idx = Math.floor(rnd() * len);
  const r = rnd();
  if (r < 0.55 || len < 3) {
    const attrs = rnd() < 0.3 ? { bold: true } : undefined;
    const text = 'xyzw\n'[Math.floor(rnd() * 5)].repeat(1 + Math.floor(rnd() * 3));
    return new Delta().retain(idx).insert(text, attrs);
  }
  if (r < 0.8) {
    const n = Math.min(1 + Math.floor(rnd() * 3), len - 1 - idx);
    return n > 0 ? new Delta().retain(idx).delete(n) : new Delta().retain(idx).insert('q');
  }
  const n = Math.max(1, Math.min(3, len - idx));
  return new Delta().retain(idx).retain(n, { italic: rnd() < 0.5 ? true : null });
}

function simulate(seed, { clients: nClients = 3, steps = 400 } = {}) {
  const rnd = prng(seed);
  const store = new Store(null, { seedDemo: false });
  const hub = new CollabHub(store);
  const start = { ops: [{ insert: 'Hello world\n' }] };
  const { id } = store.createDocument({ ownerId: 'u_alice', title: 'fuzz', content: start });

  const clients = Array.from({ length: nClients }, (_, i) => ({
    ot: new OTClient({ Delta, version: 1, clientId: `c${i}` }),
    doc: new Delta(start.ops),
    inbox: [], // server -> client stream (ordered, like SSE)
    lastSent: null,
  }));

  const submit = (body) => {
    const before = store.getDocument(id).version;
    const entry = hub.submit(store.getDocument(id), body);
    if (entry.version > before) for (const c of clients) c.inbox.push(entry);
  };

  const step = (c, action) => {
    if (action === 'edit') {
      const d = randomEdit(c.doc, rnd);
      c.doc = c.doc.compose(d);
      c.ot.applyLocal(d);
    } else if (action === 'send') {
      const body = c.ot.takeSend();
      if (body) submit((c.lastSent = body));
    } else if (action === 'retry' && c.ot.pending && c.lastSent) {
      // Simulates a lost response followed by a resend of the same (clientId, seq).
      submit({ ...c.ot.outgoing() });
    } else if (action === 'recv' && c.inbox.length) {
      const res = c.ot.receive(c.inbox.shift());
      assert.notEqual(res.type, 'gap');
      if (res.type === 'remote') c.doc = c.doc.compose(res.delta);
    }
  };

  for (let i = 0; i < steps; i++) {
    const c = clients[Math.floor(rnd() * nClients)];
    const r = rnd();
    step(c, r < 0.4 ? 'edit' : r < 0.6 ? 'send' : r < 0.65 ? 'retry' : 'recv');
  }
  // Quiesce: deliver and send until everyone is idle.
  for (let guard = 0; guard < 10000 && clients.some((c) => !c.ot.idle || c.inbox.length); guard++) {
    for (const c of clients) {
      step(c, 'send');
      while (c.inbox.length) step(c, 'recv');
    }
  }

  const server = new Delta(store.getDocument(id).content.ops);
  return { server, clients };
}

test('OT fuzz: concurrent random edits from 3 clients always converge', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const { server, clients } = simulate(seed);
    for (const [i, c] of clients.entries()) {
      assert.ok(c.ot.idle, `seed ${seed}: client ${i} not idle`);
      assert.deepEqual(c.doc.ops, server.ops, `seed ${seed}: client ${i} diverged from server`);
    }
    const last = server.ops[server.ops.length - 1];
    assert.ok(last.insert.endsWith('\n'), `seed ${seed}: trailing newline lost`);
  }
});
