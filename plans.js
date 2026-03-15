'use strict';

// ---------------------------------------------------------------------------
// OpsCopilot-Lite — Plan model, feature entitlements, and Stripe billing
//
// Two plan tiers:
//   free — limited analysis (50 parts), no export, no history
//   pro  — unlimited analysis, full export, saved history
//
// Plan resolution priority (highest wins):
//   1. Database lookup: user_subscriptions table (Stripe webhook-maintained)
//   2. Environment override: PLAN=pro (for local dev / demos)
//   3. Default: free
//
// Pricing is centralised in STRIPE_CONFIG so it's easy to change.
// ---------------------------------------------------------------------------

const PLANS = {
  free: {
    key:          'free',
    name:         'Free',
    maxParts:     50,
    fullTable:    false,
    csvExport:    false,
    pdfExport:    false,
    savedHistory: false
  },
  pro: {
    key:          'pro',
    name:         'Pro',
    maxParts:     Infinity,
    fullTable:    true,
    csvExport:    true,
    pdfExport:    true,
    savedHistory: true
  }
};

// ---------------------------------------------------------------------------
// Stripe configuration — centralised so pricing changes require editing one
// place.  Price IDs come from env vars so test-mode and live-mode are separate.
// ---------------------------------------------------------------------------
const STRIPE_CONFIG = {
  secretKey:        (process.env.STRIPE_SECRET_KEY      || '').trim(),
  webhookSecret:    (process.env.STRIPE_WEBHOOK_SECRET  || '').trim(),
  proPriceId:       (process.env.STRIPE_PRO_PRICE_ID    || '').trim(),
  // Customer portal return URL — defaults to the app origin.
  portalReturnUrl:  (process.env.APP_URL                || 'http://localhost:3000').trim(),
};

const stripeConfigured = Boolean(STRIPE_CONFIG.secretKey && STRIPE_CONFIG.proPriceId);

// Lazy-init Stripe SDK (only when actually configured)
let _stripe = null;
function getStripe() {
  if (!_stripe && stripeConfigured) {
    _stripe = require('stripe')(STRIPE_CONFIG.secretKey, {
      apiVersion: '2024-12-18.acacia'
    });
  }
  return _stripe;
}

// Active Stripe subscription statuses that grant Pro access.
const ACTIVE_STATUSES = new Set(['active', 'trialing']);

// ---------------------------------------------------------------------------
// getPlan(userId?) — returns the plan for a given user.
//
// Without Supabase or Stripe: falls back to the PLAN env var (demo mode).
// With Supabase: looks up user_subscriptions; caches nothing (row is tiny).
// ---------------------------------------------------------------------------
function getPlan(userId) {
  // Env-var override — works in dev and demo mode without any DB or Stripe.
  const envPlan = (process.env.PLAN || '').trim().toLowerCase();
  if (envPlan === 'pro') return PLANS.pro;
  if (!userId)           return PLANS.free;
  return PLANS.free; // synchronous fallback; async lookup via getPlanForUser
}

/**
 * Async per-user plan lookup via Supabase.
 * Falls back to env-var / free when DB is unavailable.
 *
 * @param {string} userId — Supabase auth user ID
 * @param {object} supabaseAdmin — service-role client (or null)
 * @returns {Promise<object>} plan object from PLANS
 */
async function getPlanForUser(userId, supabaseAdmin) {
  // Env-var override always wins (dev / demo mode)
  const envPlan = (process.env.PLAN || '').trim().toLowerCase();
  if (envPlan === 'pro') return PLANS.pro;
  if (!userId || !supabaseAdmin) return PLANS.free;

  try {
    const { data, error } = await supabaseAdmin
      .from('user_subscriptions')
      .select('plan_key, stripe_status')
      .eq('user_id', userId)
      .single();

    if (error || !data) return PLANS.free;

    // Only grant Pro when the subscription is in an active state
    if (data.plan_key === 'pro' && ACTIVE_STATUSES.has(data.stripe_status)) {
      return PLANS.pro;
    }
    return PLANS.free;
  } catch (_) {
    return PLANS.free;
  }
}

/**
 * Builds the entitlements object suitable for JSON serialisation.
 * Converts Infinity → null so the value is safe to transmit to the frontend.
 */
function planEntitlements(plan) {
  return {
    maxParts:     plan.maxParts === Infinity ? null : plan.maxParts,
    fullTable:    plan.fullTable,
    csvExport:    plan.csvExport,
    pdfExport:    plan.pdfExport,
    savedHistory: plan.savedHistory
  };
}

/**
 * Applies plan limits to a raw analyzeRows result in-place.
 */
function applyPlanLimits(plan, result) {
  const total = result.results.length;

  if (plan.maxParts !== Infinity && total > plan.maxParts) {
    result.results          = result.results.slice(0, plan.maxParts);
    result.resultsTruncated = true;
  } else {
    result.resultsTruncated = false;
  }

  result.totalBeforeTruncation = total;

  result.plan = {
    key:          plan.key,
    name:         plan.name,
    entitlements: planEntitlements(plan)
  };

  return result;
}

module.exports = {
  getPlan,
  getPlanForUser,
  applyPlanLimits,
  planEntitlements,
  PLANS,
  STRIPE_CONFIG,
  stripeConfigured,
  getStripe,
  ACTIVE_STATUSES
};
