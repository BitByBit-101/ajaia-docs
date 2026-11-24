'use strict';

const Delta = require('quill-delta');

const MAX_LOG = 1000;
const MAX_CHANGE_OPS = 5000;
const MAX_DOC_LENGTH = 1_000_000;

class CollabError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function validateChange(ops) {
  if (!Array.isArray(ops)) throw new CollabError(400, 'Change must be an ops array.');
  if (ops.length > MAX_CHANGE_OPS) throw new CollabError(413, 'Change is too large.');
  for (const op of ops) {
    if (!op || typeof op !== 'object') throw new CollabError(400, 'Invalid operation.');
    const keys = Object.keys(op).filter((k) => k !== 'attributes');
    if (keys.length !== 1) throw new CollabError(400, 'Invalid operation.');
    const [k] = keys;
    const v = op[k];
    const ok =
      (k === 'insert' && (typeof v === 'string' ? v.length > 0 : v !== null && typeof v === 'object')) ||
      ((k === 'retain' || k === 'delete') && Number.isInteger(v) && v > 0);
    if (!ok) throw new CollabError(400, 'Invalid operation.');
    if (op.attributes !== undefined && (op.attributes === null || typeof op.attributes !== 'object')) {
      throw new CollabError(400, 'Invalid operation attributes.');
    }
  }
  return new Delta(ops);
}

/**
 * Central-server operational transformation (the Google Docs / ot.js model).
 * The server is the single source of ordering: every accepted change gets the next
 * version number, and changes made against an older version are transformed past
 * everything that landed since, then broadcast to all open editors over SSE.
 */
class CollabHub {
  constructor(store) {
    this.store = store;
    this.logs = new Map(); // docId -> [{ version, ops, clientId }]
    this.subscribers = new Map(); // docId -> Set<res>
    this.editing = new Map(); // `${docId}:${userId}` -> timeout clearing the "editing" flag
    this.userStreams = new Map(); // userId -> Set<res>
  }

  submit(doc, { baseVersion, ops, clientId, seq, userId }) {
    if (!Number.isInteger(baseVersion)) throw new CollabError(400, 'baseVersion is required.');
    if (typeof clientId !== 'string' || !clientId || clientId.length > 64) throw new CollabError(400, 'clientId is required.');
    if (!Number.isInteger(seq)) throw new CollabError(400, 'seq is required.');

    // A retry of a change that already landed (lost response): don't apply twice.
    const log = this.logs.get(doc.id) || [];
    const dup = log.find((e) => e.clientId === clientId && e.seq === seq);
    if (dup) return dup;

    let change = validateChange(ops);

    const missing = this.#since(doc, baseVersion);
    if (missing === null) throw new CollabError(409, 'Your copy is too far behind. Reload to continue.');
    for (const entry of missing) change = new Delta(entry.ops).transform(change, true);

    const current = new Delta(doc.content ? doc.content.ops : [{ insert: '\n' }]);
    const next = current.compose(change);
    const last = next.ops[next.ops.length - 1];
    if (!last || typeof last.insert !== 'string' || !last.insert.endsWith('\n') || next.length() < 1) {
      throw new CollabError(400, 'Change would corrupt the document.');
    }
    if (next.length() > MAX_DOC_LENGTH) throw new CollabError(413, 'Document is too large.');

    const updated = this.store.updateDocument(doc.id, { content: { ops: next.ops } }, { deferPersist: true });
    const entry = { version: updated.version, ops: change.ops, clientId, seq };
    log.push(entry);
    if (log.length > MAX_LOG) log.splice(0, log.length - MAX_LOG);
    this.logs.set(doc.id, log);
    this.#broadcast(doc.id, 'op', entry, entry.version);
    if (userId) this.#markEditing(doc.id, userId);
    return entry;
  }

  /** Entries after `version`, or null if history no longer covers that gap. */
  #since(doc, version) {
    if (version > doc.version) return null;
    if (version === doc.version) return [];
    const log = this.logs.get(doc.id) || [];
    const idx = log.findIndex((e) => e.version === version + 1);
    return idx === -1 ? null : log.slice(idx);
  }

  /** Called when content is replaced wholesale (e.g. import), invalidating op history. */
  reset(docId) {
    this.logs.delete(docId);
    this.#broadcast(docId, 'resync', {});
  }

  broadcastTitle(docId, title) {
    this.#broadcast(docId, 'title', { title });
  }

  subscribe(doc, req, res) {
    this.#openStream(req, res);

    // On auto-reconnect the browser sends Last-Event-ID, which is newer than ?since.
    const since = Number(req.headers['last-event-id'] ?? req.query.since);
    if (Number.isInteger(since)) {
      const missing = this.#since(doc, since);
      if (missing === null) this.#send(res, 'resync', {});
      else for (const e of missing) this.#send(res, 'op', e, e.version);
    }

    let set = this.subscribers.get(doc.id);
    if (!set) this.subscribers.set(doc.id, (set = new Set()));
    res.locals.userId = req.user.id;
    set.add(res);
    this.#broadcastPresence(doc.id);
    req.on('close', () => {
      set.delete(res);
      if (!set.size) this.subscribers.delete(doc.id);
      this.#broadcastPresence(doc.id);
    });
  }

  /** Who has the document open right now (one entry per user, across tabs). */
  presence(docId) {
    const doc = this.store.getDocument(docId);
    const set = this.subscribers.get(docId);
    if (!doc || !set) return [];
    const seen = new Map();
    for (const res of set) {
      const userId = res.locals.userId;
      if (seen.has(userId)) continue;
      const user = this.store.getUser(userId);
      const role = this.store.getRole(doc, userId);
      if (user && role) seen.set(userId, { user, role, editing: this.editing.has(`${docId}:${userId}`) });
    }
    return [...seen.values()];
  }

  // "Editing" = made a change in the last 2.5 s; broadcast only when the flag flips.
  #markEditing(docId, userId) {
    const key = `${docId}:${userId}`;
    const wasEditing = this.editing.has(key);
    clearTimeout(this.editing.get(key));
    const timer = setTimeout(() => {
      this.editing.delete(key);
      this.#broadcastPresence(docId);
    }, 2500);
    timer.unref?.();
    this.editing.set(key, timer);
    if (!wasEditing) this.#broadcastPresence(docId);
  }

  #broadcastPresence(docId) {
    this.#broadcast(docId, 'presence', { users: this.presence(docId) });
  }

  /** Per-user stream for dashboard-level updates (shared with you, access removed, renamed). */
  subscribeUser(req, res) {
    this.#openStream(req, res);
    const userId = req.user.id;
    let set = this.userStreams.get(userId);
    if (!set) this.userStreams.set(userId, (set = new Set()));
    set.add(res);
    req.on('close', () => {
      set.delete(res);
      if (!set.size) this.userStreams.delete(userId);
    });
  }

  notifyUsers(userIds, data = {}) {
    for (const userId of new Set(userIds)) {
      const set = this.userStreams.get(userId);
      if (set) for (const res of set) this.#send(res, 'docs', data);
    }
  }

  #openStream(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    // Comment pings keep proxies from closing idle streams.
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => clearInterval(ping));
  }

  /** Close all streams for a document (e.g. deleted). */
  closeAll(docId) {
    const set = this.subscribers.get(docId);
    if (!set) return;
    for (const res of set) {
      this.#send(res, 'gone', {});
      res.end();
    }
    this.subscribers.delete(docId);
    this.logs.delete(docId);
  }

  /** Close one user's streams, e.g. after their access changes. */
  closeUser(docId, userId, event = 'gone') {
    const set = this.subscribers.get(docId);
    if (!set) return;
    for (const res of set) {
      if (res.locals.userId !== userId) continue;
      this.#send(res, event, {});
      res.end();
      set.delete(res);
    }
    this.#broadcastPresence(docId);
  }

  #send(res, event, data, id) {
    res.write(`${id !== undefined ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  #broadcast(docId, event, data, id) {
    const set = this.subscribers.get(docId);
    if (set) for (const res of set) this.#send(res, event, data, id);
  }
}

module.exports = { CollabHub, CollabError };
