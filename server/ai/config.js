'use strict';

// ---------------------------------------------------------------------------
// AI model routing — single source of truth for model selection.
//
// MODEL_MAP maps each helper type to the model that should be used for Pro
// (or admin) users.  The "default" key is used as the fallback for any type
// not explicitly listed, and as the only model for free-plan users.
//
// To update the model for a helper type, change it here only.
// ---------------------------------------------------------------------------

const MODEL_MAP = {
  expedite_email:         'gpt-4.1',
  escalation_summary:     'gpt-4.1',
  meeting_talking_points: 'gpt-4.1',
  // Free-plan fallback and catch-all default.
  default:                'gpt-4.1-mini',
};

module.exports = { MODEL_MAP };
