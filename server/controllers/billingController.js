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
    return res.status(503).json({ error: 'Billing is not configured.' });
  }

  try {
    const stripe    = getStripe();
    const userId    = req.user.id;
    const email     = req.user.email;
    const returnUrl = STRIPE_CONFIG.portalReturnUrl || `${req.protocol}://${req.get('host')}`;

    // Look up or create a subscription row so we have a Stripe customer ID
    let { data: subRow } = await supabaseAdmin
      .from('user_subscriptions')
      .select('stripe_customer_id')
      .eq('user_id', userId)
      .single();

    let customerId = subRow?.stripe_customer_id;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email,
        metadata: { supabase_user_id: userId }
      });
      customerId = customer.id;

      await supabaseAdmin
        .from('user_subscriptions')
        .upsert({
          user_id:             userId,
          stripe_customer_id:  customerId,
          subscription_status: 'inactive',
          plan:                'free',
          updated_at:          new Date().toISOString()
        }, { onConflict: 'user_id' });
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
    console.error('[POST /api/billing/checkout]', err.message);
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
    return res.status(503).json({ error: 'Billing is not configured.' });
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
    console.error('[POST /api/billing/portal]', err.message);
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

  // Process subscription lifecycle events
  if (SUBSCRIPTION_EVENTS.has(event.type)) {
    try {
      const obj = event.data.object;

      if (event.type === 'checkout.session.completed') {
        // Session object shape: { customer, subscription, metadata }
        const userId     = obj.metadata?.user_id || obj.metadata?.supabase_user_id;
        const customerId = obj.customer;
        const subId      = obj.subscription;

        if (!userId) {
          console.warn('[Stripe webhook] checkout.session.completed: no user_id in session metadata');
        } else {
          const { error } = await supabaseAdmin
            .from('user_subscriptions')
            .upsert({
              user_id:                userId,
              stripe_customer_id:     customerId,
              stripe_subscription_id: subId,
              subscription_status:    'active',
              plan:                   'pro',
              updated_at:             new Date().toISOString()
            }, { onConflict: 'user_id' });

          if (error) console.error('[Stripe webhook] checkout upsert error:', error.message);
          else       console.log(`[Stripe webhook] checkout.session.completed: user ${userId} → pro/active`);
        }
      } else {
        // customer.subscription.created / .updated / .deleted
        const customerId = obj.customer;
        const priceId    = obj.items?.data?.[0]?.price?.id || '';
        const plan       = (priceId === STRIPE_CONFIG.proPriceId) ? 'pro' : 'free';
        const periodEnd  = obj.current_period_end
          ? new Date(obj.current_period_end * 1000).toISOString()
          : null;

        // Prefer user_id from subscription metadata; fall back to DB lookup by customer
        let userId = obj.metadata?.user_id || obj.metadata?.supabase_user_id;
        if (!userId) {
          const { data: existing } = await supabaseAdmin
            .from('user_subscriptions')
            .select('user_id')
            .eq('stripe_customer_id', customerId)
            .single();
          userId = existing?.user_id;
        }

        if (!userId) {
          console.warn(`[Stripe webhook] ${event.type}: no user found for customer ${customerId}`);
        } else {
          const { error } = await supabaseAdmin
            .from('user_subscriptions')
            .upsert({
              user_id:                userId,
              stripe_customer_id:     customerId,
              stripe_subscription_id: obj.id,
              subscription_status:    obj.status,
              plan,
              current_period_end:     periodEnd,
              updated_at:             new Date().toISOString()
            }, { onConflict: 'user_id' });

          if (error) console.error('[Stripe webhook] upsert error:', error.message);
          else       console.log(`[Stripe webhook] ${event.type}: user ${userId} → ${plan}/${obj.status}`);
        }
      }
    } catch (dbErr) {
      console.error('[Stripe webhook] DB error:', dbErr.message);
      // Still return 200 so Stripe won't retry endlessly
    }
  }

  // Acknowledge receipt (Stripe retries on non-2xx)
  res.json({ received: true });
}

module.exports = { createCheckoutSession, createPortalSession, stripeWebhookHandler };
