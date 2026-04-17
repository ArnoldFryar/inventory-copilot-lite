'use strict';

// ---------------------------------------------------------------------------
// server/lib/pfep/pfepIngest.js — CSV validation and normalisation for PFEP
// register uploads.
//
// Responsibilities:
//   1. Encoding detection + decoding  (same logic as procurementIngest)
//   2. Preamble-row skipping
//   3. Column header resolution       (via pfepColumnMap.resolveHeaders)
//   4. Per-row validation             (required fields, numeric coercion)
//   5. Normalisation                  (canonical PFEPPart shape from types.js)
//   6. Aggregated error/warning output
//
// Callers receive:
//   {
//     ok       : boolean        — false if hard errors prevent analysis
//     errors   : string[]       — blocking errors (column or file level)
//     warnings : string[]       — non-fatal notes for UI hints
//     rows     : PFEPPart[]     — normalised rows
//     meta     : IngestMeta     — encoding, preamble count, column aliases
//     stats    : IngestStats    — total/skipped/parsed counts
//   }
// ---------------------------------------------------------------------------

const fs    = require('fs');
const iconv = require('iconv-lite');
const csv   = require('csv-parser');
const { Readable } = require('stream');

const {
  resolveHeaders,
  acceptedNames,
  countResolvedHeaders,
  REQUIRED_FIELDS,
} = require('./pfepColumnMap');

const { VALID_REPLENISHMENT_METHODS, VALID_ABC_CLASSES } = require('./types');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const UTF8_SCAN_BYTES   = 8 * 1024;
const MAX_PREAMBLE_ROWS = 20;
const MIN_HEADER_CELLS  = 2;
const MIN_HEADER_FIELDS = 1;
const MAX_ROW_ERRORS    = 50;

const NULL_LIKE = new Set([
  'n/a', 'na', 'n.a.', 'n.a',
  'null', 'nil', 'none',
  '#n/a', '#na', '#null', '#value!', '#ref!',
  '-', '\u2014', '\u2013',
  'tbd', 'missing', 'unknown', '?',
  'blank', 'empty',
]);

// ---------------------------------------------------------------------------
// detectEncoding
// ---------------------------------------------------------------------------
function detectEncoding(buf) {
  if (!buf || buf.length === 0) return { encoding: 'utf8', method: 'empty-file-fallback' };
  if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF)
    return { encoding: 'utf8', method: 'bom-utf8' };
  if (buf[0] === 0xFF && buf[1] === 0xFE)
    return { encoding: null, method: 'bom-utf16le',
      error: 'File is UTF-16 LE. Open in Excel and re-save as CSV UTF-8.' };
  if (buf[0] === 0xFE && buf[1] === 0xFF)
    return { encoding: null, method: 'bom-utf16be',
      error: 'File is UTF-16 BE. Open in Excel and re-save as CSV UTF-8.' };
  if (hasInvalidUTF8(buf, UTF8_SCAN_BYTES))
    return { encoding: 'win1252', method: 'utf8-validation-failed-assumed-win1252' };
  return { encoding: 'utf8', method: 'utf8-validated-no-bom' };
}

function hasInvalidUTF8(buf, limit) {
  const end = Math.min(buf.length, limit);
  let i = 0;
  while (i < end) {
    const b = buf[i];
    if (b < 0x80) { i++; continue; }
    if ((b & 0xE0) === 0xC0) {
      if (i + 1 >= end || (buf[i + 1] & 0xC0) !== 0x80) return true;
      i += 2; continue;
    }
    if ((b & 0xF0) === 0xE0) {
      if (i + 2 >= end || (buf[i + 1] & 0xC0) !== 0x80 || (buf[i + 2] & 0xC0) !== 0x80) return true;
      i += 3; continue;
    }
    if ((b & 0xF8) === 0xF0) {
      if (i + 3 >= end || (buf[i + 1] & 0xC0) !== 0x80 || (buf[i + 2] & 0xC0) !== 0x80 || (buf[i + 3] & 0xC0) !== 0x80) return true;
      i += 4; continue;
    }
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function isNullLike(v) {
  if (v === null || v === undefined) return true;
  return NULL_LIKE.has(String(v).trim().toLowerCase());
}

function cleanString(v) {
  if (isNullLike(v)) return null;
  return String(v).trim() || null;
}

function parsePositiveNumber(v) {
  if (isNullLike(v)) return null;
  const n = parseFloat(String(v).replace(/[,$]/g, ''));
  return isFinite(n) ? n : null;
}

function parsePositiveInteger(v) {
  if (isNullLike(v)) return null;
  const n = parseInt(String(v).replace(/[,$]/g, ''), 10);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

// ---------------------------------------------------------------------------
// parseReplenishmentMethod
// Maps common aliases to a valid VALID_REPLENISHMENT_METHODS value.
// ---------------------------------------------------------------------------
const REPL_MAP = {
  'min max': 'min_max',
  'min/max': 'min_max',
  'minmax':  'min_max',
  'k':       'kanban',
  'mrp':     'mrp',
  'cons':    'consignment',
  'jit':     'jit',
  'rop':     'reorder_point',
  'reorder': 'reorder_point',
};

function parseReplenishmentMethod(v) {
  if (isNullLike(v)) return 'min_max'; // safe default
  const raw = String(v).trim().toLowerCase();
  if (VALID_REPLENISHMENT_METHODS.has(raw)) return raw;
  return REPL_MAP[raw] || 'other';
}

// ---------------------------------------------------------------------------
// parseABCClass
// ---------------------------------------------------------------------------
function parseABCClass(v) {
  if (isNullLike(v)) return null;
  const raw = String(v).trim().toUpperCase();
  return VALID_ABC_CLASSES.has(raw) ? raw : null;
}

// ---------------------------------------------------------------------------
// looksLikeHeader
// Returns true if the row contains enough recognisable PFEP column names
// to be treated as the header row during preamble detection.
// ---------------------------------------------------------------------------
function looksLikeHeader(rowObj) {
  const keys = Object.keys(rowObj);
  if (keys.length < MIN_HEADER_CELLS) return false;
  const lowerKeys = keys.map(k => k.trim().toLowerCase());
  const matched = lowerKeys.filter(k => acceptedNames.has(k));
  return matched.length >= MIN_HEADER_FIELDS;
}

// ---------------------------------------------------------------------------
// normaliseRow
// Converts a raw CSV row object to a PFEPPart, applying field mapping,
// type coercion, and null normalisation.
// ---------------------------------------------------------------------------
function normaliseRow(raw, mapping, rowIndex) {
  function get(canonical) {
    const col = mapping[canonical];
    return col ? raw[col] : undefined;
  }

  return {
    part_number:          cleanString(get('part_number')),
    part_description:     cleanString(get('part_description')),
    commodity_class:      cleanString(get('commodity_class')),
    abc_class:            parseABCClass(get('abc_class')),
    supplier:             cleanString(get('supplier')),
    secondary_supplier:   cleanString(get('secondary_supplier')),
    supplier_part_number: cleanString(get('supplier_part_number')),
    replenishment_method: parseReplenishmentMethod(get('replenishment_method')),
    lead_time_days:       parsePositiveInteger(get('lead_time_days')),
    reorder_point:        parsePositiveNumber(get('reorder_point')),
    min_qty:              parsePositiveNumber(get('min_qty')),
    max_qty:              parsePositiveNumber(get('max_qty')),
    pack_multiple:        parsePositiveNumber(get('pack_multiple')),
    standard_pack:        parsePositiveNumber(get('standard_pack')),
    unit_of_measure:      cleanString(get('unit_of_measure')),
    unit_cost:            parsePositiveNumber(get('unit_cost')),
    annual_usage:         parsePositiveNumber(get('annual_usage')),
    point_of_use:         cleanString(get('point_of_use')),
    plant:                cleanString(get('plant')),
    notes:                cleanString(get('notes')),
    row_index:            rowIndex,
  };
}

// ---------------------------------------------------------------------------
// ingestPFEPCsv
//
// Main entry point.  Reads a PFEP CSV file from disk and returns structured
// results.
//
// @param {string} filePath — absolute path to the uploaded CSV
// @returns {Promise<{ok, errors, warnings, rows, meta, stats}>}
// ---------------------------------------------------------------------------
async function ingestPFEPCsv(filePath) {
  const errors   = [];
  const warnings = [];
  const rows     = [];

  // ── 1. Read file ──────────────────────────────────────────────────────────
  let fileBuffer;
  try {
    fileBuffer = fs.readFileSync(filePath);
  } catch (e) {
    return {
      ok: false,
      errors: [`Could not read uploaded file: ${e.message}`],
      warnings: [],
      rows: [],
      meta:  {},
      stats: { total_rows: 0, parsed_rows: 0, skipped_rows: 0 },
    };
  }

  if (fileBuffer.length === 0) {
    return {
      ok: false,
      errors: ['Uploaded file is empty.'],
      warnings: [],
      rows: [],
      meta:  {},
      stats: { total_rows: 0, parsed_rows: 0, skipped_rows: 0 },
    };
  }

  // ── 2. Detect encoding + decode ───────────────────────────────────────────
  const enc = detectEncoding(fileBuffer);
  if (enc.error) {
    return {
      ok: false,
      errors: [enc.error],
      warnings: [],
      rows: [],
      meta:  { encoding: enc.method },
      stats: { total_rows: 0, parsed_rows: 0, skipped_rows: 0 },
    };
  }

  const csvText = iconv.decode(
    enc.encoding === 'utf8' ? fileBuffer : fileBuffer,
    enc.encoding,
  );
  const cleanText = csvText.replace(/^\uFEFF/, '');

  // ── 3. Raw CSV parse ──────────────────────────────────────────────────────
  const rawRows = await parseCsvText(cleanText);

  if (rawRows.length === 0) {
    return {
      ok: false,
      errors: ['File has no data rows.'],
      warnings: [],
      rows: [],
      meta:  { encoding: enc.method },
      stats: { total_rows: 0, parsed_rows: 0, skipped_rows: 0 },
    };
  }

  // ── 4. Preamble detection ─────────────────────────────────────────────────
  let headerRowIndex = 0;
  for (let i = 0; i < Math.min(rawRows.length, MAX_PREAMBLE_ROWS); i++) {
    if (looksLikeHeader(rawRows[i])) {
      headerRowIndex = i;
      break;
    }
  }

  if (headerRowIndex > 0) {
    warnings.push(`Skipped ${headerRowIndex} preamble row(s) before headers.`);
  }

  // The actual data rows begin after the header row that csv-parser already
  // used as keys.  Re-parse with a sliced input so the true header row
  // at headerRowIndex becomes the keys.
  let dataRows = rawRows;
  if (headerRowIndex > 0) {
    const lines   = cleanText.split('\n');
    const trimmed = lines.slice(headerRowIndex).join('\n');
    dataRows      = await parseCsvText(trimmed);
  }

  // ── 5. Resolve columns ────────────────────────────────────────────────────
  const rawKeys = dataRows.length > 0 ? Object.keys(dataRows[0]) : [];
  const { mapping, missing: missingFields, warnings: colWarnings } = resolveHeaders(rawKeys);

  colWarnings.forEach(w => warnings.push(w));

  if (missingFields.length > 0) {
    errors.push(
      `Required column(s) not found: ${missingFields.join(', ')}. ` +
      `Ensure your PFEP export includes a part number column.`
    );
    return {
      ok: false, errors, warnings, rows: [],
      meta: { encoding: enc.method, columns_resolved: countResolvedHeaders(mapping) },
      stats: { total_rows: dataRows.length, parsed_rows: 0, skipped_rows: dataRows.length },
    };
  }

  // ── 6. Normalise rows ─────────────────────────────────────────────────────
  let rowErrorCount = 0;
  let skipped       = 0;

  for (let i = 0; i < dataRows.length; i++) {
    const raw = dataRows[i];

    // Skip blank rows
    const allEmpty = Object.values(raw).every(v => !v || !String(v).trim());
    if (allEmpty) { skipped++; continue; }

    const part = normaliseRow(raw, mapping, i);

    // Validate required field
    if (!part.part_number) {
      if (rowErrorCount < MAX_ROW_ERRORS) {
        errors.push(`Row ${i + 2}: missing part number — row skipped.`);
      }
      rowErrorCount++;
      skipped++;
      continue;
    }

    rows.push(part);
  }

  if (rowErrorCount > MAX_ROW_ERRORS) {
    errors.push(`…and ${rowErrorCount - MAX_ROW_ERRORS} more row error(s) suppressed.`);
  }

  if (rows.length === 0) {
    return {
      ok: false,
      errors: errors.length ? errors : ['No valid part rows found after parsing.'],
      warnings,
      rows: [],
      meta: { encoding: enc.method, columns_resolved: countResolvedHeaders(mapping) },
      stats: { total_rows: dataRows.length, parsed_rows: 0, skipped_rows: skipped },
    };
  }

  return {
    ok: true,
    errors,
    warnings,
    rows,
    meta: {
      encoding:          enc.method,
      columns_resolved:  countResolvedHeaders(mapping),
      preamble_rows:     headerRowIndex,
      column_mapping:    mapping,
    },
    stats: {
      total_rows:  dataRows.length,
      parsed_rows: rows.length,
      skipped_rows: skipped,
    },
  };
}

// ---------------------------------------------------------------------------
// parseCsvText — wraps csv-parser in a Promise for async/await use.
// ---------------------------------------------------------------------------
function parseCsvText(text) {
  return new Promise((resolve, reject) => {
    const result = [];
    const stream = Readable.from([text]);
    stream
      .pipe(csv({ skipLines: 0, strict: false, trim: true }))
      .on('data', row  => result.push(row))
      .on('error', err => reject(err))
      .on('end',   ()  => resolve(result));
  });
}

module.exports = { ingestPFEPCsv };
