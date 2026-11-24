'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Users are seeded, not stored: auth is intentionally mocked for this scope.
const SEED_USERS = Object.freeze([
  { id: 'u_alice', name: 'Alice Chen', email: 'alice@ajaia.dev' },
  { id: 'u_bob', name: 'Bob Patel', email: 'bob@ajaia.dev' },
  { id: 'u_carol', name: 'Carol Diaz', email: 'carol@ajaia.dev' },
]);

const ROLES = ['editor', 'viewer'];

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function welcomeDelta() {
  return {
    ops: [
      { insert: 'Welcome to Ajaia Docs' },
      { insert: '\n', attributes: { header: 1 } },
      { insert: 'This document is owned by ' },
      { insert: 'Alice', attributes: { bold: true } },
      { insert: ' and shared with Bob as an ' },
      { insert: 'editor', attributes: { italic: true } },
      { insert: '.\n' },
      { insert: 'Things to try' },
      { insert: '\n', attributes: { header: 2 } },
      { insert: 'Format text: ' },
      { insert: 'bold', attributes: { bold: true } },
      { insert: ', ' },
      { insert: 'italic', attributes: { italic: true } },
      { insert: ', ' },
      { insert: 'underline', attributes: { underline: true } },
      { insert: '\n', attributes: { list: 'bullet' } },
      { insert: 'Rename this document using the title field' },
      { insert: '\n', attributes: { list: 'bullet' } },
      { insert: 'Share it with Carol from the Share panel' },
      { insert: '\n', attributes: { list: 'bullet' } },
      { insert: 'Refresh the page - everything is saved automatically' },
      { insert: '\n', attributes: { list: 'ordered' } },
    ],
  };
}

class Store {
  /**
   * @param {string|null} file JSON file path; null keeps data in memory only.
   * @param {{seedDemo?: boolean}} [options]
   */
  constructor(file, { seedDemo = true } = {}) {
    this.file = file;
    this.users = SEED_USERS;
    const loaded = this.#load();
    this.documents = loaded.documents;
    this.shares = loaded.shares;
    if (!loaded.existed && seedDemo) this.#seedDemo();
  }

  #load() {
    if (this.file && fs.existsSync(this.file)) {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return { existed: true, documents: parsed.documents || [], shares: parsed.shares || [] };
    }
    return { existed: false, documents: [], shares: [] };
  }

  #persist() {
    if (!this.file) return;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    // Write-then-rename so a crash mid-write never leaves a truncated DB.
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ documents: this.documents, shares: this.shares }, null, 2));
    fs.renameSync(tmp, this.file);
  }

  #seedDemo() {
    const welcome = this.createDocument({ ownerId: 'u_alice', title: 'Welcome to Ajaia Docs', content: welcomeDelta() });
    this.upsertShare(welcome.id, 'u_bob', 'editor');
    const plan = this.createDocument({
      ownerId: 'u_carol',
      title: 'Q3 Planning Notes (view only for Alice)',
      content: {
        ops: [
          { insert: 'Q3 Planning' },
          { insert: '\n', attributes: { header: 1 } },
          { insert: 'Alice can read this but not edit it.\n' },
        ],
      },
    });
    this.upsertShare(plan.id, 'u_alice', 'viewer');
  }

  // Users
  listUsers() {
    return this.users;
  }

  getUser(id) {
    return this.users.find((u) => u.id === id) || null;
  }

  getUserByEmail(email) {
    const needle = String(email || '').trim().toLowerCase();
    return this.users.find((u) => u.email === needle) || null;
  }

  // Documents
  createDocument({ ownerId, title, content = null, importedHtml = null }) {
    const now = new Date().toISOString();
    const doc = {
      id: newId('d'),
      ownerId,
      title,
      content: content || (importedHtml ? null : { ops: [{ insert: '\n' }] }),
      importedHtml,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.documents.push(doc);
    this.#persist();
    return doc;
  }

  getDocument(id) {
    return this.documents.find((d) => d.id === id) || null;
  }

  updateDocument(id, patch, { deferPersist = false } = {}) {
    const doc = this.getDocument(id);
    if (!doc) return null;
    if (patch.title !== undefined) doc.title = patch.title;
    // version tracks content only; it is the OT sequence number.
    if (patch.content !== undefined) {
      doc.content = patch.content;
      doc.importedHtml = null;
      doc.version += 1;
    }
    doc.updatedAt = new Date().toISOString();
    if (deferPersist) this.#schedulePersist();
    else this.#persist();
    return doc;
  }

  // Live typing produces many small changes; batch disk writes.
  #schedulePersist() {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.#persist();
    }, 500);
    this.persistTimer.unref?.();
  }

  flush() {
    if (!this.persistTimer) return;
    clearTimeout(this.persistTimer);
    this.persistTimer = null;
    this.#persist();
  }

  deleteDocument(id) {
    this.documents = this.documents.filter((d) => d.id !== id);
    this.shares = this.shares.filter((s) => s.docId !== id);
    this.#persist();
  }

  /** @returns {'owner'|'editor'|'viewer'|null} */
  getRole(doc, userId) {
    if (!doc || !userId) return null;
    if (doc.ownerId === userId) return 'owner';
    const share = this.shares.find((s) => s.docId === doc.id && s.userId === userId);
    return share ? share.role : null;
  }

  listDocumentsForUser(userId) {
    const byRecent = (a, b) => b.updatedAt.localeCompare(a.updatedAt);
    const owned = this.documents.filter((d) => d.ownerId === userId).sort(byRecent);
    const sharedIds = new Set(this.shares.filter((s) => s.userId === userId).map((s) => s.docId));
    const shared = this.documents.filter((d) => sharedIds.has(d.id) && d.ownerId !== userId).sort(byRecent);
    return { owned, shared };
  }

  // Shares
  listShares(docId) {
    return this.shares.filter((s) => s.docId === docId);
  }

  upsertShare(docId, userId, role) {
    const existing = this.shares.find((s) => s.docId === docId && s.userId === userId);
    if (existing) {
      existing.role = role;
    } else {
      this.shares.push({ docId, userId, role, createdAt: new Date().toISOString() });
    }
    this.#persist();
  }

  removeShare(docId, userId) {
    const before = this.shares.length;
    this.shares = this.shares.filter((s) => !(s.docId === docId && s.userId === userId));
    if (this.shares.length !== before) this.#persist();
    return this.shares.length !== before;
  }
}

module.exports = { Store, SEED_USERS, ROLES };
