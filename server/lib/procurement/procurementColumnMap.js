'use strict';

// ---------------------------------------------------------------------------
// procurementColumnMap.js — Procurement Copilot column alias mapping
//
// Mirrors the design of columnMap.js (the inventory module's alias table) but
// targets purchase-order exports instead of inventory ERP files.
//
// Common source systems covered: SAP ME21/ME2M, Oracle iProcurement, Coupa,
// Ariba, NetSuite SuiteProc, Epicor POSummary, and generic Excel/CSV exports.
//
// REQUIRED_FIELDS  — analysis cannot proceed without these
// OPTIONAL_FIELDS  — enriches scoring; parsed to null when absent
//
// Usage:
//   const { resolveHeaders, acceptedNames, REQUIRED_FIELDS } = require('./procurementColumnMap');
//   const { mapping, missing, warnings } = resolveHeaders(rawKeys);
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// ALIASES
// Each entry: canonicalName → ordered array of accepted header strings.
// All values are lower-cased; matching is case-insensitive + trimmed.
// The canonical name itself leads every list so exact-match succeeds on the
// first iteration without needing a special case.
// ---------------------------------------------------------------------------
const ALIASES = {

  // ── REQUIRED ─────────────────────────────────────────────────────────────

  po_number: [
    'po_number',
    'po number',      'po no',          'po no.',          'po #',
    'purchase order', 'purchase order number',             'purchase order no',
    'order number',   'order no',       'order no.',       'order #',
    'po_no',          'ponumber',        'doc number',     'document number',
    'doc no',         'document no',    'po ref',          'po reference',
    'purchase order ref',
  ],

  supplier: [
    'supplier',
    'supplier name',  'supplier_name',
    'vendor',         'vendor name',    'vendor_name',
    'vendor code',    'vendor_code',    'supplier code',   'supplier_code',
    'creditor',       'creditor name',  'sold by',         'source',
    'manufacturer',   'mfg',            'mfr',
    'trader',         'ship from',
  ],

  line_amount: [
    'line_amount',
    'line amount',    'line total',     'line value',
    'net value',      'net amount',     'amount',
    'extended amount','extended price', 'extended cost',
    'total amount',   'total price',    'total value',     'total cost',
    'po value',       'po amount',
    'value',          'cost',
  ],

  // ── REQUIRED (at least one date column must be present) ──────────────────

  due_date: [
    'due_date',
    'due date',       'delivery date',  'promised date',   'promise date',
    'confirmed date', 'confirm date',   'supplier confirm date',
    'eta',            'estimated arrival', 'expected delivery',
    'sched date',     'scheduled date', 'sched delivery date',
    'reschedule date','delivery scheduled date',
  ],

  need_date: [
    'need_date',
    'need date',      'need by date',   'need by',
    'required date',  'required by',    'request date',    'requested date',
    'delivery requested', 'want date',  'required delivery date',
    'must have date', 'material need date',
  ],

  // ── OPTIONAL ─────────────────────────────────────────────────────────────

  line_number: [
    'line_number',
    'line number',    'line no',        'line no.',        'line',
    'item line',      'pos',            'position',        'line_no',
    'item no',        'item number',    'po line',         'po line no',
  ],

  item_code: [
    'item_code',
    'item code',      'part number',    'part no',         'part no.',
    'part #',         'part_number',    'sku',
    'material',       'material number','material no',     'material_number',
    'item',           'item number',    'component',       'part id',
    'product',        'product number', 'product code',    'product no',
  ],

  item_description: [
    'item_description',
    'item description','description',   'desc',
    'part description','part desc',     'material description',
    'item name',      'product name',   'part name',
    'long description',
  ],

  quantity_ordered: [
    'quantity_ordered',
    'quantity ordered','qty ordered',   'order qty',       'order quantity',
    'po qty',         'qty',            'quantity',        'order_qty',
    'open qty',       'open quantity',  'remaining qty',   'balance qty',
    'balance',
    // parenthesised export variants (SAP ME2M, NetSuite)
    'qty (ordered)',  'quantity (ordered)', 'qty. (ordered)', 'ordered qty',
    'po quantity',
  ],

  quantity_received: [
    'quantity_received',
    'quantity received','qty received', 'received qty',    'qty rec',
    'received',       'goods receipt qty','gr qty',        'delivered qty',
    'delivered',      'receipt qty',    'received to date',
    // parenthesised variants
    'qty (received)', 'quantity (received)', 'qty. (received)',
  ],

  unit_price: [
    'unit_price',
    'unit price',     'price',          'net price',       'unit cost',
    'price per unit', 'cost per unit',  'unit cost',       'each',
  ],

  order_date: [
    'order_date',
    'order date',     'po date',        'creation date',   'created date',
    'document date',  'issue date',     'released date',   'placed date',
    'purchase date',  'entry date',
  ],

  buyer: [
    'buyer',
    'buyer name',     'buyer code',     'purchaser',       'procurement agent',
    'purchasing agent','purchasing agent code',             'procurement officer',
    'owner',          'requestor',      'requested by',
  ],

  plant: [
    'plant',
    'plant code',     'site',           'location',        'facility',
    'warehouse',      'ship to',        'delivery address','destination',
    'receiving location','receiving site',
  ],

  category: [
    'category',
    'spend category', 'purchase category','commodity',     'commodity code',
    'gl account desc','account',         'expense type',   'cost center',
    'cost category',  'product group',   'material group',
  ],

};

// Fields that MUST be present for analysis to proceed.
const REQUIRED_FIELDS = ['po_number', 'supplier', 'line_amount'];

// At least one date column is required.  Having neither means we cannot
// compute overdue or due-soon signals.
const DATE_FIELDS = ['due_date', 'need_date'];

// ---------------------------------------------------------------------------
// resolveHeaders
// Maps raw CSV header keys to canonical field names.
//
// Parameters:
//   rawKeys : string[]  — headers exactly as they appear in the CSV
//
// Returns:
//   {
//     mapping  : { [canonical]: rawKey }   — all resolved fields
//     aliases  : { [canonical]: rawKey }   — fields resolved via a non-canonical name
//     missing  : string[]                  — required fields with no match
//     warnings : string[]                  — non-fatal notes (e.g. no date column found)
//   }
// ---------------------------------------------------------------------------
function resolveHeaders(rawKeys) {
  // Build normalised (trimmed + lower-cased) → original key lookup.
  const normToRaw = Object.create(null);
  for (const k of rawKeys) {
    normToRaw[k.trim().toLowerCase()] = k;
  }

  const mapping  = Object.create(null);
  const aliases  = Object.create(null);
  const missing  = [];
  const warnings = [];

  for (const [canonical, variations] of Object.entries(ALIASES)) {
    let resolved   = null;
    let resolvedBy = null;

    for (const alias of variations) {
      const orig = normToRaw[alias];
      if (orig !== undefined) {
        resolved   = orig;
        resolvedBy = alias;
        break;
      }
    }

    if (resolved !== null) {
      mapping[canonical] = resolved;
      // Only record alias when the raw header wasn't already the canonical name.
      if (resolvedBy !== canonical) {
        aliases[canonical] = resolved;
      }
    } else if (REQUIRED_FIELDS.includes(canonical)) {
      missing.push(canonical);
    }
    // Optional fields that are absent are simply absent from mapping — not an error.
  }

  // Date-column check: warn (not error) if neither date field was resolved.
  const hasDateCol = DATE_FIELDS.some(function (f) { return mapping[f] !== undefined; });
  if (!hasDateCol) {
    warnings.push(
      'No delivery date column found (looked for: due_date, need_date, promise_date, etc.). ' +
      'Overdue and due-soon signals will be unavailable.'
    );
  }

  return { mapping, aliases, missing, warnings };
}

// ---------------------------------------------------------------------------
// acceptedNames
// Returns a human-readable string listing accepted aliases for a field.
// Used in 422 error messages so users know what to rename their column.
// Shows up to 8 common aliases to keep the message scannable.
// ---------------------------------------------------------------------------
function acceptedNames(canonical) {
  const all   = ALIASES[canonical] || [canonical];
  const shown = all.slice(0, 8);
  const rest  = all.length - shown.length;
  const list  = shown.join(', ');
  return rest > 0 ? `${list} (+ ${rest} more)` : list;
}

// ---------------------------------------------------------------------------
// countResolvedHeaders
// Returns the number of canonical fields resolvable from a set of raw keys.
// Used by procurementIngest.js for preamble-skip heuristics, mirroring the
// role resolveHeaders plays in csvIngest.js's findHeaderRowIndex.
// ---------------------------------------------------------------------------
function countResolvedHeaders(rawKeys) {
  const normToRaw = Object.create(null);
  for (const k of rawKeys) {
    normToRaw[k.trim().toLowerCase()] = k;
  }
  let count = 0;
  for (const variations of Object.values(ALIASES)) {
    for (const alias of variations) {
      if (normToRaw[alias] !== undefined) {
        count++;
        break;
      }
    }
  }
  return count;
}

module.exports = { ALIASES, REQUIRED_FIELDS, DATE_FIELDS, resolveHeaders, acceptedNames, countResolvedHeaders };
