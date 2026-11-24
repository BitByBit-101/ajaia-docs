# Ajaia Docs

A lightweight collaborative document editor: create, edit (rich text), rename, import files, and share documents with other users using owner / editor / viewer roles.

**Live demo:** https://ajaia-docs-0sxe.onrender.com  ·  **Walkthrough video:** see `VIDEO_URL.txt`

> Hosted on Render's free tier: the first load after ~15 min idle takes ~30 s to wake up, and data resets to the demo documents on restart.

## Demo accounts (no password)

| User | Email | Seeded data |
|------|-------|-------------|
| Alice Chen | alice@ajaia.dev | Owns "Welcome to Ajaia Docs" (shared with Bob as editor); has view-only access to Carol's "Q3 Planning Notes" |
| Bob Patel | bob@ajaia.dev | Can edit Alice's welcome doc |
| Carol Diaz | carol@ajaia.dev | Owns "Q3 Planning Notes" |

Click a user on the sign-in screen. Use **Switch user** (top right) to change accounts. A second browser or incognito window lets you stay signed in as two users at once.

## Features

- **Documents:** create, rename (click the title), delete (owner only), and continuous autosave with a save-status indicator.
- **Rich text (Quill 2):** H1–H3, bold, italic, underline, strikethrough, numbered and bulleted lists, blockquote, links.
- **File import:** `.txt`, `.md`, and `.docx` files up to 2 MB become a new editable document. Formatting is preserved: headings, bold and italic, lists. Other file types are rejected with a clear message.
- **Sharing:** the owner grants access by user with **Can edit** or **Can view**, changes roles, and revokes access. The dashboard separates **My documents** from **Shared with me** and shows role badges. Viewers get a read-only editor.
- **Persistence:** documents (stored as Quill Delta JSON) and shares are written to a JSON file and survive a refresh or server restart.
- **Real-time co-editing:** several people can type in the same document at the same moment, even in the same paragraph, and every keystroke appears for the others in well under a second. This uses operational transformation (the Google Docs model): the server orders every change and transforms concurrent ones so all editors converge. Changes are pushed over Server-Sent Events. Viewers watch edits arrive live.
- **Presence:** chips show who else has the document open, whether they're **editing** right now (pulsing) or just viewing. Updates are instant.
- **Live cursors:** see other people's caret and selection in their color with a name label. Cursors stay attached to the right text as anyone edits.
- **Live sharing:** when someone shares a doc with you, changes your role, or removes access, you get a notification and your dashboard updates without a refresh.
- **Resilience:** retried sends are idempotent. A dropped connection reconnects and replays missed changes. If a client falls too far behind, it reloads the latest version instead of corrupting the document.
- **Responsiveness:** edits are sent the moment you type (keystrokes typed while a save is in flight are batched). Each tab holds a single live connection, and switching documents is instant. On the live site, an edit reaches other users in one network round trip (about 0.3 s from India to Render's US region; server processing is about 3 ms).
- **Sample files** for import demos live in `samples/` (`.docx`, `.md`, `.txt`, and an unsupported `.pdf`).

## Run locally

Requires Node.js 20+.

```bash
npm install
npm start           # http://localhost:3000
npm test            # 15 tests: API, real-time, sharing, persistence + 200-scenario OT fuzz (node:test)
```

Data is stored in `data/db.json`, which is created and seeded with demo data on first run. Delete that file to reset.

| Env var | Default | Purpose |
|---------|---------|---------|
| `PORT` | `3000` | HTTP port |
| `DATA_FILE` | `./data/db.json` | Storage file location |
| `SESSION_SECRET` | random per boot | HMAC key for session cookies. Set it in production so sessions survive restarts. |
| `NODE_ENV` | – | `production` turns on `Secure` cookies |

## Deploy (Render, free tier)

1. Push this folder to a GitHub repo.
2. On Render, choose **New → Blueprint** and select the repo. `render.yaml` configures the build, start, health check, and a generated `SESSION_SECRET`.
3. Open the `*.onrender.com` URL.

> Note: the free Render tier has no persistent disk. Data persists across refreshes and while the instance is running. A redeploy or idle spin-down (after about 15 minutes) resets it to the seeded demo data. The first request after idling takes about 30 seconds while the instance wakes up. See [ARCHITECTURE.md](ARCHITECTURE.md) for the Postgres upgrade path.

## Project layout

```
src/
  index.js      server entry (env config)
  app.js        Express routes, auth middleware, access checks, validation, error handling
  store.js      JSON-file persistence, seed data, role resolution
  auth.js       HMAC-signed session cookie helpers
  importers.js  .txt/.md/.docx -> sanitized HTML
  collab.js     real-time hub: OT transform/ordering, op log, SSE fan-out
public/
  index.html, app.js, styles.css   vanilla JS SPA (no build step) + Quill
  ot-client.js  OT client state machine (shared with Node tests)
test/
  api.test.js   end-to-end API tests against a real server instance
  ot-fuzz.test.js  200 randomized 3-client concurrent-editing convergence scenarios
```

## API summary

| Method | Path | Access |
|--------|------|--------|
| POST | `/api/login` `{email}` / `/api/logout` | public |
| GET | `/api/me`, `/api/documents` (`{owned, shared}`) | signed in |
| POST | `/api/documents` `{title?, content?}` | signed in |
| POST | `/api/documents/import` (multipart `file`) | signed in |
| GET | `/api/documents/:id` | owner / editor / viewer |
| PATCH | `/api/documents/:id` `{title?, content?, baseVersion?}` | owner / editor |
| DELETE | `/api/documents/:id` | owner |
| GET/PUT | `/api/documents/:id/shares` `{email, role}` | owner |
| DELETE | `/api/documents/:id/shares/:userId` | owner |
| GET | `/api/documents/:id/presence` (who has the doc open, and who is editing) | owner / editor / viewer |
| POST | `/api/documents/:id/cursor` `{clientId, version, index, length}` (your caret or selection) | owner / editor / viewer |
| GET | `/api/events` (per-user Server-Sent Events: shared with you, access changed or removed, renamed, deleted) | signed in |
| POST | `/api/documents/:id/ops` `{baseVersion, ops, clientId, seq}` (one change, as a Quill Delta) | owner / editor |
| GET | `/api/documents/:id/events?since=N&clientId=X` (Server-Sent Events: `op`, `presence`, `cursor`, `cursor-leave`, `title`, `resync`, `reload`, `gone`) | owner / editor / viewer |

Users without access get `404` (not `403`) so document IDs can't be probed.
