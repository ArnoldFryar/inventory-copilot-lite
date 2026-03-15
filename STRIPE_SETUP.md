# Stripe Billing Setup

OpsCopilot-Lite uses Stripe for Pro plan subscriptions. This guide covers setup from scratch.

## Prerequisites

- A [Stripe account](https://dashboard.stripe.com/register) (test mode is fine for development)
- Supabase auth configured (see existing setup)
- The `user_subscriptions` table created via `supabase_migration.sql`

## 1. Create a Product and Price

1. Go to **Stripe Dashboard → Products → Add product**
2. Name: `OpsCopilot-Lite Pro` (or whatever you like)
3. Add a **Recurring** price:
   - Amount: your monthly price (e.g. $29/month)
   - Billing period: Monthly
4. Copy the **Price ID** (starts with `price_`)

## 2. Create a Webhook Endpoint

1. Go to **Stripe Dashboard → Developers → Webhooks → Add endpoint**
2. Endpoint URL: `https://your-domain.com/api/billing/webhook`
3. Subscribe to these events:
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
4. Copy the **Signing secret** (starts with `whsec_`)

> **Local development**: Use the [Stripe CLI](https://stripe.com/docs/stripe-cli) to forward webhooks:
> ```
> stripe listen --forward-to localhost:3000/api/billing/webhook
> ```
> The CLI prints a webhook signing secret you can use locally.

## 3. Configure Environment Variables

Add these to your `.env` file:

```env
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRO_PRICE_ID=price_...
APP_URL=https://your-domain.com
```

| Variable | Description |
|----------|-------------|
| `STRIPE_SECRET_KEY` | Secret key from Stripe Dashboard → Developers → API keys |
| `STRIPE_WEBHOOK_SECRET` | Webhook signing secret from step 2 |
| `STRIPE_PRO_PRICE_ID` | Price ID from step 1 |
| `APP_URL` | Your app's public URL (used for checkout success/cancel redirects) |

## 4. Configure Customer Portal

1. Go to **Stripe Dashboard → Settings → Billing → Customer portal**
2. Enable the portal
3. Configure allowed actions (cancel subscription, update payment method, view invoices)

The "Manage billing" button in the app links users to this portal.

## 5. Run the Database Migration

If you haven't already, run the updated `supabase_migration.sql` in the Supabase SQL Editor. It creates the `user_subscriptions` table used by the webhook handler.

## How It Works

1. **Checkout**: When a free user clicks "Upgrade to Pro", the frontend calls `POST /api/billing/checkout`. The server creates a Stripe Checkout Session and returns the URL. The browser redirects to Stripe's hosted checkout page.

2. **Webhook**: After successful payment, Stripe sends a `customer.subscription.created` event to `/api/billing/webhook`. The server verifies the signature, then upserts the user's subscription state in the `user_subscriptions` table.

3. **Plan resolution**: On every authenticated request, `getPlanForUser()` queries `user_subscriptions` to determine the user's active plan. If the subscription status is `active` or `trialing`, they get Pro; otherwise Free.

4. **Portal**: Pro users see a "Manage billing" link that opens Stripe's Customer Portal where they can update payment, cancel, or view invoices.

## Demo / Dev Mode

Set `PLAN=pro` in `.env` to force Pro for all users without configuring Stripe. This is useful for demos and local development. The env-var override takes precedence over any database lookup.

When `STRIPE_SECRET_KEY` and `STRIPE_PRO_PRICE_ID` are not set, billing features are gracefully hidden — no upgrade buttons appear and the app works as before.

## Test Mode vs Live Mode

- Use `sk_test_` keys for development. Stripe provides [test card numbers](https://stripe.com/docs/testing#cards) like `4242 4242 4242 4242`.
- Switch to `sk_live_` keys for production. Remember to create a separate webhook endpoint for your production URL.
