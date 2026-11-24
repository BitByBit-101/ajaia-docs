// OT client state machine, shared by the browser editor and the Node test suite.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OTClient = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * Tracks one sent-but-unacknowledged change (`pending`) plus local edits made since (`buffer`).
   * The server orders all changes; remote ops are transformed past our unacknowledged ones.
   */
  class OTClient {
    constructor({ Delta, version, clientId }) {
      this.Delta = Delta;
      this.version = version;
      this.clientId = clientId;
      this.pending = null;
      this.pendingSeq = 0;
      this.buffer = null;
      this.seq = 0;
    }

    get idle() {
      return !this.pending && !this.buffer;
    }

    applyLocal(delta) {
      this.buffer = this.buffer ? this.buffer.compose(delta) : delta;
    }

    /** Moves the buffer into flight; returns the request body, or null if nothing to send. */
    takeSend() {
      if (this.pending || !this.buffer) return null;
      // Concurrent deletes can reduce a buffered edit to nothing; don't send no-ops.
      if (this.buffer.chop().ops.length === 0) {
        this.buffer = null;
        return null;
      }
      this.pending = this.buffer;
      this.buffer = null;
      this.pendingSeq = ++this.seq;
      return this.outgoing();
    }

    /** Request body for (re)sending the in-flight change against our latest known version. */
    outgoing() {
      return { baseVersion: this.version, ops: this.pending.ops, clientId: this.clientId, seq: this.pendingSeq };
    }

    /**
     * Handle a server-ordered op.
     * @returns {{type: 'ignore'} | {type: 'gap'} | {type: 'ack'} | {type: 'remote', delta: object}}
     */
    receive(entry) {
      if (entry.version <= this.version) return { type: 'ignore' };
      if (entry.version !== this.version + 1) return { type: 'gap' };
      this.version = entry.version;

      if (this.pending && entry.clientId === this.clientId && entry.seq === this.pendingSeq) {
        this.pending = null;
        return { type: 'ack' };
      }

      let remote = new this.Delta(entry.ops);
      if (this.pending) {
        const p = remote.transform(this.pending, true);
        remote = this.pending.transform(remote, false);
        this.pending = p;
      }
      if (this.buffer) {
        const b = remote.transform(this.buffer, true);
        remote = this.buffer.transform(remote, false);
        this.buffer = b;
      }
      return { type: 'remote', delta: remote };
    }
  }

  return OTClient;
});
