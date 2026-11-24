'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { ROLES } = require('./store');
const { COOKIE_NAME, makeToken, verifyToken, parseCookies } = require('./auth');
const { fileToHtml, ImportError, SUPPORTED_EXTENSIONS, MAX_UPLOAD_BYTES } = require('./importers');

const MAX_TITLE = 200;
const MAX_OPS = 20000;

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function validateTitle(raw) {
  if (typeof raw !== 'string') throw new HttpError(400, 'Title must be a string.');
  const title = raw.trim();
  if (!title) throw new HttpError(400, 'Title cannot be empty.');
  if (title.length > MAX_TITLE) throw new HttpError(400, `Title must be at most ${MAX_TITLE} characters.`);
  return title;
}

/** Shallow structural check that content is a Quill Delta made only of inserts. */
function validateDelta(content) {
  if (!content || typeof content !== 'object' || !Array.isArray(content.ops)) {
    throw new HttpError(400, 'Content must be a Quill Delta: { ops: [...] }.');
  }
  if (content.ops.length > MAX_OPS) throw new HttpError(413, 'Document is too large.');
  for (const op of content.ops) {
    const okInsert = op && (typeof op.insert === 'string' || (op.insert && typeof op.insert === 'object'));
    const okAttrs = op && (op.attributes === undefined || (typeof op.attributes === 'object' && op.attributes !== null));
    if (!okInsert || !okAttrs || Object.keys(op).some((k) => k !== 'insert' && k !== 'attributes')) {
      throw new HttpError(400, 'Content contains invalid operations.');
    }
  }
  return { ops: content.ops };
}

function createApp({ store, secret = crypto.randomBytes(32).toString('hex'), secureCookies = false } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));

  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    next();
  });

  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use('/vendor/quill', express.static(path.join(path.dirname(require.resolve('quill/package.json')), 'dist')));

  // Attach the current user (if any) from the signed session cookie.
  app.use((req, _res, next) => {
    const userId = verifyToken(parseCookies(req.headers.cookie)[COOKIE_NAME], secret);
    req.user = userId ? store.getUser(userId) : null;
    next();
  });

  const requireUser = (req, _res, next) => (req.user ? next() : next(new HttpError(401, 'Please sign in.')));

  // Non-members get 404 rather than 403 so document ids can't be probed.
  function loadDoc(minRole) {
    const rank = { viewer: 1, editor: 2, owner: 3 };
    return (req, _res, next) => {
      const doc = store.getDocument(req.params.id);
      const role = store.getRole(doc, req.user.id);
      if (!doc || !role) return next(new HttpError(404, 'Document not found.'));
      if (rank[role] < rank[minRole]) {
        return next(new HttpError(403, minRole === 'owner' ? 'Only the owner can do that.' : 'You have view-only access.'));
      }
      req.doc = doc;
      req.role = role;
      next();
    };
  }

  const summarize = (doc, userId) => ({
    id: doc.id,
    title: doc.title,
    owner: store.getUser(doc.ownerId),
    role: store.getRole(doc, userId),
    updatedAt: doc.updatedAt,
  });

  const shareView = (docId) =>
    store.listShares(docId).map((s) => ({ user: store.getUser(s.userId), role: s.role }));

  // ---- Auth (mocked: seeded users, no passwords) ----
  app.post('/api/login', (req, res) => {
    const user = store.getUserByEmail(req.body && req.body.email);
    if (!user) throw new HttpError(401, 'Unknown user. Use one of the demo accounts.');
    const cookie = [
      `${COOKIE_NAME}=${encodeURIComponent(makeToken(user.id, secret))}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      'Max-Age=604800',
      secureCookies ? 'Secure' : null,
    ].filter(Boolean);
    res.set('Set-Cookie', cookie.join('; '));
    res.json({ user });
  });

  app.post('/api/logout', (_req, res) => {
    res.set('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    res.json({ ok: true });
  });

  app.get('/api/me', requireUser, (req, res) => res.json({ user: req.user }));

  // Public so the login screen can list the seeded demo accounts.
  app.get('/api/users', (_req, res) => res.json({ users: store.listUsers() }));

  // ---- Documents ----
  app.get('/api/documents', requireUser, (req, res) => {
    const { owned, shared } = store.listDocumentsForUser(req.user.id);
    res.json({
      owned: owned.map((d) => summarize(d, req.user.id)),
      shared: shared.map((d) => summarize(d, req.user.id)),
    });
  });

  app.post('/api/documents', requireUser, (req, res) => {
    const body = req.body || {};
    const title = body.title === undefined ? 'Untitled document' : validateTitle(body.title);
    const content = body.content === undefined ? undefined : validateDelta(body.content);
    const doc = store.createDocument({ ownerId: req.user.id, title, content });
    res.status(201).json({ document: doc, role: 'owner' });
  });

  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });

  // Express 4 doesn't catch async rejections, so forward them explicitly.
  app.post('/api/documents/import', requireUser, upload.single('file'), (req, res, next) => {
    if (!req.file) return next(new HttpError(400, 'No file uploaded (expected form field "file").'));
    fileToHtml(req.file.originalname, req.file.buffer)
      .then(({ title, html }) => {
        const doc = store.createDocument({ ownerId: req.user.id, title, importedHtml: html });
        res.status(201).json({ document: doc, role: 'owner' });
      })
      .catch(next);
  });

  app.get('/api/documents/:id', requireUser, loadDoc('viewer'), (req, res) => {
    res.json({
      document: req.doc,
      role: req.role,
      owner: store.getUser(req.doc.ownerId),
      shares: req.role === 'owner' ? shareView(req.doc.id) : undefined,
    });
  });

  app.patch('/api/documents/:id', requireUser, loadDoc('editor'), (req, res) => {
    const body = req.body || {};
    const patch = {};
    if (body.title !== undefined) patch.title = validateTitle(body.title);
    if (body.content !== undefined) {
      patch.content = validateDelta(body.content);
      // Optimistic concurrency: reject content saves based on a stale version.
      if (body.baseVersion !== undefined && body.baseVersion !== req.doc.version) {
        throw new HttpError(409, 'This document was changed elsewhere. Reload to get the latest version.', {
          currentVersion: req.doc.version,
        });
      }
    }
    if (!Object.keys(patch).length) throw new HttpError(400, 'Nothing to update.');
    const doc = store.updateDocument(req.doc.id, patch);
    res.json({ document: doc, role: req.role });
  });

  app.delete('/api/documents/:id', requireUser, loadDoc('owner'), (req, res) => {
    store.deleteDocument(req.doc.id);
    res.status(204).end();
  });

  // ---- Sharing (owner only) ----
  app.get('/api/documents/:id/shares', requireUser, loadDoc('owner'), (req, res) => {
    res.json({ shares: shareView(req.doc.id) });
  });

  app.put('/api/documents/:id/shares', requireUser, loadDoc('owner'), (req, res) => {
    const { email, role = 'editor' } = req.body || {};
    if (!ROLES.includes(role)) throw new HttpError(400, `Role must be one of: ${ROLES.join(', ')}.`);
    const target = store.getUserByEmail(email);
    if (!target) throw new HttpError(404, 'No user with that email.');
    if (target.id === req.doc.ownerId) throw new HttpError(400, 'The owner already has full access.');
    store.upsertShare(req.doc.id, target.id, role);
    res.json({ shares: shareView(req.doc.id) });
  });

  app.delete('/api/documents/:id/shares/:userId', requireUser, loadDoc('owner'), (req, res) => {
    if (!store.removeShare(req.doc.id, req.params.userId)) throw new HttpError(404, 'Share not found.');
    res.json({ shares: shareView(req.doc.id) });
  });

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found.')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.extra });
    if (err instanceof ImportError) return res.status(400).json({ error: err.message });
    if (err instanceof multer.MulterError) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? `File too large (max ${MAX_UPLOAD_BYTES / 1024 / 1024} MB).` : err.message;
      return res.status(400).json({ error: msg });
    }
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON body.' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large.' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  });

  return app;
}

module.exports = { createApp, SUPPORTED_EXTENSIONS };
