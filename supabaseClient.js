'use strict';

// ---------------------------------------------------------------------------
// OpsCopilot-Lite — Supabase client singleton
//
// Provides a server-side Supabase client and JWT verification helper.
//
// Environment variables (required for Supabase features):
//   SUPABASE_URL       — project URL, e.g. https://xyz.supabase.co
//   SUPABASE_ANON_KEY  — public anon key (safe for client-side usage)
//   SUPABASE_SERVICE_KEY — service-role key (server-side only, never exposed)
//
// When env vars are missing, supabase* exports resolve to null and the
// auth middleware falls through gracefully — anonymous behaviour is preserved.
// ---------------------------------------------------------------------------

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL         = (process.env.SUPABASE_URL         || '').trim();
const SUPABASE_ANON_KEY    = (process.env.SUPABASE_ANON_KEY    || '').trim();
const SUPABASE_SERVICE_KEY = (process.env.SUPABASE_SERVICE_KEY || '').trim();

const isConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY && SUPABASE_SERVICE_KEY);

// Service-role client — bypasses RLS, used by protected API routes only.
const supabaseAdmin = isConfigured
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false }
    })
  : null;

/**
 * Verifies a Supabase access token (JWT) and returns the user object.
 *
 * @param {string} token — Bearer token from the Authorization header.
 * @returns {Promise<{user: object|null, error: string|null}>}
 */
async function verifyToken(token) {
  if (!supabaseAdmin) {
    return { user: null, error: 'Supabase is not configured.' };
  }
  if (!token) {
    return { user: null, error: 'No token provided.' };
  }
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data?.user) {
    return { user: null, error: error?.message || 'Invalid token.' };
  }
  return { user: data.user, error: null };
}

module.exports = {
  supabaseAdmin,
  verifyToken,
  isConfigured,
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
};
