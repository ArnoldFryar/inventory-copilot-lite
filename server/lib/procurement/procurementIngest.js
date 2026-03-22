'use strict';

// ---------------------------------------------------------------------------
// procurementIngest.js — CSV validation and normalisation for Open PO uploads
//
// Responsibilities:
//   1. Encoding detection + decoding  (reuses logic from csvIngest.js)
//   2. Preamble-row skipping          (same heuristic, procurement alias table)
//   3. Column header resolution       (via procurementColumnMap.resolveHeaders)
//   4. Per-row validation             (required fields, numeric, date, sentinel)
//   5. Normalisation                  (canonical POLine shape from types.js)
//   6. Aggregated error/warning output
//
// This module is intentionally free of I/O side-effects beyond file reading.
// No AI, no scoring — those are downstream responsibilities.
//
// Callers receive:
//   {
//     ok      : boolean          — false if any hard errors block analysis
//     errors  : string[]         — blocking file-level or column-level errors
//     warnings: string[]         — non-fatal notes safe to surface as UI hints
//     rows    : POLine[]         — normalised rows (populated even with warnings)
//     meta    : IngestMeta       — encoding, preamble count, column aliases
//     stats   : IngestStats      — row counts for the upload response summary
//   }
//
// Shape references: server/lib/procurement/types.js
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
} = require('./procurementColumnMap');

// ---------------------------------------------------------------------------
// Constants (mirror csvIngest.js thresholds)
// ---------------------------------------------------------------------------

const UTF8_SCAN_BYTES  = 8 * 1024;
const MAX_PREAMBLE_ROWS = 20;
// A header candidate must have at least this many cells.
const MIN_HEADER_CELLS = 3;
// At least this many procurement canonical fields must resolve on a line
// for it to be treated as the column header row.
const MIN_HEADER_FIELDS = 2;

// Maximum number of per-row validation errors to collect before stopping.
// Avoids flooding the response with thousands of identical error messages
// on completely wrong files.
const MAX_ROW_ERRORS = 50;

// ---------------------------------------------------------------------------
// NULL_LIKE
// String sentinels treated as absent values.  Matches the set in analyzer.js.
// ---------------------------------------------------------------------------
const NULL_LIKE = new Set([
  'n/a', 'na', 'n.a.', 'n.a',
  'null', 'nil', 'none',
  '#n/a', '#na', '#null', '#value!', '#ref!',
  '-', '\u2014', '\u2013',
  'tbd', 'missing', 'unknown', '?',
  'blank', 'empty',
]);

// ---------------------------------------------------------------------------
// detectEncoding  (identical logic to csvIngest.js — no shared import to
// avoid circular deps; both files own this small function)
// ---------------------------------------------------------------------------
function detectEncoding(buf) {
  if (!buf || buf.length === 0) return { encoding: 'utf8', method: 'empty-file-fallback' };

  if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF)
    return { encoding: 'utf8', method: 'bom-utf8' };

  if (buf[0] === 0xFF && buf[1] === 0xFE)
    return { encoding: null, method: 'bom-utf16le',
      error: 'File is UTF-16 LE encoded. Open in Excel and re-save as "CSV (Comma delimited) (*.csv)".' };

  if (buf[0] === 0xFE && buf[1] === 0xFF)
    return { encoding: null, method: 'bom-utf16be',
      error: 'File is UTF-16 BE encoded. Open in Excel and re-save as "CSV (Comma delimited) (*.csv)".' };

  if (hasInvalidUTF8(buf, UTF8_SCAN_BYTES))
    return { encoding: 'win1252', method: 'utf8-validation-failed-assumed-win1252' };

  return { encoding: 'utf8', method: 'utf8-validated-no-bom' };
}

function hasInvalidUTF8(buf, limit) {
  const end = Math.min(buf.length, limit);
  let i = 0;
  while (i < end) {
    const b = buf[i];
    if (b < 0x80) { i += 1; continue; }
    if (b >= 0xC2 && b <= 0xDF) {
      if (i + 1 >= end) break;
      if ((buf[i+1] & 0xC0) !== 0x80) return true;
      i += 2;
    } else if (b >= 0xE0 && b <= 0xEF) {
      if (i + 2 >= end) break;
      if ((buf[i+1] & 0xC0) !== 0x80 || (buf[i+2] & 0xC0) !== 0x80) return true;
      if (b === 0xE0 && buf[i+1] < 0xA0) return true;
      if (b === 0xED && buf[i+1] >= 0xA0) return true;
      i += 3;
    } else if (b >= 0xF0 && b <= 0xF4) {
      if (i + 3 >= end) break;
      if ((buf[i+1] & 0xC0) !== 0x80 || (buf[i+2] & 0xC0) !== 0x80 || (buf[i+3] & 0xC0) !== 0x80) return true;
      if (b === 0xF0 && buf[i+1] < 0x90) return true;
      if (b === 0xF4 && buf[i+1] > 0x8F) return true;
      i += 4;
    } else {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// parseCSVLine  (RFC 4180 minimal parser — for header detection only)
// ---------------------------------------------------------------------------
function parseCSVLine(line) {
  const fields = [];
  let current  = '';
  let inQuote  = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i+1] === '"') { current += '"'; i++; }
      else inQuote = !inQuote;
    } else if (ch === ',' && !inQuote) {
      fields.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

// ---------------------------------------------------------------------------
// findHeaderRowIndex
// Scans lines 0..MAX_PREAMBLE_ROWS for the first line that resolves at least
// MIN_HEADER_FIELDS procurement canonical columns.
// ---------------------------------------------------------------------------
function findHeaderRowIndex(lines) {
  for (let i = 0; i < Math.min(lines.length, MAX_PREAMBLE_ROWS); i++) {
    const line = lines[i];
    if (!line || line.trim() === '') continue;
    const cells = parseCSVLine(line);
    if (cells.length < MIN_HEADER_CELLS) continue;
    if (countResolvedHeaders(cells) >= MIN_HEADER_FIELDS) return i;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// safeNumber
// Parses a CSV cell to a finite non-negative number, or null.
// Handles thousands commas, currency prefixes, unit suffixes (e.g. "50 EA"),
// and all NULL_LIKE sentinels.  Negative values → null.
// ---------------------------------------------------------------------------
function safeNumber(raw) {
  if (raw === null || raw === undefined) return null;
  const trimmed = String(raw).trim();
  if (trimmed === '' || NULL_LIKE.has(trimmed.toLowerCase())) return null;

  const withoutUnit  = trimmed.replace(/\s[a-zA-Z][a-zA-Z\s]*$/, '');
  const unformatted  = withoutUnit.replace(/,(?=\d{3}(\D|$))/g, '');
  const cleaned      = unformatted.replace(/^[\$€£¥\s]+|[\s%]+$/g, '');
  const n            = Number(cleaned);
  if (!isFinite(n) || n < 0) return null;
  return n;
}

// ---------------------------------------------------------------------------
// parseDate
// Parses a CSV cell to an ISO 8601 date string ("YYYY-MM-DD"), or null.
//
// Supported input formats (in priority order):
//   1. ISO 8601:              2024-03-15         → "2024-03-15"
//   2. US format mm/dd/yyyy:  03/15/2024         → "2024-03-15"
//   3. UK/EU dd/mm/yyyy:      15/03/2024         → "2024-03-15"  [see note]
//   4. US short mm/dd/yy:     03/15/24           → "2024-03-15"
//   5. Named month:           15-Mar-2024 / Mar 15, 2024
//   6. Excel serial number:   45366              → 2024-03-15
//   7. Timestamp (truncated): 2024-03-15T10:00Z  → "2024-03-15"
//
// Ambiguity note (format 3 vs 2):
//   Slash-delimited dates with first segment > 12 are unambiguously DD/MM.
//   Dates with first segment ≤ 12 default to MM/DD (US) because that is the
//   dominant ERP export format in our pilot market.  An explicit warning is
//   attached to each such row so users can catch misinterpretations.
// ---------------------------------------------------------------------------
const MONTH_MAP = {
  jan: 1, feb: 2, mar: 3, apr: 4,  may: 5,  jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

// Excel's date serial epoch: serial 1 = January 1, 1900.
// Dec 31, 1899 ("January 0, 1900") as Unix-ms anchor means adding `serial`
// days lands on the correct Gregorian date.
// For serial >= 60 we subtract 1 to compensate for Excel's phantom
// February 29, 1900 (Excel bug: it treated 1900 as a leap year).
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 31);  // 31 Dec 1899 ("Jan 0, 1900")

function parseDate(raw) {
  if (raw === null || raw === undefined) return { value: null, ambiguous: false };
  const trimmed = String(raw).trim();
  if (trimmed === '' || NULL_LIKE.has(trimmed.toLowerCase()))
    return { value: null, ambiguous: false };

  // ── 7. ISO 8601 timestamp prefix ────────────────────────────────────────
  const isoTs = trimmed.match(/^(\d{4}-\d{2}-\d{2})(?:T|$|\s)/);
  if (isoTs) return { value: isoTs[1], ambiguous: false };

  // ── 1. ISO 8601 date (strict) ────────────────────────────────────────────
  const iso = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) {
    const y = parseInt(iso[1], 10), m = parseInt(iso[2], 10), d = parseInt(iso[3], 10);
    if (isValidCalendarDate(y, m, d)) return { value: toISO(y, m, d), ambiguous: false };
  }

  // ── 5. Named month: "15-Mar-2024", "Mar 15, 2024", "15 Mar 2024" ────────
  const named = trimmed.match(
    /^(\d{1,2})[\s\-\/]([A-Za-z]{3})[\s\-\/,\s]*(\d{2,4})$|^([A-Za-z]{3})[\s\-\/](\d{1,2})[\s,\-]*(\d{2,4})$/
  );
  if (named) {
    let day, mon, year;
    if (named[1]) { day = parseInt(named[1], 10); mon = MONTH_MAP[named[2].toLowerCase()]; year = expandYear(parseInt(named[3], 10)); }
    else           { mon = MONTH_MAP[named[4].toLowerCase()]; day = parseInt(named[5], 10); year = expandYear(parseInt(named[6], 10)); }
    if (mon && isValidCalendarDate(year, mon, day)) return { value: toISO(year, mon, day), ambiguous: false };
  }

  // ── 2/3/4. Slash-delimited: mm/dd/yyyy, dd/mm/yyyy, mm/dd/yy ────────────
  const slashed = trimmed.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (slashed) {
    const a = parseInt(slashed[1], 10);
    const b = parseInt(slashed[2], 10);
    const c = expandYear(parseInt(slashed[3], 10));

    // If first segment > 12, must be DD/MM/YYYY.
    if (a > 12 && isValidCalendarDate(c, b, a)) return { value: toISO(c, b, a), ambiguous: false };

    // Both segments ≤ 12: default MM/DD (US), flag as ambiguous.
    if (isValidCalendarDate(c, a, b)) return { value: toISO(c, a, b), ambiguous: b <= 12 };
  }

  // ── 6. Excel serial number ───────────────────────────────────────────────
  if (/^\d{4,5}$/.test(trimmed)) {
    const serial = parseInt(trimmed, 10);
    // Plausible Excel date range: serial 1 (1900-01-01) to ~99999 (year ~2173).
    // Reject 4-digit values that look like years (1900–2099).
    if (serial > 2099 && serial < 100000) {
      const ms = EXCEL_EPOCH_MS + (serial - (serial >= 60 ? 1 : 0)) * 86400000;
      const d  = new Date(ms);
      if (!isNaN(d)) {
        return {
          value: toISO(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()),
          ambiguous: false,
        };
      }
    }
  }

  return { value: null, ambiguous: false };
}

function expandYear(y) {
  if (y >= 100) return y;
  // 2-digit year: 00–49 → 2000–2049; 50–99 → 1950–1999.
  return y < 50 ? 2000 + y : 1900 + y;
}

function isValidCalendarDate(y, m, d) {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  if (y < 1900 || y > 2200) return false;
  if (m < 1 || m > 12) return false;
  if (d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() + 1 === m && dt.getUTCDate() === d;
}

function toISO(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// normaliseRow
//
// Takes a raw csv-parser row object and a resolved field mapping, produces a
// validated, normalised POLine record (matches the Shape in types.js).
//
// Returns:
//   {
//     line   : POLine | null   — populated when the row is usable
//     errors : string[]        — blocking field-level errors (row is unusable)
//     warnings: string[]       — non-fatal issues (row is included with caveats)
//   }
// ---------------------------------------------------------------------------
function normaliseRow(raw, mapping, rowIndex) {
  const errors   = [];
  const warnings = [];

  // ── Helper: get cell value by canonical field name ─────────────────────
  function cell(canonical) {
    const rawKey = mapping[canonical];
    if (!rawKey) return '';
    const v = raw[rawKey];
    return v === undefined ? '' : String(v).trim();
  }

  // ── Required fields ────────────────────────────────────────────────────

  const poNumberRaw = cell('po_number');
  if (!poNumberRaw || NULL_LIKE.has(poNumberRaw.toLowerCase())) {
    errors.push(`Row ${rowIndex + 1}: missing required field "PO Number".`);
  }
  const po_number = poNumberRaw || null;

  const supplierRaw = cell('supplier');
  if (!supplierRaw || NULL_LIKE.has(supplierRaw.toLowerCase())) {
    errors.push(`Row ${rowIndex + 1}: missing required field "Supplier Name".`);
  }
  const supplier = supplierRaw || null;

  const lineAmountRaw = cell('line_amount');
  const line_amount   = safeNumber(lineAmountRaw);
  if (lineAmountRaw && line_amount === null) {
    errors.push(`Row ${rowIndex + 1}: "Line Amount" value "${lineAmountRaw}" is not a valid number.`);
  }
  // Zero is permitted (cancelled or no-cost lines); only reject un-parsable values.
  const resolvedLineAmount = line_amount !== null ? line_amount : 0;

  // If all three required fields fail, skip the row entirely.
  if (errors.length > 0) {
    return { line: null, errors, warnings };
  }

  // ── Optional numeric fields ────────────────────────────────────────────

  const quantity_ordered  = safeNumber(cell('quantity_ordered'));
  const quantity_received = safeNumber(cell('quantity_received'));
  const unit_price        = safeNumber(cell('unit_price'));

  // ── Date fields ────────────────────────────────────────────────────────

  function resolveDate(canonical, label) {
    const raw_val   = cell(canonical);
    if (!raw_val) return null;
    const { value, ambiguous } = parseDate(raw_val);
    if (value === null) {
      warnings.push(`Row ${rowIndex + 1}: "${label}" value "${raw_val}" could not be parsed as a date — treated as absent.`);
    } else if (ambiguous) {
      warnings.push(`Row ${rowIndex + 1}: "${label}" date "${raw_val}" is ambiguous (MM/DD vs DD/MM). Interpreted as MM/DD (US default).`);
    }
    return value;
  }

  const order_date     = resolveDate('order_date',     'Order Date');
  const requested_date = resolveDate('need_date',      'Need Date');
  const confirmed_date = resolveDate('due_date',       'Due Date');
  const actual_date    = null; // not present in Open PO exports (no receipts yet)

  // ── Delivery status ────────────────────────────────────────────────────
  //
  // Open PO exports represent orders not yet fulfilled. Status is derived
  // deterministically from confirmed_date vs today's date:
  //   - no confirmed_date → 'pending'
  //   - confirmed_date < today → 'overdue'
  //   - confirmed_date >= today → 'pending'
  //
  // A downstream scoring pass can refine this with partial-receipt data
  // (quantity_received < quantity_ordered).
  const TODAY_ISO = toISO(
    new Date().getFullYear(), new Date().getMonth() + 1, new Date().getDate()
  );

  let delivery_status = 'pending';
  let days_variance   = null;

  if (confirmed_date) {
    if (confirmed_date < TODAY_ISO) {
      delivery_status = 'overdue';
      days_variance = dateDiffDays(confirmed_date, TODAY_ISO); // positive = days past due
    } else {
      delivery_status = 'pending';
      days_variance = dateDiffDays(TODAY_ISO, confirmed_date); // positive = days remaining
    }
  } else if (requested_date) {
    // Fall back to need_date when due_date is absent.
    if (requested_date < TODAY_ISO) {
      delivery_status = 'overdue';
      days_variance = dateDiffDays(requested_date, TODAY_ISO);
    } else {
      delivery_status = 'pending';
      days_variance = dateDiffDays(TODAY_ISO, requested_date);
    }
  }

  // Flag partial receipt if both quantity fields are present.
  if (
    quantity_ordered !== null && quantity_received !== null &&
    quantity_received > 0 && quantity_received < quantity_ordered
  ) {
    delivery_status = 'partial';
  }

  // ── Optional string fields ─────────────────────────────────────────────

  function optStr(canonical) {
    const v = cell(canonical);
    return v && !NULL_LIKE.has(v.toLowerCase()) ? v : null;
  }

  const line_number       = optStr('line_number');
  const item_code         = optStr('item_code');
  const item_description  = optStr('item_description');
  const category          = optStr('category');
  const buyer             = optStr('buyer');
  const plant             = optStr('plant');

  const line = {
    po_number,
    line_number,
    supplier,
    item_code,
    item_description,
    quantity_ordered,
    quantity_received,
    unit_price,
    line_amount:      resolvedLineAmount,
    order_date,
    requested_date,
    confirmed_date,
    actual_date,
    delivery_status,
    days_variance,
    category,
    buyer,
    plant,
    risk_flags:       [],   // populated by downstream scorer
    applied_rules:    [],   // populated by downstream scorer
    _row_index:       rowIndex,
  };

  return { line, errors, warnings };
}

// ---------------------------------------------------------------------------
// dateDiffDays
// Returns the number of calendar days from ISO date string `a` to `b`.
// Positive when b > a (b is later).
// ---------------------------------------------------------------------------
function dateDiffDays(a, b) {
  const msA = Date.UTC(
    parseInt(a.slice(0, 4), 10), parseInt(a.slice(5, 7), 10) - 1, parseInt(a.slice(8, 10), 10)
  );
  const msB = Date.UTC(
    parseInt(b.slice(0, 4), 10), parseInt(b.slice(5, 7), 10) - 1, parseInt(b.slice(8, 10), 10)
  );
  return Math.round((msB - msA) / 86400000);
}

// ---------------------------------------------------------------------------
// ingestPOCsv
//
// Main entry point.  Reads `filePath`, validates, and normalises all PO lines.
//
// Callback: (result: IngestResult)
//
// IngestResult:
//   {
//     ok       : boolean,
//     errors   : string[],
//     warnings : string[],
//     rows     : POLine[],
//     meta     : { encoding, encodingMethod, preambleRowsSkipped, columnAliases },
//     stats    : { totalRows, validRows, invalidRows, warningRows },
//   }
// ---------------------------------------------------------------------------
function ingestPOCsv(filePath, callback) {
  const meta = {
    encoding:            'unknown',
    encodingMethod:      'unknown',
    preambleRowsSkipped: 0,
    columnAliases:       {},
  };

  function fail(errors) {
    callback({ ok: false, errors: Array.isArray(errors) ? errors : [errors], warnings: [], rows: [], meta, stats: null });
  }

  // ── 1. Read ─────────────────────────────────────────────────────────────
  fs.readFile(filePath, (readErr, buf) => {
    if (readErr) return fail(`Could not read uploaded file: ${readErr.message}`);

    // ── 2. Encoding ────────────────────────────────────────────────────────
    const enc = detectEncoding(buf);
    meta.encoding       = enc.encoding  || 'unsupported';
    meta.encodingMethod = enc.method;
    if (enc.error) return fail(enc.error);

    // ── 3. Decode ──────────────────────────────────────────────────────────
    let decoded;
    try { decoded = iconv.decode(buf, enc.encoding); }
    catch (e) { return fail(`Could not decode file as ${enc.encoding}: ${e.message}`); }

    if (decoded.charCodeAt(0) === 0xFEFF) decoded = decoded.slice(1);
    if (!decoded.trim()) return fail('The uploaded file is empty.');

    // ── 4. Split lines ─────────────────────────────────────────────────────
    const lines = decoded.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

    // ── 5. Find header row ─────────────────────────────────────────────────
    const headerIdx = findHeaderRowIndex(lines);
    if (headerIdx === -1) {
      return fail(
        `Could not find a recognisable column header in the first ${MAX_PREAMBLE_ROWS} lines. ` +
        'Required columns (any accepted alias): PO Number, Supplier, Line Amount. ' +
        `Accepted names for "PO Number": ${acceptedNames('po_number')}. ` +
        `Accepted names for "Supplier": ${acceptedNames('supplier')}. ` +
        `Accepted names for "Line Amount": ${acceptedNames('line_amount')}.`
      );
    }

    if (headerIdx > 0) {
      meta.preambleRowsSkipped = headerIdx;
    }

    // ── 6. Stream through csv-parser ───────────────────────────────────────
    const trimmedCSV = lines.slice(headerIdx).join('\n');
    const rawRows    = [];
    let   parseError = null;
    let   settled    = false;

    const readable = new Readable();
    readable.push(trimmedCSV);
    readable.push(null);

    readable
      .pipe(csv())
      .on('error', (e) => {
        if (settled) return;
        settled    = true;
        parseError = e.message;
      })
      .on('data', (row) => rawRows.push(row))
      .on('end', () => {
        if (settled) return;
        settled = true;

        if (parseError) return fail(`CSV parse error: ${parseError}`);
        if (rawRows.length === 0) return fail('The file contains a header row but no data rows.');

        // ── 7. Resolve headers ───────────────────────────────────────────
        const rawKeys = Object.keys(rawRows[0]);
        const { mapping, aliases, missing, warnings: headerWarnings } = resolveHeaders(rawKeys);

        meta.columnAliases = aliases;

        if (missing.length > 0) {
          const hints = missing.map(f =>
            `"${f}" — accepted names: ${acceptedNames(f)}`
          ).join('; ');
          return fail(`Missing required column(s): ${hints}.`);
        }

        // ── 8. Normalise rows ────────────────────────────────────────────
        const validRows    = [];
        const allErrors    = [];
        const allWarnings  = [...headerWarnings];
        let   warningRows  = 0;
        let   errorCount   = 0;

        for (let i = 0; i < rawRows.length; i++) {
          // Skip completely blank rows (all cells empty).
          const values = Object.values(rawRows[i]);
          if (values.every(v => String(v).trim() === '')) continue;

          const { line, errors, warnings } = normaliseRow(rawRows[i], mapping, i);

          if (errors.length > 0) {
            errorCount++;
            if (allErrors.length < MAX_ROW_ERRORS) {
              allErrors.push(...errors);
            } else if (allErrors.length === MAX_ROW_ERRORS) {
              allErrors.push(`(further row errors suppressed — ${rawRows.length - i} rows remaining)`);
            }
          }

          if (warnings.length > 0) {
            warningRows++;
            allWarnings.push(...warnings);
          }

          if (line !== null) {
            validRows.push(line);
          }
        }

        const stats = {
          totalRows:   rawRows.length,
          validRows:   validRows.length,
          invalidRows: errorCount,
          warningRows,
        };

        // File-level failure: no valid rows could be produced.
        if (validRows.length === 0) {
          return callback({
            ok:       false,
            errors:   allErrors.length > 0 ? allErrors : ['No valid rows could be parsed from the file.'],
            warnings: allWarnings,
            rows:     [],
            meta,
            stats,
          });
        }

        callback({
          ok:       allErrors.length === 0,
          errors:   allErrors,
          warnings: allWarnings,
          rows:     validRows,
          meta,
          stats,
        });
      });
  });
}

module.exports = {
  ingestPOCsv,
  // Exported for unit testing
  parseDate,
  safeNumber,
  normaliseRow,
  detectEncoding,
};
