'use strict';

// ---------------------------------------------------------------------------
// OpsCopilot — Supabase admin (service-role) client
//
// SERVER-SIDE ONLY. Never import this module from browser-facing bundles.
// The service role key bypasses Row Level Security; it must stay on the server.
//
// Environment variables:
//   SUPABASE_URL         — project URL, e.g. https://xyz.supabase.co
//   SUPABASE_SERVICE_KEY — service-role secret key (never expose to browser)
// ---------------------------------------------------------------------------

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL         = (process.env.SUPABASE_URL         || '').trim();
const SUPABASE_SERVICE_KEY = (process.env.SUPABASE_SERVICE_KEY || '').trim();

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  // Warn loudly at startup rather than failing silently at query time.
  console.warn(
    '[supabaseAdmin] SUPABASE_URL or SUPABASE_SERVICE_KEY is not set. ' +
    'Database operations will be unavailable.'
  );
}

/**
 * Supabase client initialised with the service-role key.
 * Bypasses RLS — use only in trusted server-side code.
 *
 * Resolves to null when required env vars are absent (graceful degradation).
 */
const supabaseAdmin =
  SUPABASE_URL && SUPABASE_SERVICE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      })
    : null;

module.exports = { supabaseAdmin };
