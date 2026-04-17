'use strict';

// ---------------------------------------------------------------------------
// procurementAnalyzer.js — Procurement Copilot risk analysis engine.
//
// Orchestrates the full analysis pipeline for a set of normalised POLine
// records produced by procurementIngest.ingestPOCsv().
//
// Pipeline:
//   1. Score every row via procurementRules.scoreRow()
//   2. Build per-supplier rollups (aggregated metrics)
//   3. Apply supplier-level concentration flags (THRESHOLDS-driven)
//   4. Generate ProcurementInsight objects (actionable findings)
//   5. Generate action candidates (High-risk rows for the action queue)
//   6. Build run-level summary counts
//
// All logic is deterministic — identical inputs produce identical outputs.
// No AI, no random state.
//
// Shape references: server/lib/procurement/types.js
// Scoring rules:   server/lib/procurement/procurementRules.js
// ---------------------------------------------------------------------------

const { THRESHOLDS, RULES, RULE_TO_FLAG, scoreRow, isoDateDiff } = require('./procurementRules');

// ---------------------------------------------------------------------------
// todayISO — UTC date string for reproducible day-boundary comparisons.
// ---------------------------------------------------------------------------
function todayISO() {
  const d = new Date();
  return (
    d.getUTCFullYear() +
    '-' + String(d.getUTCMonth() + 1).padStart(2, '0') +
    '-' + String(d.getUTCDate()).padStart(2, '0')
  );
}

// ---------------------------------------------------------------------------
// analyzeRows
//
// Main entry point.  Accepts an array of POLine objects (the `rows` field
// from ingestPOCsv's result) and returns a complete AnalysisResult.
//
// Returns:
//   {
//     lines            : ScoredPOLine[]       — rows annotated with scores
//     supplierRollups  : SupplierRollup[]      — one entry per distinct supplier
//     insights         : ProcurementInsight[]  — actionable findings, sorted by severity
//     actionCandidates : ScoredPOLine[]        — High-risk rows for the action queue
//     summary          : ProcurementRunSummary — run-level counts
//   }
// ---------------------------------------------------------------------------
function analyzeRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return {
      lines:            [],
      supplierRollups:  [],
      insights:         [],
      actionCandidates: [],
      summary:          buildEmptySummary(),
    };
  }

  const ctx = { today: todayISO() };

  // ── 1. Score every row ──────────────────────────────────────────────────
  const lines = rows.map(line => {
    const s = scoreRow(line, ctx);
    return {
      ...line,
      risk_score:    s.score,
      severity:      s.severity,
      applied_rules: s.applied_rules,
      risk_flags:    s.risk_flags,
    };
  });

  // ── 2. Per-supplier rollups ─────────────────────────────────────────────
  const supplierRollups = buildSupplierRollups(lines, ctx);

  // ── 3. Concentration flags on rollups ───────────────────────────────────
  applyConcentrationFlags(supplierRollups);

  // ── 4. Insights ─────────────────────────────────────────────────────────
  const insights = generateInsights(lines, supplierRollups, ctx);

  // ── 5. Action candidates ────────────────────────────────────────────────
  const actionCandidates = generateActionCandidates(lines);

  // ── 6. Run summary ───────────────────────────────────────────────────────
  const summary = buildSummary(lines, supplierRollups, insights);

  return { lines, supplierRollups, insights, actionCandidates, summary };
}

// ---------------------------------------------------------------------------
// buildSupplierRollups
//
// Groups scored lines by supplier and computes aggregated metrics for each.
// Returns an array of SupplierRollup objects sorted by severity (High first)
// then total spend descending.
// ---------------------------------------------------------------------------
function buildSupplierRollups(scoredLines, ctx) {
  // Group lines keyed by supplier name.
  const map = new Map();
  for (const line of scoredLines) {
    const key = line.supplier;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(line);
  }

  const totalRunSpend = scoredLines.reduce((s, l) => s + (l.line_amount || 0), 0);

  const rollups = [];

  for (const [supplier, lines] of map) {
    const totalSpend = lines.reduce((s, l) => s + (l.line_amount || 0), 0);
    const spendSharePct = totalRunSpend > 0
      ? parseFloat(((totalSpend / totalRunSpend) * 100).toFixed(1))
      : 0;

    const poSet   = new Set(lines.map(l => l.po_number).filter(Boolean));
    const itemSet = new Set(lines.map(l => l.item_code).filter(Boolean));

    const overdueCount    = lines.filter(l => l.delivery_status === 'overdue').length;
    const highRiskCount   = lines.filter(l => l.severity === 'High').length;
    const flaggedCount    = lines.filter(l => l.applied_rules.length > 0).length;
    const dueSoonCount    = lines.filter(l => l.applied_rules.includes('due_soon')).length;

    // Total open dollars that are past due (overdue + partial-overdue).
    const pastDueDollars = lines
      .filter(l =>
        l.delivery_status === 'overdue' ||
        (l.delivery_status === 'partial' && l.confirmed_date && l.confirmed_date < ctx.today)
      )
      .reduce((s, l) => s + (l.line_amount || 0), 0);

    // Maximum days any line is over its confirmed date (re-derived from dates
    // for precision; does not rely on days_variance semantics from ingest).
    let maxDaysOverdue = 0;
    for (const l of lines) {
      if (l.confirmed_date && l.confirmed_date < ctx.today) {
        const d = isoDateDiff(l.confirmed_date, ctx.today);
        if (d > maxDaysOverdue) maxDaysOverdue = d;
      }
    }

    // Supplier severity = worst severity across its lines.
    const sev = lines.some(l => l.severity === 'High')   ? 'High'
              : lines.some(l => l.severity === 'Medium') ? 'Medium'
              : 'Low';

    // On-time rate: % of lines with a resolved delivery that arrived on or before confirmed date.
    // Only lines with a confirmed_date and a final status (not 'pending') are counted.
    const resolvedLines = lines.filter(l => l.confirmed_date && l.delivery_status !== 'pending');
    const onTimeCount   = resolvedLines.filter(l => (l.days_variance ?? 0) <= 0).length;
    const onTimeRatePct = resolvedLines.length > 0
      ? parseFloat(((onTimeCount / resolvedLines.length) * 100).toFixed(1))
      : null;

    // Average days variance across lines that have a numeric days_variance.
    const varianceLines = lines.filter(l => l.days_variance != null && isFinite(l.days_variance));
    const avgDaysVariance = varianceLines.length > 0
      ? parseFloat((varianceLines.reduce((s, l) => s + l.days_variance, 0) / varianceLines.length).toFixed(1))
      : null;

    rollups.push({
      supplier,
      line_count:       lines.length,
      po_count:         poSet.size,
      item_count:       itemSet.size > 0 ? itemSet.size : null,
      total_spend:      totalSpend,
      spend_share_pct:  spendSharePct,
      on_time_rate_pct: onTimeRatePct,
      avg_days_variance: avgDaysVariance,
      overdue_count:    overdueCount,
      high_risk_count:  highRiskCount,
      flagged_count:    flaggedCount,
      due_soon_count:   dueSoonCount,
      past_due_dollars: pastDueDollars,
      max_days_overdue: maxDaysOverdue > 0 ? maxDaysOverdue : null,
      risk_flags:       [],   // populated by applyConcentrationFlags
      severity:         sev,
    });
  }

  // Sort: High first → total_spend desc.
  const SEV_ORDER = { High: 0, Medium: 1, Low: 2 };
  rollups.sort((a, b) => {
    const d = SEV_ORDER[a.severity] - SEV_ORDER[b.severity];
    return d !== 0 ? d : b.total_spend - a.total_spend;
  });

  return rollups;
}

// ---------------------------------------------------------------------------
// applyConcentrationFlags
//
// Adds concentration_risk and delivery_variance flags to rollups that meet
// the THRESHOLDS-defined concentration criteria.  Modifies rollups in place.
//
// Two independent concentration triggers:
//   a) Spend share: supplier accounts for >= CONCENTRATION_PCT of run spend.
//   b) Risk density: supplier has >= CONCENTRATION_HIGH_LINES High-severity lines.
//
// Either trigger alone is sufficient to flag concentration_risk.
// ---------------------------------------------------------------------------
function applyConcentrationFlags(rollups) {
  for (const rollup of rollups) {
    const isHighConcentrationSpend = rollup.spend_share_pct  >= THRESHOLDS.CONCENTRATION_PCT;
    const isHighConcentrationRisk  = rollup.high_risk_count  >= THRESHOLDS.CONCENTRATION_HIGH_LINES;

    if (isHighConcentrationSpend || isHighConcentrationRisk) {
      addFlag(rollup, 'concentration_risk');
      // Escalate severity: concentration + risk density → at least Medium.
      if (rollup.severity === 'Low') rollup.severity = 'Medium';
    }

    // Delivery variance: any overdue lines at this supplier.
    if (rollup.overdue_count > 0) {
      addFlag(rollup, 'delivery_variance');
    }
  }
}

function addFlag(rollup, flag) {
  if (!rollup.risk_flags.includes(flag)) rollup.risk_flags.push(flag);
}

// ---------------------------------------------------------------------------
// generateInsights
//
// Produces an array of ProcurementInsight objects (see types.js for shape).
//
// Insight categories implemented in this MVP:
//   I1 — Past-due lines cluster           (supplier_risk)
//   I2 — Promise-after-need cluster       (supplier_risk)
//   I3 — No delivery date cluster         (supplier_risk)
//   I4 — High-concentration suppliers     (supplier_risk, one per supplier)
//   I5 — Due-soon cluster                 (supplier_risk)
//
// Each insight has a stable deterministic id: "{category}:{detail_slug}".
// Same input always produces the same insight id — safe to use as a key
// for deduplication and as a foreign key for action items.
// ---------------------------------------------------------------------------
function generateInsights(scoredLines, supplierRollups, ctx) {
  const insights = [];

  // ── I1: Past-due lines (run-level) ─────────────────────────────────────
  const pastDueLines = scoredLines.filter(l => l.applied_rules.includes('past_due'));
  if (pastDueLines.length > 0) {
    const exposure        = pastDueLines.reduce((s, l) => s + (l.line_amount || 0), 0);
    const suppliers       = [...new Set(pastDueLines.map(l => l.supplier))];
    const longestOverdue  = pastDueLines.reduce((max, l) => {
      const d = l.confirmed_date ? isoDateDiff(l.confirmed_date, ctx.today) : 0;
      return Math.max(max, d);
    }, 0);

    insights.push({
      id:                'supplier_risk:past_due_lines',
      category:          'supplier_risk',
      severity:          'High',
      title:             `${pastDueLines.length} open PO line${n(pastDueLines.length)} past due — ${fmtCurrency(exposure)} at risk`,
      description:       `${pastDueLines.length} open PO line${n(pastDueLines.length)} ${have(pastDueLines.length)} passed ${their(pastDueLines.length)} due date, `
                       + `representing ${fmtCurrency(exposure)} in open exposure across ${suppliers.length} supplier${n(suppliers.length)}. `
                       + `Longest overdue: ${longestOverdue} day${longestOverdue !== 1 ? 's' : ''}.`,
      affected_supplier: suppliers.length === 1 ? suppliers[0] : null,
      affected_items:    uniqueItems(pastDueLines),
      metric_value:      pastDueLines.length,
      metric_label:      'past due lines',
      risk_flags:        ['delivery_variance'],
      recommended_action: 'Expedite overdue lines with each affected supplier. Prioritise highest-value and longest-past-due items first. '
                        + 'Escalate to procurement management if any line is > 30 days overdue.',
    });
  }

  // ── I2: Promise-after-need (run-level) ─────────────────────────────────
  const promiseLateLines = scoredLines.filter(l => l.applied_rules.includes('promise_after_need'));
  if (promiseLateLines.length > 0) {
    const maxGap = promiseLateLines.reduce((max, l) => {
      const gap = (l.confirmed_date && l.requested_date)
        ? isoDateDiff(l.requested_date, l.confirmed_date)
        : 0;
      return Math.max(max, gap);
    }, 0);

    const sev = promiseLateLines.length >= 3 ? 'High' : 'Medium';

    insights.push({
      id:                'supplier_risk:promise_after_need',
      category:          'supplier_risk',
      severity:          sev,
      title:             `${promiseLateLines.length} line${n(promiseLateLines.length)} committed beyond need date (up to ${maxGap} days late)`,
      description:       `${promiseLateLines.length} PO line${n(promiseLateLines.length)} ${have(promiseLateLines.length)} a supplier promise date later than the buyer's need date. `
                       + `The largest gap between promise date and need date is ${maxGap} calendar day${maxGap !== 1 ? 's' : ''}.`,
      affected_supplier: null,
      affected_items:    uniqueItems(promiseLateLines),
      metric_value:      maxGap,
      metric_label:      'days — max gap (promise vs need)',
      risk_flags:        ['delivery_variance'],
      recommended_action: 'Negotiate expedited delivery or identify qualified alternative sources. '
                        + 'Notify production planning of the confirmed delays and quantify the schedule impact.',
    });
  }

  // ── I3: No promise date (run-level) ────────────────────────────────────
  const noDatLines = scoredLines.filter(l => l.applied_rules.includes('no_promise_date'));
  if (noDatLines.length > 0) {
    const sev = noDatLines.length >= 5 ? 'High' : 'Medium';

    insights.push({
      id:                'supplier_risk:no_promise_date',
      category:          'supplier_risk',
      severity:          sev,
      title:             `${noDatLines.length} line${n(noDatLines.length)} with no delivery date on record`,
      description:       `${noDatLines.length} open PO line${n(noDatLines.length)} ${have(noDatLines.length)} no confirmed or requested delivery date. `
                       + `Without a date there is no way to determine whether ${noDatLines.length === 1 ? 'this line is' : 'these lines are'} at risk.`,
      affected_supplier: null,
      affected_items:    uniqueItems(noDatLines),
      metric_value:      noDatLines.length,
      metric_label:      'lines without a delivery date',
      risk_flags:        [],
      recommended_action: 'Contact each affected supplier to obtain a firm delivery commitment. '
                        + 'Update the PO delivery date in your ERP once confirmed.',
    });
  }

  // ── I4: High-concentration suppliers (one insight per supplier) ─────────
  const concentratedRollups = supplierRollups.filter(r =>
    r.risk_flags.includes('concentration_risk')
  );
  for (const rollup of concentratedRollups) {
    const concentrationReasons = [];
    if (rollup.spend_share_pct >= THRESHOLDS.CONCENTRATION_PCT)
      concentrationReasons.push(`${rollup.spend_share_pct}% of total run spend`);
    if (rollup.high_risk_count >= THRESHOLDS.CONCENTRATION_HIGH_LINES)
      concentrationReasons.push(`${rollup.high_risk_count} High-risk lines`);

    insights.push({
      id:                `supplier_risk:concentration_${slug(rollup.supplier)}`,
      category:          'supplier_risk',
      severity:          rollup.severity,
      title:             `${rollup.supplier} — supplier concentration risk (${concentrationReasons.join(', ')})`,
      description:       `${rollup.supplier} has ${rollup.line_count} open PO line${n(rollup.line_count)} totalling ${fmtCurrency(rollup.total_spend)} `
                       + `(${rollup.spend_share_pct}% of this run's total spend). `
                       + (rollup.high_risk_count > 0
                          ? `${rollup.high_risk_count} of ${rollup.line_count === 1 ? 'that line is' : 'those lines are'} High-risk.`
                          : ''),
      affected_supplier: rollup.supplier,
      affected_items:    [],
      metric_value:      rollup.spend_share_pct,
      metric_label:      '% of run spend',
      risk_flags:        ['concentration_risk'],
      recommended_action: 'Review single-source dependencies for this supplier. '
                        + 'Develop contingency sourcing options and consider splitting volume '
                        + 'across qualified alternates to reduce exposure.',
    });
  }

  // ── I5: Due-soon cluster (run-level) ───────────────────────────────────
  const dueSoonLines = scoredLines.filter(l => l.applied_rules.includes('due_soon'));
  if (dueSoonLines.length > 0) {
    insights.push({
      id:                'supplier_risk:due_soon',
      category:          'supplier_risk',
      severity:          'Medium',
      title:             `${dueSoonLines.length} line${n(dueSoonLines.length)} due within ${THRESHOLDS.DUE_SOON_DAYS} days`,
      description:       `${dueSoonLines.length} open PO line${n(dueSoonLines.length)} ${are(dueSoonLines.length)} due within the next ${THRESHOLDS.DUE_SOON_DAYS} calendar days. `
                       + `Proactive confirmation now can prevent these from becoming overdue.`,
      affected_supplier: null,
      affected_items:    uniqueItems(dueSoonLines),
      metric_value:      dueSoonLines.length,
      metric_label:      `lines due within ${THRESHOLDS.DUE_SOON_DAYS} days`,
      risk_flags:        [],
      recommended_action: `Contact suppliers for all ${dueSoonLines.length} line${n(dueSoonLines.length)} due within the next ${THRESHOLDS.DUE_SOON_DAYS} days. `
                        + 'Request shipment confirmation or tracking details.',
    });
  }

  // Sort: High first → metric_value desc (more lines / bigger gap = higher up).
  const SEV_ORDER = { High: 0, Medium: 1, Low: 2 };
  insights.sort((a, b) => {
    const sd = SEV_ORDER[a.severity] - SEV_ORDER[b.severity];
    return sd !== 0 ? sd : (b.metric_value || 0) - (a.metric_value || 0);
  });

  return insights;
}

// ---------------------------------------------------------------------------
// generateActionCandidates
//
// Returns the subset of scored lines that warrant an explicit action item.
//
// Inclusion criteria (any one is sufficient):
//   - severity === 'High'          (delivery crisis or very high combined risk)
//   - large_dollar_exposure fired  (high-value lines need visibility even if Low risk)
//
// Sorted: High first → risk_score desc → most-overdue first.
// ---------------------------------------------------------------------------
function generateActionCandidates(scoredLines) {
  const candidates = scoredLines.filter(
    l => l.severity === 'High' || l.applied_rules.includes('large_dollar_exposure')
  );

  const SEV_ORDER = { High: 0, Medium: 1, Low: 2 };
  candidates.sort((a, b) => {
    const sd = SEV_ORDER[a.severity] - SEV_ORDER[b.severity];
    if (sd !== 0) return sd;
    if (b.risk_score !== a.risk_score) return b.risk_score - a.risk_score;
    // Tiebreak: most overdue first (days_variance is positive = days past due for overdue).
    return (b.days_variance || 0) - (a.days_variance || 0);
  });

  return candidates;
}

// ---------------------------------------------------------------------------
// buildSummary — ProcurementRunSummary (per types.js).
// ---------------------------------------------------------------------------
function buildSummary(scoredLines, supplierRollups, insights) {
  const totalSpend       = scoredLines.reduce((s, l) => s + (l.line_amount || 0), 0);
  const flaggedLines     = scoredLines.filter(l => l.applied_rules.length > 0);
  const highRiskSuppliers = supplierRollups.filter(r => r.severity === 'High').length;
  const pastDueLines     = scoredLines.filter(l => l.delivery_status === 'overdue');
  const pastDueDollars   = pastDueLines.reduce((s, l) => s + (l.line_amount || 0), 0);
  const dueSoonLines     = scoredLines.filter(l => (l.risk_flags || []).includes('due_soon'));
  const highRiskLines    = scoredLines.filter(l => l.severity === 'High');

  return {
    total_lines:           scoredLines.length,
    total_po_count:        new Set(scoredLines.map(l => l.po_number).filter(Boolean)).size,
    supplier_count:        supplierRollups.length,
    total_spend:           totalSpend,
    currency:              'USD',   // MVP: assumed; detect from upload metadata in later pass
    flagged_lines:         flaggedLines.length,
    high_risk_suppliers:   highRiskSuppliers,
    high_risk_lines:       highRiskLines.length,
    due_soon_lines:        dueSoonLines.length,
    insights_count:        insights.length,
    past_due_lines:        pastDueLines.length,
    past_due_dollars:      pastDueDollars,
    // Exposure at risk = all open lines with any risk flag.
    dollar_exposure_at_risk: flaggedLines.reduce((s, l) => s + (l.line_amount || 0), 0),
  };
}

function buildEmptySummary() {
  return {
    total_lines: 0, total_po_count: 0, supplier_count: 0,
    total_spend: 0, currency: 'USD', flagged_lines: 0,
    high_risk_suppliers: 0, high_risk_lines: 0, due_soon_lines: 0,
    insights_count: 0,
    past_due_lines: 0, past_due_dollars: 0, dollar_exposure_at_risk: 0,
  };
}

// ---------------------------------------------------------------------------
// Formatting helpers  (pure — no locale dependencies on the server)
// ---------------------------------------------------------------------------

function fmtCurrency(n) {
  // Rounds to whole dollars; inserts thousands commas.
  const rounded = Math.round(n || 0);
  return '$' + rounded.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function slug(str) {
  return String(str).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function uniqueItems(lines) {
  return [...new Set(lines.map(l => l.item_code).filter(Boolean))];
}

// Tiny pluralisation helpers for insight descriptions.
const n       = count => count === 1 ? ''   : 's';
const have    = count => count === 1 ? 'has' : 'have';
const are     = count => count === 1 ? 'is'  : 'are';
const their   = count => count === 1 ? 'its' : 'their';

module.exports = { analyzeRows };
