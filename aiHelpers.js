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
  model:   (process.env.AI_MODEL       || 'gpt-4o-mini').trim(),
  baseUrl: (process.env.AI_BASE_URL    || 'https://api.openai.com/v1').trim(),
};

const aiConfigured = Boolean(AI_CONFIG.apiKey);

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
  const system = [
    'You are an operations assistant helping a manufacturing materials planner.',
    'Draft a professional supplier email requesting expedited delivery.',
    'Use ONLY the data provided — do not invent supplier names, contact details, or part details not present.',
    'Keep the tone professional and concise.',
    'Include a clear subject line.',
    'End with a note that this is a draft for human review.',
  ].join(' ');

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
  const system = [
    'You are an operations assistant writing an internal escalation summary.',
    'The audience is plant leadership or supply chain management.',
    'Use ONLY the data provided — do not fabricate statistics or part details.',
    'Keep it to 200 words or fewer.',
    'Structure: situation overview, key risk items, recommended next steps.',
  ].join(' ');

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
  const system = [
    'You are an operations assistant preparing meeting talking points.',
    'The audience is a materials review or S&OP meeting.',
    'Use ONLY the data provided — do not fabricate statistics or part details.',
    'Structure as numbered bullet points grouped by topic.',
    'Cover: supply risks, excess/dead stock, data quality, recommended actions.',
    'Keep it under 300 words.',
  ].join(' ');

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
 * @param {string} helperType — one of VALID_HELPER_TYPES
 * @param {object} runData    — { summary, results, topPriority, analyzedAt, thresholds }
 * @returns {Promise<{text: string, model: string, usage: object}>}
 */
async function generateHelper(helperType, runData) {
  if (!VALID_HELPER_TYPES.has(helperType)) {
    throw new Error(`Unknown helper type: ${helperType}`);
  }
  if (!aiConfigured) {
    throw new Error('AI provider is not configured. Set OPENAI_API_KEY.');
  }

  const ctx    = shapeInput(runData);
  const prompt = PROMPT_BUILDERS[helperType](ctx);

  const body = {
    model:       AI_CONFIG.model,
    messages: [
      { role: 'system', content: prompt.system },
      { role: 'user',   content: prompt.user },
    ],
    max_tokens:  1024,
    temperature: 0.3,   // low temperature for factual, grounded output
  };

  // Abort the request after 10 seconds to prevent indefinite hangs.
  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), 10_000);

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
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`AI provider returned ${res.status}: ${errBody.slice(0, 200)}`);
  }

  const json = await res.json();
  const choice = json.choices?.[0];
  if (!choice?.message?.content) {
    throw new Error('AI provider returned an empty response.');
  }

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
