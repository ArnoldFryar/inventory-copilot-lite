'use strict';

// ---------------------------------------------------------------------------
// generateProcurementSummary.js — server-side AI executive summary generation.
//
// Called during saveProcurementRun (after deterministic analysis completes).
// Uses the same OpenAI chat completions API as the inventory AI helpers,
// but is purpose-built for procurement run data and stores the result
// directly in summary_json.ai_summary rather than returning it to a client
// for ephemeral display.
//
// This function is non-blocking in the save flow — if AI generation fails,
// the run is still saved without an AI summary (graceful degradation).
// ---------------------------------------------------------------------------

const { AI_CONFIG, aiConfigured } = require('../../aiHelpers');
const { MODEL_MAP }               = require('./config');
const { buildProcurementSummaryPrompt } = require('./procurementPrompts');

const AI_TIMEOUT_MS = 90_000;

/**
 * Generate an AI executive summary for a procurement run.
 *
 * @param {object} opts
 * @param {object} opts.summary          — summary metrics from analyzeRows
 * @param {Array}  opts.lines            — scored PO lines
 * @param {Array}  opts.supplierRollups  — per-supplier aggregations
 * @param {Array}  opts.insights         — engine-generated insights
 * @param {Array}  opts.actionCandidates — recommended action items
 * @param {string} [opts.fileName]       — original CSV file name
 * @returns {Promise<{ text: string, model: string } | null>}
 *   Returns null when AI is not configured or when generation fails.
 */
async function generateProcurementSummary({
  summary,
  lines,
  supplierRollups,
  insights,
  actionCandidates,
  fileName,
}) {
  if (!aiConfigured) {
    console.log('[PROCUREMENT_AI] skipped — AI not configured');
    return null;
  }

  const prompt = buildProcurementSummaryPrompt({
    summary,
    lines,
    supplierRollups,
    insights,
    actionCandidates,
    fileName,
  });

  const model = AI_CONFIG.model || MODEL_MAP.procurement_run_summary || MODEL_MAP.default;

  const body = {
    model,
    messages: [
      { role: 'system', content: prompt.system },
      { role: 'user',   content: prompt.user },
    ],
    max_tokens:  1024,
    temperature: 0.3,
  };

  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

  const t0 = Date.now();
  console.log('[PROCUREMENT_AI] start', { model, ts: new Date(t0).toISOString() });

  let res;
  try {
    res = await fetch(`${AI_CONFIG.baseUrl}/chat/completions`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${AI_CONFIG.apiKey}`,
      },
      body:   JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (fetchErr) {
    clearTimeout(timeoutId);
    const durationMs = Date.now() - t0;
    const isAbort = fetchErr.name === 'AbortError';
    console.error('[PROCUREMENT_AI] fetch failed', {
      durationMs,
      isTimeout: isAbort,
      error:     fetchErr.message,
    });
    return null;
  } finally {
    clearTimeout(timeoutId);
  }

  const durationMs = Date.now() - t0;

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    console.error('[PROCUREMENT_AI] API error', { status: res.status, durationMs, body: errBody.slice(0, 300) });
    return null;
  }

  const json = await res.json();
  const choice = json.choices?.[0];
  if (!choice?.message?.content) {
    console.error('[PROCUREMENT_AI] empty response', { durationMs });
    return null;
  }

  console.log('[PROCUREMENT_AI] done', {
    durationMs,
    model:  json.model,
    tokens: json.usage?.total_tokens ?? 0,
  });

  return {
    text:  choice.message.content.trim(),
    model: json.model || model,
  };
}

module.exports = { generateProcurementSummary };
