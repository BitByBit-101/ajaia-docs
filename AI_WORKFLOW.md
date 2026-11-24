# AI Workflow Note

## Tools used
- **GitHub Copilot (agent mode in VS Code, Claude model):** planning, scaffolding, writing code and tests, running commands, and driving a browser for UI checks.
- **Me:** scope decisions, reviewing every file, and choosing what to accept, change, or reject.

## Where AI materially sped things up
- **Scope to plan in minutes.** I had the AI turn the brief into a concrete stack, an API surface, and a list of cuts, which I then edited.
- **Boilerplate with sharp edges:** HMAC cookie signing with a timing-safe compare, multer and error-middleware wiring, and the import pipeline (marked/mammoth/sanitize-html).
- **Test suite:** 12 end-to-end API tests against a real server instance (auth, forged cookie, CRUD with formatting round-trip, validation, conflicts, the full role matrix, import sanitization, presence, concurrent OT merges, a live SSE stream, disk persistence), plus a randomized OT fuzz test.
- **Real-time co-editing:** the AI drafted the OT client/server protocol quickly. I spent my review time on the ordering and failure cases rather than on boilerplate.
- **UI verification:** the agent drove the running app through Playwright. It created a doc, applied formatting, reloaded to confirm persistence, imported Markdown, shared with Bob, switched users, and confirmed view-only mode.

## What I changed or rejected
- **Rejected storing HTML as the document format** (the first instinct). I switched to Quill Delta JSON so the server can validate structure and avoid stored XSS.
- **Rejected `better-sqlite3`.** Native builds on Windows and some free hosts are a common failure point. I chose a JSON store behind a `Store` interface instead.
- **Fixed an async error-handling bug.** The first import route was an `async` handler. Express 4 doesn't catch rejected promises, so a bad file would have hung the request. I rewrote it to forward errors with `.catch(next)`.
- **Fixed a version race.** An early design saved titles and content through separate requests, which could trigger false `409` conflicts. I merged them into one serialized save path.
- **Fixed the test script.** `node --test test/` fails on Node 22 on Windows. Changed it to `node --test` (auto-discovery).
- **Fixed a `.docx` import gap.** While generating sample files, I found that mammoth drops underlines by default, and underline is a required format. Added a `u => u` style map.
- **Picked polling over WebSockets for presence**, and SSE + POST over WebSockets for co-editing. Both reuse the existing auth and access middleware and need no extra dependency.
- **Chose OT on Quill Deltas over Yjs.** Yjs would have meant a bundler and a new stored format. `quill-delta` already provides `transform`.
- **Changed where acks come from.** The first draft acknowledged sends from the POST response. That can race with remote changes still in the event stream, so acks now come through the same ordered SSE stream.
- **Added idempotent retries** (`clientId` + `seq`), so a resend after a lost response can't duplicate text.
- **Fixed a bug the fuzz test found.** A buffered edit can be transformed into a no-op, for example formatting text someone else just deleted, and the server rejected empty changes. The client now drops no-ops and the server tolerates them.
- **Extracted the OT client into a shared module** so the exact browser logic runs in the Node fuzz test.
- **Replaced a flaky browser stress test with a deterministic fuzz test.** The headless browser throttled timers in hidden tabs, so I moved convergence testing into Node where it's reproducible by seed.
- **Made `/api/users` public** after noticing the login screen needed it before sign-in. It exposes only seeded demo names and emails.
- **Changed no-access responses from `403` to `404`.** This stops anyone from probing whether a document ID exists.

## How I verified correctness
- `npm test`: 13 tests pass, including 200 randomized seeds where 3 clients edit concurrently and must end identical to the server.
- Two-editor browser check: two live editors on the same doc, both typing at the same time (one at the top, one at the end). Both editors and the server ended with identical content.
- Manual and agent-driven browser runs of every core flow (listed above), including the error paths: an unsupported file type, editing as a viewer, an empty title.
- Read through all generated code for security issues: output is built with `textContent` (no `innerHTML` with user data), uploads are sanitized, cookies are HttpOnly + SameSite=Lax (+ Secure in production), and request sizes are capped.
- UX check: save-status text, toasts for errors, a view-only banner, a disabled toolbar and title for viewers, and a confirmation before delete.
