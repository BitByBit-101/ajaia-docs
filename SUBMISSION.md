# Submission – Ajaia Docs

**Live URL:** `<LIVE_URL>`
**Walkthrough video:** `<VIDEO_URL>` (also in `VIDEO_URL.txt`)
**Demo accounts (no password):** alice@ajaia.dev, bob@ajaia.dev, carol@ajaia.dev. Pick one on the sign-in screen.

## Included

| Item | Path |
|------|------|
| Source code (server) | `src/` |
| Source code (frontend) | `public/` |
| Automated tests | `test/api.test.js` (`npm test`) |
| Setup and run instructions | `README.md` |
| Architecture note | `ARCHITECTURE.md` |
| AI workflow note | `AI_WORKFLOW.md` |
| Deployment config (Render) | `render.yaml` |
| Sample files for import | `samples/` |
| Walkthrough video link | `VIDEO_URL.txt` |
| Dependency manifest | `package.json`, `package-lock.json` |

`node_modules/` and `data/` are excluded. Run `npm install` and the data file is recreated with seed data on first start.

## Suggested review path (about 3 minutes)
1. Sign in as **Alice**. "My documents" and "Shared with me" are listed separately, with role badges.
2. Open "Welcome to Ajaia Docs", edit and format text, rename it, and refresh. Everything persists.
3. Go back and choose **Import file** with a `.md`, `.txt`, or `.docx` file. It becomes a new editable document.
4. In that document, click **Share** and give Bob **Can view**.
5. Click **Switch user** and sign in as **Bob**. The document appears under "Shared with me" as view-only, and the editor is read-only.
6. As Bob, open the Welcome doc (Can edit). Bob can edit it but has no Share or Delete buttons.
7. Optional live demo: open the same doc as Alice in a normal window and as Bob in an incognito window. Each sees the other's avatar, and a save by one appears for the other within about 4 seconds.

## Status

**Working end to end:** create, rename, rich-text edit, autosave and reopen, delete; `.txt`/`.md`/`.docx` import; owner/editor/viewer sharing with grant, change, and revoke; persistence; conflict detection (`409`); presence avatars and live pickup of other users' saves; validation and error messages; tests.

**Incomplete or limited:**
- No character-level simultaneous co-editing. If two people type at the same moment, the second save is blocked with a reload prompt instead of being merged.
- Mocked auth: seeded users only.
- On the free host, data resets on redeploy or idle spin-down (works locally indefinitely).

**Next 2–4 hours:** Postgres-backed `Store`, version history, Markdown/PDF export, WebSockets + Yjs for true co-editing, and a Playwright UI test. Details are in `ARCHITECTURE.md`.
