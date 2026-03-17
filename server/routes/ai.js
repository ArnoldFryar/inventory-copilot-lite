'use strict';

// ---------------------------------------------------------------------------
// ai routes — premium AI helper drafts (Pro plan only).
//
// POST /api/ai-helper       — generate an AI helper output
// GET  /api/ai-helper/types — list available helper types
// ---------------------------------------------------------------------------

const express  = require('express');
const router   = express.Router();

const requireAuth  = require('../middleware/requireAuth');
const { getPlanForUser }                              = require('../../plans');
const { supabaseAdmin }                               = require('../../supabaseClient');
const {
  generateHelper,
  aiConfigured,
  VALID_HELPER_TYPES,
  HELPER_TYPES
}                                                     = require('../../aiHelpers');

// ---------------------------------------------------------------------------
// POST /api/ai-helper — generate a premium AI helper draft.
// Requires Pro plan. AI output is downstream of the deterministic engine.
// ---------------------------------------------------------------------------
router.post('/api/ai-helper', requireAuth, async (req, res) => {
  const plan = await getPlanForUser(req.user.id, supabaseAdmin);
  if (plan.key !== 'pro') {
    return res.status(403).json({ error: 'AI helpers are a Pro plan feature.' });
  }

  if (!aiConfigured) {
    return res.status(503).json({ error: 'AI provider is not configured.' });
  }

  const { helperType, runData } = req.body || {};

  if (!helperType || !VALID_HELPER_TYPES.has(helperType)) {
    return res.status(400).json({
      error: `Invalid helper type. Valid types: ${[...VALID_HELPER_TYPES].join(', ')}`,
    });
  }

  if (!runData || !runData.summary || !Array.isArray(runData.results)) {
    return res.status(400).json({ error: 'runData with summary and results is required.' });
  }

  try {
    const result = await generateHelper(helperType, runData);

    // Telemetry — log which helper was used (no PII, no content)
    const safe = {
      ts:    new Date().toISOString(),
      event: 'ai_helper_generated',
      props: {
        helper_type: helperType,
        model:       result.model,
        tokens:      result.usage?.total_tokens || 0,
        part_count:  runData.summary?.total || 0,
      }
    };
    console.log('EVENT', JSON.stringify(safe));

    res.json({
      text:       result.text,
      model:      result.model,
      helperType: helperType,
      label:      HELPER_TYPES[helperType].label,
      disclaimer: 'This is an AI-generated draft for human review. Verify all details before sending or acting on this content.',
    });
  } catch (err) {
    console.error('AI_HELPER_ERROR', {
      helperType,
      error:     err.message,
      timestamp: new Date().toISOString(),
    });
    res.status(502).json({
      error:   'ai_provider_error',
      message: 'AI provider unavailable',
    });
  }
});

// ---------------------------------------------------------------------------
// GET /api/ai-helper/types — available helper types and AI configuration state.
// ---------------------------------------------------------------------------
router.get('/api/ai-helper/types', (_req, res) => {
  res.json({
    configured: aiConfigured,
    types: Object.entries(HELPER_TYPES).map(([key, val]) => ({
      key,
      label:       val.label,
      description: val.description,
    })),
  });
});

module.exports = router;
