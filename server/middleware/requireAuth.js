'use strict';

// ---------------------------------------------------------------------------
// requireAuth — Express middleware that verifies a Supabase JWT.
//
// Must be applied before any route that needs req.user.
// Returns 401 when the token is absent, expired, or invalid.
// ---------------------------------------------------------------------------

const { verifyToken } = require('../../supabaseClient');

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  const { user, error } = await verifyToken(token);
  if (!user) {
    return res.status(401).json({ error: error || 'Invalid session.' });
  }
  req.user = user;
  next();
}

module.exports = requireAuth;
