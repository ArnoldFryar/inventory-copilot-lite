# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased] — 2026-03-16

### Added — User Accounts & Saved History (Supabase)
- **`supabaseClient.js`** — Server-side Supabase client singleton with JWT verification helper (`verifyToken`). Gracefully exports `null`/`false` when env vars are missing so anonymous mode keeps working.
- **`supabase_migration.sql`** — Database schema: `analysis_runs` table with UUIDs, jsonb columns for summary/results, Row-Level Security policies scoped to `auth.uid()`, and a composite index on `(user_id, uploaded_at)`.
- **`.env.example`** — Template documenting all environment variables (PORT, PLAN, rate limits, Supabase URL/keys).
- **`public/auth.js`** — Frontend auth module. Dynamically loads Supabase browser SDK from CDN, fetches config from `/api/auth-config`, and exposes `signUp`, `signIn`, `signOut`, `getSession`, `getToken`, `onAuthChange` on `window.authModule`.
- **Server routes** — `/api/auth-config` (public, returns Supabase URL + anon key), `requireAuth` middleware, `/api/runs` CRUD (POST/GET/GET:id/DELETE) with ownership enforcement.
- **Frontend auth UI** — Sign In button in header, account menu (email + sign out), auth modal (email/password sign-in and sign-up), Save to History button in action bar, history section with load/delete per run.
- **6 new regression tests** (P25) for `supabaseClient` module shape + graceful degradation when unconfigured. Total: **95 tests**, all passing.
- **README.md** — Added Supabase setup section (create project, run migration, set env vars, enable email auth).

### Changed
- **`server.js`** — Added Supabase import, updated CSP `connect-src` to allow Supabase URL, raised JSON body limit from 4 KB to 10 MB (for results_json payloads), added `requireAuth` middleware and full `/api/runs` CRUD.
- **`public/index.html`** — Added auth.js script tag, account menu in header, auth modal dialog, Save to History button, history section. Updated footer version to v0.4.
- **`public/script.js`** — Added auth DOM refs, auth state management, modal open/close/toggle/submit handlers, sign-out handler, `onAuthStateChanged` listener, Save to History handler (POST /api/runs), history panel (fetch/render/load/delete runs), auth initialization on page load.
- **`public/style.css`** — Added styles for account menu, sign-in button, auth modal, auth form inputs/errors, save-run button, history list items. Updated print stylesheet to hide all auth/history UI.
- **`package.json`** — Added `@supabase/supabase-js@2` dependency.

### Previous — Plan / Monetization Shell

### Removed
- **`inventory-copilot-lite/` sub-folder** — Deleted in full. This was an earlier prototype that pre-dated the current architecture. It contained its own `server.js` (no rate-limiting, no column-alias resolution, no BOM handling), a simpler `analyzer.js` (inline thresholds, no `config.js`/`columnMap.js`), and dependencies on `openai`, `cors`, and `dotenv` that are not used by the active app. All functionality has been superseded by the root-level application.
- **`inventory-copilot-lite/node_modules/`** — Removed along with the prototype folder above. These were the prototype's installed dependencies; they have no relation to the active app's `node_modules`.

### Added
- **`.gitignore`** — New root-level file. Excludes `node_modules/`, `uploads/`, `.env` / `.env.*`, generated CSV exports (`exports/`, `*.csv.out`, `*.export.csv`), and common OS/editor artefacts (`.DS_Store`, `Thumbs.db`, `.idea/`, `.vscode/`, `*.log`, etc.).
- **`README.md`** — New file. Includes quick-start instructions, accepted CSV column aliases, an **Active App Structure** section that lists every canonical file/directory, and a summary table of what was removed and why.

### No behaviour changes
- Zero modifications to `analyzer.js`, `config.js`, `columnMap.js`, `csvIngest.js`, `server.js`, or any frontend file.
- All 73 regression tests pass (`npm test`).
