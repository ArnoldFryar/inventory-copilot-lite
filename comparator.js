'use strict';

// ---------------------------------------------------------------------------
// OpsCopilot-Lite — Run Comparison Engine
//
// Pure, deterministic comparison between two analysis result sets.
// No I/O, no side effects — safe to call from server routes or tests.
//
// Comparison key: part_number (case-sensitive exact match).
// Rows with no part_number or "(no part number)" are excluded from matching
// because they cannot be reliably linked across runs.
// ---------------------------------------------------------------------------

// Risk ordering: lower number = higher risk.
// Used to determine whether a part worsened or improved between runs.
// Invalid is placed between Excess and Healthy — it's a data-quality issue,
// not an active supply risk, so moving from Healthy→Invalid is a slight
// worsening (data degraded) while moving from Urgent→Invalid is an improvement
// (part dropped out of supply risk, even if via bad data).
const STATUS_RISK = {
  'Urgent Stockout Risk': 0,
  'Stockout Risk':        1,
  'Potential Dead Stock': 2,
  'No Usage Data':        3,
  'Excess Inventory':     4,
  'Invalid':              5,
  'Healthy':              6
};

function riskOf(status) {
  return STATUS_RISK[status] ?? 99;
}

// ---------------------------------------------------------------------------
// compareRuns
//
// Parameters:
//   currentRows — RowResult[] from the current (newer) analysis
//   priorRows   — RowResult[] from the previous (older) analysis
//
// Returns ComparisonResult:
//   {
//     hasPrior           : boolean,
//     newUrgent          : ChangeItem[],   — became urgent (new part or worsened into urgent)
//     resolvedUrgent     : ChangeItem[],   — was urgent, no longer (improved or removed)
//     worsened           : ChangeItem[],   — moved to a higher-risk status
//     improved           : ChangeItem[],   — moved to a lower-risk status
//     added              : ChangeItem[],   — in current but not in prior
//     removed            : ChangeItem[],   — in prior but not in current
//     unchanged          : number,
//     statusDeltas       : { [status]: number },  — net change per bucket
//     leadershipSentence : string
//   }
// ---------------------------------------------------------------------------
function compareRuns(currentRows, priorRows) {
  if (!Array.isArray(currentRows) || !Array.isArray(priorRows) || priorRows.length === 0) {
    return { hasPrior: false };
  }

  // Build lookup maps keyed by part_number.
  // Skip unmatchable rows (no part number).
  const isMatchable = (pn) => pn && pn !== '(no part number)';

  const priorMap = new Map();
  for (const row of priorRows) {
    if (isMatchable(row.part_number)) priorMap.set(row.part_number, row);
  }

  const currentMap = new Map();
  for (const row of currentRows) {
    if (isMatchable(row.part_number)) currentMap.set(row.part_number, row);
  }

  const newUrgent      = [];
  const resolvedUrgent = [];
  const worsened       = [];
  const improved       = [];
  const added          = [];
  const removed        = [];
  let   unchanged      = 0;

  // ── Process current rows ────────────────────────────────────────────────
  for (const [pn, curr] of currentMap) {
    const prev = priorMap.get(pn);

    if (!prev) {
      // Part is new — didn't exist in prior run
      const item = { part_number: pn, status: curr.status, severity: curr.severity, coverage: curr.coverage };
      added.push(item);
      if (curr.status === 'Urgent Stockout Risk') {
        newUrgent.push(item);
      }
      continue;
    }

    const prevRisk = riskOf(prev.status);
    const currRisk = riskOf(curr.status);

    if (prevRisk === currRisk) {
      unchanged++;
      continue;
    }

    const changeItem = {
      part_number:   pn,
      prev_status:   prev.status,
      status:        curr.status,
      prev_severity: prev.severity,
      severity:      curr.severity,
      coverage:      curr.coverage,
      prev_coverage: prev.coverage
    };

    if (currRisk < prevRisk) {
      // Worsened — moved to higher risk
      worsened.push(changeItem);
      if (curr.status === 'Urgent Stockout Risk' && prev.status !== 'Urgent Stockout Risk') {
        newUrgent.push({ part_number: pn, status: curr.status, severity: curr.severity, coverage: curr.coverage, prev_status: prev.status });
      }
    } else {
      // Improved — moved to lower risk
      improved.push(changeItem);
      if (prev.status === 'Urgent Stockout Risk' && curr.status !== 'Urgent Stockout Risk') {
        resolvedUrgent.push({ part_number: pn, prev_status: prev.status, status: curr.status, coverage: curr.coverage });
      }
    }
  }

  // ── Find removed parts ──────────────────────────────────────────────────
  for (const [pn, prev] of priorMap) {
    if (!currentMap.has(pn)) {
      removed.push({ part_number: pn, status: prev.status, severity: prev.severity, coverage: prev.coverage });
      if (prev.status === 'Urgent Stockout Risk') {
        resolvedUrgent.push({ part_number: pn, prev_status: prev.status, status: '(removed)', coverage: null });
      }
    }
  }

  // ── Net change by status bucket ─────────────────────────────────────────
  const ALL_STATUSES = Object.keys(STATUS_RISK);
  const statusDeltas = {};
  for (const bucket of ALL_STATUSES) {
    const currCount = currentRows.filter(r => r.status === bucket).length;
    const prevCount = priorRows.filter(r => r.status === bucket).length;
    statusDeltas[bucket] = currCount - prevCount;
  }

  // ── Leadership comparison sentence ──────────────────────────────────────
  const leadershipSentence = buildLeadershipSentence({
    newUrgent, resolvedUrgent, worsened, improved, added, removed
  });

  return {
    hasPrior: true,
    newUrgent,
    resolvedUrgent,
    worsened,
    improved,
    added,
    removed,
    unchanged,
    statusDeltas,
    leadershipSentence
  };
}

// ---------------------------------------------------------------------------
// buildLeadershipSentence
// Produces a plain-language summary suitable for forwarding to leadership.
// Follows the same style as the main leadership narrative — no emoji,
// no all-caps status names, one sentence.
// ---------------------------------------------------------------------------
function buildLeadershipSentence({ newUrgent, resolvedUrgent, worsened, improved, added, removed }) {
  const parts = [];

  if (newUrgent.length > 0)
    parts.push(`${newUrgent.length} new urgent item${newUrgent.length > 1 ? 's' : ''}`);
  if (resolvedUrgent.length > 0)
    parts.push(`${resolvedUrgent.length} previously urgent item${resolvedUrgent.length > 1 ? 's' : ''} resolved`);
  if (worsened.length > 0)
    parts.push(`${worsened.length} item${worsened.length > 1 ? 's' : ''} worsened`);
  if (improved.length > 0)
    parts.push(`${improved.length} item${improved.length > 1 ? 's' : ''} improved`);
  if (added.length > 0)
    parts.push(`${added.length} new part${added.length > 1 ? 's' : ''}`);
  if (removed.length > 0)
    parts.push(`${removed.length} part${removed.length > 1 ? 's' : ''} no longer in file`);

  if (parts.length === 0) {
    return 'No material changes since the last upload.';
  }

  return 'Since the last upload: ' + parts.join(', ') + '.';
}

module.exports = { compareRuns, STATUS_RISK };
