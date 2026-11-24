# Ajaia Docs

A lightweight collaborative document editor: create, edit (rich text), rename, import files, and share documents with other users using owner / editor / viewer roles.

**Live demo:** `<LIVE_URL>`  ·  **Walkthrough video:** see `VIDEO_URL.txt`

## Demo accounts (no password)

| User | Email | Seeded data |
|------|-------|-------------|
| Alice Chen | alice@ajaia.dev | Owns "Welcome to Ajaia Docs" (shared with Bob as editor); has view-only access to Carol's "Q3 Planning Notes" |
| Bob Patel | bob@ajaia.dev | Can edit Alice's welcome doc |
| Carol Diaz | carol@ajaia.dev | Owns "Q3 Planning Notes" |

Click a user on the sign-in screen. Use **Switch user** (top right) to change accounts. A second browser or incognito window lets you stay signed in as two users at once.

## Features

- **Documents:** create, rename (click the title), delete (owner only), and autosave about 0.8 s after you stop typing, with a save-status indicator.
- **Rich text (Quill 2):** H1–H3, bold, italic, underline, strikethrough, numbered and bulleted lists, blockquote, links.
- **File import:** `.txt`, `.md`, and `.docx` files up to 2 MB become a new editable document. Formatting is preserved: headings, bold and italic, lists. Other file types are rejected with a clear message.
- **Sharing:** the owner grants access by user with **Can edit** or **Can view**, changes roles, and revokes access. The dashboard separates **My documents** from **Shared with me** and shows role badges. Viewers get a read-only editor.
- **Persistence:** documents (stored as Quill Delta JSON) and shares are written to a JSON file and survive a refresh or server restart.
- **Conflict safety:** saves carry a `baseVersion`. A stale save returns `409`, and the UI asks you to reload instead of silently overwriting someone else's changes.

## Run locally

Requires Node.js 20+.

```bash
npm install
npm start           # http://localhost:3000
npm test            # API + persistence tests (node:test, no extra deps)
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
public/
  index.html, app.js, styles.css   vanilla JS SPA (no build step) + Quill
test/
  api.test.js   end-to-end API tests against a real server instance
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

Users without access get `404` (not `403`) so document IDs can't be probed.
