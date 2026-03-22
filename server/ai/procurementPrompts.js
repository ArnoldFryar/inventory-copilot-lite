'use strict';

// ---------------------------------------------------------------------------
// Procurement Copilot — AI summary prompt builder.
//
// Generates an executive summary grounded entirely in the deterministic
// risk-engine outputs (summary metrics, flagged PO lines, supplier rollups,
// insights, and action candidates).  The LLM receives only structured data —
// never raw CSV — so it cannot hallucinate fields the engine didn't produce.
//
// Output sections: Executive Summary, Top Operational Risks, Recommended
// Buyer Actions.  Stored in summary_json.ai_summary on each saved run.
// ---------------------------------------------------------------------------

/**
 * Strip control characters and non-printable chars from user-sourced strings
 * before embedding them in the prompt.  This mitigates prompt-injection
 * attempts hidden in CSV fields (supplier names, descriptions, etc.).
 */
function sanitize(str) {
  if (typeof str !== 'string') return '';
  // Remove ASCII control chars (0x00-0x1F except \n, \t) and DEL (0x7F),
  // plus Unicode category "Other" chars that could hide injection payloads.
  // eslint-disable-next-line no-control-regex
  return str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

const DATA_CONSTRAINT =
  'Use ONLY the data provided — do not invent supplier names, dollar amounts, ' +
  'part details, statistics, dates, or any information not present in the input.';

const FORMAT_RULES = [
  'FORMATTING RULES (mandatory):',
  '- No paragraph longer than 3 lines.',
  '- Use bullet points wherever a list of 2+ items exists.',
  '- No filler language ("I hope this finds you well", "as you know", "it is worth noting").',
  '- Every sentence must add information or request action.',
].join('\n');

const PROCUREMENT_SYSTEM_PROMPT = [
  'You are a senior procurement analyst reviewing an Open PO risk analysis.',
  '',
  'TONE:',
  '- Direct and actionable — every sentence earns its place',
  '- Business-impact focused — lead with dollars and risk',
  '- Concise — maximum 350 words total',
  '',
  'REQUIRED OUTPUT STRUCTURE (use these exact section headers):',
  '',
  '## Executive Summary',
  '2–3 sentences: what was analyzed, overall risk posture, biggest concern.',
  '',
  '## Top Operational Risks',
  '- Bullet list of 3–5 risks ranked by dollar exposure or delivery impact.',
  '- Each bullet: supplier name (if applicable), what the risk is, and the metric that proves it.',
  '',
  '## Recommended Buyer Actions',
  '- Numbered list of 3–5 concrete next steps a buyer should take today.',
  '- Each item names the action, the supplier/PO it targets, and the expected outcome.',
  '',
  FORMAT_RULES,
  '',
  DATA_CONSTRAINT,
].join('\n');

// ---------------------------------------------------------------------------
// Prompt builder — shapes deterministic outputs into a grounded user message.
// ---------------------------------------------------------------------------

/**
 * Build the { system, user } message pair for a procurement run summary.
 *
 * @param {object} opts
 * @param {object} opts.summary          — summary metrics from analyzeRows
 * @param {Array}  opts.lines            — scored PO lines (will be truncated)
 * @param {Array}  opts.supplierRollups  — per-supplier aggregations
 * @param {Array}  opts.insights         — engine-generated insights
 * @param {Array}  opts.actionCandidates — recommended action items
 * @param {string} [opts.fileName]       — original CSV filename for context
 * @returns {{ system: string, user: string }}
 */
function buildProcurementSummaryPrompt({
  summary = {},
  lines = [],
  supplierRollups = [],
  insights = [],
  actionCandidates = [],
  fileName,
}) {
  const system = PROCUREMENT_SYSTEM_PROMPT;

  // Top flagged lines — cap at 15 to keep token count bounded.
  const MAX_LINES = 15;
  const topLines = lines
    .filter(l => (l.severity || '').toLowerCase() !== 'low')
    .sort((a, b) => (b.risk_score || 0) - (a.risk_score || 0))
    .slice(0, MAX_LINES)
    .map(l => ({
      po_number:        sanitize(l.po_number),
      supplier:         sanitize(l.supplier),
      item_description: sanitize((l.item_description || '').slice(0, 60)),
      line_amount:      l.line_amount,
      days_variance:    l.days_variance,
      delivery_status:  l.delivery_status,
      severity:         l.severity,
      risk_flags:       l.risk_flags || [],
    }));

  // Compact supplier rollups — only top 10 by risk.
  const topSuppliers = supplierRollups
    .slice(0, 10)
    .map(s => ({
      supplier:         sanitize(s.supplier),
      line_count:       s.line_count,
      overdue_count:    s.overdue_count,
      past_due_dollars: s.past_due_dollars,
      spend_share_pct:  s.spend_share_pct,
      severity:         s.severity,
    }));

  // Insight titles only — full descriptions are in the structured data.
  const insightTitles = insights.slice(0, 8).map(i => ({
    title:    sanitize(i.title),
    severity: i.severity,
    action:   i.recommended_action ? sanitize(i.recommended_action) : null,
  }));

  const actionTitles = actionCandidates.slice(0, 8).map(a =>
    `${sanitize(a.po_number || 'PO')} / ${sanitize(a.supplier || 'Supplier')} — ${a.severity || 'Review'}`
  );

  const user = [
    fileName ? `File: ${sanitize(String(fileName).slice(0, 100))}` : '',
    '',
    '=== SUMMARY METRICS ===',
    `Total PO lines: ${summary.total_lines ?? 0}`,
    `Past due lines: ${summary.past_due_lines ?? 0}`,
    `Past due dollars: $${(summary.past_due_dollars ?? 0).toLocaleString()}`,
    `Flagged lines: ${summary.flagged_lines ?? 0}`,
    `High risk suppliers: ${summary.high_risk_suppliers ?? 0}`,
    `Dollar exposure at risk: $${(summary.dollar_exposure_at_risk ?? 0).toLocaleString()}`,
    `Supplier count: ${summary.supplier_count ?? 0}`,
    '',
    '=== TOP FLAGGED PO LINES ===',
    JSON.stringify(topLines, null, 2),
    '',
    '=== SUPPLIER RISK ROLLUPS ===',
    JSON.stringify(topSuppliers, null, 2),
    '',
    '=== ENGINE INSIGHTS ===',
    JSON.stringify(insightTitles, null, 2),
    '',
    '=== ACTION CANDIDATES ===',
    actionTitles.length > 0 ? actionTitles.map(t => '- ' + t).join('\n') : '(none)',
    '',
    'Write a concise executive summary, top operational risks, and recommended buyer actions.',
  ].filter(l => l !== undefined).join('\n');

  return { system, user };
}

module.exports = { buildProcurementSummaryPrompt, PROCUREMENT_SYSTEM_PROMPT };
