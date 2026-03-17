'use strict';

// ---------------------------------------------------------------------------
// planAccess — single source of truth for Pro subscription entitlement.
//
// All code paths that need to decide whether a user has Pro access should
// import and call hasProAccess(subscription) rather than comparing
// subscription_status === 'active' inline.  This ensures that new statuses
// (e.g. 'trialing') only need to be added here.
//
// Usage:
//   const { hasProAccess } = require('./planAccess');
//   if (hasProAccess({ plan: data.plan, status: data.subscription_status })) { ... }
// ---------------------------------------------------------------------------

/** Stripe subscription statuses that grant Pro access. */
const ACTIVE_SUB_STATUSES = new Set(['active', 'trialing']);

/**
 * Returns true when the subscription object represents an active Pro plan.
 *
 * @param {{ plan: string, status: string }|null|undefined} subscription
 * @returns {boolean}
 */
function hasProAccess(subscription) {
  if (!subscription) return false;
  return subscription.plan === 'pro' && ACTIVE_SUB_STATUSES.has(subscription.status);
}

module.exports = { hasProAccess, ACTIVE_SUB_STATUSES };
