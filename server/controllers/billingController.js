'use strict';

// ---------------------------------------------------------------------------
// billingController — reusable handlers for all Stripe billing endpoints.
//
// Keeping logic here lets multiple routes share the same implementation
// without req.url rewriting or app.handle() indirection.
//
// Dependencies are required directly because they are module-level singletons
// already initialised before any request arrives.
// ---------------------------------------------------------------------------

const { STRIPE_CONFIG, stripeConfigured, getStripe } = require('../../plans');
const { hasProAccess } = require('../lib/planAccess');
const { supabaseAdmin }                               = require('../../supabaseClient');

// Stripe subscription lifecycle event types processed by the webhook.
const SUBSCRIPTION_EVENTS = new Set([
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted'
]);

// ---------------------------------------------------------------------------
// createCheckoutSession
// POST /api/billing/checkout
// POST /api/billing/create-checkout-session
//
// Creates a Stripe Checkout Session for the Pro monthly subscription.
// Returns { url } — the frontend redirects to this URL.
// ---------------------------------------------------------------------------
async function createCheckoutSession(req, res) {
  if (!stripeConfigured) {
    console.warn('[POST /api/billing/checkout] Stripe is not configured — STRIPE_SECRET_KEY or STRIPE_PRO_PRICE_ID missing.');
    return res.status(503).json({ error: 'Billing is not configured.' });
  }

  if (!supabaseAdmin) {
    console.error('[POST /api/billing/checkout] supabaseAdmin is null — SUPABASE_URL or SUPABASE_SERVICE_KEY missing.');
    return res.status(503).json({ error: 'Database connection is not configured. Cannot create checkout session.' });
  }

  try {
    const stripe    = getStripe();
    const userId    = req.user.id;
    const email     = req.user.email;
    const returnUrl = STRIPE_CONFIG.portalReturnUrl || `${req.protocol}://${req.get('host')}`;

    // Look up or create a subscription row so we have a Stripe customer ID
    let { data: subRow } = await supabaseAdmin
      .from('user_subscriptions')
      .select('stripe_customer_id, plan, subscription_status')
      .eq('user_id', userId)
      .single();

    if (hasProAccess({ plan: subRow?.plan, status: subRow?.subscription_status })) {
      return res.status(409).json({ error: 'Your Pro subscription is active. Manage billing to make changes.' });
    }
    let customerId = subRow?.stripe_customer_id;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email,
        metadata: { supabase_user_id: userId }
      }, { idempotencyKey: 'opscopilot-customer-' + userId });
      customerId = customer.id;

      const { error } = await supabaseAdmin
        .from('user_subscriptions')
        .upsert({
          user_id:             userId,
          stripe_customer_id:  customerId,
          subscription_status: 'inactive',
          plan:                'free',
          updated_at:          new Date().toISOString()
        }, { onConflict: 'user_id', ignoreDuplicates: true });
      if (error) throw new Error('Could not save billing account.');
    }

    const session = await stripe.checkout.sessions.create({
      mode:              'subscription',
      customer:          customerId,
      line_items:        [{ price: STRIPE_CONFIG.proPriceId, quantity: 1 }],
      success_url:       `${returnUrl}?billing=success`,
      cancel_url:        `${returnUrl}?billing=cancelled`,
      metadata:          { user_id: userId, plan: 'pro' },
      subscription_data: { metadata: { user_id: userId, plan: 'pro' } }
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('[billing] Checkout request failed');
    res.status(500).json({ error: 'Could not create checkout session. Please try again.' });
  }
}

// ---------------------------------------------------------------------------
// createPortalSession
// POST /api/billing/portal
// POST /api/billing/create-portal-session
//
// Creates a Stripe Customer Portal session for subscription management.
// Returns { url } — the frontend redirects to this URL.
// ---------------------------------------------------------------------------
async function createPortalSession(req, res) {
  if (!stripeConfigured) {
    console.warn('[POST /api/billing/portal] Stripe is not configured — STRIPE_SECRET_KEY or STRIPE_PRO_PRICE_ID missing.');
    return res.status(503).json({ error: 'Billing is not configured.' });
  }

  if (!supabaseAdmin) {
    console.error('[POST /api/billing/portal] supabaseAdmin is null — SUPABASE_URL or SUPABASE_SERVICE_KEY missing.');
    return res.status(503).json({ error: 'Database connection is not configured. Cannot open portal.' });
  }

  try {
    const stripe    = getStripe();
    const userId    = req.user.id;
    const returnUrl = STRIPE_CONFIG.portalReturnUrl || `${req.protocol}://${req.get('host')}`;

    const { data: subRow } = await supabaseAdmin
      .from('user_subscriptions')
      .select('stripe_customer_id')
      .eq('user_id', userId)
      .single();

    if (!subRow?.stripe_customer_id) {
      return res.status(404).json({ error: 'No billing account found. Subscribe to Pro first.' });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer:   subRow.stripe_customer_id,
      return_url: returnUrl
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('[billing] Portal request failed');
    res.status(500).json({ error: 'Could not open billing portal. Please try again.' });
  }
}

// ---------------------------------------------------------------------------
// stripeWebhookHandler
// POST /api/billing/webhook
//
// Verifies the Stripe signature and processes subscription lifecycle events.
// MUST be wired with express.raw({ type: 'application/json' }) so the raw
// body is available for signature verification.
// ---------------------------------------------------------------------------
async function stripeWebhookHandler(req, res) {
  if (!stripeConfigured || !supabaseAdmin) {
    return res.status(503).end();
  }

  const stripe = getStripe();
  const sig    = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body, sig, STRIPE_CONFIG.webhookSecret
    );
  } catch (err) {
    console.error('[Stripe webhook] Signature verification failed:', err.message);
    return res.status(400).json({ error: 'Webhook signature verification failed.' });
  }

  if (!SUBSCRIPTION_EVENTS.has(event.type)) return res.json({ received: true });
  try {
    const check = await supabaseAdmin.from('stripe_processed_events').select('id').eq('id', event.id).maybeSingle();
    if (check.error) throw new Error('Could not check billing delivery.');
    if (check.data) return res.json({ received: true });

    const source = event.data.object;
    if (event.type === 'checkout.session.completed' && source.mode !== 'subscription') {
      return res.json({ received: true });
    }
    const customer = typeof source.customer === 'string' ? source.customer : source.customer?.id;
    if (!customer) return res.json({ received: true });
    const account = await supabaseAdmin.from('user_subscriptions').select('user_id')
      .eq('stripe_customer_id', customer).maybeSingle();
    if (account.error) throw new Error('Could not find the billing account.');
    const owner = account.data?.user_id || source.metadata?.user_id || source.metadata?.supabase_user_id;
    if (!owner) return res.json({ received: true });

    // Read the provider's current state so late or duplicate deliveries do not
    // overwrite a newer subscription with an old webhook payload.
    const observedAt = new Date().toISOString();
    const subscriptions = await stripe.subscriptions.list({
      customer, status: 'all', limit: 100,
    }).autoPagingToArray({ limit: 1000 });
    if (subscriptions.length === 1000) throw new Error('Subscription lookup exceeded its reconciliation limit.');
    const proSubscriptions = subscriptions.filter(subscription =>
      subscription.items.data.some(item => item.price.id === STRIPE_CONFIG.proPriceId));
    const effective = proSubscriptions.find(subscription => hasProAccess({ plan: 'pro', status: subscription.status })) ||
      proSubscriptions.sort((first, second) => second.created - first.created)[0];
    const periodEnd = effective?.current_period_end ||
      effective?.items.data.find(item => item.price.id === STRIPE_CONFIG.proPriceId)?.current_period_end;
    const { error } = await supabaseAdmin.rpc('record_subscription_event', {
      p_event_id: event.id, p_observed_at: observedAt, p_user_id: owner,
      p_customer_id: customer, p_subscription_id: effective?.id || null,
      p_plan: effective ? 'pro' : 'free', p_status: effective?.status || 'inactive',
      p_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
    });
    if (error) throw new Error('Billing state could not be persisted.');
    return res.json({ received: true });
  } catch (_) {
    console.error('[billing] Subscription reconciliation failed');
    return res.status(503).json({ error: 'Subscription update could not be saved. Retry delivery.' });
  }
}

module.exports = { createCheckoutSession, createPortalSession, stripeWebhookHandler };
