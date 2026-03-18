'use strict';

// ---------------------------------------------------------------------------
// OpsCopilot-Lite — AI Helper Actions
//
// Optional, premium AI-generated drafts downstream of the deterministic
// triage engine.  These helpers NEVER reclassify parts or change thresholds.
// They take the current run's actual data as structured input and produce
// human-reviewable text: supplier emails, escalation summaries, and meeting
// talking points.
//
// Provider: OpenAI chat completions API (gpt-4o-mini by default).
// The provider is swappable via AI_PROVIDER env var in future.
//
// Every prompt is self-contained, auditable, and grounded in real data.
// ---------------------------------------------------------------------------

/**
 * AI provider configuration.
 * All values come from environment variables so no secrets are hard-coded.
 */
const AI_CONFIG = {
  apiKey:  (process.env.OPENAI_API_KEY || '').trim(),
  // AI_MODEL env var overrides the route-selected model (useful in dev/demo).
  // In production the model is chosen per helper type via server/ai/config.js MODEL_MAP.
  model:   (process.env.AI_MODEL       || '').trim(),
  baseUrl: (process.env.AI_BASE_URL    || 'https://api.openai.com/v1').trim(),
};

const aiConfigured = Boolean(AI_CONFIG.apiKey);

const { getSystemPrompt } = require('./server/ai/prompts');

// ---------------------------------------------------------------------------
// Helper-type registry — one entry per premium action.
// Each entry defines how to shape the run data into a prompt.
// ---------------------------------------------------------------------------

const HELPER_TYPES = {
  expedite_email: {
    label:       'Supplier Expedite Email',
    description: 'Draft email requesting expedited delivery for urgent/critical parts.',
  },
  escalation_summary: {
    label:       'Internal Escalation Summary',
    description: 'Concise internal summary for escalating supply risk to leadership.',
  },
  meeting_talking_points: {
    label:       'Meeting Talking Points',
    description: 'Structured talking points for materials review meetings.',
  },
};

const VALID_HELPER_TYPES = new Set(Object.keys(HELPER_TYPES));

// ---------------------------------------------------------------------------
// Input shaping — extract only what the prompt needs from a run's data.
// This keeps the token count manageable and prevents leaking extraneous
// data into the LLM context.
// ---------------------------------------------------------------------------

/**
 * Builds the structured context object sent into every prompt.
 *
 * @param {object} opts
 * @param {object} opts.summary   — summary counts from analyzeRows
 * @param {Array}  opts.results   — RowResult array (may be truncated)
 * @param {Array}  opts.topPriority — top-priority items
 * @param {string} opts.analyzedAt — ISO timestamp
 * @param {object} opts.thresholds — classification thresholds
 * @returns {object} shaped context for prompt interpolation
 */
function shapeInput({ summary, results, topPriority, analyzedAt, thresholds }) {
  // Cap how many results we feed to the LLM — keeps prompt bounded.
  const MAX_ITEMS = 30;
  const urgentParts = (results || [])
    .filter(r => r.status === 'Urgent Stockout Risk' || r.status === 'Stockout Risk')
    .slice(0, MAX_ITEMS);

  const excessParts = (results || [])
    .filter(r => r.status === 'Excess Inventory' || r.status === 'Potential Dead Stock')
    .slice(0, MAX_ITEMS);

  return {
    analyzedAt:   analyzedAt || new Date().toISOString(),
    total:        summary?.total        ?? 0,
    urgentCount:  summary?.urgent_stockout ?? 0,
    stockoutCount: summary?.stockout_risk ?? 0,
    excessCount:  summary?.excess        ?? 0,
    deadStockCount: summary?.dead_stock   ?? 0,
    healthyCount: summary?.healthy       ?? 0,
    noUsageCount: summary?.no_usage      ?? 0,
    invalidCount: summary?.invalid       ?? 0,
    topPriority:  (topPriority || []).slice(0, 10).map(simplifyRow),
    urgentParts:  urgentParts.map(simplifyRow),
    excessParts:  excessParts.map(simplifyRow),
    thresholds,
  };
}

/** Strip a RowResult down to the fields the LLM needs. */
function simplifyRow(r) {
  return {
    part_number: r.part_number,
    status:      r.status,
    severity:    r.severity,
    coverage:    r.coverage,
    on_hand:     r.on_hand,
    daily_usage: r.daily_usage,
    lead_time:   r.lead_time,
    reason:      r.reason,
  };
}

// ---------------------------------------------------------------------------
// Prompt builders — one per helper type.
// Each returns the system message and user message for the chat completion.
// ---------------------------------------------------------------------------

function buildExpediteEmailPrompt(ctx) {
  const system = getSystemPrompt('expedite_email');

  const parts = ctx.urgentParts.length > 0 ? ctx.urgentParts : ctx.topPriority;
  const user = [
    `Analysis date: ${ctx.analyzedAt}`,
    `Total parts analyzed: ${ctx.total}`,
    `Urgent stockout parts: ${ctx.urgentCount}`,
    `Stockout risk parts: ${ctx.stockoutCount}`,
    '',
    'Parts requiring expedited delivery:',
    JSON.stringify(parts, null, 2),
    '',
    'Draft a supplier expedite email covering these parts.',
    'Group by severity if there are multiple parts.',
    'Include specific coverage days and lead times from the data.',
  ].join('\n');

  return { system, user };
}

function buildEscalationSummaryPrompt(ctx) {
  const system = getSystemPrompt('escalation_summary');

  const user = [
    `Analysis date: ${ctx.analyzedAt}`,
    `Total parts: ${ctx.total}`,
    `Urgent stockout: ${ctx.urgentCount}`,
    `Stockout risk: ${ctx.stockoutCount}`,
    `Excess inventory: ${ctx.excessCount}`,
    `Potential dead stock: ${ctx.deadStockCount}`,
    `Healthy: ${ctx.healthyCount}`,
    `No usage data: ${ctx.noUsageCount}`,
    `Invalid: ${ctx.invalidCount}`,
    '',
    'Top priority items:',
    JSON.stringify(ctx.topPriority, null, 2),
    '',
    'Write a concise internal escalation summary.',
  ].join('\n');

  return { system, user };
}

function buildMeetingTalkingPointsPrompt(ctx) {
  const system = getSystemPrompt('meeting_talking_points');

  const allItems = [
    ...ctx.urgentParts,
    ...ctx.excessParts,
    ...ctx.topPriority,
  ];
  // Deduplicate by part_number
  const seen = new Set();
  const unique = allItems.filter(r => {
    if (seen.has(r.part_number)) return false;
    seen.add(r.part_number);
    return true;
  });

  const user = [
    `Analysis date: ${ctx.analyzedAt}`,
    `Scope: ${ctx.total} parts analyzed`,
    `Urgent stockout: ${ctx.urgentCount} | Stockout risk: ${ctx.stockoutCount}`,
    `Excess: ${ctx.excessCount} | Dead stock: ${ctx.deadStockCount}`,
    `Healthy: ${ctx.healthyCount} | No usage data: ${ctx.noUsageCount}`,
    `Classification thresholds: ${JSON.stringify(ctx.thresholds)}`,
    '',
    'Key items:',
    JSON.stringify(unique.slice(0, 20), null, 2),
    '',
    'Generate structured meeting talking points.',
  ].join('\n');

  return { system, user };
}

const PROMPT_BUILDERS = {
  expedite_email:        buildExpediteEmailPrompt,
  escalation_summary:    buildEscalationSummaryPrompt,
  meeting_talking_points: buildMeetingTalkingPointsPrompt,
};

// ---------------------------------------------------------------------------
// Generation — calls the AI provider's chat completions API.
// ---------------------------------------------------------------------------

/**
 * Generate an AI helper draft.
 *
 * @param {string} helperType    — one of VALID_HELPER_TYPES
 * @param {object} runData       — { summary, results, topPriority, analyzedAt, thresholds }
 * @param {object} [opts]
 * @param {string} [opts.model]  — model override from route (MODEL_MAP selection)
 * @returns {Promise<{text: string, model: string, usage: object}>}
 */
async function generateHelper(helperType, runData, { model: modelOverride } = {}) {
  if (!VALID_HELPER_TYPES.has(helperType)) {
    throw new Error(`Unknown helper type: ${helperType}`);
  }
  if (!aiConfigured) {
    throw new Error('AI provider is not configured. Set OPENAI_API_KEY.');
  }

  const ctx    = shapeInput(runData);
  const prompt = PROMPT_BUILDERS[helperType](ctx);

  // Model priority: env-var override → route selection (MODEL_MAP) → fallback.
  const resolvedModel = AI_CONFIG.model || modelOverride || 'gpt-4.1';

  const body = {
    model:       resolvedModel,
    messages: [
      { role: 'system', content: prompt.system },
      { role: 'user',   content: prompt.user },
    ],
    max_tokens:  1024,
    temperature: 0.3,   // low temperature for factual, grounded output
  };

  // Abort the request after 90 seconds — LLM completions routinely take
  // 15-30 s; 10 s was far too short and caused "This operation was aborted".
  const AI_TIMEOUT_MS = 90_000;
  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

  const t0 = Date.now();
  console.log('[AI_HELPER] start', { helperType, model: resolvedModel, ts: new Date(t0).toISOString() });

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
    console.error('[AI_HELPER] fetch failed', {
      helperType,
      durationMs,
      errorName:    fetchErr.name,
      errorMessage: fetchErr.message,
      isTimeout:    isAbort,
    });
    if (isAbort) {
      throw new Error(`AI request timed out after ${Math.round(durationMs / 1000)}s (limit ${AI_TIMEOUT_MS / 1000}s).`);
    }
    throw new Error(`AI network error: ${fetchErr.message}`);
  } finally {
    clearTimeout(timeoutId);
  }

  const durationMs = Date.now() - t0;

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    console.error('[AI_HELPER] API error', { helperType, status: res.status, durationMs, body: errBody.slice(0, 300) });
    throw new Error(`AI provider returned ${res.status}: ${errBody.slice(0, 200)}`);
  }

  const json = await res.json();
  const choice = json.choices?.[0];
  if (!choice?.message?.content) {
    console.error('[AI_HELPER] empty response', { helperType, durationMs, json });
    throw new Error('AI provider returned an empty response.');
  }

  console.log('[AI_HELPER] done', { helperType, durationMs, model: json.model, tokens: json.usage?.total_tokens ?? 0 });

  return {
    text:  choice.message.content.trim(),
    model: json.model || AI_CONFIG.model,
    usage: json.usage || {},
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  AI_CONFIG,
  aiConfigured,
  HELPER_TYPES,
  VALID_HELPER_TYPES,
  shapeInput,
  simplifyRow,
  generateHelper,
  // Exposed for testing
  PROMPT_BUILDERS,
};
