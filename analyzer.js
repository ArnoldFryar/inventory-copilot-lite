'use strict';

const cfg         = require('./config');
const { resolveHeaders } = require('./columnMap');

// Destructure so all existing references below remain unchanged.
// Thresholds are defined and documented in config.js — edit them there.
const {
  CRITICAL_RATIO,
  URGENT_RATIO,
  EXCESS_RATIO,
  DEAD_STOCK_RATIO,
  TOP_PRIORITY_MAX
} = cfg;

// Numeric weight used for sorting (lower = surfaces first)
const SEVERITY_ORDER = { High: 0, Medium: 1, Low: 2 };

// ---------------------------------------------------------------------------
// NULL_LIKE
// Strings that unambiguously signal a missing or unknown value in ERP
// exports.  These must be rejected before Number() parsing because some of
// them (e.g. "-") would silently parse as NaN anyway, but others like "0" do
// not appear here — 0 is a legitimate quantity value.
// ---------------------------------------------------------------------------
const NULL_LIKE = new Set([
  'n/a', 'na', 'n.a.', 'n.a',
  'null', 'nil', 'none',
  '#n/a', '#na', '#null', '#value!', '#ref!',
  '-', '\u2014', '\u2013',   // ASCII hyphen, em-dash, en-dash
  'tbd', 'missing', 'unknown', '?',
  'blank', 'empty',
]);

// ---------------------------------------------------------------------------
// safePositiveNumber
// Parses a raw CSV string value into a finite, non-negative number.
// Returns NaN if the value is absent, non-numeric, negative, or a known
// null-like sentinel.  Handles common ERP export formatting:
//   - thousands commas    : "1,234"   → 1234
//   - currency prefixes   : "$100"    → 100
//   - unit suffixes       : "50 units" | "30 days" | "200 PCS" → numeric part
//   - null-like strings   : "N/A"     → NaN
//   - excess whitespace   : " 50 "    → 50
//
// Thousands-comma rule: a comma is treated as a thousands separator ONLY
// when exactly 3 digits follow it (e.g. "1,234" or "1,234,567").
// "1,5" or "1,50" (European decimal comma) are NOT stripped — they parse
// as NaN and produce an Invalid row rather than a silently wrong number.
// ---------------------------------------------------------------------------
function safePositiveNumber(raw) {
  if (raw === null || raw === undefined) return NaN;

  const trimmed = String(raw).trim();
  if (trimmed === '') return NaN;

  // Reject known null/empty sentinels before attempting numeric parse.
  if (NULL_LIKE.has(trimmed.toLowerCase())) return NaN;

  // Strip a trailing unit-label word if separated from the number by whitespace.
  // Handles ERP fields like "50 units", "30 days", "200 PCS", "1,500 kg".
  // The pattern requires the suffix to start with a letter (so scientific
  // notation like "1e3" is unaffected — there is no leading space before 'e').
  const withoutUnit = trimmed.replace(/\s[a-zA-Z][a-zA-Z\s]*$/, '');

  // Strip thousands-separator commas: ONLY when exactly 3 digits follow.
  // - "1,234"   → "1234"   (thousands ✓)
  // - "1,234,567" → "1234567" (compound thousands ✓)
  // - "1,5"     → "1,5"    (European decimal — not stripped → NaN → Invalid ✓)
  // - "1,50"    → "1,50"   (ambiguous — not stripped → NaN → Invalid ✓)
  // The lookahead \d{3}(\D|$) matches exactly 3 digits followed by a
  // non-digit or end of string.
  const unformatted = withoutUnit.replace(/,(?=\d{3}(\D|$))/g, '');

  // Strip leading currency symbols and trailing whitespace/percent.
  // Does not strip digits or decimal points.
  const cleaned = unformatted.replace(/^[\$€£¥\s]+|[\s%]+$/g, '');

  const n = Number(cleaned);          // handles integers, decimals, "1e2"
  if (!isFinite(n)) return NaN;       // rejects Infinity, -Infinity, NaN
  if (n < 0)        return NaN;       // negative inventory/usage/lead-time is invalid

  return n;
}

// ---------------------------------------------------------------------------
// classifyRow
// Pure classification function — takes validated numbers, returns status,
// severity, reason, and recommended_action. No I/O, no side effects.
//
// Status taxonomy (in priority order):
//   Urgent Stockout Risk  — coverage ≤ lead_time × URGENT_RATIO (< lead_time)
//                           Critical sub-band: coverage ≤ lead_time × CRITICAL_RATIO
//   Stockout Risk         — coverage < lead_time (non-urgent)
//   No Usage Data         — daily_usage === 0 (cannot compute coverage)
//   Potential Dead Stock  — coverage > lead_time × DEAD_STOCK_RATIO  [Medium severity]
//   Excess Inventory      — coverage > lead_time × EXCESS_RATIO      [Low severity]
//   Healthy               — coverage ≥ lead_time and ≤ lead_time × EXCESS_RATIO
// ---------------------------------------------------------------------------
function classifyRow(onHand, dailyUsage, leadTime) {

  // ── No usage signal ────────────────────────────────────────────────────
  // daily_usage = 0 means we have no consumption rate to compute coverage.
  // This is distinct from Excess: we simply cannot classify the part.
  if (dailyUsage === 0) {
    return {
      coverage:           null,
      status:             'No Usage Data',
      // Low — this is a data-quality / investigation item, not an active supply
      // action.  Grouping it with Stockout Risk (Medium) inflates priority counts
      // and misleads reviewers sorting exports by severity.
      severity:           'Low',
      reason:             `Daily usage is 0; cannot compute coverage (on hand: ${onHand})`,
      recommended_action: 'Verify part activity in ERP — no consumption recorded in this export'
    };
  }

  const rawCoverage  = onHand / dailyUsage;
  const coverage     = +rawCoverage.toFixed(1);
  // pctRemaining is derived from the rounded coverage value (not rawCoverage)
  // so that the percentage shown in reason strings is consistent with the
  // coverage value a reviewer sees in the table.  Classification logic
  // continues to use rawCoverage for precision.
  const pctRemaining = Math.round((coverage / leadTime) * 100);

  // ── Critical stockout (≤ CRITICAL_RATIO of lead time remaining) ────────
  // Coverage at or below 25 % of lead time — standard replenishment lead time
  // cannot complete before stock runs out.  Line stoppage is imminent.
  if (rawCoverage < leadTime && rawCoverage <= leadTime * CRITICAL_RATIO) {
    return {
      coverage,
      status:             'Urgent Stockout Risk',
      severity:           'High',
      reason:             `Coverage ${coverage} days — only ${pctRemaining}% of lead time ${leadTime} days remains (critical threshold: ${CRITICAL_RATIO * 100}%)`,
      recommended_action: 'Escalate immediately — coverage may not last until a standard replenishment order arrives'
    };
  }

  // ── Urgent stockout (≤ URGENT_RATIO of lead time remaining) ───────────
  // Less than URGENT_RATIO of lead time remaining in stock.
  // At 50 % you are already consuming the "emergency" window.
  if (rawCoverage < leadTime && rawCoverage <= leadTime * URGENT_RATIO) {
    return {
      coverage,
      status:             'Urgent Stockout Risk',
      severity:           'High',
      reason:             `Coverage ${coverage} days is critically below lead time ${leadTime} days — only ${pctRemaining}% of lead time remains`,
      recommended_action: 'Expedite immediately — coverage is within emergency window'
    };
  }

  // ── Standard stockout ─────────────────────────────────────────────────
  if (rawCoverage < leadTime) {
    const gap = (leadTime - coverage).toFixed(1);
    return {
      coverage,
      status:             'Stockout Risk',
      severity:           'Medium',
      reason:             `Coverage ${coverage} days — ${gap} days short of lead time (${leadTime} days)`,
      recommended_action: 'Review open POs and expedite if needed'
    };
  }

  // ── Potential dead stock ───────────────────────────────────────────────
  // Coverage exceeds DEAD_STOCK_RATIO × lead time — far above any reasonable
  // safety stock level.  Indicates possible obsolescence, demand collapse, or
  // severe over-procurement.  Disposition decision (return, scrap, write-off)
  // is required.  Severity is Medium because this is a financial risk that
  // belongs in the priority panel alongside active supply risks.
  if (rawCoverage > leadTime * DEAD_STOCK_RATIO) {
    return {
      coverage,
      status:             'Potential Dead Stock',
      severity:           'Medium',
      reason:             `Coverage ${coverage} days — more than ${DEAD_STOCK_RATIO}\u00d7 lead time of ${leadTime} days`,
      recommended_action: 'Evaluate for disposition — possible obsolete or severely over-procured part'
    };
  }

  // ── Excess inventory ──────────────────────────────────────────────────
  // Coverage exceeds EXCESS_RATIO × lead time — more than two full replenishment
  // windows in stock suggests over-procurement or reduced demand.
  if (rawCoverage > leadTime * EXCESS_RATIO) {
    return {
      coverage,
      status:             'Excess Inventory',
      severity:           'Low',
      reason:             `Coverage ${coverage} days — more than ${EXCESS_RATIO}\u00d7 lead time of ${leadTime} days`,
      recommended_action: 'Review excess for demand pull-in, return to supplier, or reallocation'
    };
  }

  // ── Healthy ───────────────────────────────────────────────────────────
  return {
    coverage,
    status:             'Healthy',
    severity:           'Low',
    reason:             `Coverage ${coverage} days — adequately stocked against lead time of ${leadTime} days`,
    recommended_action: 'No action required'
  };
}

// ---------------------------------------------------------------------------
// analyzeRow
// Parses and validates a single raw CSV row using the resolved field map,
// then delegates to classifyRow.
//
// Parameters:
//   row      — raw object from csv-parser (keys are original CSV headers)
//   fieldMap — { canonical → rawKey } produced by resolveHeaders() in
//              analyzeRows().  Resolved once per batch, not per row.
//
// Returns a RowResult:
//  {
//    part_number        : string,
//    on_hand            : number | null,
//    daily_usage        : number | null,
//    lead_time          : number | null,
//    coverage           : number | null,
//    status             : string,
//    severity           : 'High' | 'Medium' | 'Low',
//    reason             : string,
//    recommended_action : string
//  }
// ---------------------------------------------------------------------------
function analyzeRow(row, fieldMap) {
  // Use the pre-resolved mapping to extract values by canonical name.
  // fieldMap[canonical] is the exact raw header key in this CSV.
  const get = (canonical) => {
    const key = fieldMap[canonical];
    return key !== undefined ? row[key] : undefined;
  };

  const rawPartNumber = get('part_number');
  const rawOnHand     = get('on_hand');
  const rawDailyUsage = get('daily_usage');
  const rawLeadTime   = get('lead_time');
  const rawSupplier   = get('supplier');

  const partNumber = (rawPartNumber !== null && rawPartNumber !== undefined)
    ? String(rawPartNumber).trim()
    : '';
  const label = partNumber || '(no part number)';

  const supplier = (rawSupplier !== null && rawSupplier !== undefined)
    ? String(rawSupplier).trim()
    : '';

  const onHand     = safePositiveNumber(rawOnHand);
  const dailyUsage = safePositiveNumber(rawDailyUsage);
  const leadTime   = safePositiveNumber(rawLeadTime);

  // ── Invalid row: one or more required numeric fields could not be parsed ──
  const badFields = [];
  if (isNaN(onHand))     badFields.push('on_hand');
  if (isNaN(dailyUsage)) badFields.push('daily_usage');
  if (isNaN(leadTime))   badFields.push('lead_time');
  // Zero lead time is a data error — instant-replenishment is not a real
  // ERP scenario; it means the field was not populated or defaulted to 0.
  // Coverage-based triage is meaningless without a positive lead time.
  if (!isNaN(leadTime) && leadTime === 0) badFields.push('lead_time (must be > 0)');

  if (badFields.length > 0) {
    const FRIENDLY_FIELD_NAMES = {
      'on_hand':                     'Quantity on Hand',
      'daily_usage':                 'Daily Usage',
      'lead_time':                   'Lead Time',
      'lead_time (must be > 0)':     'Lead Time (must be greater than zero)',
    };
    const friendlyBadFields = badFields.map(f => FRIENDLY_FIELD_NAMES[f] || f);
    return {
      part_number:        label,
      supplier:           supplier,
      on_hand:            isNaN(onHand)     ? null : onHand,
      daily_usage:        isNaN(dailyUsage) ? null : dailyUsage,
      lead_time:          isNaN(leadTime)   ? null : leadTime,
      coverage:           null,
      status:             'Invalid',
      severity:           'Low',
      reason:             `Missing or unreadable value for: ${friendlyBadFields.join(', ')}`,
      recommended_action: 'Check the source data — these fields are missing or contain non-numeric values'
    };
  }

  const classification = classifyRow(onHand, dailyUsage, leadTime);

  return {
    part_number: label,
    supplier:    supplier,
    on_hand:     onHand,
    daily_usage: dailyUsage,
    lead_time:   leadTime,
    ...classification
  };
}

// ---------------------------------------------------------------------------
// priorityTierOf
// Returns the sort tier for a row so active stockouts always surface above
// imminent risks, and imminent risks always surface above everything else.
//
//   Tier 1 — ACTIVE STOCKOUT : coverage ≤ 0 (on hand depleted)
//   Tier 2 — IMMINENT RISK   : coverage positive but below lead time
//   Tier 3 — all other rows  (excess, dead stock, healthy, no-usage, invalid)
//
// Null coverage (Invalid / No Usage Data rows) falls through to Tier 3.
// ---------------------------------------------------------------------------
function priorityTierOf(row) {
  const cov = row.coverage;
  const lt  = row.lead_time;
  if (cov !== null && cov !== undefined && cov <= 0) return 1;
  if (cov !== null && cov !== undefined &&
      lt  !== null && lt  !== undefined && cov < lt)  return 2;
  return 3;
}

// ---------------------------------------------------------------------------
// analyzeRows
// Maps raw CSV rows → RowResult[], sorts by priority tier + coverage, builds
// summary counts, and selects the top-priority items for the priority panel.
//
// Returns:
//  {
//    summary     : { total, urgent_stockout, stockout_risk, no_usage,
//                    excess, dead_stock, healthy, invalid,
//                    high_priority, medium_priority, low_priority },
//    topPriority : RowResult[]   — up to TOP_PRIORITY_MAX non-Low rows
//    results     : RowResult[]   — all rows, sorted
//  }
// ---------------------------------------------------------------------------
function analyzeRows(rows, preResolved) {
  // ── Resolve column aliases once for the entire batch ───────────────────
  // If the caller (server.js) has already called resolveHeaders for schema
  // validation, it passes the result directly here so we don't duplicate
  // the work.  If called standalone (tests, CLI), we resolve internally.
  const firstKeys = rows.length > 0 ? Object.keys(rows[0]) : [];
  const { mapping, aliases } = preResolved || resolveHeaders(firstKeys);

  if (Object.keys(aliases).length > 0) {
    const notes = Object.entries(aliases)
      .map(([canonical, raw]) => `${canonical} ← "${raw}"`).join(', ');
    console.log(`[analyzeRows] column aliases resolved: ${notes}`);
  }

  const results = rows.map(row => analyzeRow(row, mapping));

  // ── Duplicate part number detection ─────────────────────────────────
  // If the same part number appears more than once, both rows are analyzed
  // independently. The report will look complete but cover the same part
  // twice. Surface a warning so the user knows to de-duplicate before acting.
  const seenParts        = new Set();
  const duplicateWarnings = [];
  results.forEach(r => {
    const pn = r.part_number;
    if (pn && pn !== '(no part number)') {
      if (seenParts.has(pn)) {
        if (!duplicateWarnings.includes(pn)) duplicateWarnings.push(pn);
      } else {
        seenParts.add(pn);
      }
    }
  });
  if (duplicateWarnings.length > 0) {
    console.warn(`[analyzeRows] duplicate part numbers detected: ${duplicateWarnings.join(', ')}`);
  }

  // Sort: Tier 1 (active stockouts) before Tier 2 (imminent risks) before
  // Tier 3 (everything else).
  // Within the same tier, sort by lead-time gap DESC — a part that is
  // 20 days short of its 30-day lead time (gap = 20) is more urgent than
  // one that is 3 days short of a 7-day lead time (gap = 3) even if both
  // have positive coverage.  Tie-break on coverage ASC so the most
  // depleted row surfaces first when gaps are equal.
  // Null lead_time or coverage → gap defaults to 0; null coverage → Infinity.
  results.sort((a, b) => {
    const tA = priorityTierOf(a);
    const tB = priorityTierOf(b);
    if (tA !== tB) return tA - tB;
    const gapA = (a.lead_time != null && a.coverage != null) ? a.lead_time - a.coverage : 0;
    const gapB = (b.lead_time != null && b.coverage != null) ? b.lead_time - b.coverage : 0;
    if (gapB !== gapA) return gapB - gapA;  // DESC: larger gap = higher urgency
    const cA = (a.coverage !== null && a.coverage !== undefined) ? a.coverage : Infinity;
    const cB = (b.coverage !== null && b.coverage !== undefined) ? b.coverage : Infinity;
    return cA - cB;  // ASC: lower coverage first
  });

  const count = (pred) => results.filter(pred).length;

  const summary = {
    total:           results.length,
    urgent_stockout: count(r => r.status === 'Urgent Stockout Risk'),
    stockout_risk:   count(r => r.status === 'Stockout Risk'),
    no_usage:        count(r => r.status === 'No Usage Data'),
    excess:          count(r => r.status === 'Excess Inventory'),
    dead_stock:      count(r => r.status === 'Potential Dead Stock'),
    healthy:         count(r => r.status === 'Healthy'),
    invalid:         count(r => r.status === 'Invalid'),
    high_priority:   count(r => r.severity === 'High'),
    medium_priority: count(r => r.severity === 'Medium'),
    low_priority:    count(r => r.severity === 'Low')
  };

  // Top-priority panel: surface the most actionable supply-risk rows.
  // Excludes 'Invalid' rows — those are data-quality issues, not supply
  // actions, and should not appear alongside genuine stockout risks.
  // Because results are already sorted, we just filter + slice.
  const topPriority = results
    .filter(r => r.severity !== 'Low' && r.status !== 'Invalid')
    .slice(0, TOP_PRIORITY_MAX);

  // ── Summary integrity assertion ─────────────────────────────────────────
  // The 7 named status counts must sum to total.  If they don't, a future
  // classification change introduced a gap — catch it here rather than
  // silently displaying inconsistent metrics to users.
  const statusSum = summary.urgent_stockout + summary.stockout_risk +
    summary.no_usage + summary.excess + summary.dead_stock +
    summary.healthy + summary.invalid;
  if (statusSum !== summary.total) {
    // Non-throwing warning so the response still returns — but the
    // discrepancy is visible in server logs for investigation.
    console.warn(
      `[analyzeRows] summary count mismatch: status counts sum to ${statusSum}` +
      ` but total is ${summary.total}. Check classification logic.`
    );
  }

  return {
    summary,
    topPriority,
    results,
    analyzedAt:    new Date().toISOString(),
    // Expose only the five classification thresholds, not the entire cfg module.
    // Sending `cfg` directly would leak any future additions to config.js.
    thresholds: {
      CRITICAL_RATIO:   cfg.CRITICAL_RATIO,
      URGENT_RATIO:     cfg.URGENT_RATIO,
      EXCESS_RATIO:     cfg.EXCESS_RATIO,
      DEAD_STOCK_RATIO: cfg.DEAD_STOCK_RATIO,
      TOP_PRIORITY_MAX: cfg.TOP_PRIORITY_MAX,
    },
    // columnAliases: non-empty only when the CSV used non-canonical header names.
    // Frontend uses this for the audit note so reviewers know what was remapped.
    columnAliases: aliases,
    // duplicateWarnings: part numbers that appeared more than once in the upload.
    // An empty array means no duplicates detected.
    duplicateWarnings,
  };
}

module.exports = { analyzeRows };
