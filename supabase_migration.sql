-- ============================================================================
-- OpsCopilot-Lite — Supabase schema migration
--
-- Run once via the Supabase SQL Editor (Dashboard → SQL → New query).
-- This creates the analysis_runs table with row-level security (RLS) so
-- each user can only access their own rows.
--
-- Prerequisites:
--   1. A Supabase project with auth enabled (email/password provider ON).
--   2. The service-role key set in SUPABASE_SERVICE_KEY env var on the server.
-- ============================================================================

-- ── analysis_runs ───────────────────────────────────────────────────────────
-- Stores one row per upload/analysis that an authenticated user explicitly
-- saves.  Covers the schema target from the roadmap:
--   id, user_id, file_name, uploaded_at, part_count, summary_json,
--   results_json, plan_at_upload, source_type
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS analysis_runs (
  id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  file_name       text NOT NULL DEFAULT 'unknown',
  uploaded_at     timestamptz NOT NULL DEFAULT now(),
  part_count      integer NOT NULL DEFAULT 0,
  summary_json    jsonb NOT NULL DEFAULT '{}'::jsonb,
  results_json    jsonb NOT NULL DEFAULT '[]'::jsonb,
  plan_at_upload  text NOT NULL DEFAULT 'free',
  source_type     text NOT NULL DEFAULT 'manual'
    CHECK (source_type IN ('sample', 'manual'))
);

-- Index for fast per-user listing sorted by recency.
CREATE INDEX IF NOT EXISTS idx_runs_user_uploaded
  ON analysis_runs (user_id, uploaded_at DESC);

-- ── Row-Level Security ──────────────────────────────────────────────────────
-- Enable RLS so the anon/public key cannot access rows directly and each
-- authenticated user can only see/modify their own data.
-- The service-role key bypasses RLS automatically, which is what the
-- server-side API routes use.

ALTER TABLE analysis_runs ENABLE ROW LEVEL SECURITY;

-- Allow authenticated users to SELECT their own rows only.
DROP POLICY IF EXISTS "Users can read own runs" ON analysis_runs;
CREATE POLICY "Users can read own runs"
  ON analysis_runs FOR SELECT
  USING (auth.uid() = user_id);

-- Allow authenticated users to INSERT rows with their own user_id.
DROP POLICY IF EXISTS "Users can insert own runs" ON analysis_runs;
CREATE POLICY "Users can insert own runs"
  ON analysis_runs FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Allow authenticated users to DELETE their own rows only.
DROP POLICY IF EXISTS "Users can delete own runs" ON analysis_runs;
CREATE POLICY "Users can delete own runs"
  ON analysis_runs FOR DELETE
  USING (auth.uid() = user_id);

-- ── events ──────────────────────────────────────────────────────────────────
-- Lightweight product event log.
-- Rows are written by the server-side /api/events endpoint (service-role key).
-- Regular users have no SELECT access — all reads happen via service-role only.
-- user_id is nullable so anonymous events (pre-sign-in) can still be captured.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS events (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  event_name  text NOT NULL,
  properties  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_events_user_created
  ON events (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_events_name_created
  ON events (event_name, created_at DESC);

ALTER TABLE events ENABLE ROW LEVEL SECURITY;

-- Block direct client reads — analysis is done via service-role only.
DROP POLICY IF EXISTS "No client reads on events" ON events;
CREATE POLICY "No client reads on events"
  ON events FOR SELECT
  USING (false);

-- Authenticated users may insert only their own rows.
DROP POLICY IF EXISTS "Users can insert own events" ON events;
CREATE POLICY "Users can insert own events"
  ON events FOR INSERT
  WITH CHECK (auth.uid() = user_id OR user_id IS NULL);

-- ── Notes ───────────────────────────────────────────────────────────────────
-- • results_json stores the full array of RowResult objects.  For the data
--   volumes this app handles (≤ 50k rows, each ~200 bytes) a single JSONB
--   column is simpler and fast enough.  A normalised child table can be
--   introduced later if query-level filtering of individual results becomes
--   a product requirement.
--
-- • No UPDATE policy is needed for analysis_runs — runs are immutable records.
-- ────────────────────────────────────────────────────────────────────────────

-- ============================================================================
-- user_subscriptions — Stripe billing state per user
--
-- One row per user, upserted by the Stripe webhook handler or at checkout.
-- The server reads this to resolve each user's active plan instead of
-- relying on the PLAN env var.
-- ============================================================================

CREATE TABLE IF NOT EXISTS user_subscriptions (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  stripe_customer_id     text        UNIQUE,
  stripe_subscription_id text,
  subscription_status    text        NOT NULL DEFAULT 'inactive',
  plan                   text        NOT NULL DEFAULT 'free',
  current_period_end     timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

-- Fast lookup by user (most queries filter on user_id).
CREATE INDEX IF NOT EXISTS idx_user_subscriptions_user_id
  ON user_subscriptions (user_id);

-- Unique index on user_id so UPSERT (onConflict: 'user_id') works correctly.
-- One subscription row per Supabase user.
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_subscriptions_user_id_uniq
  ON user_subscriptions (user_id);

-- ── Row-Level Security ──────────────────────────────────────────────────────
-- Enable RLS so the anon key cannot access rows directly.
-- The service-role key (used by the server) bypasses RLS automatically.
ALTER TABLE user_subscriptions ENABLE ROW LEVEL SECURITY;

-- Allow authenticated users to SELECT their own subscription row only.
DROP POLICY IF EXISTS "Users can read own subscription" ON user_subscriptions;
CREATE POLICY "Users can read own subscription"
  ON user_subscriptions FOR SELECT
  USING (auth.uid() = user_id);

-- No INSERT/UPDATE/DELETE policies for the anon key — only the server
-- (via service-role key, bypassing RLS) writes to this table.

-- ============================================================================
-- profiles — one row per auth user, created at signup
--
-- Stores non-sensitive identity metadata (email, admin flag) that is safe to
-- read via the anon RLS policy.  The server can also read/write this table
-- via the service-role key (bypasses RLS).
--
-- id is the same UUID as auth.users(id) — no separate PK sequence needed.
-- ============================================================================

CREATE TABLE IF NOT EXISTS profiles (
  id         uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email      text,
  is_admin   boolean NOT NULL DEFAULT false,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

-- Allow authenticated users to read their own profile row.
DROP POLICY IF EXISTS "Users can view own profile" ON profiles;
CREATE POLICY "Users can view own profile"
  ON profiles FOR SELECT
  USING (auth.uid() = id);

-- Allow the user to insert their own profile row at signup.
DROP POLICY IF EXISTS "Users can insert own profile" ON profiles;
CREATE POLICY "Users can insert own profile"
  ON profiles FOR INSERT
  WITH CHECK (auth.uid() = id);

-- ============================================================================
-- Seed: backfill existing auth users into profiles
--
-- Run after the profiles table is created to populate rows for any users who
-- signed up before this table existed.  Safe to re-run — ON CONFLICT (id) DO
-- NOTHING is idempotent.
-- ============================================================================

INSERT INTO profiles (id, email)
SELECT id, email
FROM auth.users
WHERE email = 'breeze0125@gmail.com'
ON CONFLICT (id) DO NOTHING;

-- Grant admin to the primary account.
UPDATE profiles
SET is_admin = true
WHERE email = 'breeze0125@gmail.com';

-- ============================================================================
-- Migration: add module_key to analysis_runs
--
-- Allows the history table to store runs from any OpsCopilot product module
-- (inventory, procurement, …) without a separate table per module.
-- Existing rows default to 'inventory' — no data loss, fully backwards-
-- compatible.  The CHECK constraint mirrors the VALID_MODULES set in
-- runController.js; update both together when adding a module.
--
-- Run this section independently if the base schema was already applied.
-- ============================================================================

ALTER TABLE analysis_runs
  ADD COLUMN IF NOT EXISTS module_key text NOT NULL DEFAULT 'inventory'
    CHECK (module_key IN ('inventory', 'procurement'));

-- Index supports history list filtered by module (e.g. show only procurement runs).
CREATE INDEX IF NOT EXISTS idx_runs_user_module
  ON analysis_runs (user_id, module_key, uploaded_at DESC);


-- ============================================================================
-- Procurement Copilot — normalised tables
--
-- These tables store the structured output of a procurement analysis run.
-- They sit alongside the JSONB blobs in analysis_runs (summary_json /
-- results_json) which continue to serve as the fast-path for full-run
-- rendering.  The normalised tables enable cross-run queries, per-supplier
-- drill-down, and action-item tracking that JSONB alone cannot support
-- efficiently.
--
-- Design decisions:
--   • user_id is denormalised onto every child table so RLS policies can
--     enforce row ownership without joining back to analysis_runs.
--   • Monetary values use `numeric` (not integer cents) — procurement
--     teams work in decimal dollars and need arbitrary precision.
--   • Date columns use `date` (not timestamptz) — PO dates are business
--     calendar dates with no time component.
--   • risk_flags uses `text[]` (PostgreSQL array) — enables GIN indexing
--     and @> containment queries, better than JSONB for a flat string set.
--   • applied_rules / rule_details use `jsonb` — flexible, unstructured
--     explainability data that varies per rule.
--   • All child rows cascade-delete when the parent run is removed.
--     Action items use ON DELETE SET NULL for insight_id so they survive
--     insight regeneration if needed.
--   • Future modules (Supplier, Planning) can follow the same pattern:
--     a run in analysis_runs (new module_key value) + normalised children.
--
-- Run this section independently if the base schema was already applied.
-- ============================================================================


-- ── procurement_po_lines ────────────────────────────────────────────────────
-- One row per parsed PO line item from a CSV upload.
-- Maps 1:1 to the POLine shape in server/lib/procurement/types.js.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS procurement_po_lines (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id             uuid        NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  user_id            uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Core PO fields
  po_number          text        NOT NULL,
  line_number        text,
  supplier           text        NOT NULL,
  item_code          text,
  item_description   text,

  -- Quantities & pricing
  quantity_ordered   numeric,
  quantity_received  numeric,
  unit_price         numeric,
  line_amount        numeric     NOT NULL DEFAULT 0,

  -- Dates (business calendar, no time component)
  order_date         date,
  requested_date     date,
  confirmed_date     date,
  actual_date        date,

  -- Delivery status & risk
  delivery_status    text        NOT NULL DEFAULT 'pending'
    CHECK (delivery_status IN (
      'on_time', 'early', 'late', 'partial', 'overdue', 'cancelled', 'pending'
    )),
  days_variance      integer,
  category           text,
  risk_flags         text[]      NOT NULL DEFAULT '{}',

  -- Explainability: which rules fired on this line and why
  applied_rules      jsonb       NOT NULL DEFAULT '[]'::jsonb,

  -- Risk engine outputs
  risk_score         integer     NOT NULL DEFAULT 0,
  severity           text        NOT NULL DEFAULT 'Low'
    CHECK (severity IN ('High', 'Medium', 'Low')),

  -- Buyer / plant attribution (optional in many ERP exports)
  buyer              text,
  plant              text,

  -- Preserves original CSV row order for display
  row_index          integer     NOT NULL DEFAULT 0
);

-- Reconcile older deployments where the table already existed before newer
-- procurement fields were added. CREATE TABLE IF NOT EXISTS does not evolve an
-- existing table shape, so these ALTERs are required for safe re-runs.
ALTER TABLE procurement_po_lines
  ADD COLUMN IF NOT EXISTS buyer text,
  ADD COLUMN IF NOT EXISTS plant text,
  ADD COLUMN IF NOT EXISTS quantity_received numeric,
  ADD COLUMN IF NOT EXISTS confirmed_date date,
  ADD COLUMN IF NOT EXISTS actual_date date,
  ADD COLUMN IF NOT EXISTS applied_rules jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS category text,
  ADD COLUMN IF NOT EXISTS risk_flags text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS risk_score integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS severity text NOT NULL DEFAULT 'Low',
  ADD COLUMN IF NOT EXISTS row_index integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_po_lines_run
  ON procurement_po_lines (run_id);

CREATE INDEX IF NOT EXISTS idx_po_lines_user_status
  ON procurement_po_lines (user_id, delivery_status);

CREATE INDEX IF NOT EXISTS idx_po_lines_supplier
  ON procurement_po_lines (supplier);

-- GIN index for risk_flags array containment queries (e.g. WHERE risk_flags @> '{single_source}')
CREATE INDEX IF NOT EXISTS idx_po_lines_risk_flags
  ON procurement_po_lines USING GIN (risk_flags);

ALTER TABLE procurement_po_lines ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own po_lines" ON procurement_po_lines;
CREATE POLICY "Users can read own po_lines"
  ON procurement_po_lines FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own po_lines" ON procurement_po_lines;
CREATE POLICY "Users can insert own po_lines"
  ON procurement_po_lines FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own po_lines" ON procurement_po_lines;
CREATE POLICY "Users can delete own po_lines"
  ON procurement_po_lines FOR DELETE
  USING (auth.uid() = user_id);


-- ── procurement_supplier_rollups ────────────────────────────────────────────
-- One row per unique supplier per run.  Pre-computed aggregates that power
-- the Supplier Risk Breakdown table on the procurement dashboard.
-- Maps 1:1 to the SupplierRollup shape in types.js.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS procurement_supplier_rollups (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id             uuid        NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  user_id            uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  supplier           text        NOT NULL,
  line_count         integer     NOT NULL DEFAULT 0,
  po_count           integer     NOT NULL DEFAULT 0,
  total_spend        numeric     NOT NULL DEFAULT 0,
  spend_share_pct    numeric,
  on_time_rate_pct   numeric,
  avg_days_variance  numeric,
  item_count         integer     NOT NULL DEFAULT 0,

  -- Risk engine rollup outputs
  overdue_count      integer     NOT NULL DEFAULT 0,
  high_risk_count    integer     NOT NULL DEFAULT 0,
  flagged_count      integer     NOT NULL DEFAULT 0,
  due_soon_count     integer     NOT NULL DEFAULT 0,
  past_due_dollars   numeric     NOT NULL DEFAULT 0,
  max_days_overdue   integer,

  risk_flags         text[]      NOT NULL DEFAULT '{}',
  severity           text        NOT NULL DEFAULT 'Low'
    CHECK (severity IN ('High', 'Medium', 'Low'))
);

ALTER TABLE procurement_supplier_rollups
  ADD COLUMN IF NOT EXISTS item_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS flagged_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS due_soon_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS past_due_dollars numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_days_overdue integer,
  ADD COLUMN IF NOT EXISTS risk_flags text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS severity text NOT NULL DEFAULT 'Low';

CREATE INDEX IF NOT EXISTS idx_supplier_rollups_run
  ON procurement_supplier_rollups (run_id);

CREATE INDEX IF NOT EXISTS idx_supplier_rollups_user_severity
  ON procurement_supplier_rollups (user_id, severity);

ALTER TABLE procurement_supplier_rollups ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own supplier_rollups" ON procurement_supplier_rollups;
CREATE POLICY "Users can read own supplier_rollups"
  ON procurement_supplier_rollups FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own supplier_rollups" ON procurement_supplier_rollups;
CREATE POLICY "Users can insert own supplier_rollups"
  ON procurement_supplier_rollups FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own supplier_rollups" ON procurement_supplier_rollups;
CREATE POLICY "Users can delete own supplier_rollups"
  ON procurement_supplier_rollups FOR DELETE
  USING (auth.uid() = user_id);


-- ── procurement_insights ────────────────────────────────────────────────────
-- One row per actionable finding produced by the analysis engine.
-- Maps 1:1 to the ProcurementInsight shape in types.js.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS procurement_insights (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id              uuid        NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  user_id             uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  insight_key         text        NOT NULL,     -- stable deterministic key: "{category}:{detail_key}"
  category            text        NOT NULL
    CHECK (category IN ('spend_analysis', 'supplier_risk', 'po_consolidation')),
  severity            text        NOT NULL DEFAULT 'Low'
    CHECK (severity IN ('High', 'Medium', 'Low')),
  title               text        NOT NULL,
  description         text,
  affected_supplier   text,
  affected_items      text[]      NOT NULL DEFAULT '{}',
  metric_value        numeric,
  metric_label        text,
  risk_flags          text[]      NOT NULL DEFAULT '{}',
  recommended_action  text,

  -- Explainability: which rules produced this insight and their parameters
  rule_details        jsonb       NOT NULL DEFAULT '{}'::jsonb
);

ALTER TABLE procurement_insights
  ADD COLUMN IF NOT EXISTS affected_items text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS metric_value numeric,
  ADD COLUMN IF NOT EXISTS metric_label text,
  ADD COLUMN IF NOT EXISTS risk_flags text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS recommended_action text,
  ADD COLUMN IF NOT EXISTS rule_details jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_insights_run
  ON procurement_insights (run_id);

CREATE INDEX IF NOT EXISTS idx_insights_user_category
  ON procurement_insights (user_id, category);

ALTER TABLE procurement_insights ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own insights" ON procurement_insights;
CREATE POLICY "Users can read own insights"
  ON procurement_insights FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own insights" ON procurement_insights;
CREATE POLICY "Users can insert own insights"
  ON procurement_insights FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own insights" ON procurement_insights;
CREATE POLICY "Users can delete own insights"
  ON procurement_insights FOR DELETE
  USING (auth.uid() = user_id);


-- ── procurement_action_items ────────────────────────────────────────────────
-- User-editable tasks derived from insights.  The only mutable table in the
-- procurement schema — status, assignee, note, and due_date can be updated.
-- Maps 1:1 to the ProcurementActionItem shape in types.js.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS procurement_action_items (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id       uuid        NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  insight_id   uuid        REFERENCES procurement_insights(id) ON DELETE SET NULL,
  user_id      uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  title        text        NOT NULL,
  status       text        NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'in_progress', 'resolved', 'dismissed')),
  assignee     text,
  due_date     date,
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE procurement_action_items
  ADD COLUMN IF NOT EXISTS insight_id uuid REFERENCES procurement_insights(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS assignee text,
  ADD COLUMN IF NOT EXISTS due_date date,
  ADD COLUMN IF NOT EXISTS note text,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_action_items_run
  ON procurement_action_items (run_id);

CREATE INDEX IF NOT EXISTS idx_action_items_user_status
  ON procurement_action_items (user_id, status);

ALTER TABLE procurement_action_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own action_items" ON procurement_action_items;
CREATE POLICY "Users can read own action_items"
  ON procurement_action_items FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own action_items" ON procurement_action_items;
CREATE POLICY "Users can insert own action_items"
  ON procurement_action_items FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own action_items" ON procurement_action_items;
CREATE POLICY "Users can update own action_items"
  ON procurement_action_items FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own action_items" ON procurement_action_items;
CREATE POLICY "Users can delete own action_items"
  ON procurement_action_items FOR DELETE
  USING (auth.uid() = user_id);

-- ============================================================================
-- PFEP (Plan For Every Part) — master parts register
--
-- The PFEP register stores per-part replenishment parameters: supplier(s),
-- lead time, pack multiple, min/max quantities, point-of-use, and ABC class.
-- It is the data layer that bridges inventory triage and procurement analysis —
-- a stable source of truth for how each part should be sourced and stocked.
--
-- Design decisions:
--   • UNIQUE (user_id, part_number) enables upsert semantics — importing the
--     same PFEP file twice is idempotent.  Updated parts overwrite old values.
--   • source_run_id links back to the analysis_runs row for the import that
--     last set this part's values.  ON DELETE SET NULL so parts survive if the
--     import event is purged from history.
--   • replenishment_method uses a closed-set CHECK; mirrors pfepColumnMap.js.
--   • abc_class uses a CHECK; null is permitted for unclassified parts.
--   • Monetary / quantity values use numeric (not integer) for decimal fidelity.
--
-- Run this section after the procurement schema has been applied.
-- ============================================================================

-- ── Extend module_key CHECK to include 'pfep' ────────────────────────────────
-- The original ADD COLUMN constrained module_key to ('inventory','procurement').
-- Drop and re-add the constraint to include 'pfep'.  Safe to re-run.
ALTER TABLE analysis_runs
  DROP CONSTRAINT IF EXISTS analysis_runs_module_key_check;

ALTER TABLE analysis_runs
  ADD CONSTRAINT analysis_runs_module_key_check
    CHECK (module_key IN ('inventory', 'procurement', 'pfep'));

-- ── pfep_parts ───────────────────────────────────────────────────────────────
-- One row per unique part number per user.  Upserted on every PFEP CSV import.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pfep_parts (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Identity
  part_number          text        NOT NULL,
  part_description     text,
  commodity_class      text,
  abc_class            text        CHECK (abc_class IN ('A', 'B', 'C')),

  -- Supplier(s)
  supplier             text,
  secondary_supplier   text,
  supplier_part_number text,

  -- Replenishment parameters
  replenishment_method text        NOT NULL DEFAULT 'min_max'
    CHECK (replenishment_method IN (
      'min_max', 'kanban', 'mrp', 'consignment', 'jit', 'reorder_point', 'other'
    )),
  lead_time_days       integer,
  reorder_point        numeric,
  min_qty              numeric,
  max_qty              numeric,
  pack_multiple        numeric,
  standard_pack        numeric,
  unit_of_measure      text,

  -- Cost & demand
  unit_cost            numeric,
  annual_usage         numeric,

  -- Location
  point_of_use         text,
  plant                text,

  -- Free-form
  notes                text,

  -- Import provenance
  source_run_id        uuid        REFERENCES analysis_runs(id) ON DELETE SET NULL,
  imported_at          timestamptz NOT NULL DEFAULT now(),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- Unique constraint: one part row per user.  Drives ON CONFLICT upsert.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pfep_parts_user_part
  ON pfep_parts (user_id, part_number);

-- Fast per-user listing sorted by most-recently updated.
CREATE INDEX IF NOT EXISTS idx_pfep_parts_user
  ON pfep_parts (user_id, updated_at DESC);

-- Supports supplier-level cross-referencing with procurement data.
CREATE INDEX IF NOT EXISTS idx_pfep_parts_supplier
  ON pfep_parts (user_id, supplier);

ALTER TABLE pfep_parts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own pfep_parts" ON pfep_parts;
CREATE POLICY "Users can read own pfep_parts"
  ON pfep_parts FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own pfep_parts" ON pfep_parts;
CREATE POLICY "Users can insert own pfep_parts"
  ON pfep_parts FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own pfep_parts" ON pfep_parts;
CREATE POLICY "Users can update own pfep_parts"
  ON pfep_parts FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own pfep_parts" ON pfep_parts;
CREATE POLICY "Users can delete own pfep_parts"
  ON pfep_parts FOR DELETE
  USING (auth.uid() = user_id);
