'use strict';

// ---------------------------------------------------------------------------
// procurementRules.js — Rule definitions and row-level risk scoring.
//
// Design principles:
//   Pure functions only — no I/O, no side effects, deterministic output.
//   Each rule is a self-contained object: { key, label, points, test() }.
//   scoreRow() iterates RULES and sums points; the caller never needs to
//   know rule internals.
//
// Scoring model:
//   Each rule contributes a fixed point value (additive, capped at 100).
//   Severity bands are derived from the total score:
//     score >= SCORE_HIGH   → 'High'
//     score >= SCORE_MEDIUM → 'Medium'
//     otherwise             → 'Low'
//   This makes severity deterministic and tunable without touching rule logic.
//
// Adding a rule:
//   Push a new entry to RULES.  scoreRow() picks it up automatically.
//   Add the key to RULE_TO_FLAG if it maps to a VALID_RISK_FLAG for rollup use.
//
// Tuning thresholds:
//   All numeric thresholds are in THRESHOLDS below.
//   Each can be overridden per deployment with the PCO_* environment variables
//   listed in the comments, without a code change.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// THRESHOLDS
// ---------------------------------------------------------------------------
const THRESHOLDS = {
  // Days before due date that triggers the "due_soon" flag.
  // Lower to 7 for tighter supply chains; raise to 21 for long-haul imports.
  // Override: PCO_DUE_SOON_DAYS (default 14)
  DUE_SOON_DAYS: parseInt(process.env.PCO_DUE_SOON_DAYS || '14', 10),

  // Line amount (same currency as the upload) above which "large_dollar_exposure"
  // fires.  A $10k default works for mid-market manufacturing; raise to $50k+
  // for aerospace / defence spends.
  // Override: PCO_LARGE_DOLLAR_THRESHOLD (default 10000)
  LARGE_DOLLAR_THRESHOLD: parseFloat(process.env.PCO_LARGE_DOLLAR_THRESHOLD || '10000'),

  // Supplier's share of total run spend (%) above which concentration_risk fires.
  // Override: PCO_CONCENTRATION_PCT (default 30)
  CONCENTRATION_PCT: parseFloat(process.env.PCO_CONCENTRATION_PCT || '30'),

  // Minimum number of High-severity lines under one supplier to independently
  // trigger concentration_risk (regardless of spend share).
  // Override: PCO_CONCENTRATION_HIGH_LINES (default 5)
  CONCENTRATION_HIGH_LINES: parseInt(process.env.PCO_CONCENTRATION_HIGH_LINES || '5', 10),

  // Score boundaries for severity bands.  Adjust to recalibrate the
  // High/Medium split without touching rule point values.
  SCORE_HIGH:   40,
  SCORE_MEDIUM: 20,
};

// ---------------------------------------------------------------------------
// isoDateDiff
// Returns (b − a) in whole calendar days.  Positive when b is later.
// Operates on 'YYYY-MM-DD' strings; avoids localtime timezone shifts.
// ---------------------------------------------------------------------------
function isoDateDiff(a, b) {
  const [y1, m1, d1] = a.split('-').map(Number);
  const [y2, m2, d2] = b.split('-').map(Number);
  return Math.round(
    (Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000
  );
}

// ---------------------------------------------------------------------------
// RULES
//
// Each rule:
//   key               : stable string identifier (snake_case)
//   label             : human-readable short name for UI display
//   points            : score contribution when the rule fires
//   recommended_action: what the buyer should do (surfaces in action queue)
//   test(line, ctx)   : (POLine, RunCtx) → boolean
//                       RunCtx: { today: 'YYYY-MM-DD' }
//
// Rules are evaluated in order.  All matching rules fire — they are not
// mutually exclusive.  (Example: a line can be both past_due AND large_dollar.)
// ---------------------------------------------------------------------------
const RULES = [
  // ───────────────────────────────────────────────────────────────────────
  // R1  past_due  [40 pts — High threshold]
  //
  // The PO line's due date (confirmed or need date) has passed without a
  // full receipt recorded.  This is the highest-priority delivery risk:
  // a late open PO line directly threatens production schedules.
  //
  // The rule covers both 'overdue' lines (full amount unpaid) and 'partial'
  // lines whose confirmed date is in the past (remaining balance overdue).
  // ───────────────────────────────────────────────────────────────────────
  {
    key:    'past_due',
    label:  'Past Due',
    points: 40,
    recommended_action: 'Expedite or reschedule — this PO line is past its due date. '
      + 'Contact the supplier immediately for a revised delivery commitment.',

    test(line, ctx) {
      if (line.delivery_status === 'overdue') return true;
      // Partial receipt lines: flag if confirmed date has passed.
      if (
        line.delivery_status === 'partial' &&
        line.confirmed_date  !== null &&
        line.confirmed_date  <  ctx.today
      ) return true;
      return false;
    },
  },

  // ───────────────────────────────────────────────────────────────────────
  // R2  promise_after_need  [30 pts — crosses High threshold with past_due]
  //
  // The supplier's confirmed delivery date is later than the buyer's
  // requested need date.  The buyer placed the order expecting it on time,
  // but the supplier has already indicated it cannot meet that date.
  // ───────────────────────────────────────────────────────────────────────
  {
    key:    'promise_after_need',
    label:  'Promise Date After Need Date',
    points: 30,
    recommended_action: "Supplier's promise date is later than your need date. "
      + 'Escalate with the supplier for acceleration, or adjust the production '
      + 'schedule and notify downstream stakeholders.',

    test(line) {
      return (
        !!line.confirmed_date  &&
        !!line.requested_date  &&
        line.confirmed_date > line.requested_date
      );
    },
  },

  // ───────────────────────────────────────────────────────────────────────
  // R3  due_soon  [20 pts — Medium threshold on its own]
  //
  // The confirmed (or need) date falls within DUE_SOON_DAYS of today.
  // The line is not yet late but needs active monitoring to prevent it
  // from slipping into overdue.
  //
  // Fires on 'pending' and 'partial' lines only — 'overdue' lines are
  // already captured by past_due (higher priority).
  // Requires the date to be in the future; past-dates are ignored here
  // to avoid double-counting with past_due.
  // ───────────────────────────────────────────────────────────────────────
  {
    key:    'due_soon',
    label:  'Due Soon',
    points: 20,
    recommended_action: `Delivery is due within ${THRESHOLDS.DUE_SOON_DAYS} days. `
      + 'Proactively confirm supplier readiness and track the shipment.',

    test(line, ctx) {
      if (line.delivery_status !== 'pending' && line.delivery_status !== 'partial') return false;
      const date = line.confirmed_date || line.requested_date;
      if (!date) return false;
      if (date < ctx.today) return false;  // in the past — handled by past_due
      const daysAway = isoDateDiff(ctx.today, date);
      return daysAway >= 0 && daysAway <= THRESHOLDS.DUE_SOON_DAYS;
    },
  },

  // ───────────────────────────────────────────────────────────────────────
  // R4  no_promise_date  [15 pts — Medium threshold on its own]
  //
  // No confirmed delivery date AND no need date is on record.
  // Zero delivery visibility: impossible to determine whether this line
  // is at risk without obtaining a date from the supplier.
  // ───────────────────────────────────────────────────────────────────────
  {
    key:    'no_promise_date',
    label:  'No Promise Date',
    points: 15,
    recommended_action: 'No delivery date on record. Contact the supplier to '
      + 'obtain a firm delivery commitment and update the PO in your ERP.',

    test(line) {
      return !line.confirmed_date && !line.requested_date;
    },
  },

  // ───────────────────────────────────────────────────────────────────────
  // R5  large_dollar_exposure  [10 pts — Low on its own; boosts combined score]
  //
  // Line amount meets or exceeds LARGE_DOLLAR_THRESHOLD.  Alone this is a
  // Low flag (dollar size is not a delivery risk by itself) but it amplifies
  // the combined score when a delivery risk rule also fires, ensuring that
  // high-value at-risk lines always surface to the action queue.
  //
  // Example: past_due (40) + large_dollar (10) = 50 pts → High.
  //          large_dollar alone (10) → Low but still appears in action candidates.
  // ───────────────────────────────────────────────────────────────────────
  {
    key:    'large_dollar_exposure',
    label:  'Large Dollar Exposure',
    points: 10,
    recommended_action: `High-value line (≥ $${THRESHOLDS.LARGE_DOLLAR_THRESHOLD.toLocaleString('en-US')}). `
      + 'Ensure an escalation path and executive visibility if delivery is at risk.',

    test(line) {
      return (line.line_amount || 0) >= THRESHOLDS.LARGE_DOLLAR_THRESHOLD;
    },
  },
];

// ---------------------------------------------------------------------------
// RULE_TO_FLAG
// Maps rule keys to VALID_RISK_FLAGS (from types.js) for supplier rollup
// aggregation.  null means the rule has no rollup-level flag equivalent.
// ---------------------------------------------------------------------------
const RULE_TO_FLAG = {
  past_due:             'delivery_variance',
  promise_after_need:   'delivery_variance',
  due_soon:             null,
  no_promise_date:      null,
  large_dollar_exposure: null,
};

// ---------------------------------------------------------------------------
// scoreRow
//
// Applies all RULES to a single POLine and returns a scoring result.
// This is the only function external code needs to call from this module
// for row-level scoring.
//
// Parameters:
//   line : POLine        — normalised PO line from procurementIngest
//   ctx  : RunCtx        — { today: 'YYYY-MM-DD' }
//
// Returns:
//   {
//     score            : number    — 0–100 (additive points, capped)
//     severity         : string    — 'High' | 'Medium' | 'Low'
//     applied_rules    : string[]  — ordered list of rule keys that fired
//     risk_flags       : string[]  — unique VALID_RISK_FLAG values derived
//     recommended_actions: string[] — ordered actions (highest-priority first)
//   }
// ---------------------------------------------------------------------------
function scoreRow(line, ctx) {
  const fired  = [];
  let   points = 0;

  for (const rule of RULES) {
    if (rule.test(line, ctx)) {
      fired.push(rule);
      points += rule.points;
    }
  }

  const score = Math.min(100, points);

  const severity =
    score >= THRESHOLDS.SCORE_HIGH   ? 'High'   :
    score >= THRESHOLDS.SCORE_MEDIUM ? 'Medium' :
    'Low';

  // Deduplicate risk flags (multiple rules may map to the same flag).
  const risk_flags = [...new Set(
    fired.map(r => RULE_TO_FLAG[r.key]).filter(Boolean)
  )];

  return {
    score,
    severity,
    applied_rules:       fired.map(r => r.key),
    risk_flags,
    recommended_actions: fired.map(r => r.recommended_action),
  };
}

module.exports = { THRESHOLDS, RULES, RULE_TO_FLAG, scoreRow, isoDateDiff };
