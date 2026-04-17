'use strict';

// ---------------------------------------------------------------------------
// server/lib/pfep/pfepAnalyzer.js — PFEP register analysis engine.
//
// Accepts an array of PFEPPart records and returns:
//   alerts   : PFEPAlert[]       — cross-reference findings, sorted High first
//   summary  : PFEPRunSummary    — run-level counts
//
// All logic is deterministic — no AI, no random state.
// Shape references: server/lib/pfep/types.js
// ---------------------------------------------------------------------------

const { VALID_ALERT_TYPES } = require('./types');

// ---------------------------------------------------------------------------
// Severity ranking — higher = worse.
// ---------------------------------------------------------------------------
const SEVERITY_RANK = { High: 3, Medium: 2, Low: 1 };

function maxSeverity(...severities) {
  return severities.reduce((best, s) =>
    (SEVERITY_RANK[s] || 0) > (SEVERITY_RANK[best] || 0) ? s : best
  , 'Low');
}

// ---------------------------------------------------------------------------
// analyzeRegister
//
// Main entry point.
//
// @param {PFEPPart[]} rows — normalised rows from pfepIngest
// @returns {{ alerts: PFEPAlert[], summary: PFEPRunSummary }}
// ---------------------------------------------------------------------------
function analyzeRegister(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { alerts: [], summary: buildEmptySummary() };
  }

  const alerts = [];

  for (const part of rows) {
    checkDataGaps(part, alerts);
    checkParameterConsistency(part, alerts);
    checkSecondarySupplier(part, alerts);
  }

  // Sort: High first, then Medium, then Low.
  alerts.sort((a, b) => (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0));

  const summary = buildSummary(rows, alerts);
  return { alerts, summary };
}

// ---------------------------------------------------------------------------
// checkDataGaps
// Flags missing critical fields that prevent downstream cross-referencing.
// ---------------------------------------------------------------------------
function checkDataGaps(part, alerts) {
  if (!part.supplier) {
    alerts.push({
      alert_type:  'data_gap_supplier',
      severity:    'High',
      part_number: part.part_number,
      title:       'No supplier recorded',
      description: `Part ${part.part_number} has no supplier. Procurement cross-referencing is not possible without a source.`,
      context:     { abc_class: part.abc_class },
    });
  }

  if (part.lead_time_days === null || part.lead_time_days === undefined) {
    alerts.push({
      alert_type:  'data_gap_lead_time',
      severity:    'Medium',
      part_number: part.part_number,
      title:       'Lead time not specified',
      description: `Part ${part.part_number} has no lead time. Urgency and replenishment timing cannot be calculated.`,
      context:     { supplier: part.supplier },
    });
  }

  if (part.pack_multiple === null || part.pack_multiple === undefined) {
    alerts.push({
      alert_type:  'data_gap_pack_multiple',
      severity:    'Low',
      part_number: part.part_number,
      title:       'Pack multiple not specified',
      description: `Part ${part.part_number} has no pack multiple. PO quantity validation will be skipped for this part.`,
      context:     { supplier: part.supplier },
    });
  }
}

// ---------------------------------------------------------------------------
// checkParameterConsistency
// Flags min/max/reorder logic errors that would cause mis-replenishment.
// ---------------------------------------------------------------------------
function checkParameterConsistency(part, alerts) {
  const { part_number, min_qty, max_qty, reorder_point, pack_multiple } = part;

  // min >= max is a data entry error
  if (min_qty !== null && max_qty !== null && min_qty >= max_qty) {
    alerts.push({
      alert_type:  'min_max_inverted',
      severity:    'High',
      part_number,
      title:       'Min/max quantities are inverted',
      description: `Part ${part_number}: min qty (${min_qty}) is ≥ max qty (${max_qty}). This will cause constant replenishment triggers.`,
      context:     { min_qty, max_qty },
    });
  }

  // reorder_point >= max means the replenishment trigger is never below the ceiling
  if (reorder_point !== null && max_qty !== null && reorder_point >= max_qty) {
    alerts.push({
      alert_type:  'reorder_above_max',
      severity:    'High',
      part_number,
      title:       'Reorder point is at or above max quantity',
      description: `Part ${part_number}: reorder point (${reorder_point}) ≥ max qty (${max_qty}). The replenishment trigger will always fire.`,
      context:     { reorder_point, max_qty },
    });
  }

  // min_qty is not a multiple of pack_multiple
  if (min_qty !== null && pack_multiple !== null && pack_multiple > 0) {
    if (min_qty % pack_multiple !== 0) {
      alerts.push({
        alert_type:  'pack_multiple_mismatch',
        severity:    'Medium',
        part_number,
        title:       'Min quantity not aligned to pack multiple',
        description: `Part ${part_number}: min qty (${min_qty}) is not a multiple of pack multiple (${pack_multiple}). Orders will require partial packs.`,
        context:     { min_qty, pack_multiple, remainder: min_qty % pack_multiple },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// checkSecondarySupplier
// Flags A-class parts with no backup source (single-source risk).
// ---------------------------------------------------------------------------
function checkSecondarySupplier(part, alerts) {
  if (part.abc_class === 'A' && part.supplier && !part.secondary_supplier) {
    alerts.push({
      alert_type:  'no_secondary_supplier',
      severity:    'Medium',
      part_number: part.part_number,
      title:       'A-class part has no secondary supplier',
      description: `Part ${part.part_number} is classified A-class but has only one supplier (${part.supplier}). A supply disruption would immediately impact production.`,
      context:     { supplier: part.supplier, abc_class: 'A' },
    });
  }
}

// ---------------------------------------------------------------------------
// buildSummary
// ---------------------------------------------------------------------------
function buildSummary(rows, alerts) {
  const summary = buildEmptySummary();

  summary.total_parts = rows.length;

  for (const part of rows) {
    if (!part.supplier)    summary.missing_supplier++;
    if (part.lead_time_days === null || part.lead_time_days === undefined) summary.missing_lead_time++;
    if (part.pack_multiple === null || part.pack_multiple === undefined)   summary.missing_pack_multiple++;

    const hasMissingCritical =
      !part.supplier ||
      part.lead_time_days === null || part.lead_time_days === undefined;
    if (hasMissingCritical) summary.data_gap_count++;

    if (part.abc_class === 'A') summary.a_class_count++;
    else if (part.abc_class === 'B') summary.b_class_count++;
    else if (part.abc_class === 'C') summary.c_class_count++;
    else summary.unclassified_count++;
  }

  summary.alert_count      = alerts.length;
  summary.high_alert_count = alerts.filter(a => a.severity === 'High').length;

  return summary;
}

function buildEmptySummary() {
  return {
    total_parts:           0,
    missing_supplier:      0,
    missing_lead_time:     0,
    missing_pack_multiple: 0,
    a_class_count:         0,
    b_class_count:         0,
    c_class_count:         0,
    unclassified_count:    0,
    data_gap_count:        0,
    alert_count:           0,
    high_alert_count:      0,
  };
}

module.exports = { analyzeRegister };
