# Inventory Copilot Lite

OpsCopilot-Lite — a lightweight inventory triage tool that ingests a CSV export from any ERP/WMS and returns a prioritised list of parts needing attention (stockout risk, excess inventory, slow movers).

## Quick Start

```bash
npm install
npm start          # starts on http://localhost:3000
npm test           # runs the regression suite
```

Upload a CSV file with the following columns (aliases and mixed-case headers are auto-resolved):

| Canonical column | Common aliases accepted |
|---|---|
| `part_number` | `sku`, `item`, `part`, `part_no`, … |
| `on_hand` | `qty`, `quantity`, `stock`, `inventory`, … |
| `daily_usage` | `usage`, `avg_usage`, `daily_demand`, … |
| `lead_time` | `lt`, `lead`, `leadtime`, `days_lead`, … |

---

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
└── _test_regression.js          ← Node regression suite (95 tests); run with `npm test`
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

## Deployment

The app is a single-process Node/Express server. Set `PORT` via environment variable (default: `3000`). No database or external API dependencies are needed for the core analysis — Supabase is optional for user accounts and history.

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

When configured, users will see a "Sign in" button in the header. After signing in, they can save analysis runs to their account and reload them from the history panel.
