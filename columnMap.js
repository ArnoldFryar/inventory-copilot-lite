'use strict';

// ---------------------------------------------------------------------------
// OpsCopilot-Lite — column alias mapping
//
// ERP systems export inventory data under wildly inconsistent column names.
// This module resolves incoming CSV headers to the four canonical field names
// the analyzer expects, without requiring users to rename their file first.
//
// Design:
//   ALIASES[canonicalName] = [ordered list of known variations]
//   All variations are stored and matched lower-cased + trimmed.
//   The canonical name itself is always the first entry so the exact-match
//   fast-path falls through naturally.
//
// Resolution order per field:
//   1. Walk ALIASES[canonical] top-to-bottom.
//   2. First variation whose normalised form appears in the CSV wins.
//   3. If no variation matches → field is "missing"; server returns 422 with
//      all accepted names listed so the user knows exactly what to rename.
//
// To add a new alias: append it to the relevant array below.  No other file
// needs to change.
// ---------------------------------------------------------------------------

const ALIASES = {

  part_number: [
    // ── Canonical ──────────────────────────────────────────────────────────
    'part_number',
    // ── Common ERP / MRP variations ───────────────────────────────────────
    'part no',   'part no.',  'partno',  'part number',  'partnumber',
    'item',      'item_number', 'item no', 'item no.',  'itemnumber', 'item number',
    'material',  'material_number', 'material number', 'mat no', 'mat_no',
    'sku',
    'product',   'product_number', 'product no', 'product number',
    'component',
    'part',
    'part id',   'part_id',
  ],

  on_hand: [
    // ── Canonical ──────────────────────────────────────────────────────────
    'on_hand',
    // ── Common ERP / MRP variations ───────────────────────────────────────
    'on hand',   'onhand',
    'qty on hand', 'qty_on_hand', 'quantity on hand', 'quantity_on_hand',
    'quantity',  'qty',
    'oh',        'qoh',
    'stock',     'stock_qty',   'stock qty',   'current_stock',  'current stock',
    'inventory',
    'available', 'available_qty', 'available qty',
    'balance',   'stock_balance', 'stock balance',
    'unrestricted', 'unrestricted stock',   // SAP EWM term
    'on-hand',   'on-hand qty',
  ],

  daily_usage: [
    // ── Canonical ──────────────────────────────────────────────────────────
    'daily_usage',
    // ── Common ERP / MRP variations ───────────────────────────────────────
    'daily usage',
    'avg daily usage',  'avg_daily_usage',  'average_daily_usage', 'average daily usage',
    'usage_per_day',    'usage per day',
    'demand_per_day',   'demand per day',
    'avg_demand',       'average demand',    'avg demand',
    'daily_demand',     'daily demand',
    'consumption',      'daily_consumption', 'daily consumption',
    'adu',              // Average Daily Usage — standard DDMRP / MRP term
    'avg usage',        'average usage',
    'usage rate',       'usage_rate',
    'demand rate',      'demand_rate',
  ],

  lead_time: [
    // ── Canonical ──────────────────────────────────────────────────────────
    'lead_time',
    // ── Common ERP / MRP variations ───────────────────────────────────────
    'lead time',     'leadtime',
    'lt_days',       'lt days',   'lt',
    'replenishment_lead_time',  'replenishment lead time',
    'vendor lead time',         'vendor_lead_time',
    'supplier lead time',       'supplier_lead_time',
    'procurement_lead_time',    'procurement lead time',
    'resupply_days',            'resupply days',
    'days_to_receive',          'days to receive',
    'purchasing lead time',     'purchasing_lead_time',
    'planned lead time',        'planned_lead_time',
    'lt (days)',                'lead time (days)',
    'lead time days',
  ],

};

// ---------------------------------------------------------------------------
// resolveHeaders
// Maps raw CSV header keys to canonical field names using the alias table.
//
// Parameters:
//   rawKeys : string[]   — the header names exactly as they appear in the CSV
//
// Returns:
//   {
//     mapping : { [canonical]: rawKey }  — all resolved fields
//     aliases : { [canonical]: rawKey }  — only fields resolved via an alias
//                                          (i.e., not named exactly canonical)
//     missing : string[]                 — canonical fields with no match
//   }
//
// The caller (analyzeRows) uses `mapping` as the lookup table for every row.
// The caller (server.js) uses `missing` to return a 422 with helpful hints.
// The response includes `aliases` so the frontend can log what was remapped.
// ---------------------------------------------------------------------------
function resolveHeaders(rawKeys) {
  // Build a normalised-form → original-key lookup once for the whole batch.
  const normalised = Object.create(null);
  for (const k of rawKeys) {
    normalised[k.trim().toLowerCase()] = k;
  }

  const mapping = Object.create(null);
  const aliases  = Object.create(null);
  const missing  = [];

  for (const [canonical, variations] of Object.entries(ALIASES)) {
    let resolved   = null;
    let resolvedBy = null;

    for (const alias of variations) {
      const orig = normalised[alias];   // alias is already lower-cased
      if (orig !== undefined) {
        resolved   = orig;
        resolvedBy = alias;
        break;
      }
    }

    if (resolved !== null) {
      mapping[canonical] = resolved;
      // Record alias only when the raw header wasn't already the canonical name.
      if (resolvedBy !== canonical) {
        aliases[canonical] = resolved;   // human-readable: the raw header
      }
    } else {
      missing.push(canonical);
    }
  }

  return { mapping, aliases, missing };
}

// ---------------------------------------------------------------------------
// acceptedNames
// Returns a concise human-readable string listing accepted aliases for a
// field.  Used in 422 error messages so users know exactly what to rename.
// Shows the canonical name plus up to 8 common alternatives to keep the
// message scannable.
// ---------------------------------------------------------------------------
function acceptedNames(canonical) {
  const all = ALIASES[canonical] || [canonical];
  // Always show canonical + first 7 aliases (the most common ones).
  const shown = all.slice(0, 8);
  const rest  = all.length - shown.length;
  const list  = shown.join(', ');
  return rest > 0 ? `${list} (+ ${rest} more)` : list;
}

module.exports = { ALIASES, resolveHeaders, acceptedNames };
