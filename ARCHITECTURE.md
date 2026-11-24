# Architecture Note

## Goal
Ship a coherent, testable slice of a Google Docs-like editor within about 4–6 hours. I put depth into the core loop (**create → edit → save → share → reopen as another user**) instead of spreading effort thinly across many features.

## Stack and why

| Layer | Choice | Reason |
|-------|--------|--------|
| Server | Node 22 + Express 4 | Small, familiar, fast to make correct. One process serves both the API and the static UI. |
| Editor | Quill 2 (served from `node_modules`, no CDN) | Mature rich-text editor with a structured document model (Delta). Writing my own on top of `contentEditable`/`execCommand` would cost hours and still be buggy. |
| Frontend | Vanilla JS SPA, hash routing | Three screens don't justify React plus a bundler. No build step means less to break in deployment. |
| Storage | JSON file with atomic write-then-rename | Zero setup for reviewers, works locally and on any host. Every access goes through `Store`, so swapping in Postgres or SQLite touches one module. |
| Auth | Seeded users + HMAC-signed HttpOnly cookie | The brief allows mocked auth. Signing the cookie still makes access control real: a user can't forge another identity by editing the cookie. |
| Import | `marked` (md), `mammoth` (docx), then `sanitize-html` | Convert to HTML, then strip anything the editor can't represent (including scripts) before it reaches the client. |

## Key decisions

1. **Store content as Quill Delta JSON, not HTML.** Delta is structured, easy to validate on the server, and round-trips formatting exactly. HTML would require sanitizing on every save and is an XSS risk.
2. **Imports are converted once, on the client.** The server stores sanitized `importedHtml`. When the document is first opened, Quill's own clipboard converter turns it into a Delta, which is then saved and the HTML cleared. This avoids reimplementing HTML→Delta conversion on the server and keeps a single content format afterward.
3. **Roles: owner / editor / viewer.** This is slightly beyond the minimum, but each role is a one-line rank check in `loadDoc(minRole)` and it makes the sharing demo meaningful. Only the owner can share or delete.
4. **404 for no access.** This avoids leaking whether a document ID exists.
5. **Real-time co-editing with central-server operational transformation (OT).** This is the same model Google Docs uses. Each document has a version number and an in-memory log of recent changes.
   - A client sends its change with the version it was based on. The server transforms the change past everything that landed since (`quill-delta`'s `transform`), applies it, assigns the next version, and pushes it to all open editors over **Server-Sent Events**.
   - Each client ([public/ot-client.js](public/ot-client.js)) keeps one in-flight change (`pending`) and edits typed since (`buffer`). Incoming remote changes are transformed against both before they're applied to the editor, so your cursor and unsent typing are preserved.
   - Acknowledgements arrive through the same ordered event stream rather than the POST response. That removes the classic race where a response overtakes an earlier remote change.
   - **Why OT over a CRDT (Yjs):** Quill Deltas already ship with `transform`, so OT needed no new dependency, no bundler, and no change to the stored format. A CRDT would add a binary document format and a build step.
   - **Why SSE over WebSockets:** one-way push is all that's needed (edits go up as plain POSTs that reuse the existing auth and access checks). SSE also auto-reconnects with `Last-Event-ID`, which the server uses to replay missed changes.
6. **Robustness details:** sends carry `(clientId, seq)`, so a retried request after a lost response is never applied twice. Edits that a concurrent delete reduces to nothing are dropped. The server refuses changes that would remove the document's final newline or exceed size limits. Content writes to disk are batched every 500 ms and flushed on shutdown. Role changes and revoked access are pushed to open editors immediately.
7. **Presence via polling.** Every 4 s the client sends a heartbeat. The server keeps an in-memory `docId → {userId: lastSeen}` map with a 12 s TTL. Presence is best-effort, so simple polling was enough.
8. **Validation at the boundary:** title length and emptiness, Delta shape (op types, counts, and attributes), document size cap, JSON body size (2 MB), upload size (2 MB), file-extension allowlist, `.docx` magic-byte check, and share role allowlist. Errors return consistent `{error}` JSON, which the UI shows as toasts or inline messages.

## How correctness is tested

- `test/ot-fuzz.test.js` runs 200 randomized scenarios. In each, 3 simulated clients make random inserts, deletes, and formatting changes concurrently against the real server hub, with random message delivery timing and duplicate retries. It asserts that every client ends byte-identical to the server.
- `test/api.test.js` covers the HTTP layer end to end, including a real SSE stream and a two-user same-version edit that must merge to `"Hello brave world!"`.

## Deliberately cut

| Cut | Why |
|-----|-----|
| Live remote cursors / selections | Nice to have; presence avatars cover "who's here". |
| Real auth (passwords, OAuth) | The brief allows mocking it. Seeded users make the reviewer flow faster. |
| Sharing with arbitrary emails / invites | Sharing is limited to existing (seeded) users. |
| Comments, version history, export | Optional stretch items, not core. |
| Images or tables in the editor | Need file storage and a more complex schema. |
| Persistent storage on the free host | Documented trade-off; see below. |

## Known limitations

- The JSON store is single-process and rewrites the whole file on each write. That's fine for a demo, but not for concurrent production load.
- On Render's free tier, data resets on redeploy or idle spin-down. Seed data makes every reset demo-ready.
- The collaboration hub is in memory and single-process. Scaling to several server instances would need a shared ordering point (e.g. Postgres row lock or Redis stream) and pub/sub.
- Undo covers only your own edits (by design), but it is not transformed perfectly across others' edits in every edge case.

## Next 2–4 hours

1. Move `Store` to Postgres (Neon or Supabase free tier): `users`, `documents(content jsonb, version)`, `shares(doc_id, user_id, role)`. Same interface, durable on the free host.
2. Version history: snapshot the Delta on each save (throttled), plus a restore UI.
3. Export to Markdown/PDF and "import into the current document".
4. Live remote cursors (broadcast selection ranges over the same event stream).
5. Browser end-to-end test (Playwright) for the editor UI.
