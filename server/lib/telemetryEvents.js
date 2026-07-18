'use strict';

// Shared telemetry contract. Client event producers and the HTTP route are
// covered together by regression tests so conversion events cannot silently
// drift out of the server allowlist.
const VALID_EVENTS = new Set([
  // Navigation / lifecycle
  'page_load',

  // Paywall / billing funnel
  'helper_access_attempt',
  'upgrade_btn_clicked',
  'upgrade_auth_required',
  'upgrade_checkout_resumed',
  'billing_plan_loaded',
  'checkout_started',
  'billing_portal_clicked',

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
  'history_signin_clicked',
  'run_saved',
  'run_auto_saved',
  'history_run_loaded',
  'history_run_deleted',
  'history_compare_clicked',

  // Comparison
  'comparison_shown',
]);

/**
 * Keep telemetry intentionally small and non-sensitive.
 * Nested objects/arrays and suspicious keys are dropped; accepted string
 * values are capped so raw operational data cannot become analytics payloads.
 */
function sanitizeProperties(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};

  const output = {};
  Object.entries(input).slice(0, 20).forEach(([key, value]) => {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key)) return;

    if (typeof value === 'boolean') {
      output[key] = value;
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      output[key] = value;
    } else if (typeof value === 'string') {
      output[key] = value.slice(0, 100);
    }
  });
  return output;
}

module.exports = { VALID_EVENTS, sanitizeProperties };
