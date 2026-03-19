'use strict';

// ---------------------------------------------------------------------------
// events route — lightweight server-side event logging.
//
// POST /api/events
//   Body: { event: string, properties?: object }
//   Auth: optional — user_id is stored when a valid token is provided.
//
// Writes to the `events` table when Supabase is configured.
// Falls back to console.log so local dev always captures the signal.
// ---------------------------------------------------------------------------

const express       = require('express');
const router        = express.Router();
const { supabaseAdmin, verifyToken } = require('../../supabaseClient');

// Allowlist of event names accepted from the client.
// Any unrecognised name is rejected with 400 to prevent log spam.
const VALID_EVENTS = new Set([
  // Paywall
  'helper_access_attempt',
  'upgrade_btn_clicked',
  // AI helpers
  'ai_helper_used',
  'ai_helper_error',
  // Upload / analysis
  'upload_started',
  'upload_failed',
  'sample_loaded',
  'sample_csv_downloaded',
  'demo_loaded',
  'analysis_completed',
  // Export
  'export_csv_clicked',
  'export_comparison_csv_clicked',
  'print_clicked',
  // History
  'run_saved',
  'run_auto_saved',
  'history_run_loaded',
  'history_run_deleted',
  'history_compare_clicked',
  // Comparison
  'comparison_shown',
]);

router.post('/api/events', async (req, res) => {
  const { event, properties } = req.body || {};

  if (!event || typeof event !== 'string') {
    return res.status(400).json({ error: 'event is required.' });
  }
  if (!VALID_EVENTS.has(event)) {
    return res.status(400).json({ error: 'Unknown event.' });
  }
  // properties must be an object (or absent)
  const props = (properties && typeof properties === 'object' && !Array.isArray(properties))
    ? properties
    : {};

  // Attempt to resolve user_id from optional Bearer token
  let userId = null;
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (token && supabaseAdmin) {
    const { user } = await verifyToken(token).catch(() => ({ user: null }));
    if (user) userId = user.id;
  }

  console.log('[event]', event, JSON.stringify({ user_id: userId, ...props }));

  if (supabaseAdmin) {
    // fire-and-forget — don't block the response on DB write
    supabaseAdmin.from('events').insert({
      user_id:    userId,
      event_name: event,
      properties: props,
    }).then(({ error }) => {
      if (error) console.error('[event] DB write error:', error.message);
    });
  }

  res.status(204).end();
});

module.exports = router;
