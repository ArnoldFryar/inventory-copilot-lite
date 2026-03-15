'use strict';

// ---------------------------------------------------------------------------
// getUserPlan — resolves the active plan for a Supabase user.
//
// Queries the user_subscriptions table using the service-role client and
// returns 'pro' if the user has an active Pro subscription, otherwise 'free'.
//
// Usage:
//   const { getUserPlan } = require('./server/lib/getUserPlan');
//   const plan = await getUserPlan(userId, supabaseAdmin); // 'pro' | 'free'
//
// Parameters:
//   userId        {string} — Supabase auth user UUID
//   supabaseAdmin {object} — service-role Supabase client (server-side only)
//
// Returns:
//   Promise<'pro'|'free'>
// ---------------------------------------------------------------------------

/**
 * Returns 'pro' when the user has an active Pro subscription,
 * 'free' in all other cases (no row, cancelled, past_due, missing args, error).
 *
 * @param {string} userId
 * @param {import('@supabase/supabase-js').SupabaseClient|null} supabaseAdmin
 * @returns {Promise<'pro'|'free'>}
 */
async function getUserPlan(userId, supabaseAdmin) {
  if (!userId || !supabaseAdmin) return 'free';

  try {
    const { data, error } = await supabaseAdmin
      .from('user_subscriptions')
      .select('plan, subscription_status')
      .eq('user_id', userId)
      .single();

    if (error || !data) return 'free';

    if (data.subscription_status === 'active' && data.plan === 'pro') {
      return 'pro';
    }
    return 'free';
  } catch (_) {
    return 'free';
  }
}

module.exports = { getUserPlan };
