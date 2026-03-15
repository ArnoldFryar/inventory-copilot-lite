'use strict';

// ---------------------------------------------------------------------------
// requireProPlan — Express middleware that gates Pro-only endpoints.
//
// Must be used AFTER requireAuth so req.user is already populated.
// Uses dependency injection for supabaseAdmin so the module stays testable
// and stateless — call requireProPlan(supabaseAdmin) to get the middleware fn.
//
// Usage:
//   const requireProPlan = require('./server/middleware/requireProPlan');
//   app.get('/api/export', requireAuth, requireProPlan(supabaseAdmin), handler);
//
// Returns:
//   403 { error: 'Pro plan required.' }  — when user is on free plan
//   Calls next()                         — when user has an active Pro plan
// ---------------------------------------------------------------------------

const { getUserPlan } = require('../lib/getUserPlan');

/**
 * Factory that returns an Express middleware function.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient|null} supabaseAdmin
 * @returns {import('express').RequestHandler}
 */
function requireProPlan(supabaseAdmin) {
  return async function (req, res, next) {
    const userId = req.user?.id;

    if (!userId) {
      // requireAuth should have caught this first, but guard defensively.
      return res.status(401).json({ error: 'Authentication required.' });
    }

    try {
      const plan = await getUserPlan(userId, supabaseAdmin);
      if (plan !== 'pro') {
        return res.status(403).json({ error: 'Pro plan required.' });
      }
      next();
    } catch (_err) {
      // Fail closed — deny access if plan resolution throws unexpectedly.
      return res.status(403).json({ error: 'Pro plan required.' });
    }
  };
}

module.exports = requireProPlan;
