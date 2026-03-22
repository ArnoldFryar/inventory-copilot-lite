'use strict';

// ---------------------------------------------------------------------------
// AI model routing — single source of truth for model selection.
//
// MODEL_MAP maps each helper type to its model. All callers are Pro or admin
// (free users are blocked at the route gate before reaching this). The
// "default" key is a catch-all for any type not explicitly listed.
//
// To update the model for a helper type, change it here only.
// ---------------------------------------------------------------------------

const MODEL_MAP = {
  expedite_email:              'gpt-4.1',
  escalation_summary:          'gpt-4.1',
  meeting_talking_points:      'gpt-4.1',
  procurement_run_summary:     'gpt-4.1',
  default:                     'gpt-4.1',
};

module.exports = { MODEL_MAP };
