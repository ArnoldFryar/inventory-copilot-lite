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
