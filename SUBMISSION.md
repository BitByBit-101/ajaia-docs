# Submission – Ajaia Docs

**Live URL:** https://ajaia-docs-0sxe.onrender.com (free tier: first load after idle takes ~30 s)
**Source:** https://github.com/BitByBit-101/ajaia-docs
**Walkthrough video:** `<VIDEO_URL>` (also in `VIDEO_URL.txt`)
**Demo accounts (no password):** alice@ajaia.dev, bob@ajaia.dev, carol@ajaia.dev. Pick one on the sign-in screen.

## Included

| Item | Path |
|------|------|
| Source code (server) | `src/` |
| Source code (frontend) | `public/` |
| Automated tests | `test/api.test.js`, `test/ot-fuzz.test.js` (`npm test`, 15 tests) |
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
4. In that document, click **Share** and give Bob **Can view**. If Bob is signed in on his dashboard in another window, he gets a notification and the doc appears without a refresh.
5. Click **Switch user** and sign in as **Bob**. The document appears under "Shared with me" as view-only, and the editor is read-only.
6. As Bob, open the Welcome doc (Can edit). Bob can edit it but has no Share or Delete buttons.
7. **Real-time co-editing:** open the same doc as Alice in a normal window and as Bob in an incognito window, side by side. Type in both at once, even in the same sentence. Each person's text appears in the other window instantly, you can see each other's cursor and selection with a name label, and nothing is lost.

## Status

**Working end to end:** create, rename, rich-text edit, autosave and reopen, delete; `.txt`/`.md`/`.docx` import; owner/editor/viewer sharing with grant, change, and revoke; persistence; **real-time simultaneous co-editing** (operational transformation + Server-Sent Events); live cursors and selections with name labels; presence chips showing who is editing or viewing; live share, role-change, and removal notifications; validation and error messages; tests, including a 200-scenario convergence fuzz test.

**Measured on the live site:** an edit reaches the other user in about 0.3 s from India (one round trip to Render's US region); server processing is about 3 ms.

**Incomplete or limited:**
- Comments and suggestion mode are not implemented.
- Mocked auth: seeded users only.
- On the free host, data resets on redeploy or idle spin-down (works locally indefinitely), and the first load after 15 minutes idle takes about 30 s.

**Next 2–4 hours:** Postgres-backed `Store`, version history, Markdown/PDF export, comments anchored to text, and a Playwright UI test. Details are in `ARCHITECTURE.md`.
