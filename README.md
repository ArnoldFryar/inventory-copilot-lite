# Inventory Copilot Lite

OpsCopilot-Lite — a lightweight inventory triage tool that ingests CSV and Excel (.xlsx) exports from ERP/WMS systems and returns a prioritised list of parts needing attention (stockout risk, excess inventory, slow movers).

## Quick start

Use the Node.js release in `.nvmrc`.

```sh
npm ci
npm start
npm test
npx playwright install chromium
npm run test:browser
```

Upload a CSV or XLSX export up to 5 MB and 50,000 rows. OpsCopilot can suggest common ERP column aliases. Use **Review column mapping** to select custom headers, choose a worksheet, or confirm a calendar conversion. The **Run sample** button previews a ready-made export.

| Fields | Inventory results |
| --- | --- |
| Part number and on hand | Quantity and zero-stock review |
| Add positive daily usage | Days of coverage |
| Add comparable lead time | Shortage risk ranking |

Signed-in users may remember mappings in the current browser. Missing inputs remain visible as data needs. Confirm open POs, allocations and demand in the ERP before acting on coverage results.

## Active App Structure

The following files and directories are **canonical** — they constitute the entire active application. Do not add business logic outside this tree.

```
inventory-copilot-lite/          ← repo root
│
├── server.js                    ← Express server, file upload & routes
├── analyzer.js                  ← Core classification logic (do not edit thresholds here)
├── config.js                    ← All tunable thresholds live here
├── columnMap.js                 ← Header alias resolution & BOM handling
├── csvIngest.js                 ← Encoding detection, header-row finder, CSV parsing
├── xlsxIngest.js                ← Safe workbook parsing, worksheet/header detection
├── plans.js                     ← Plan model (free/pro) & limit enforcement
├── supabaseClient.js            ← Server-side Supabase client & JWT verification
├── supabase_migration.sql       ← Database schema (run once in Supabase SQL Editor)
├── .env.example                 ← Template for required environment variables
├── package.json
├── package-lock.json
│
├── public/                      ← Static frontend (served by Express)
│   ├── index.html
│   ├── script.js
│   ├── style.css
│   ├── analytics.js
│   ├── auth.js                  ← Frontend auth module (CDN Supabase SDK)
│   └── sample.csv               ← Example upload for manual testing
│
├── uploads/                     ← Transient upload staging (gitignored)
│
├── _test_regression.js          ← Deterministic regression and policy checks
└── _test_http.js                ← HTTP security and route-contract checks
```

### What was removed and why

| Removed | Reason |
|---|---|
| `inventory-copilot-lite/` sub-folder | Older prototype that predates the current architecture. It used OpenAI, `cors`, and `dotenv` but had no rate-limiting, no column-alias resolution, no BOM handling, and no test suite. All functionality it provided has been superseded by the root-level app. |
| `inventory-copilot-lite/node_modules/` | Contained dependencies for the removed prototype only; no longer needed. |

> **node_modules is gitignored.** Run `npm install` after cloning to restore dependencies.

---

## Configuration

All classification thresholds are centralised in [`config.js`](config.js). Adjust values there; do not hard-code thresholds in `analyzer.js`.

AI helpers are authenticated and rate limited per account. The defaults in
`.env.example` cap requests at 20 per 15 minutes and bound the analysis,
selection, supplier-group, and refinement payload sizes before provider calls.
Tune the `AI_RATE_*` and `AI_MAX_*` values for the capacity of your deployment.

The hostname diagnostic route is off by default. Set
`ENABLE_HOST_DIAGNOSTICS=true` only while actively troubleshooting routing.

## Quality Gates

`npm test` runs both the core regression suite and live HTTP integration checks.
The HTTP suite verifies the security-header baseline, safe JSON errors,
telemetry event compatibility, disabled diagnostics, and authentication order
for premium AI requests.

## Deployment

The app is a single-process Node 24 and Express 5 server. Set `PORT` via environment variable (default: `3000`). No database or external API dependencies are needed for the core analysis — Supabase is optional for user accounts and history.

---

## Supabase Setup (Optional)

The app works fully without Supabase — anonymous access, sample data, upload, and analysis all function. To enable **user accounts and saved analysis history**, set up Supabase:

### 1. Create a Supabase project

Go to [supabase.com](https://supabase.com) and create a free project.

### 2. Run the database migration

Open the **SQL Editor** in your Supabase dashboard and paste the contents of [`supabase_migration.sql`](supabase_migration.sql). This creates the `analysis_runs` table with Row-Level Security.

### 3. Set environment variables

Copy `.env.example` to `.env` and fill in the three Supabase values:

```bash
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=eyJ...          # public anon key (safe for browser)
SUPABASE_SERVICE_KEY=eyJ...       # service-role key (server-only, never exposed)
```

### 4. Enable email/password auth

In the Supabase dashboard under **Authentication → Providers**, ensure **Email** is enabled. No SMTP setup is required for development (Supabase sends confirmation emails via its built-in mailer).

### 5. Restart the server

```bash
npm start
```

When configured, users can sign in and open or delete their saved runs. Pro users may save new customer analyses explicitly. Free includes full-file counts and a preview of 50 ranked rows.

### Inventory v2 rollout

For an existing database, apply the **Inventory v2** section at the end of `supabase_migration.sql` in staging before starting the updated service. For a new database, apply the full migration. Configure the Supabase password recovery redirect allowlist for the application origin and test with separate Free and Pro accounts. Run Stripe's test checkout, cancellation and delivery retry before enabling paid traffic. Publish the build using the Git SHA that passed the checks.

Raw inventory uploads use a private temporary folder. Normal completion deletes the file. Periodic cleanup removes abandoned files older than one hour. Signed-in Pro analyses are held in a bounded, process-local cache for up to 30 minutes, or until saved or deleted. A restart or cache eviction can require reanalysis. Keep this deployment single-instance or use a shared private cache before scaling. Saved results remain in Supabase until deletion, subject to the deployment's provider backup schedule. AI only receives bounded selected row facts and requested guidance to draft follow-up. Review provider retention before using customer data.
