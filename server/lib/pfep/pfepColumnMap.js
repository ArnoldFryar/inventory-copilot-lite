'use strict';

// ---------------------------------------------------------------------------
// server/lib/pfep/pfepColumnMap.js — PFEP CSV column alias mapping.
//
// Covers common PFEP export formats from Excel-based PFEP templates, SAP MM,
// Oracle Inventory, Epicor, NetSuite, and generic operations spreadsheets.
//
// Usage:
//   const { resolveHeaders, REQUIRED_FIELDS } = require('./pfepColumnMap');
//   const { mapping, missing, warnings } = resolveHeaders(rawKeys);
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// ALIASES
// canonicalName → ordered array of accepted header strings (lower-cased).
// ---------------------------------------------------------------------------
const ALIASES = {

  // ── REQUIRED ─────────────────────────────────────────────────────────────

  part_number: [
    'part_number',
    'part number',      'part no',          'part no.',         'part #',
    'item number',      'item no',          'item no.',         'item code',
    'sku',              'material',         'material number',  'material no',
    'component',        'product number',   'product code',     'product no',
    'part id',          'component number', 'drawing number',   'drawing no',
  ],

  // ── OPTIONAL ─────────────────────────────────────────────────────────────

  part_description: [
    'part_description',
    'part description', 'description',      'desc',
    'item description', 'part name',        'component description',
    'material description', 'product description',
  ],

  commodity_class: [
    'commodity_class',
    'commodity class',  'commodity',        'commodity code',
    'commodity group',  'part family',      'part class',
    'item class',       'category',         'item category',
    'product group',    'product family',
  ],

  abc_class: [
    'abc_class',
    'abc class',        'abc',              'abc code',
    'abc classification', 'abc category',   'abc tier',
    'velocity class',   'velocity',         'abc ranking',
  ],

  supplier: [
    'supplier',
    'supplier name',    'supplier_name',
    'primary supplier', 'preferred supplier',
    'vendor',           'vendor name',      'vendor_name',
    'source',           'manufacturer',     'mfg',
  ],

  secondary_supplier: [
    'secondary_supplier',
    'secondary supplier', 'alternate supplier', 'alt supplier',
    'backup supplier',   'second source',    '2nd supplier',
    'alternate vendor',  'alt vendor',       'supplier 2',
    'vendor 2',          'fallback supplier',
  ],

  supplier_part_number: [
    'supplier_part_number',
    'supplier part number', 'supplier part no', 'vendor part number',
    'vendor part no',       'mfg part number',  'manufacturer part no',
    'cross reference',      'xref',             'alternate part no',
  ],

  replenishment_method: [
    'replenishment_method',
    'replenishment method', 'repl method',      'replenishment type',
    'replen type',          'replen method',    'planning method',
    'supply method',        'order type',       'supply type',
  ],

  lead_time_days: [
    'lead_time_days',
    'lead time days',   'lead time',        'lead time (days)',
    'lt days',          'lt',               'supplier lead time',
    'purchase lead time', 'procurement lead time', 'standard lead time',
    'avg lead time',    'average lead time',
  ],

  reorder_point: [
    'reorder_point',
    'reorder point',    'rop',              're-order point',
    'order point',      'safety stock',     'safety_stock',
    'min inventory',    'trigger point',    'reorder level',
    'reorder qty',      'order trigger',
  ],

  min_qty: [
    'min_qty',
    'min qty',          'min quantity',     'minimum quantity',
    'min order qty',    'moq',              'minimum order qty',
    'min',              'minimum',          'min inventory',
  ],

  max_qty: [
    'max_qty',
    'max qty',          'max quantity',     'maximum quantity',
    'max on hand',      'max inventory',    'max',
    'maximum',          'max stock',        'max level',
  ],

  pack_multiple: [
    'pack_multiple',
    'pack multiple',    'pack mult',        'packing multiple',
    'order multiple',   'order mult',       'lot multiple',
    'lot size multiple', 'rounding factor', 'multiple',
    'increment',        'order increment',
  ],

  standard_pack: [
    'standard_pack',
    'standard pack',    'std pack',         'standard package',
    'package size',     'pkg size',         'pack size',
    'std pack qty',     'supplier pack',    'carton qty',
  ],

  unit_of_measure: [
    'unit_of_measure',
    'unit of measure',  'uom',              'unit',
    'u/m',              'measure',          'um',
    'units',            'qty unit',         'quantity unit',
  ],

  unit_cost: [
    'unit_cost',
    'unit cost',        'std cost',         'standard cost',
    'unit price',       'cost',             'price',
    'purchase price',   'avg cost',         'standard price',
    'item cost',
  ],

  annual_usage: [
    'annual_usage',
    'annual usage',     'annual demand',    'yearly demand',
    'annual qty',       'annual quantity',  'annual consumption',
    'usage per year',   'demand per year',  'annual volume',
    'forecast qty',     'annual forecast',
  ],

  point_of_use: [
    'point_of_use',
    'point of use',     'pou',              'location',
    'bin location',     'bin',              'storage location',
    'cell',             'line',             'work cell',
    'work center',      'production area',  'use location',
  ],

  plant: [
    'plant',
    'plant code',       'facility',         'site',
    'site code',        'location code',    'mfg plant',
    'factory',          'division',
  ],

  notes: [
    'notes',
    'note',             'comments',         'comment',
    'remarks',          'remark',           'memo',
  ],
};

// ---------------------------------------------------------------------------
// REQUIRED_FIELDS
// Analysis hard-fails if none of these resolve.  Just part_number is enough
// to import a register — all other fields enrich but don't block parsing.
// ---------------------------------------------------------------------------
const REQUIRED_FIELDS = new Set(['part_number']);

// ---------------------------------------------------------------------------
// acceptedNames — flat set used for O(1) "is this a known header?" checks.
// ---------------------------------------------------------------------------
const acceptedNames = new Set(
  Object.values(ALIASES).flatMap(arr => arr)
);

// ---------------------------------------------------------------------------
// resolveHeaders
//
// Given an array of raw CSV header strings, returns:
//   mapping  : { [canonicalName]: rawHeader }  — canonical → first matching raw key
//   missing  : string[]                        — REQUIRED_FIELDS not resolved
//   warnings : string[]                        — optional but unrecognised headers
// ---------------------------------------------------------------------------
function resolveHeaders(rawKeys) {
  const mapping  = {};
  const resolved = new Set();

  for (const [canonical, aliases] of Object.entries(ALIASES)) {
    for (const alias of aliases) {
      const match = rawKeys.find(k => k.trim().toLowerCase() === alias);
      if (match) {
        mapping[canonical] = match;
        resolved.add(canonical);
        break;
      }
    }
  }

  const missing = [...REQUIRED_FIELDS].filter(f => !resolved.has(f));

  const unrecognised = rawKeys.filter(k => !acceptedNames.has(k.trim().toLowerCase()));
  const warnings = unrecognised.length
    ? [`${unrecognised.length} unrecognised column(s) ignored: ${unrecognised.slice(0, 5).join(', ')}${unrecognised.length > 5 ? ' …' : ''}`]
    : [];

  return { mapping, missing, warnings };
}

/**
 * Returns count of how many canonical fields were resolved.
 */
function countResolvedHeaders(mapping) {
  return Object.keys(mapping).length;
}

module.exports = {
  resolveHeaders,
  acceptedNames,
  countResolvedHeaders,
  REQUIRED_FIELDS,
  ALIASES,
};
