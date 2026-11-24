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
5. **Optimistic concurrency instead of real-time collaboration.** Each save sends `baseVersion`. A mismatch returns `409` and the UI blocks further edits until a reload. This prevents silent lost updates when two people edit the same document, without the cost of CRDT/OT and WebSockets.
6. **Serialized client save queue.** Title and content changes go through a single `flushSave()`, so version numbers never race against each other.
7. **Validation at the boundary:** title length and emptiness, Delta shape (insert-only ops, op-count cap), JSON body size (2 MB), upload size (2 MB), file-extension allowlist, `.docx` magic-byte check, and share role allowlist. Errors return consistent `{error}` JSON, which the UI shows as toasts or inline messages.

## Deliberately cut

| Cut | Why |
|-----|-----|
| Real-time co-editing (CRDT/OT, presence) | The biggest cost and risk. Conflict detection covers correctness for this scope. |
| Real auth (passwords, OAuth) | The brief allows mocking it. Seeded users make the reviewer flow faster. |
| Sharing with arbitrary emails / invites | Sharing is limited to existing (seeded) users. |
| Comments, version history, export | Optional stretch items, not core. |
| Images or tables in the editor | Need file storage and a more complex schema. |
| Persistent storage on the free host | Documented trade-off; see below. |

## Known limitations

- The JSON store is single-process and rewrites the whole file on each write. That's fine for a demo, but not for concurrent production load.
- On Render's free tier, data resets on redeploy or idle spin-down. Seed data makes every reset demo-ready.
- Edit conflicts are detected but not merged.

## Next 2–4 hours

1. Move `Store` to Postgres (Neon or Supabase free tier): `users`, `documents(content jsonb, version)`, `shares(doc_id, user_id, role)`. Same interface, durable on the free host.
2. Version history: snapshot the Delta on each save (throttled), plus a restore UI.
3. Export to Markdown/PDF and "import into the current document".
4. Presence indicator ("Bob is viewing") through polling or SSE, as a step toward real-time.
5. Browser end-to-end test (Playwright) for the editor UI.
