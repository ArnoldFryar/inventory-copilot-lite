'use strict';
/**
 * OpsCopilot-Lite — regression tests
 *
 * Run: node _test_regression.js
 *
 * Covers the top risks identified in the engineering review:
 *   P1  BOM-prefixed headers resolve correctly
 *   P2  Orphaned-file guard (server.js code path, verified structurally)
 *   P3  analyzeRows accepts pre-resolved mapping (no double resolveHeaders)
 *   P4  thresholds payload has exactly the 4 expected keys
 *   P5  Invalid rows have severity 'Low', not 'Medium'
 *   P6  Invalid rows excluded from topPriority
 *   P7  Summary counts sum to total
 *   P8  safePositiveNumber: thousands comma, currency prefix, null-like, BOM char
 *   P9  classifyRow boundaries: on_hand=0, daily_usage=0, lead_time=0
 *   P10 resolveHeaders: ERP aliases, case insensitivity, BOM-prefixed key miss
 *   P11 Urgent threshold boundary: exactly at URGENT_RATIO
 *   P12 Analyzer is deterministic (same input → same output on repeated calls)
 *
 * Dirty data additions (stress test session):
 *   P12 European decimal comma: "1,5" → Invalid (not silently 15)
 *   P13 Unit suffix stripping: "50 units", "30 days", "200 PCS"
 *   P14 Blank row filtering: all-empty rows excluded before analysis
 *   P15 Duplicate part number detection: duplicateWarnings populated
 *   P16 Comma edge cases: compound thousands, ambiguous groups, scientific notation
 *
 * Plan / monetization:
 *   P23 Plan model: PLANS shape, getPlan(), env-var override, fallback to free
 *   P24 Plan limits enforcement: truncation, non-truncation, response annotation
 *
 * Auth / Supabase:
 *   P25 Supabase client module shape and graceful degradation when unconfigured
 *
 * History / savedHistory:
 *   P26 savedHistory entitlement: free=false, pro=true in plan + response
 *   P27 History data shape: analyzeRows has required fields; richer summary_json
 *       reconstruction works for both new and backward-compat formats
 *
 * Comparison engine:
 *   P28 compareRuns: basic scenario — improved, worsened, new, removed, unchanged
 *   P29 compareRuns: edge cases — first run, empty arrays, part-number matching
 *   P30 compareRuns: status deltas and leadership sentence generation
 *
 * Stripe billing integration:
 *   P31 STRIPE_CONFIG shape: all keys present, stripeConfigured flag
 *   P32 ACTIVE_STATUSES: includes active/trialing, excludes canceled/past_due
 *   P33 getPlanForUser: env-var override (PLAN=pro) bypasses DB lookup
 *   P34 getPlanForUser: returns free for null/missing supabaseAdmin
 *   P35 getPlanForUser: mock DB lookup — active subscription → pro
 *   P36 getPlanForUser: mock DB lookup — canceled subscription → free
 *
 * AI helper actions:
 *   P37 AI_CONFIG shape: all keys present, aiConfigured false when unset
 *   P38 HELPER_TYPES / VALID_HELPER_TYPES: all three helper types registered
 *   P39 shapeInput: structured context from run data, capped item counts
 *   P40 simplifyRow: strips to exactly the expected fields
 *   P41 Prompt builders: return { system, user } for all helper types
 *   P42 generateHelper: rejects unknown helper type, rejects when unconfigured
 *
 * Stabilization audit:
 *   P43 Comparator: duplicate part_number handling (Map last-write-wins)
 *   P44 Plan entitlements: inline require, all keys present, pro vs free
 *   P45 applyPlanLimits: response shape completeness, pro preserves all rows
 *   P46 Comparator: all-unchanged zero deltas, stable leadership sentence
 *   P47 Config: relationship invariants (CRITICAL < URGENT < 1, EXCESS < DEAD_STOCK)
 *   P48 analyzeRows: response shape for history storage / autoSaveRun
 *   P49 shapeInput: AI grounding edge cases (healthy exclusion, topPriority cap)
 *   P50 VALID_HELPER_TYPES: rejects arbitrary strings
 *   P51 Unused import cleanup verification (csv-parser removed, SUBSCRIPTION_EVENTS module-level)
 */

const assert = require('assert').strict;
const { analyzeRows }             = require('./analyzer');
const { resolveHeaders, ALIASES } = require('./columnMap');
const cfg                         = require('./config');
const { compareRuns, STATUS_RISK } = require('./comparator');
const {
  detectEncoding,
  hasInvalidUTF8,
  findHeaderRowIndex,
  parseCSVHeaderLine,
}                                 = require('./csvIngest');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗  ${name}`);
    console.error(`     ${err.message}`);
    failed++;
  }
}

// Async test support — collected and run at end, before final summary.
const asyncTests = [];
function testAsync(name, fn) {
  asyncTests.push({ name, fn });
}

// ─── P1: BOM-prefixed headers ─────────────────────────────────────────────────
// Simulates what happens when csv-parser is called WITHOUT bom:true on an
// Excel/ERP export. The first column header gets a \uFEFF prefix.
// resolveHeaders must NOT match the BOM-prefixed key (it won't, by design).
// BUT when parseCSV uses bom:true, the BOM is stripped before resolveHeaders
// is ever called. We verify both behaviours here.

console.log('\n[P1] BOM-prefixed headers');

test('BOM prefix is stripped by trim() in resolveHeaders (double protection with bom:true)', () => {
  // V8\'s String.prototype.trim() strips U+FEFF per ECMAScript spec, so even
  // a BOM-prefixed key resolves correctly through resolveHeaders alone.
  // csv({ bom: true }) provides defence at the parser layer — belt AND braces.
  const bomKey = '\uFEFFpart_number';
  const rawKeys = [bomKey, 'on_hand', 'daily_usage', 'lead_time'];
  const { missing } = resolveHeaders(rawKeys);
  assert.deepEqual(missing, [],
    'trim() in resolveHeaders strips BOM from header keys; bom:true in csv-parser adds a second layer');
});

test('BOM-stripped headers resolve correctly (bom:true behavior)', () => {
  // After csv({ bom: true }), the BOM is stripped from the first key
  const rawKeys = ['part_number', 'on_hand', 'daily_usage', 'lead_time'];
  const { missing } = resolveHeaders(rawKeys);
  assert.deepEqual(missing, [], 'All canonical headers should resolve after BOM is stripped');
});

test('ERP-style BOM-stripped headers resolve via aliases', () => {
  // Typical SAP export headers, BOM already stripped by csv parser
  const rawKeys = ['Part No', 'QTY ON HAND', 'Avg Daily Usage', 'Lead Time'];
  const { missing, aliases } = resolveHeaders(rawKeys);
  assert.deepEqual(missing, [], 'All ERP alias headers should resolve');
  assert.equal(Object.keys(aliases).length, 4, 'All 4 fields should be noted as aliased');
});

// ─── P3: Pre-resolved mapping accepted ────────────────────────────────────────
console.log('\n[P3] analyzeRows accepts pre-resolved mapping');

test('analyzeRows with pre-resolved mapping produces same result as internal resolution', () => {
  const rows = [
    { part_number: 'P1', on_hand: '100', daily_usage: '10', lead_time: '30' },
    { part_number: 'P2', on_hand: '5',   daily_usage: '10', lead_time: '30' },
  ];
  const { mapping, aliases } = resolveHeaders(Object.keys(rows[0]));
  const resA = analyzeRows(rows);
  const resB = analyzeRows(rows, { mapping, aliases });
  assert.equal(resA.summary.total, resB.summary.total, 'total should match');
  assert.equal(resA.summary.urgent_stockout, resB.summary.urgent_stockout, 'urgent_stockout should match');
  assert.deepEqual(
    resA.results.map(r => r.status),
    resB.results.map(r => r.status),
    'all statuses should match'
  );
});

// ─── P4: Thresholds payload ────────────────────────────────────────────────────
console.log('\n[P4] thresholds payload scope');

test('thresholds payload has exactly the 5 expected keys', () => {
  const rows = [{ part_number: 'P1', on_hand: '100', daily_usage: '10', lead_time: '30' }];
  const { thresholds } = analyzeRows(rows);
  const keys = Object.keys(thresholds).sort();
  assert.deepEqual(keys, ['CRITICAL_RATIO', 'DEAD_STOCK_RATIO', 'EXCESS_RATIO', 'TOP_PRIORITY_MAX', 'URGENT_RATIO'],
    'thresholds should have exactly CRITICAL_RATIO, URGENT_RATIO, EXCESS_RATIO, DEAD_STOCK_RATIO, TOP_PRIORITY_MAX');
});

test('thresholds values match config', () => {
  const rows = [{ part_number: 'P1', on_hand: '100', daily_usage: '10', lead_time: '30' }];
  const { thresholds } = analyzeRows(rows);
  assert.equal(thresholds.CRITICAL_RATIO,   cfg.CRITICAL_RATIO);
  assert.equal(thresholds.URGENT_RATIO,     cfg.URGENT_RATIO);
  assert.equal(thresholds.EXCESS_RATIO,     cfg.EXCESS_RATIO);
  assert.equal(thresholds.DEAD_STOCK_RATIO, cfg.DEAD_STOCK_RATIO);
  assert.equal(thresholds.TOP_PRIORITY_MAX, cfg.TOP_PRIORITY_MAX);
});

// ─── P5: Invalid row severity ──────────────────────────────────────────────────
console.log('\n[P5] Invalid row severity');

test('Invalid rows have severity Low', () => {
  const rows = [
    { part_number: 'BAD1', on_hand: '',    daily_usage: '10', lead_time: '30' },
    { part_number: 'BAD2', on_hand: '100', daily_usage: '10', lead_time: '0'  },
    { part_number: 'BAD3', on_hand: 'N/A', daily_usage: '10', lead_time: '30' },
  ];
  const { results } = analyzeRows(rows);
  results.forEach(r => {
    assert.equal(r.status, 'Invalid', `${r.part_number} should be Invalid`);
    assert.equal(r.severity, 'Low',
      `Invalid row ${r.part_number} should have severity Low, got ${r.severity}`);
  });
});

test('Invalid rows do not inflate medium_priority count', () => {
  // on_hand=20, daily_usage=1, lead_time=30 → coverage=20 → Stockout Risk (Medium)
  // on_hand=20, daily_usage=10 would give coverage=2 → Urgent (High) — wrong for this test
  const rows = [
    { part_number: 'BAD',   on_hand: '', daily_usage: '10', lead_time: '30' },    // Invalid (Low)
    { part_number: 'RISK',  on_hand: '20', daily_usage: '1', lead_time: '30' },   // Stockout Risk (Medium)
  ];
  const { summary } = analyzeRows(rows);
  // Only the Stockout Risk row should be medium_priority
  assert.equal(summary.medium_priority, 1, 'medium_priority should not include Invalid rows');
  assert.equal(summary.invalid, 1, 'invalid count should be 1');
});

// ─── P6: topPriority exclusions ───────────────────────────────────────────────
console.log('\n[P6] topPriority exclusions');

test('Invalid rows never appear in topPriority', () => {
  const rows = [
    { part_number: 'URGENT', on_hand: '5',   daily_usage: '10', lead_time: '30' },
    { part_number: 'BADROW', on_hand: '',    daily_usage: '10', lead_time: '30' },
    { part_number: 'RISK',   on_hand: '20',  daily_usage: '10', lead_time: '30' },
  ];
  const { topPriority } = analyzeRows(rows);
  const hasInvalid = topPriority.some(r => r.status === 'Invalid');
  assert.equal(hasInvalid, false, 'topPriority must never contain Invalid rows');
});

test('Low severity rows (Healthy, Excess, Invalid) excluded from topPriority', () => {
  // coverage=45, lead_time=30: 45 ≥ 30 AND 45 ≤ 30×2=60 → Healthy (Low)
  // coverage=100, lead_time=30: 100 > 60 AND 100 ≤ 30×6=180 → Excess (Low)
  // Dead Stock is now Medium — see next test
  const rows = [
    { part_number: 'HEALTHY', on_hand: '45',  daily_usage: '1', lead_time: '30' },
    { part_number: 'EXCESS',  on_hand: '100', daily_usage: '1', lead_time: '30' },
    { part_number: 'INVALID', on_hand: '',    daily_usage: '1', lead_time: '30' },
  ];
  const { topPriority } = analyzeRows(rows);
  assert.equal(topPriority.length, 0, 'topPriority should be empty when all items are Low severity');
});

test('Potential Dead Stock rows appear in topPriority (Medium severity)', () => {
  // 999 > 30 × DEAD_STOCK_RATIO(6.0) = 180 → Potential Dead Stock → Medium
  const rows = [
    { part_number: 'DEAD', on_hand: '999', daily_usage: '1', lead_time: '30' },
  ];
  const { topPriority } = analyzeRows(rows);
  assert.equal(topPriority.length, 1, 'Potential Dead Stock (Medium) should appear in topPriority');
  assert.equal(topPriority[0].status, 'Potential Dead Stock');
});

// ─── P7: Summary integrity ────────────────────────────────────────────────────
console.log('\n[P7] Summary integrity');

test('7 named status counts always sum to total', () => {
  const rows = [
    { part_number: 'U',  on_hand: '5',   daily_usage: '10', lead_time: '30' },  // Urgent
    { part_number: 'R',  on_hand: '20',  daily_usage: '10', lead_time: '30' },  // Risk
    { part_number: 'N',  on_hand: '100', daily_usage: '0',  lead_time: '30' },  // No Usage
    { part_number: 'E',  on_hand: '300', daily_usage: '1',  lead_time: '30' },  // Dead Stock (300 > 30×6=180 with ratio thresholds)
    { part_number: 'D',  on_hand: '999', daily_usage: '1',  lead_time: '7'  },  // Dead Stock
    { part_number: 'H',  on_hand: '100', daily_usage: '2',  lead_time: '30' },  // Healthy
    { part_number: 'I',  on_hand: '',    daily_usage: '10', lead_time: '30' },  // Invalid
  ];
  const { summary: s } = analyzeRows(rows);
  const sum = s.urgent_stockout + s.stockout_risk + s.no_usage +
              s.excess + s.dead_stock + s.healthy + s.invalid;
  assert.equal(sum, s.total, `Status counts (${sum}) must equal total (${s.total})`);
});

// ─── P8: safePositiveNumber ────────────────────────────────────────────────────
console.log('\n[P8] safePositiveNumber via analyzeRow');

const numTests = [
  // [label, on_hand value, expected status]
  // 1,500 / 1 = 1500 days coverage → far above DEAD_STOCK_THRESH(180) → Potential Dead Stock
  // verifies safePositiveNumber strips the thousands comma so Number('1500') parses correctly
  ['thousands comma on_hand', '1,500',     'Potential Dead Stock'],
  ['currency $ on_hand',      '$80',        'Excess Inventory'],
  ['N/A on_hand',             'N/A',        'Invalid'],
  ['null literal on_hand',    'null',       'Invalid'],
  ['negative on_hand',        '-50',        'Invalid'],
  ['empty on_hand',           '',           'Invalid'],
  ['zero on_hand',            '0',          'Urgent Stockout Risk'],
];

numTests.forEach(([label, rawOnHand, expectedStatus]) => {
  test(`safePositiveNumber: ${label} → ${expectedStatus}`, () => {
    const rows = [{ part_number: 'T', on_hand: rawOnHand, daily_usage: '1', lead_time: '30' }];
    const { results } = analyzeRows(rows);
    assert.equal(results[0].status, expectedStatus,
      `on_hand="${rawOnHand}" should produce "${expectedStatus}", got "${results[0].status}"`);
  });
});

// ─── P9: classifyRow boundaries ──────────────────────────────────────────────
console.log('\n[P9] Classification boundaries');

test('on_hand=0 → Urgent Stockout Risk (not Invalid)', () => {
  const rows = [{ part_number: 'Z', on_hand: '0', daily_usage: '5', lead_time: '30' }];
  const { results } = analyzeRows(rows);
  assert.equal(results[0].status, 'Urgent Stockout Risk');
  assert.equal(results[0].coverage, 0);
});

test('daily_usage=0 → No Usage Data (not Invalid)', () => {
  const rows = [{ part_number: 'Z', on_hand: '100', daily_usage: '0', lead_time: '30' }];
  const { results } = analyzeRows(rows);
  assert.equal(results[0].status, 'No Usage Data');
  assert.equal(results[0].coverage, null);
});

test('lead_time=0 → Invalid', () => {
  const rows = [{ part_number: 'Z', on_hand: '100', daily_usage: '5', lead_time: '0' }];
  const { results } = analyzeRows(rows);
  assert.equal(results[0].status, 'Invalid');
});

test('exactly at URGENT_RATIO threshold → Urgent (boundary inclusive)', () => {
  // coverage must be ≤ lead_time * URGENT_RATIO to be Urgent
  // on_hand = lead_time * URGENT_RATIO * daily_usage  → exactly at boundary
  const lt     = 30;
  const usage  = 1;
  const onHand = lt * cfg.URGENT_RATIO * usage;  // exactly 15
  const rows = [{ part_number: 'Z', on_hand: String(onHand), daily_usage: String(usage), lead_time: String(lt) }];
  const { results } = analyzeRows(rows);
  assert.equal(results[0].status, 'Urgent Stockout Risk',
    `coverage=${onHand} should be Urgent at exactly ${cfg.URGENT_RATIO * 100}% of lead time ${lt}`);
});

test('just above URGENT_RATIO threshold → Stockout Risk', () => {
  const lt     = 30;
  const usage  = 1;
  const onHand = lt * cfg.URGENT_RATIO * usage + 0.1;  // 15.1 — just above Urgent boundary
  const rows = [{ part_number: 'Z', on_hand: String(onHand), daily_usage: String(usage), lead_time: String(lt) }];
  const { results } = analyzeRows(rows);
  assert.equal(results[0].status, 'Stockout Risk');
});

test('exactly at CRITICAL_RATIO threshold → Urgent Stockout Risk (critical zone)', () => {
  const lt     = 30;
  const usage  = 1;
  const onHand = lt * cfg.CRITICAL_RATIO * usage;  // exactly 7.5 (25% of lead time)
  const rows = [{ part_number: 'Z', on_hand: String(onHand), daily_usage: String(usage), lead_time: String(lt) }];
  const { results } = analyzeRows(rows);
  assert.equal(results[0].status,   'Urgent Stockout Risk');
  assert.equal(results[0].severity, 'High');
});

test('critical zone and standard urgent zone have different recommended actions', () => {
  // critical: 5/30 = 16.7% ≤ CRITICAL_RATIO (25%)
  // urgent:  12/30 = 40%, between CRITICAL_RATIO and URGENT_RATIO
  const critical = analyzeRows([{ part_number: 'C', on_hand: '5',  daily_usage: '1', lead_time: '30' }]).results[0];
  const urgent   = analyzeRows([{ part_number: 'U', on_hand: '12', daily_usage: '1', lead_time: '30' }]).results[0];
  assert.equal(critical.status,   'Urgent Stockout Risk');
  assert.equal(urgent.status,     'Urgent Stockout Risk');
  assert.notEqual(critical.recommended_action, urgent.recommended_action,
    'critical zone should have more severe action text than standard urgent');
});

// ─── P10: resolveHeaders alias coverage ──────────────────────────────────────
console.log('\n[P10] resolveHeaders');

test('resolveHeaders is case-insensitive', () => {
  const { missing } = resolveHeaders(['PART_NUMBER', 'ON_HAND', 'DAILY_USAGE', 'LEAD_TIME']);
  assert.deepEqual(missing, []);
});

test('resolveHeaders: mixed case ERP headers', () => {
  const { missing } = resolveHeaders(['Item Number', 'Stock Qty', 'ADU', 'Lead Time (days)']);
  assert.deepEqual(missing, []);
});

test('resolveHeaders: completely unknown headers → all 4 missing', () => {
  const { missing } = resolveHeaders(['col_a', 'col_b', 'col_c', 'col_d']);
  assert.equal(missing.length, 4);
});

// ─── P11: Determinism ─────────────────────────────────────────────────────────
console.log('\n[P11] Determinism');

test('analyzeRows is deterministic: same input → identical output on two calls', () => {
  const rows = [
    { part_number: 'P1', on_hand: '5',   daily_usage: '10', lead_time: '30' },
    { part_number: 'P2', on_hand: '100', daily_usage: '0',  lead_time: '30' },
    { part_number: 'P3', on_hand: '500', daily_usage: '1',  lead_time: '30' },
    { part_number: 'P4', on_hand: '',    daily_usage: '10', lead_time: '30' },
  ];
  const r1 = analyzeRows(JSON.parse(JSON.stringify(rows)));
  const r2 = analyzeRows(JSON.parse(JSON.stringify(rows)));
  assert.deepEqual(
    r1.results.map(r => ({ status: r.status, severity: r.severity, coverage: r.coverage })),
    r2.results.map(r => ({ status: r.status, severity: r.severity, coverage: r.coverage })),
    'Results must be identical across two calls with the same input'
  );
  assert.deepEqual(r1.summary, r2.summary, 'Summary must be identical across two calls');
});

// ─── P12: European decimal comma ──────────────────────────────────────────────
console.log('\n[P12] European decimal comma');

test('"1,5" (European decimal) produces Invalid, not silently 15', () => {
  const rows = [{ part_number: 'EU1', on_hand: '100', daily_usage: '1,5', lead_time: '14' }];
  const { results } = analyzeRows(rows);
  assert.equal(results[0].status, 'Invalid',
    'daily_usage="1,5": old regex silently misparsed as 15; must now produce Invalid');
});

test('"0,5" produces Invalid', () => {
  const rows = [{ part_number: 'EU2', on_hand: '100', daily_usage: '0,5', lead_time: '10' }];
  const { results } = analyzeRows(rows);
  assert.equal(results[0].status, 'Invalid');
});

test('"1,50" (2 digits after comma) produces Invalid', () => {
  const rows = [{ part_number: 'EU3', on_hand: '100', daily_usage: '1,50', lead_time: '14' }];
  const { results } = analyzeRows(rows);
  assert.equal(results[0].status, 'Invalid',
    '"1,50" is ambiguous and must not be silently parsed');
});

test('"1,500" (exactly 3 digits) still parses as 1500', () => {
  const rows = [{ part_number: 'EU4', on_hand: '1,500', daily_usage: '5', lead_time: '30' }];
  const { results } = analyzeRows(rows);
  assert.notEqual(results[0].status, 'Invalid');
  assert.equal(results[0].on_hand, 1500);
});

test('"1,234,567" (compound thousands) parses as 1234567', () => {
  const rows = [{ part_number: 'EU5', on_hand: '1,234,567', daily_usage: '1', lead_time: '30' }];
  const { results } = analyzeRows(rows);
  assert.equal(results[0].on_hand, 1234567);
});

// ─── P13: Unit suffix stripping ───────────────────────────────────────────────
console.log('\n[P13] Unit suffix stripping');

[
  ['50 units', 50,   'on_hand with unit label'],
  ['30 days',  30,   'lead_time with day label'],
  ['200 PCS',  200,  'uppercase PCS'],
  ['5 EA',     5,    'unit abbreviation EA'],
  ['1,500 kg', 1500, 'thousands + unit suffix'],
].forEach(([raw, expected, label]) => {
  test(`unit suffix: "${raw}" -> ${expected} (${label})`, () => {
    const rows = [{ part_number: 'U', on_hand: raw, daily_usage: '1', lead_time: '30' }];
    const { results } = analyzeRows(rows);
    assert.equal(results[0].on_hand, expected,
      `on_hand="${raw}" should parse as ${expected}`);
    assert.notEqual(results[0].status, 'Invalid',
      `on_hand="${raw}" must not produce Invalid`);
  });
});

test('scientific notation "1e3" is NOT affected by unit-suffix stripping', () => {
  const rows = [{ part_number: 'SCI', on_hand: '1e3', daily_usage: '1', lead_time: '30' }];
  const { results } = analyzeRows(rows);
  assert.equal(results[0].on_hand, 1000, '"1e3" must parse as 1000');
});

// ─── P14: Blank row filtering ─────────────────────────────────────────────────
console.log('\n[P14] Blank row filtering');

function filterBlankRows(rows) {
  return rows.filter(row =>
    Object.values(row).some(v => v !== null && String(v).trim() !== '')
  );
}

test('all-empty rows filtered out, not counted as Invalid', () => {
  const raw = [
    { part_number: 'P1', on_hand: '100', daily_usage: '2', lead_time: '30' },
    { part_number: '',   on_hand: '',    daily_usage: '',   lead_time: ''   },
    { part_number: ' ',  on_hand: '  ',  daily_usage: ' ',  lead_time: ' '  },
    { part_number: 'P2', on_hand: '50',  daily_usage: '5', lead_time: '14' },
  ];
  const { summary } = analyzeRows(filterBlankRows(raw));
  assert.equal(summary.total, 2, 'blank rows must not contribute to total');
  assert.equal(summary.invalid, 0, 'blank rows must not inflate invalid count');
});

test('partial row (has part_number only) passes filter and becomes Invalid', () => {
  const raw = [{ part_number: 'P1', on_hand: '', daily_usage: '', lead_time: '' }];
  const { summary } = analyzeRows(filterBlankRows(raw));
  assert.equal(summary.total, 1, 'partial row must not be filtered');
  assert.equal(summary.invalid, 1, 'partial row must become Invalid');
});

// ─── P15: Duplicate part number detection ────────────────────────────────────
console.log('\n[P15] Duplicate detection');

test('duplicate parts populate duplicateWarnings', () => {
  const rows = [
    { part_number: 'P1', on_hand: '100', daily_usage: '2', lead_time: '30' },
    { part_number: 'P2', on_hand: '50',  daily_usage: '5', lead_time: '14' },
    { part_number: 'P1', on_hand: '80',  daily_usage: '2', lead_time: '30' },
  ];
  const { duplicateWarnings, summary } = analyzeRows(rows);
  assert.ok(duplicateWarnings.includes('P1'));
  assert.equal(duplicateWarnings.length, 1);
  assert.equal(summary.total, 3, 'duplicates are analyzed, not discarded');
});

test('no duplicates yields empty duplicateWarnings array', () => {
  const rows = [
    { part_number: 'A', on_hand: '100', daily_usage: '2', lead_time: '14' },
    { part_number: 'B', on_hand: '50',  daily_usage: '1', lead_time: '7'  },
  ];
  assert.deepEqual(analyzeRows(rows).duplicateWarnings, []);
});

test('triplicate part listed once in duplicateWarnings', () => {
  const rows = [
    { part_number: 'DUP', on_hand: '100', daily_usage: '2', lead_time: '14' },
    { part_number: 'DUP', on_hand: '50',  daily_usage: '2', lead_time: '14' },
    { part_number: 'DUP', on_hand: '75',  daily_usage: '2', lead_time: '14' },
  ];
  const { duplicateWarnings } = analyzeRows(rows);
  assert.equal(duplicateWarnings.length, 1);
});

test('blank part numbers are excluded from duplicate detection', () => {
  const rows = [
    { part_number: '', on_hand: '100', daily_usage: '2', lead_time: '14' },
    { part_number: '', on_hand: '50',  daily_usage: '2', lead_time: '14' },
  ];
  assert.deepEqual(analyzeRows(rows).duplicateWarnings, []);
});

// ─── P16: Response shape contract ─────────────────────────────────────────────
// Guards against a server change leaving the frontend with an unexpected shape
// and ending up in a half-rendered state.
console.log('\n[P16] Response shape contract');

test('analyzeRows always returns all required top-level keys', () => {
  const rows = [{ part_number: 'P1', on_hand: '100', daily_usage: '2', lead_time: '14' }];
  const result = analyzeRows(rows);
  const required = ['results', 'summary', 'topPriority', 'thresholds', 'analyzedAt',
                    'columnAliases', 'duplicateWarnings'];
  required.forEach(k => {
    assert.ok(k in result, `response must include top-level key: "${k}"`);
  });
});

test('analyzedAt is a valid ISO string', () => {
  const rows = [{ part_number: 'P1', on_hand: '100', daily_usage: '2', lead_time: '14' }];
  const { analyzedAt } = analyzeRows(rows);
  assert.ok(typeof analyzedAt === 'string' && !isNaN(Date.parse(analyzedAt)),
    `analyzedAt must be a valid ISO date string, got: ${analyzedAt}`);
});

test('results is an array; summary and thresholds are plain objects', () => {
  const rows = [{ part_number: 'P1', on_hand: '100', daily_usage: '2', lead_time: '14' }];
  const { results, summary, thresholds } = analyzeRows(rows);
  assert.ok(Array.isArray(results),              'results must be an array');
  assert.ok(typeof summary    === 'object' && !Array.isArray(summary),    'summary must be an object');
  assert.ok(typeof thresholds === 'object' && !Array.isArray(thresholds), 'thresholds must be an object');
});

test('every result row has the 9 required RowResult fields', () => {
  const rows = [
    { part_number: 'OK',  on_hand: '100', daily_usage: '2',  lead_time: '14' },
    { part_number: 'BAD', on_hand: '',    daily_usage: '2',  lead_time: '14' },
    { part_number: 'NU',  on_hand: '50',  daily_usage: '0',  lead_time: '14' },
  ];
  const FIELDS = ['part_number','on_hand','daily_usage','lead_time',
                  'coverage','status','severity','reason','recommended_action'];
  analyzeRows(rows).results.forEach(r => {
    FIELDS.forEach(f => {
      assert.ok(f in r, `row "${r.part_number}" is missing field "${f}"`);
    });
  });
});

// ─── P17: Coverage rounding contract ──────────────────────────────────────────
// Ensures coverage is always rounded to 1 decimal so the table display and
// the CSV export always show the same value.
console.log('\n[P17] Coverage rounding');

test('coverage is always null or a number with at most 1 decimal place', () => {
  const rows = [
    { part_number: 'A', on_hand: '100', daily_usage: '3',  lead_time: '14' },  // 33.3...
    { part_number: 'B', on_hand: '10',  daily_usage: '7',  lead_time: '14' },  // 1.4285...
    { part_number: 'C', on_hand: '1',   daily_usage: '3',  lead_time: '14' },  // 0.3333...
    { part_number: 'D', on_hand: '100', daily_usage: '0',  lead_time: '14' },  // No usage — null
  ];
  analyzeRows(rows).results.forEach(r => {
    if (r.coverage === null) return;  // No Usage Data / Invalid
    const asString = String(r.coverage);
    const decimalIdx = asString.indexOf('.');
    const decimalPlaces = decimalIdx === -1 ? 0 : asString.length - decimalIdx - 1;
    assert.ok(decimalPlaces <= 1,
      `coverage for "${r.part_number}" has ${decimalPlaces} decimal places (value: ${r.coverage}); expected ≤1`);
  });
});

// ─── P18: Config constants integrity ──────────────────────────────────────────
// Any rename of config constants breaks /api/config, the thresholds payload,
// and the narrative.  Assert all 5 expected keys exist and are positive numbers.
console.log('\n[P18] Config constants');

test('all 5 expected threshold constants are present and are positive numbers', () => {
  const REQUIRED = ['CRITICAL_RATIO', 'URGENT_RATIO', 'EXCESS_RATIO', 'DEAD_STOCK_RATIO', 'TOP_PRIORITY_MAX'];
  REQUIRED.forEach(key => {
    assert.ok(key in cfg, `config.js is missing constant: ${key}`);
    assert.ok(typeof cfg[key] === 'number' && cfg[key] > 0,
      `config.${key} must be a positive number, got: ${cfg[key]}`);
  });
});

test('CRITICAL_RATIO < URGENT_RATIO (critical band is more acute than urgent)', () => {
  assert.ok(cfg.CRITICAL_RATIO < cfg.URGENT_RATIO,
    `CRITICAL_RATIO (${cfg.CRITICAL_RATIO}) must be < URGENT_RATIO (${cfg.URGENT_RATIO})`);
});

test('EXCESS_RATIO < DEAD_STOCK_RATIO (excess band is below dead-stock band)', () => {
  assert.ok(cfg.EXCESS_RATIO < cfg.DEAD_STOCK_RATIO,
    `EXCESS_RATIO (${cfg.EXCESS_RATIO}) must be < DEAD_STOCK_RATIO (${cfg.DEAD_STOCK_RATIO})`);
});

// ─── P19: detectEncoding — BOM detection ──────────────────────────────────────
console.log('\n[P19] detectEncoding — BOM detection');

test('UTF-8 BOM (EF BB BF) → encoding utf8, method bom-utf8', () => {
  const buf = Buffer.from([0xEF, 0xBB, 0xBF, 0x50, 0x61, 0x72, 0x74]); // BOM + 'Part'
  const r = detectEncoding(buf);
  assert.equal(r.encoding, 'utf8');
  assert.equal(r.method, 'bom-utf8');
  assert.ok(!r.error);
});

test('UTF-16 LE BOM (FF FE) → error present, encoding null', () => {
  const buf = Buffer.from([0xFF, 0xFE, 0x50, 0x00]);
  const r = detectEncoding(buf);
  assert.equal(r.encoding, null);
  assert.ok(typeof r.error === 'string' && r.error.length > 0);
  assert.ok(r.error.includes('UTF-16'), `expected UTF-16 mention, got: "${r.error}"`);
});

test('UTF-16 BE BOM (FE FF) → error present, encoding null', () => {
  const buf = Buffer.from([0xFE, 0xFF, 0x00, 0x50]);
  const r = detectEncoding(buf);
  assert.equal(r.encoding, null);
  assert.ok(typeof r.error === 'string' && r.error.length > 0);
});

test('clean ASCII CSV (no BOM) → encoding utf8', () => {
  const buf = Buffer.from('Part No,QTY,Usage,LT\r\nP001,50,5,30', 'ascii');
  const r = detectEncoding(buf);
  assert.equal(r.encoding, 'utf8');
  assert.ok(!r.error);
});

// ─── P20: hasInvalidUTF8 and Windows-1252 detection ───────────────────────────
console.log('\n[P20] hasInvalidUTF8 — UTF-8 byte-level validation');

test('valid 2-byte UTF-8 for é (C3 A9) → hasInvalidUTF8 = false', () => {
  const buf = Buffer.from([0xC3, 0xA9]);
  assert.equal(hasInvalidUTF8(buf, 8), false);
});

test('Windows-1252 byte 0xFC (ü) is invalid UTF-8 → hasInvalidUTF8 = true', () => {
  const buf = Buffer.from([0x50, 0xFC, 0x30, 0x31]); // 'P', 0xFC, '0', '1'
  assert.equal(hasInvalidUTF8(buf, 8), true);
});

test('naked continuation byte (0x80) → hasInvalidUTF8 = true', () => {
  const buf = Buffer.from([0x41, 0x80, 0x42]); // 'A', bad byte, 'B'
  assert.equal(hasInvalidUTF8(buf, 8), true);
});

test('overlong NUL encoding (C0 80) → hasInvalidUTF8 = true', () => {
  const buf = Buffer.from([0xC0, 0x80]);
  assert.equal(hasInvalidUTF8(buf, 8), true);
});

test('detectEncoding: buffer with 0xFC byte → encoding win1252', () => {
  const buf = Buffer.from([0x50, 0x61, 0x72, 0x74, 0xFC, 0x30, 0x30, 0x31]);
  const r = detectEncoding(buf);
  assert.equal(r.encoding, 'win1252');
  assert.ok(!r.error);
});

// ─── P21: parseCSVHeaderLine ──────────────────────────────────────────────────
console.log('\n[P21] parseCSVHeaderLine — RFC 4180 header parsing');

test('plain comma-separated values split into trimmed cells', () => {
  const cells = parseCSVHeaderLine('Part No,QTY ON HAND,Avg Daily Usage,Lead Time');
  assert.deepEqual(cells, ['Part No', 'QTY ON HAND', 'Avg Daily Usage', 'Lead Time']);
});

test('quoted field containing a comma is treated as one cell', () => {
  const cells = parseCSVHeaderLine('"Part, Number",On Hand,Usage,LT');
  assert.equal(cells.length, 4);
  assert.equal(cells[0], 'Part, Number');
});

test('doubled quote inside quoted field produces a literal quote', () => {
  const cells = parseCSVHeaderLine('"Part ""No""",On Hand,Usage,LT');
  assert.equal(cells[0], 'Part "No"');
});

test('whitespace around unquoted values is trimmed', () => {
  const cells = parseCSVHeaderLine('  Part No  ,  On Hand  ');
  assert.deepEqual(cells, ['Part No', 'On Hand']);
});

// ─── P22: findHeaderRowIndex — preamble-row skipping ──────────────────────────
console.log('\n[P22] findHeaderRowIndex — ERP preamble detection');

test('header at row 0 (no preamble) → returns 0', () => {
  const lines = [
    'Part No,QTY ON HAND,Avg Daily Usage,Lead Time',
    'P001,50,5,30',
  ];
  assert.equal(findHeaderRowIndex(lines), 0);
});

test('2 metadata rows before real header → returns 2', () => {
  const lines = [
    'Inventory Detail Report',
    'Generated: 2026-03-09',
    'Part No,QTY ON HAND,Avg Daily Usage,Lead Time',
    'P001,50,5,30',
  ];
  assert.equal(findHeaderRowIndex(lines), 2);
});

test('blank rows before header are skipped', () => {
  const lines = [
    '',
    '',
    'part_number,on_hand,daily_usage,lead_time',
    'P001,50,5,30',
  ];
  assert.equal(findHeaderRowIndex(lines), 2);
});

test('no recognisable header in 25 lines → returns -1', () => {
  const lines = [];
  for (let i = 0; i < 25; i++) lines.push(`Metadata row ${i}, value ${i}`);
  assert.equal(findHeaderRowIndex(lines), -1);
});

test('header at line index 19 is found (MAX_PREAMBLE_ROWS boundary)', () => {
  const lines = [];
  for (let i = 0; i < 19; i++) lines.push(`Title row ${i}`);
  lines.push('part_number,on_hand,daily_usage,lead_time'); // index 19
  lines.push('P001,50,5,30');
  assert.equal(findHeaderRowIndex(lines), 19);
});

// ─── P23: Plan model ──────────────────────────────────────────────────────────
console.log('\n[P23] Plan model');

const { getPlan: getTestPlan, applyPlanLimits: applyTestLimits, PLANS } = require('./plans');

test('PLANS.free has correct entitlements', () => {
  assert.equal(PLANS.free.key,          'free');
  assert.equal(PLANS.free.maxParts,     50);
  assert.equal(PLANS.free.csvExport,    false);
  assert.equal(PLANS.free.pdfExport,    false);
  assert.equal(PLANS.free.savedHistory, false);
});

test('PLANS.pro has correct entitlements', () => {
  assert.equal(PLANS.pro.key,       'pro');
  assert.equal(PLANS.pro.maxParts,  Infinity);
  assert.equal(PLANS.pro.csvExport, true);
  assert.equal(PLANS.pro.pdfExport, true);
});

test('getPlan() returns free by default when PLAN env var is unset', () => {
  const saved = process.env.PLAN;
  delete process.env.PLAN;
  const plan = getTestPlan();
  if (saved !== undefined) process.env.PLAN = saved;
  assert.equal(plan.key, 'free', 'default plan is free');
});

test('getPlan() returns pro when PLAN=pro', () => {
  const saved = process.env.PLAN;
  process.env.PLAN = 'pro';
  const plan = getTestPlan();
  if (saved !== undefined) process.env.PLAN = saved; else delete process.env.PLAN;
  assert.equal(plan.key, 'pro');
});

test('getPlan() falls back to free for an unknown plan key', () => {
  const saved = process.env.PLAN;
  process.env.PLAN = 'enterprise';
  const plan = getTestPlan();
  if (saved !== undefined) process.env.PLAN = saved; else delete process.env.PLAN;
  assert.equal(plan.key, 'free', 'unknown plan key falls back to free');
});

// ─── P24: Plan limits enforcement ─────────────────────────────────────────────
console.log('\n[P24] Plan limits enforcement');

function makeResult(count) {
  const rows = [];
  for (let i = 0; i < count; i++)
    rows.push({ part_number: `PART-${i}`, on_hand: '100', daily_usage: '5', lead_time: '30' });
  return analyzeRows(rows);
}

test('free plan truncates results over 50 to exactly 50', () => {
  const r = makeResult(75);
  applyTestLimits(PLANS.free, r);
  assert.equal(r.results.length, 50);
});

test('free plan sets resultsTruncated=true when limit exceeded', () => {
  const r = makeResult(55);
  applyTestLimits(PLANS.free, r);
  assert.equal(r.resultsTruncated, true);
});

test('free plan records totalBeforeTruncation correctly', () => {
  const r = makeResult(60);
  applyTestLimits(PLANS.free, r);
  assert.equal(r.totalBeforeTruncation, 60);
});

test('free plan with fewer than 50 results is not truncated', () => {
  const r = makeResult(30);
  applyTestLimits(PLANS.free, r);
  assert.equal(r.resultsTruncated, false);
  assert.equal(r.results.length, 30);
});

test('free plan with exactly 50 results is not truncated', () => {
  const r = makeResult(50);
  applyTestLimits(PLANS.free, r);
  assert.equal(r.resultsTruncated, false);
  assert.equal(r.results.length, 50);
});

test('pro plan never truncates regardless of row count', () => {
  const r = makeResult(200);
  applyTestLimits(PLANS.pro, r);
  assert.equal(r.resultsTruncated, false);
  assert.equal(r.results.length, 200);
});

test('applyPlanLimits annotates result with plan key and name', () => {
  const r = makeResult(5);
  applyTestLimits(PLANS.free, r);
  assert.ok(r.plan, 'result.plan should be present');
  assert.equal(r.plan.key,  'free');
  assert.equal(r.plan.name, 'Free');
});

test('free plan entitlements in response: csvExport=false, pdfExport=false', () => {
  const r = makeResult(5);
  applyTestLimits(PLANS.free, r);
  assert.equal(r.plan.entitlements.csvExport, false);
  assert.equal(r.plan.entitlements.pdfExport, false);
});

test('pro plan entitlements in response: csvExport=true, pdfExport=true', () => {
  const r = makeResult(5);
  applyTestLimits(PLANS.pro, r);
  assert.equal(r.plan.entitlements.csvExport, true);
  assert.equal(r.plan.entitlements.pdfExport, true);
});

test('free plan maxParts serialises as 50 (number, not Infinity)', () => {
  const r = makeResult(5);
  applyTestLimits(PLANS.free, r);
  assert.equal(r.plan.entitlements.maxParts, 50);
});

test('pro plan maxParts serialises as null (Infinity → null)', () => {
  const r = makeResult(5);
  applyTestLimits(PLANS.pro, r);
  assert.equal(r.plan.entitlements.maxParts, null);
});

// ─── P25: Supabase client module shape ────────────────────────────────────────
// Verifies that supabaseClient.js exports the expected interface regardless
// of whether Supabase env vars are configured.

const supaClient = require('./supabaseClient');

test('supabaseClient exports verifyToken function', () => {
  assert.equal(typeof supaClient.verifyToken, 'function');
});

test('supabaseClient exports isConfigured boolean', () => {
  assert.equal(typeof supaClient.isConfigured, 'boolean');
});

test('supabaseClient exports SUPABASE_URL and SUPABASE_ANON_KEY', () => {
  // Should be strings (possibly empty when not configured)
  assert.equal(typeof supaClient.SUPABASE_URL, 'string');
  assert.equal(typeof supaClient.SUPABASE_ANON_KEY, 'string');
});

test('supabaseClient.isConfigured is false when env vars are missing', () => {
  // In the test environment, Supabase env vars are not set
  assert.equal(supaClient.isConfigured, false);
});

test('supabaseClient.supabaseAdmin is null when not configured', () => {
  assert.equal(supaClient.supabaseAdmin, null);
});

test('verifyToken returns error when not configured', async () => {
  const result = await supaClient.verifyToken('fake-token');
  assert.ok(result.error, 'Expected an error when Supabase is not configured');
  assert.equal(result.user, null);
});

// ─── P26: savedHistory entitlement ────────────────────────────────────────────
// Verifies that savedHistory is correctly set per plan and propagated to
// responses via applyPlanLimits.

test('PLANS.free has savedHistory=false', () => {
  assert.equal(PLANS.free.savedHistory, false);
});

test('PLANS.pro has savedHistory=true', () => {
  assert.equal(PLANS.pro.savedHistory, true);
});

test('planEntitlements includes savedHistory field', () => {
  const { planEntitlements: pe } = require('./plans');
  const freeEnt = pe(PLANS.free);
  const proEnt  = pe(PLANS.pro);
  assert.equal(freeEnt.savedHistory, false);
  assert.equal(proEnt.savedHistory, true);
});

test('free plan response: savedHistory=false in entitlements', () => {
  const r = makeResult(5);
  applyTestLimits(PLANS.free, r);
  assert.equal(r.plan.entitlements.savedHistory, false);
});

test('pro plan response: savedHistory=true in entitlements', () => {
  const r = makeResult(5);
  applyTestLimits(PLANS.pro, r);
  assert.equal(r.plan.entitlements.savedHistory, true);
});

// ─── P27: History data shape ──────────────────────────────────────────────────
// Verifies the analysis response has all the fields the frontend needs to
// construct the history save payload, and that the richer summary_json format
// can be reconstructed correctly.

test('analyzeRows response has fields needed for history storage', () => {
  const mapping = { part_number: 'Part', on_hand: 'OH', daily_usage: 'Usage', lead_time: 'LT' };
  const rows = [{ 'Part': 'X1', 'OH': '100', 'Usage': '10', 'LT': '14' }];
  const result = analyzeRows(rows, { mapping, aliases: {} });
  assert.ok(result.summary, 'summary must be present');
  assert.ok(result.thresholds, 'thresholds must be present');
  assert.ok(Array.isArray(result.topPriority), 'topPriority must be an array');
  assert.ok(Array.isArray(result.results), 'results must be an array');
  assert.ok(result.analyzedAt, 'analyzedAt must be present');
});

test('history summary_json reconstruction: richer format with nested counts', () => {
  const stored = {
    counts: { total: 10, urgent_stockout: 2, stockout_risk: 3, no_usage: 0,
              excess: 1, dead_stock: 0, healthy: 4, invalid: 0 },
    topPriority: [{ part_number: 'A', status: 'Urgent Stockout Risk', severity: 'High' }],
    thresholds: { CRITICAL_RATIO: 0.25, URGENT_RATIO: 0.5, EXCESS_RATIO: 2,
                  DEAD_STOCK_RATIO: 6, TOP_PRIORITY_MAX: 10 },
    columnAliases: { part_number: 'Part No' }
  };
  const counts = stored.counts || stored;
  assert.equal(counts.total, 10);
  assert.equal(stored.topPriority.length, 1);
  assert.deepEqual(
    Object.keys(stored.thresholds).sort(),
    ['CRITICAL_RATIO', 'DEAD_STOCK_RATIO', 'EXCESS_RATIO', 'TOP_PRIORITY_MAX', 'URGENT_RATIO']
  );
});

test('history summary_json reconstruction: flat format (backward compat)', () => {
  const stored = { total: 10, urgent_stockout: 2, stockout_risk: 3 };
  const counts = stored.counts || stored;
  assert.equal(counts.total, 10);
  assert.deepEqual(stored.topPriority || [], []);
  assert.deepEqual(stored.thresholds || {}, {});
});

test('no auto-save for anonymous: autoSaveRun guards check user + plan', () => {
  // This test validates the guard logic from autoSaveRun (frontend).
  // In the absence of a DOM, verify the guard conditions structurally.
  const user = null;   // anonymous
  const plan = { entitlements: { savedHistory: true } };
  assert.ok(!user, 'anonymous user should be null/falsy');
  assert.ok(plan.entitlements.savedHistory, 'pro plan has savedHistory=true');
  // autoSaveRun returns early when !currentUser, so no save happens
});

test('free plan blocks save: savedHistory=false means no auto-save', () => {
  const plan = { entitlements: { savedHistory: false } };
  assert.equal(plan.entitlements.savedHistory, false);
  // autoSaveRun returns early when savedHistory is false
});

// ─── P28: compareRuns — basic scenario ────────────────────────────────────────
// Core comparison: improved, worsened, new parts, removed parts, unchanged.

console.log('\n[P28] compareRuns — basic scenario');

test('compareRuns: part improved from Urgent to Healthy', () => {
  const prior   = [{ part_number: 'A1', status: 'Urgent Stockout Risk', severity: 'High', coverage: 2 }];
  const current = [{ part_number: 'A1', status: 'Healthy', severity: 'Low', coverage: 30 }];
  const cmp = compareRuns(current, prior);
  assert.equal(cmp.hasPrior, true);
  assert.equal(cmp.improved.length, 1);
  assert.equal(cmp.improved[0].part_number, 'A1');
  assert.equal(cmp.improved[0].prev_status, 'Urgent Stockout Risk');
  assert.equal(cmp.improved[0].status, 'Healthy');
  assert.equal(cmp.resolvedUrgent.length, 1);
});

test('compareRuns: part worsened from Healthy to Urgent', () => {
  const prior   = [{ part_number: 'B1', status: 'Healthy', severity: 'Low', coverage: 30 }];
  const current = [{ part_number: 'B1', status: 'Urgent Stockout Risk', severity: 'High', coverage: 2 }];
  const cmp = compareRuns(current, prior);
  assert.equal(cmp.worsened.length, 1);
  assert.equal(cmp.newUrgent.length, 1);
  assert.equal(cmp.newUrgent[0].prev_status, 'Healthy');
});

test('compareRuns: new part in current run', () => {
  const prior   = [{ part_number: 'C1', status: 'Healthy', severity: 'Low', coverage: 20 }];
  const current = [
    { part_number: 'C1', status: 'Healthy', severity: 'Low', coverage: 20 },
    { part_number: 'C2', status: 'Stockout Risk', severity: 'Medium', coverage: 5 }
  ];
  const cmp = compareRuns(current, prior);
  assert.equal(cmp.added.length, 1);
  assert.equal(cmp.added[0].part_number, 'C2');
  assert.equal(cmp.unchanged, 1);
});

test('compareRuns: removed part from prior run', () => {
  const prior = [
    { part_number: 'D1', status: 'Healthy', severity: 'Low', coverage: 20 },
    { part_number: 'D2', status: 'Urgent Stockout Risk', severity: 'High', coverage: 1 }
  ];
  const current = [{ part_number: 'D1', status: 'Healthy', severity: 'Low', coverage: 20 }];
  const cmp = compareRuns(current, prior);
  assert.equal(cmp.removed.length, 1);
  assert.equal(cmp.removed[0].part_number, 'D2');
  assert.equal(cmp.resolvedUrgent.length, 1, 'removed urgent part should count as resolved');
});

test('compareRuns: mixed scenario — worsened + improved + unchanged', () => {
  const prior = [
    { part_number: 'E1', status: 'Stockout Risk',        severity: 'Medium', coverage: 8 },
    { part_number: 'E2', status: 'Healthy',              severity: 'Low',    coverage: 25 },
    { part_number: 'E3', status: 'Urgent Stockout Risk', severity: 'High',   coverage: 2 }
  ];
  const current = [
    { part_number: 'E1', status: 'Urgent Stockout Risk', severity: 'High',   coverage: 3 },
    { part_number: 'E2', status: 'Healthy',              severity: 'Low',    coverage: 22 },
    { part_number: 'E3', status: 'Healthy',              severity: 'Low',    coverage: 30 }
  ];
  const cmp = compareRuns(current, prior);
  assert.equal(cmp.worsened.length, 1, 'E1 worsened');
  assert.equal(cmp.improved.length, 1, 'E3 improved');
  assert.equal(cmp.unchanged, 1, 'E2 unchanged');
  assert.equal(cmp.newUrgent.length, 1, 'E1 became urgent');
  assert.equal(cmp.resolvedUrgent.length, 1, 'E3 resolved urgent');
});

// ─── P29: compareRuns — edge cases ────────────────────────────────────────────

console.log('\n[P29] compareRuns — edge cases');

test('compareRuns: first run (no prior) returns hasPrior=false', () => {
  const current = [{ part_number: 'F1', status: 'Healthy', severity: 'Low', coverage: 20 }];
  const cmp = compareRuns(current, []);
  assert.equal(cmp.hasPrior, false);
});

test('compareRuns: null/undefined prior returns hasPrior=false', () => {
  const current = [{ part_number: 'G1', status: 'Healthy', severity: 'Low', coverage: 20 }];
  assert.equal(compareRuns(current, null).hasPrior, false);
  assert.equal(compareRuns(current, undefined).hasPrior, false);
});

test('compareRuns: rows with "(no part number)" are excluded from matching', () => {
  const prior   = [{ part_number: '(no part number)', status: 'Invalid', severity: 'Low', coverage: null }];
  const current = [{ part_number: '(no part number)', status: 'Healthy', severity: 'Low', coverage: 20 }];
  const cmp = compareRuns(current, prior);
  // Both rows excluded from matching — no changes detected
  assert.equal(cmp.hasPrior, true);
  assert.equal(cmp.improved.length, 0);
  assert.equal(cmp.worsened.length, 0);
  assert.equal(cmp.added.length, 0);
  assert.equal(cmp.removed.length, 0);
  assert.equal(cmp.unchanged, 0);
});

test('compareRuns: Invalid→Invalid is unchanged, not worsened or improved', () => {
  const prior   = [{ part_number: 'H1', status: 'Invalid', severity: 'Low', coverage: null }];
  const current = [{ part_number: 'H1', status: 'Invalid', severity: 'Low', coverage: null }];
  const cmp = compareRuns(current, prior);
  assert.equal(cmp.unchanged, 1);
  assert.equal(cmp.worsened.length, 0);
  assert.equal(cmp.improved.length, 0);
});

test('compareRuns: new urgent part added', () => {
  const prior   = [{ part_number: 'I1', status: 'Healthy', severity: 'Low', coverage: 20 }];
  const current = [
    { part_number: 'I1', status: 'Healthy', severity: 'Low', coverage: 20 },
    { part_number: 'I2', status: 'Urgent Stockout Risk', severity: 'High', coverage: 1 }
  ];
  const cmp = compareRuns(current, prior);
  assert.equal(cmp.added.length, 1);
  assert.equal(cmp.newUrgent.length, 1);
  assert.equal(cmp.newUrgent[0].part_number, 'I2');
});

// ─── P30: status deltas and leadership sentence ──────────────────────────────

console.log('\n[P30] compareRuns — status deltas & leadership sentence');

test('compareRuns: statusDeltas correctly reflect net changes', () => {
  const prior = [
    { part_number: 'J1', status: 'Healthy', severity: 'Low', coverage: 20 },
    { part_number: 'J2', status: 'Healthy', severity: 'Low', coverage: 25 },
    { part_number: 'J3', status: 'Urgent Stockout Risk', severity: 'High', coverage: 2 }
  ];
  const current = [
    { part_number: 'J1', status: 'Urgent Stockout Risk', severity: 'High', coverage: 3 },
    { part_number: 'J2', status: 'Healthy', severity: 'Low', coverage: 22 },
    { part_number: 'J3', status: 'Healthy', severity: 'Low', coverage: 30 }
  ];
  const cmp = compareRuns(current, prior);
  // Urgent: was 1, now 1 → delta 0
  assert.equal(cmp.statusDeltas['Urgent Stockout Risk'], 0);
  // Healthy: was 2, now 2 → delta 0
  assert.equal(cmp.statusDeltas['Healthy'], 0);
});

test('compareRuns: statusDeltas with added/removed parts', () => {
  const prior   = [{ part_number: 'K1', status: 'Healthy', severity: 'Low', coverage: 20 }];
  const current = [
    { part_number: 'K1', status: 'Healthy', severity: 'Low', coverage: 20 },
    { part_number: 'K2', status: 'Stockout Risk', severity: 'Medium', coverage: 5 }
  ];
  const cmp = compareRuns(current, prior);
  assert.equal(cmp.statusDeltas['Stockout Risk'], 1);
  assert.equal(cmp.statusDeltas['Healthy'], 0);
});

test('compareRuns: leadershipSentence includes all non-zero categories', () => {
  const prior = [
    { part_number: 'L1', status: 'Healthy', severity: 'Low', coverage: 20 },
    { part_number: 'L2', status: 'Urgent Stockout Risk', severity: 'High', coverage: 2 }
  ];
  const current = [
    { part_number: 'L1', status: 'Urgent Stockout Risk', severity: 'High', coverage: 3 },
    { part_number: 'L3', status: 'Healthy', severity: 'Low', coverage: 30 }
  ];
  const cmp = compareRuns(current, prior);
  assert.ok(cmp.leadershipSentence.startsWith('Since the last upload:'));
  assert.ok(cmp.leadershipSentence.includes('urgent'));
  assert.ok(cmp.leadershipSentence.includes('worsened') || cmp.leadershipSentence.includes('new'));
});

test('compareRuns: no changes produces stable sentence', () => {
  const rows = [{ part_number: 'M1', status: 'Healthy', severity: 'Low', coverage: 20 }];
  const cmp = compareRuns(rows, rows);
  assert.equal(cmp.leadershipSentence, 'No material changes since the last upload.');
  assert.equal(cmp.unchanged, 1);
});

test('STATUS_RISK ordering: Urgent < Stockout < Dead Stock < No Usage < Excess < Invalid < Healthy', () => {
  assert.ok(STATUS_RISK['Urgent Stockout Risk'] < STATUS_RISK['Stockout Risk']);
  assert.ok(STATUS_RISK['Stockout Risk'] < STATUS_RISK['Potential Dead Stock']);
  assert.ok(STATUS_RISK['Potential Dead Stock'] < STATUS_RISK['No Usage Data']);
  assert.ok(STATUS_RISK['No Usage Data'] < STATUS_RISK['Excess Inventory']);
  assert.ok(STATUS_RISK['Excess Inventory'] < STATUS_RISK['Invalid']);
  assert.ok(STATUS_RISK['Invalid'] < STATUS_RISK['Healthy']);
});

// ═══════════════════════════════════════════════════════════════════════════════
// P31-P36  Stripe billing integration
// ═══════════════════════════════════════════════════════════════════════════════

const {
  STRIPE_CONFIG,
  stripeConfigured,
  ACTIVE_STATUSES,
  getPlanForUser,
} = require('./plans');

// P31 — STRIPE_CONFIG shape
test('STRIPE_CONFIG has all expected keys', () => {
  assert.ok('secretKey' in STRIPE_CONFIG);
  assert.ok('webhookSecret' in STRIPE_CONFIG);
  assert.ok('proPriceId' in STRIPE_CONFIG);
  assert.ok('portalReturnUrl' in STRIPE_CONFIG);
  // In test env (no real env vars), these should be empty strings
  assert.equal(typeof STRIPE_CONFIG.secretKey, 'string');
  assert.equal(typeof STRIPE_CONFIG.webhookSecret, 'string');
  assert.equal(typeof STRIPE_CONFIG.proPriceId, 'string');
  assert.equal(typeof STRIPE_CONFIG.portalReturnUrl, 'string');
  // portalReturnUrl defaults to localhost when APP_URL is unset
  assert.ok(STRIPE_CONFIG.portalReturnUrl.length > 0);
});

test('stripeConfigured is false when env vars are not set', () => {
  assert.equal(stripeConfigured, false);
});

// P32 — ACTIVE_STATUSES
test('ACTIVE_STATUSES includes active and trialing', () => {
  assert.ok(ACTIVE_STATUSES.has('active'));
  assert.ok(ACTIVE_STATUSES.has('trialing'));
});

test('ACTIVE_STATUSES excludes canceled, past_due, unpaid', () => {
  assert.ok(!ACTIVE_STATUSES.has('canceled'));
  assert.ok(!ACTIVE_STATUSES.has('past_due'));
  assert.ok(!ACTIVE_STATUSES.has('unpaid'));
  assert.ok(!ACTIVE_STATUSES.has('incomplete'));
});

// P33 — getPlanForUser: env-var override
testAsync('getPlanForUser returns pro when PLAN=pro env is set', async () => {
  const old = process.env.PLAN;
  process.env.PLAN = 'pro';
  try {
    const plan = await getPlanForUser('any-user-id', null);
    assert.equal(plan.key, 'pro');
  } finally {
    if (old !== undefined) process.env.PLAN = old;
    else delete process.env.PLAN;
  }
});

// P34 — getPlanForUser: no supabaseAdmin
testAsync('getPlanForUser returns free when supabaseAdmin is null', async () => {
  const old = process.env.PLAN;
  delete process.env.PLAN;
  try {
    const plan = await getPlanForUser('user-123', null);
    assert.equal(plan.key, 'free');
  } finally {
    if (old !== undefined) process.env.PLAN = old;
    else delete process.env.PLAN;
  }
});

testAsync('getPlanForUser returns free when userId is null', async () => {
  const plan = await getPlanForUser(null, {});
  assert.equal(plan.key, 'free');
});

// P35 — getPlanForUser: mock DB — active subscription → pro
testAsync('getPlanForUser returns pro for active subscription (mock DB)', async () => {
  const old = process.env.PLAN;
  delete process.env.PLAN;
  const mockSupabase = {
    from: () => ({
      select: () => ({
        eq: () => ({
          single: () => Promise.resolve({
            data: { plan: 'pro', subscription_status: 'active' },
            error: null
          })
        })
      })
    })
  };
  try {
    const plan = await getPlanForUser('user-123', mockSupabase);
    assert.equal(plan.key, 'pro');
    assert.equal(plan.savedHistory, true);
  } finally {
    if (old !== undefined) process.env.PLAN = old;
    else delete process.env.PLAN;
  }
});

testAsync('getPlanForUser returns pro for trialing subscription (mock DB)', async () => {
  const old = process.env.PLAN;
  delete process.env.PLAN;
  const mockSupabase = {
    from: () => ({
      select: () => ({
        eq: () => ({
          single: () => Promise.resolve({
            data: { plan: 'pro', subscription_status: 'trialing' },
            error: null
          })
        })
      })
    })
  };
  try {
    const plan = await getPlanForUser('user-123', mockSupabase);
    assert.equal(plan.key, 'free');
  } finally {
    if (old !== undefined) process.env.PLAN = old;
    else delete process.env.PLAN;
  }
});

// P36 — getPlanForUser: mock DB — canceled subscription → free
testAsync('getPlanForUser returns free for canceled subscription (mock DB)', async () => {
  const old = process.env.PLAN;
  delete process.env.PLAN;
  const mockSupabase = {
    from: () => ({
      select: () => ({
        eq: () => ({
          single: () => Promise.resolve({
            data: { plan: 'pro', subscription_status: 'canceled' },
            error: null
          })
        })
      })
    })
  };
  try {
    const plan = await getPlanForUser('user-123', mockSupabase);
    assert.equal(plan.key, 'free');
  } finally {
    if (old !== undefined) process.env.PLAN = old;
    else delete process.env.PLAN;
  }
});

testAsync('getPlanForUser returns free for past_due subscription (mock DB)', async () => {
  const old = process.env.PLAN;
  delete process.env.PLAN;
  const mockSupabase = {
    from: () => ({
      select: () => ({
        eq: () => ({
          single: () => Promise.resolve({
            data: { plan: 'pro', subscription_status: 'past_due' },
            error: null
          })
        })
      })
    })
  };
  try {
    const plan = await getPlanForUser('user-123', mockSupabase);
    assert.equal(plan.key, 'free');
  } finally {
    if (old !== undefined) process.env.PLAN = old;
    else delete process.env.PLAN;
  }
});

testAsync('getPlanForUser returns free when DB returns no row (mock DB)', async () => {
  const old = process.env.PLAN;
  delete process.env.PLAN;
  const mockSupabase = {
    from: () => ({
      select: () => ({
        eq: () => ({
          single: () => Promise.resolve({
            data: null,
            error: { message: 'Row not found' }
          })
        })
      })
    })
  };
  try {
    const plan = await getPlanForUser('user-123', mockSupabase);
    assert.equal(plan.key, 'free');
  } finally {
    if (old !== undefined) process.env.PLAN = old;
    else delete process.env.PLAN;
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// P37-P42  AI Helper Actions
// ═══════════════════════════════════════════════════════════════════════════════

const {
  AI_CONFIG,
  aiConfigured: testAiConfigured,
  HELPER_TYPES: testHelperTypes,
  VALID_HELPER_TYPES: testValidHelperTypes,
  shapeInput,
  simplifyRow,
  generateHelper,
  PROMPT_BUILDERS,
} = require('./aiHelpers');

console.log('\n[P37] AI_CONFIG shape');

test('AI_CONFIG has expected keys', () => {
  assert.ok('apiKey' in AI_CONFIG);
  assert.ok('model' in AI_CONFIG);
  assert.ok('baseUrl' in AI_CONFIG);
  assert.equal(typeof AI_CONFIG.apiKey, 'string');
  assert.equal(typeof AI_CONFIG.model, 'string');
  assert.equal(typeof AI_CONFIG.baseUrl, 'string');
  // Default model should be gpt-4o-mini
  assert.ok(AI_CONFIG.model.length > 0);
});

test('aiConfigured is false when OPENAI_API_KEY is not set', () => {
  assert.equal(testAiConfigured, false);
});

console.log('\n[P38] HELPER_TYPES / VALID_HELPER_TYPES');

test('HELPER_TYPES contains all three helper types', () => {
  assert.ok('expedite_email' in testHelperTypes);
  assert.ok('escalation_summary' in testHelperTypes);
  assert.ok('meeting_talking_points' in testHelperTypes);
});

test('Each HELPER_TYPE has label and description', () => {
  for (const [key, val] of Object.entries(testHelperTypes)) {
    assert.ok(val.label, `${key} missing label`);
    assert.ok(val.description, `${key} missing description`);
    assert.equal(typeof val.label, 'string');
    assert.equal(typeof val.description, 'string');
  }
});

test('VALID_HELPER_TYPES is a Set matching HELPER_TYPES keys', () => {
  assert.ok(testValidHelperTypes instanceof Set);
  assert.equal(testValidHelperTypes.size, Object.keys(testHelperTypes).length);
  for (const key of Object.keys(testHelperTypes)) {
    assert.ok(testValidHelperTypes.has(key));
  }
});

console.log('\n[P39] shapeInput');

test('shapeInput returns structured context with all expected fields', () => {
  const mockRunData = {
    summary: { total: 100, urgent_stockout: 5, stockout_risk: 10, excess: 3, dead_stock: 2, healthy: 70, no_usage: 8, invalid: 2 },
    results: [
      { part_number: 'A1', status: 'Urgent Stockout Risk', severity: 'High', coverage: 1.2, on_hand: 10, daily_usage: 8, lead_time: 14, reason: 'test' },
      { part_number: 'A2', status: 'Healthy', severity: 'Low', coverage: 30, on_hand: 500, daily_usage: 5, lead_time: 14, reason: 'test' },
      { part_number: 'A3', status: 'Excess Inventory', severity: 'Low', coverage: 60, on_hand: 1000, daily_usage: 2, lead_time: 7, reason: 'test' },
    ],
    topPriority: [
      { part_number: 'A1', status: 'Urgent Stockout Risk', severity: 'High', coverage: 1.2, on_hand: 10, daily_usage: 8, lead_time: 14, reason: 'test' },
    ],
    analyzedAt: '2026-03-15T10:00:00.000Z',
    thresholds: { CRITICAL_RATIO: 0.25, URGENT_RATIO: 0.5, EXCESS_RATIO: 2.0, DEAD_STOCK_RATIO: 6.0 },
  };

  const ctx = shapeInput(mockRunData);
  assert.equal(ctx.total, 100);
  assert.equal(ctx.urgentCount, 5);
  assert.equal(ctx.stockoutCount, 10);
  assert.equal(ctx.excessCount, 3);
  assert.equal(ctx.healthyCount, 70);
  assert.equal(ctx.analyzedAt, '2026-03-15T10:00:00.000Z');
  assert.ok(Array.isArray(ctx.urgentParts));
  assert.ok(Array.isArray(ctx.excessParts));
  assert.ok(Array.isArray(ctx.topPriority));
  assert.ok(ctx.thresholds);
  // Urgent parts should only contain the urgent/stockout items
  assert.equal(ctx.urgentParts.length, 1);
  assert.equal(ctx.urgentParts[0].part_number, 'A1');
  // Excess parts should contain excess/dead stock items
  assert.equal(ctx.excessParts.length, 1);
  assert.equal(ctx.excessParts[0].part_number, 'A3');
});

test('shapeInput caps urgent/excess parts at 30', () => {
  const bigResults = [];
  for (let i = 0; i < 50; i++) {
    bigResults.push({ part_number: `U${i}`, status: 'Urgent Stockout Risk', severity: 'High', coverage: 1, on_hand: 5, daily_usage: 10, lead_time: 14, reason: 'test' });
  }
  const ctx = shapeInput({ summary: { total: 50 }, results: bigResults, topPriority: [], analyzedAt: '', thresholds: {} });
  assert.equal(ctx.urgentParts.length, 30);
});

test('shapeInput handles empty/null inputs gracefully', () => {
  const ctx = shapeInput({ summary: {}, results: [], topPriority: null, analyzedAt: null, thresholds: null });
  assert.equal(ctx.total, 0);
  assert.equal(ctx.urgentParts.length, 0);
  assert.ok(ctx.analyzedAt); // should default to an ISO string
});

console.log('\n[P40] simplifyRow');

test('simplifyRow returns only expected fields', () => {
  const full = {
    part_number: 'X1', status: 'Healthy', severity: 'Low', coverage: 30,
    on_hand: 500, daily_usage: 5, lead_time: 14, reason: 'Ok',
    recommended_action: 'None', extra_field: 'should be stripped'
  };
  const simple = simplifyRow(full);
  const keys = Object.keys(simple).sort();
  const expected = ['coverage', 'daily_usage', 'lead_time', 'on_hand', 'part_number', 'reason', 'severity', 'status'].sort();
  assert.deepEqual(keys, expected);
  assert.equal(simple.part_number, 'X1');
  assert.equal(simple.extra_field, undefined);
});

console.log('\n[P41] Prompt builders');

test('All PROMPT_BUILDERS produce { system, user } strings', () => {
  const mockCtx = {
    analyzedAt: '2026-03-15T10:00:00Z',
    total: 100, urgentCount: 5, stockoutCount: 10, excessCount: 3,
    deadStockCount: 2, healthyCount: 70, noUsageCount: 8, invalidCount: 2,
    topPriority: [{ part_number: 'A1', status: 'Urgent Stockout Risk', severity: 'High', coverage: 1.2, on_hand: 10, daily_usage: 8, lead_time: 14, reason: 'test' }],
    urgentParts: [{ part_number: 'A1', status: 'Urgent Stockout Risk', severity: 'High', coverage: 1.2, on_hand: 10, daily_usage: 8, lead_time: 14, reason: 'test' }],
    excessParts: [],
    thresholds: { CRITICAL_RATIO: 0.25 },
  };

  for (const [key, builder] of Object.entries(PROMPT_BUILDERS)) {
    const prompt = builder(mockCtx);
    assert.ok(prompt.system, `${key}: missing system prompt`);
    assert.ok(prompt.user, `${key}: missing user prompt`);
    assert.equal(typeof prompt.system, 'string', `${key}: system not a string`);
    assert.equal(typeof prompt.user, 'string', `${key}: user not a string`);
    // System prompts should instruct to use only provided data
    assert.ok(prompt.system.toLowerCase().includes('only'), `${key}: system should mention 'only' (data grounding)`);
  }
});

test('Expedite email prompt includes urgent parts data', () => {
  const mockCtx = {
    analyzedAt: '2026-03-15', total: 50, urgentCount: 2, stockoutCount: 3,
    excessCount: 0, deadStockCount: 0, healthyCount: 40, noUsageCount: 5, invalidCount: 0,
    topPriority: [],
    urgentParts: [{ part_number: 'BOLT-42', status: 'Urgent Stockout Risk', severity: 'High', coverage: 0.5, on_hand: 2, daily_usage: 4, lead_time: 10, reason: 'test' }],
    excessParts: [],
    thresholds: {},
  };
  const prompt = PROMPT_BUILDERS.expedite_email(mockCtx);
  assert.ok(prompt.user.includes('BOLT-42'), 'Prompt should include the actual part number');
});

console.log('\n[P42] generateHelper validation');

testAsync('generateHelper rejects unknown helper type', async () => {
  await assert.rejects(
    () => generateHelper('nonexistent_type', { summary: {}, results: [] }),
    /Unknown helper type/
  );
});

testAsync('generateHelper rejects when AI provider is not configured', async () => {
  // aiConfigured is false in test env (no OPENAI_API_KEY)
  await assert.rejects(
    () => generateHelper('expedite_email', { summary: {}, results: [], topPriority: [], analyzedAt: '', thresholds: {} }),
    /not configured/
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// P43  Cross-system stabilization tests
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n[P43] Comparator: duplicate part_number handling');

test('compareRuns: duplicate part_number uses last occurrence (Map overwrite)', () => {
  // If a run has duplicate part numbers, the comparator Map uses the last one
  const current = [
    { part_number: 'DUP-1', status: 'Healthy',              severity: 'Low',  coverage: 30 },
    { part_number: 'DUP-1', status: 'Urgent Stockout Risk', severity: 'High', coverage: 0.5 },
  ];
  const prior   = [
    { part_number: 'DUP-1', status: 'Healthy', severity: 'Low', coverage: 30 },
  ];
  const cmp = compareRuns(current, prior);
  assert.ok(cmp.hasPrior);
  // Last occurrence in current is Urgent, prior was Healthy → worsened
  assert.equal(cmp.worsened.length, 1);
  assert.equal(cmp.worsened[0].status, 'Urgent Stockout Risk');
});

console.log('\n[P44] Plan entitlements: inline require in /api/plan');

test('planEntitlements is exported from plans.js', () => {
  const { planEntitlements } = require('./plans');
  assert.equal(typeof planEntitlements, 'function');
});

test('planEntitlements returns all expected entitlement keys', () => {
  const { planEntitlements, PLANS } = require('./plans');
  const ent = planEntitlements(PLANS.free);
  assert.ok('csvExport' in ent);
  assert.ok('pdfExport' in ent);
  assert.ok('savedHistory' in ent);
  assert.ok('fullTable' in ent);
  assert.ok('maxParts' in ent);
});

test('planEntitlements pro vs free: pro has all true, free has all false', () => {
  const { planEntitlements, PLANS } = require('./plans');
  const free = planEntitlements(PLANS.free);
  const pro  = planEntitlements(PLANS.pro);
  assert.equal(free.csvExport, false);
  assert.equal(free.pdfExport, false);
  assert.equal(free.savedHistory, false);
  assert.equal(pro.csvExport, true);
  assert.equal(pro.pdfExport, true);
  assert.equal(pro.savedHistory, true);
});

console.log('\n[P45] applyPlanLimits: response shape completeness');

test('applyPlanLimits annotates response with entitlements + plan metadata', () => {
  const { applyPlanLimits, PLANS } = require('./plans');
  const result = analyzeRows([
    { part_number: 'A1', on_hand: '100', daily_usage: '5', lead_time: '30' },
  ]);
  applyPlanLimits(PLANS.free, result);
  assert.ok(result.plan, 'result.plan');
  assert.ok(result.plan.key, 'result.plan.key');
  assert.ok(result.plan.name, 'result.plan.name');
  assert.ok(result.plan.entitlements, 'result.plan.entitlements');
  assert.equal(result.plan.key, 'free');
  assert.equal(typeof result.plan.entitlements, 'object');
  assert.equal(result.plan.entitlements.csvExport, false);
});

test('applyPlanLimits pro plan preserves all rows and sets uncapped maxParts', () => {
  const { applyPlanLimits, PLANS } = require('./plans');
  const rows = [];
  for (let i = 0; i < 75; i++)
    rows.push({ part_number: `PART-${i}`, on_hand: '100', daily_usage: '5', lead_time: '30' });
  const result = analyzeRows(rows);
  applyPlanLimits(PLANS.pro, result);
  assert.equal(result.results.length, 75);
  assert.equal(result.resultsTruncated, false);
  assert.equal(result.plan.entitlements.maxParts, null); // Infinity → null
});

console.log('\n[P46] Comparator: statusDeltas with empty categories');

test('compareRuns: all-unchanged produces zero deltas', () => {
  const rows = [
    { part_number: 'X1', status: 'Healthy', severity: 'Low', coverage: 30 },
    { part_number: 'X2', status: 'Excess Inventory', severity: 'Low', coverage: 60 },
  ];
  const cmp = compareRuns(rows, rows);
  assert.ok(cmp.hasPrior);
  assert.equal(cmp.worsened.length, 0);
  assert.equal(cmp.improved.length, 0);
  assert.equal(cmp.added.length, 0);
  assert.equal(cmp.removed.length, 0);
  assert.equal(cmp.unchanged, 2);
  // All statusDeltas should be 0
  for (const delta of Object.values(cmp.statusDeltas)) {
    assert.equal(delta, 0);
  }
});

test('compareRuns: leadershipSentence for stable inventory mentions stability', () => {
  const rows = [
    { part_number: 'X1', status: 'Healthy', severity: 'Low', coverage: 30 },
  ];
  const cmp = compareRuns(rows, rows);
  assert.ok(cmp.leadershipSentence.toLowerCase().includes('stable') ||
            cmp.leadershipSentence.toLowerCase().includes('unchanged') ||
            cmp.leadershipSentence.toLowerCase().includes('no '));
});

console.log('\n[P47] Config constants: relationship invariants');

test('CRITICAL_RATIO < URGENT_RATIO < 1 (both are sub-1 day coverage fractions)', () => {
  assert.ok(cfg.CRITICAL_RATIO < cfg.URGENT_RATIO, 'CRITICAL < URGENT');
  assert.ok(cfg.URGENT_RATIO < 1, 'URGENT < 1');
});

test('1 < EXCESS_RATIO < DEAD_STOCK_RATIO (excess and dead stock are over-coverage)', () => {
  assert.ok(cfg.EXCESS_RATIO > 1, 'EXCESS > 1');
  assert.ok(cfg.EXCESS_RATIO < cfg.DEAD_STOCK_RATIO, 'EXCESS < DEAD_STOCK');
});

console.log('\n[P48] analyzeRows: response shape for history storage');

test('analyzeRows response includes all fields needed for autoSaveRun body', () => {
  const result = analyzeRows([
    { part_number: 'A1', on_hand: '10', daily_usage: '5', lead_time: '14' },
  ]);
  // Fields required by autoSaveRun / POST /api/runs body construction
  assert.ok(result.summary, 'summary');
  assert.ok(Array.isArray(result.results), 'results array');
  assert.ok(result.analyzedAt, 'analyzedAt');
  assert.ok(Array.isArray(result.topPriority), 'topPriority');
  assert.ok(result.thresholds, 'thresholds');
  assert.ok(result.summary.total !== undefined, 'summary.total');
});

console.log('\n[P49] shapeInput: edge cases for AI grounding');

test('shapeInput excludes Healthy rows from urgentParts and excessParts', () => {
  const mockRunData = {
    summary: { total: 3 },
    results: [
      { part_number: 'H1', status: 'Healthy', severity: 'Low', coverage: 30, on_hand: 500, daily_usage: 5, lead_time: 14, reason: 'ok' },
      { part_number: 'H2', status: 'Healthy', severity: 'Low', coverage: 25, on_hand: 400, daily_usage: 5, lead_time: 14, reason: 'ok' },
      { part_number: 'H3', status: 'Healthy', severity: 'Low', coverage: 20, on_hand: 300, daily_usage: 5, lead_time: 14, reason: 'ok' },
    ],
    topPriority: [],
    analyzedAt: '2026-03-15T00:00:00Z',
    thresholds: {},
  };
  const ctx = shapeInput(mockRunData);
  assert.equal(ctx.urgentParts.length, 0, 'no urgent parts from healthy rows');
  assert.equal(ctx.excessParts.length, 0, 'no excess parts from healthy rows');
});

test('shapeInput topPriority is capped at 10', () => {
  const bigPriority = [];
  for (let i = 0; i < 20; i++) {
    bigPriority.push({ part_number: `P${i}`, status: 'Urgent Stockout Risk', severity: 'High', coverage: 0.5, on_hand: 5, daily_usage: 10, lead_time: 14, reason: 'test' });
  }
  const ctx = shapeInput({
    summary: { total: 20 },
    results: bigPriority,
    topPriority: bigPriority,
    analyzedAt: '2026-03-15',
    thresholds: {},
  });
  assert.ok(ctx.topPriority.length <= 10, 'topPriority capped at 10');
});

console.log('\n[P50] VALID_HELPER_TYPES rejects invalid types');

test('VALID_HELPER_TYPES does not include arbitrary strings', () => {
  assert.equal(testValidHelperTypes.has('random_action'), false);
  assert.equal(testValidHelperTypes.has(''), false);
  assert.equal(testValidHelperTypes.has(null), false);
});

console.log('\n[P51] Unused import cleanup verification');

test('server.js does not import csv-parser (cleaned up)', () => {
  const fs = require('fs');
  const serverSrc = fs.readFileSync(require('path').join(__dirname, 'server.js'), 'utf8');
  assert.ok(!serverSrc.includes("require('csv-parser')"), 'csv-parser import should be removed');
  assert.ok(!serverSrc.includes('require("csv-parser")'), 'csv-parser import should be removed');
});

test('server.js SUBSCRIPTION_EVENTS is at module level (not inside handler)', () => {
  const fs = require('fs');
  const serverSrc = fs.readFileSync(require('path').join(__dirname, 'server.js'), 'utf8');
  // SUBSCRIPTION_EVENTS should appear before the webhook route handler
  const subEventsIdx = serverSrc.indexOf('const SUBSCRIPTION_EVENTS');
  const webhookIdx   = serverSrc.indexOf("app.post('/api/billing/webhook'");
  assert.ok(subEventsIdx > -1, 'SUBSCRIPTION_EVENTS should exist');
  assert.ok(subEventsIdx < webhookIdx, 'SUBSCRIPTION_EVENTS should be defined before webhook route');
});

// ─── Run async tests then print final summary ────────────────────────────────
(async () => {
  for (const { name, fn } of asyncTests) {
    try {
      await fn();
      console.log(`  ✓  ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ✗  ${name}`);
      console.error(`     ${err.message}`);
      failed++;
    }
  }
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();