'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const requireAuth = require('../middleware/requireAuth');
const { getAnalysis } = require('../controllers/runController');
const { getPlanForUser } = require('../../plans');
const { supabaseAdmin } = require('../../supabaseClient');
const { MODEL_MAP } = require('../ai/config');
const { generateHelper, aiConfigured, VALID_HELPER_TYPES, HELPER_TYPES } = require('../../aiHelpers');

const router = express.Router();
const actions = {
  verify_receipt: 'Confirm the date and quantity of the next open receipt.',
  expedite: 'Check whether the next receipt can be expedited.',
  verify_usage: 'Verify usage and units in the source export.',
  review_supply: 'Review available inventory and planned supply.',
  review_excess: 'Confirm demand and disposition options.',
};
const openers = {
  expedite_email: 'Hi, can you review these open supply questions and confirm the next steps?',
  escalation_summary: 'Inventory exceptions for escalation review:',
  meeting_talking_points: 'Discuss these inventory exceptions at the next review:',
};
const aiLimiter = rateLimit({
  windowMs: (Number(process.env.AI_RATE_WINDOW) || 15) * 60_000,
  limit: Number(process.env.AI_RATE_MAX) || 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => req.user.id,
  message: { error: 'AI draft limit reached. Try again later.' },
});

function verifiedActions(text, rowCount) {
  const parsed = JSON.parse(text);
  const list = parsed?.actions;
  if (!Array.isArray(list) || !list.length || list.length > rowCount ||
    Object.keys(parsed).length !== 1) return null;
  const seen = new Set();
  for (const item of list) {
    if (!item || Object.keys(item).length !== 2 || !Number.isInteger(item.reference) ||
      item.reference < 1 || item.reference > rowCount || !Object.hasOwn(actions, item.action) ||
      seen.has(item.reference)) return null;
    seen.add(item.reference);
  }
  return list;
}

router.post('/api/ai-helper', requireAuth, aiLimiter, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const plan = await getPlanForUser(req.user.id, supabaseAdmin);
    if (plan.key !== 'pro') return res.status(403).json({ error: 'AI draft helpers require Pro.' });
    if (!aiConfigured) return res.status(503).json({ error: 'The AI provider is not configured.' });
    const { helperType, analysisId, saved, rowIds = [], refinement } = req.body || {};
    if (!VALID_HELPER_TYPES.has(helperType)) return res.status(400).json({ error: 'Choose an AI draft type.' });
    if (!Array.isArray(rowIds) || rowIds.length > 100 || rowIds.some(id => typeof id !== 'string' || !/^\d{1,6}$/.test(id)) ||
      (refinement && (typeof refinement.instruction !== 'string' || refinement.instruction.length > 500))) {
      return res.status(400).json({ error: 'Select up to 100 rows and use up to 500 characters of draft guidance.' });
    }

    const analysis = await getAnalysis(req.user.id, analysisId, saved === true);
    if (!analysis) return res.status(404).json({ error: 'Open or reanalyze this inventory run before drafting.' });
    const uniqueIds = new Set(rowIds);
    const selected = uniqueIds.size
      ? analysis.results.filter((row, index) => uniqueIds.has(row.row_id || String(index + 1)))
      : (analysis.topPriority || []).slice(0, 12);
    if (!selected.length || (uniqueIds.size && uniqueIds.size !== selected.length)) {
      return res.status(422).json({ error: 'Select valid inventory rows to include in this draft.' });
    }
    const rows = selected.map((row, index) => ({
      reference: index + 1, part: String(row.part_number).slice(0, 500), site: row.site || undefined,
      status: row.status, onHand: row.on_hand, dailyUsage: row.daily_usage, leadDays: row.lead_time,
      coverageDays: row.coverage_raw ?? row.coverage,
    }));
    const generated = await generateHelper(helperType, {
      summary: { total: rows.length }, results: [], topPriority: [],
    }, { model: MODEL_MAP[helperType] || MODEL_MAP.default, evidence: { rows, actions }, refinement });
    let verified;
    try { verified = verifiedActions(generated.text, rows.length); } catch (_) { verified = null; }
    if (!verified) return res.status(502).json({ error: 'The provider returned unverified references. Try another draft.' });

    const followups = verified.map(({ reference, action }) => {
      const row = rows[reference - 1];
      const identity = row.part + (row.site ? ' at ' + row.site : '');
      const coverage = row.coverageDays == null ? 'coverage unavailable' :
        'coverage ' + Number(row.coverageDays.toPrecision(4)) + ' days';
      return '- ' + identity + ' (' + row.status + ', ' + coverage + '): ' + actions[action];
    });
    res.json({
      text: openers[helperType] + '\n\n' + followups.join('\n'),
      model: generated.model, helperType, label: HELPER_TYPES[helperType].label,
      rowsReviewed: rows.length, rowsReferenced: verified.length,
      disclaimer: 'Draft for review. Confirm quantities, dates and next actions before sharing.',
    });
  } catch (_) {
    console.error('[ai] Draft request failed');
    res.status(502).json({ error: 'The AI provider is temporarily unavailable. Try again.' });
  }
});

router.get('/api/ai-helper/types', (_req, res) => {
  res.json({ configured: aiConfigured, types: Object.entries(HELPER_TYPES).map(([key, type]) => ({
    key, label: type.label, description: type.description,
  })) });
});

module.exports = router;
