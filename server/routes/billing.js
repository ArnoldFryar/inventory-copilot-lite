'use strict';

// ---------------------------------------------------------------------------
// billing routes — Stripe checkout, portal, and subscription plan resolution.
//
// POST /api/billing/checkout               — create Stripe Checkout Session
// POST /api/billing/create-checkout-session — alias for the above
// POST /api/billing/portal                 — create Stripe Customer Portal session
// POST /api/billing/create-portal-session  — alias for the above
// GET  /api/plan                           — active plan + entitlements (anon-friendly)
// GET  /api/user/plan                      — authenticated user's plan + status
//
// Note: POST /api/billing/webhook is registered in server.js BEFORE
// express.json() because Stripe signature verification requires the raw body.
// ---------------------------------------------------------------------------

const express = require('express');
const router  = express.Router();

const requireAuth  = require('../middleware/requireAuth');
const {
  createCheckoutSession,
  createPortalSession
}                  = require('../controllers/billingController');
const {
  getPlan,
  getPlanForUser,
  planEntitlements,
  stripeConfigured, getStripe, STRIPE_CONFIG
}                  = require('../../plans');
const { supabaseAdmin, verifyToken }             = require('../../supabaseClient');

// ---------------------------------------------------------------------------
// Checkout and portal
// ---------------------------------------------------------------------------
router.post('/api/billing/checkout',                requireAuth, createCheckoutSession);
router.post('/api/billing/create-checkout-session', requireAuth, createCheckoutSession);
router.post('/api/billing/portal',                  requireAuth, createPortalSession);
router.post('/api/billing/create-portal-session',   requireAuth, createPortalSession);

let cachedPrice;
let priceExpires = 0;
router.get('/api/billing/price', async (_req, res) => {
  if (!stripeConfigured) return res.json({ price: null });
  try {
    if (!cachedPrice || Date.now() > priceExpires) {
      const stripe = getStripe();
      const price = await stripe.prices.retrieve(STRIPE_CONFIG.proPriceId);
      cachedPrice = { amount: price.unit_amount, currency: price.currency,
        interval: price.recurring?.interval, intervalCount: price.recurring?.interval_count };
      priceExpires = Date.now() + 5 * 60_000;
    }
    res.json({ price: cachedPrice });
  } catch (_) {
    res.json({ price: null });
  }
});

// ---------------------------------------------------------------------------
// GET /api/plan — active plan + feature entitlements (authentication optional).
// ---------------------------------------------------------------------------
router.get('/api/plan', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const header = req.headers.authorization || '';
    const token  = header.startsWith('Bearer ') ? header.slice(7) : '';

    let plan;
    if (token && supabaseAdmin) {
      const { user } = await verifyToken(token);
      if (user) {
        plan = await getPlanForUser(user.id, supabaseAdmin);
      }
    }
    if (!plan) plan = getPlan();

    res.json({
      plan:              plan.key,
      name:              plan.name,
      entitlements:      planEntitlements(plan),
      billingConfigured: stripeConfigured
    });
  } catch (err) {
    console.error('[GET /api/plan]', err.message);
    res.status(500).json({ error: 'Could not resolve plan.' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/user/plan — authenticated user's plan, status, and renewal date.
// ---------------------------------------------------------------------------
router.get('/api/user/plan', requireAuth, async (req, res) => {
  if (!supabaseAdmin) {
    return res.json({ plan: 'free', subscriptionStatus: 'inactive', currentPeriodEnd: null });
  }
  res.set('Cache-Control', 'no-store');
  try {
    const accountPlan = await getPlanForUser(req.user.id, supabaseAdmin);
    const { data } = await supabaseAdmin
      .from('user_subscriptions')
      .select('plan, subscription_status, current_period_end')
      .eq('user_id', req.user.id)
      .single();

    if (!data) {
      return res.json({ plan: accountPlan.key, subscriptionStatus: 'inactive', currentPeriodEnd: null });
    }

    const plan = accountPlan.key;
    res.json({
      plan,
      subscriptionStatus: data.subscription_status || 'inactive',
      currentPeriodEnd:   data.current_period_end || null
    });
  } catch (err) {
    console.error('[GET /api/user/plan]', err.message);
    res.status(500).json({ error: 'Could not resolve plan.' });
  }
});

module.exports = router;
