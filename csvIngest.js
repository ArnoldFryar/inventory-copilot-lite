'use strict';

/**
 * csvIngest.js
 *
 * Responsible for two things the base csv-parser cannot do reliably:
 *
 * 1. ENCODING — Reads the raw file bytes, detects whether they are UTF-8,
 *    UTF-8-with-BOM, or Windows-1252 (the most common legacy encoding for
 *    ERP CSV exports in Western markets), and decodes to a JS string before
 *    passing to csv-parser.  UTF-16 files produce a clear error rather than
 *    silent corruption.
 *
 * 2. HEADER DETECTION — Some ERP systems prepend one or more metadata rows
 *    above the real column header row (report title, generation date, filter
 *    summary, blank spacers).  This module scans the first MAX_PREAMBLE_ROWS
 *    lines for the first line that looks like a real column header, discards
 *    everything above it, and passes only the remaining lines to csv-parser.
 *
 *    "Looks like a real column header" means:
 *      - the line parses into at least MIN_HEADER_CELLS comma-separated values
 *      - at least MIN_HEADER_FIELDS of those values match a recognised alias
 *        from columnMap.js (resolved via resolveHeaders)
 *
 * Design constraints:
 *   - No black-box heuristics.  Every decision is based on documented, byte-
 *     level or alias-resolution criteria.
 *   - Prefer hard failure over silent corruption.  If encoding is ambiguous
 *     and the fallback could produce misleading results, error clearly.
 *   - Memory: the entire file is read into a Buffer before streaming.  For
 *     pilot use with ≤ 5 MB files this is acceptable (peak ~10 MB per upload).
 *     Streaming encoding detection would require multi-pass logic that adds
 *     more complexity than value at this scale.
 */

const fs    = require('fs');
const iconv = require('iconv-lite');
const csv   = require('csv-parser');
const { Readable } = require('stream');
const { resolveHeaders } = require('./columnMap');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// How many bytes to scan when validating for invalid UTF-8 sequences.
// 8 KB is enough to catch high-byte characters in any title row or first
// data row without reading the entire file into the check loop.
const UTF8_SCAN_BYTES = 8 * 1024;

// Maximum number of leading lines to examine when searching for the column
// header.  20 covers any realistic ERP metadata block.
const MAX_PREAMBLE_ROWS = 20;

// A legitimate column header row must have at least this many comma-separated
// cells.  Prevents single-cell title rows ("Inventory Detail Report") from
// being misidentified as a header.
const MIN_HEADER_CELLS = 3;

// At least this many of the four required canonical fields (part_number,
// on_hand, daily_usage, lead_time) must be resolved for a line to be
// treated as the column header.
//
// Threshold rationale:
//   1 — too low: a row like "Part results, page 1, date" might accidentally
//       match "part_number" via the "part" alias.
//   2 — correct: requires any two recognised field names to co-occur on
//       the same line.  Covers exports with one non-standard column name.
//   3 — too strict: would reject valid exports where only 3 of 4 canonical
//       fields have recognised names.
const MIN_HEADER_FIELDS = 2;

// ---------------------------------------------------------------------------
// detectEncoding
//
// Inspects the leading bytes of a Buffer and returns the encoding to use
// when decoding to a JavaScript string.
//
// Returns:
//   { encoding: string|null, method: string, error?: string }
//
//   encoding — iconv-lite encoding name ('utf8', 'win1252'), or null on error
//   method   — how the decision was reached (for logging / response meta)
//   error    — if set, the file cannot be safely decoded; caller must abort
// ---------------------------------------------------------------------------
function detectEncoding(buf) {
  if (!buf || buf.length === 0) {
    return { encoding: 'utf8', method: 'empty-file-fallback' };
  }

  // ── BOM checks (definitive — no ambiguity) ─────────────────────────────

  // UTF-8 BOM: EF BB BF
  if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
    return { encoding: 'utf8', method: 'bom-utf8' };
  }

  // UTF-16 LE BOM: FF FE
  // csv-parser cannot handle UTF-16. Fail clearly rather than producing
  // garbage output from re-interpreting the bytes as Latin-1.
  if (buf[0] === 0xFF && buf[1] === 0xFE) {
    return {
      encoding: null,
      method:   'bom-utf16le',
      error:
        'This file is encoded as UTF-16 LE (detected by byte-order mark). ' +
        'OpsCopilot-Lite requires UTF-8 or Windows-1252 encoded CSV. ' +
        'Open the file in Excel and re-save as "CSV (Comma delimited) (*.csv)" to convert it.'
    };
  }

  // UTF-16 BE BOM: FE FF
  if (buf[0] === 0xFE && buf[1] === 0xFF) {
    return {
      encoding: null,
      method:   'bom-utf16be',
      error:
        'This file is encoded as UTF-16 BE (detected by byte-order mark). ' +
        'OpsCopilot-Lite requires UTF-8 or Windows-1252 encoded CSV. ' +
        'Open the file in Excel and re-save as "CSV (Comma delimited) (*.csv)" to convert it.'
    };
  }

  // ── No BOM — validate as UTF-8 by scanning for invalid byte sequences ──
  //
  // If the first UTF8_SCAN_BYTES contain any byte sequence that is illegal in
  // UTF-8, the file is almost certainly Windows-1252 (the dominant legacy
  // encoding for Western ERP systems: SAP, Oracle EBS, Infor, Epicor).
  //
  // The fallback to win1252 is the documented, intended behavior for this
  // one-step heuristic.  It covers the 95% case for Western manufacturing
  // pilots.  Files from CJK ERP deployments (Shift-JIS, GB2312) will also
  // trigger this path and may not decode correctly; such users will receive
  // garbled text rather than a clear error.  This is a known limitation and
  // is acceptable for the current pilot scope.
  if (hasInvalidUTF8(buf, UTF8_SCAN_BYTES)) {
    return { encoding: 'win1252', method: 'utf8-validation-failed-assumed-win1252' };
  }

  return { encoding: 'utf8', method: 'utf8-validated-no-bom' };
}

// ---------------------------------------------------------------------------
// hasInvalidUTF8
//
// Scans the first `limit` bytes of `buf` for byte sequences that violate
// the UTF-8 encoding rules (RFC 3629).  Returns true as soon as the first
// invalid sequence is found.
//
// Checks performed:
//   - Unexpected continuation bytes (0x80–0xBF not preceded by a lead byte)
//   - Overlong encodings (e.g. 2-byte encoding of a codepoint < U+0080)
//   - UTF-16 surrogate halves (U+D800–U+DFFF, illegal in UTF-8)
//   - Codepoints beyond U+10FFFF
//   - Invalid lead bytes (0xC0, 0xC1, 0xF5–0xFF)
//
// Incomplete sequences at the scan boundary are skipped, not counted as
// invalid, to avoid false positives on files that are valid UTF-8 overall.
// ---------------------------------------------------------------------------
function hasInvalidUTF8(buf, limit) {
  const end = Math.min(buf.length, limit);
  let i = 0;
  while (i < end) {
    const b = buf[i];

    if (b < 0x80) {
      i += 1; // ASCII — valid

    } else if (b >= 0xC2 && b <= 0xDF) {
      // 2-byte sequence: 110xxxxx 10xxxxxx
      if (i + 1 >= end) break;                        // truncated at limit
      if ((buf[i + 1] & 0xC0) !== 0x80) return true; // bad continuation
      i += 2;

    } else if (b >= 0xE0 && b <= 0xEF) {
      // 3-byte sequence: 1110xxxx 10xxxxxx 10xxxxxx
      if (i + 2 >= end) break;
      if ((buf[i + 1] & 0xC0) !== 0x80) return true;
      if ((buf[i + 2] & 0xC0) !== 0x80) return true;
      if (b === 0xE0 && buf[i + 1] < 0xA0) return true; // overlong (< U+0800)
      if (b === 0xED && buf[i + 1] >= 0xA0) return true; // surrogate half
      i += 3;

    } else if (b >= 0xF0 && b <= 0xF4) {
      // 4-byte sequence: 11110xxx 10xxxxxx 10xxxxxx 10xxxxxx
      if (i + 3 >= end) break;
      if ((buf[i + 1] & 0xC0) !== 0x80) return true;
      if ((buf[i + 2] & 0xC0) !== 0x80) return true;
      if ((buf[i + 3] & 0xC0) !== 0x80) return true;
      if (b === 0xF0 && buf[i + 1] < 0x90) return true; // overlong (< U+10000)
      if (b === 0xF4 && buf[i + 1] > 0x8F) return true; // > U+10FFFF
      i += 4;

    } else {
      // 0x80–0xBF: unexpected continuation byte
      // 0xC0, 0xC1: always-overlong 2-byte lead
      // 0xF5–0xFF: invalid lead bytes
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// parseCSVHeaderLine
//
// Splits a single CSV line into trimmed cell values, respecting RFC 4180
// double-quote escaping.  Used only for header-candidate detection, not for
// full data parsing (csv-parser handles that).
// ---------------------------------------------------------------------------
function parseCSVHeaderLine(line) {
  const fields = [];
  let current  = '';
  let inQuote  = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') {
        current += '"'; // escaped quote inside quoted field
        i++;
      } else {
        inQuote = !inQuote;
      }
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
//
// Scans `lines` from the top looking for the first line that satisfies the
// column-header heuristic.  Returns the 0-based line index, or -1 if no
// candidate is found within MAX_PREAMBLE_ROWS.
//
// Heuristic (see MIN_HEADER_CELLS / MIN_HEADER_FIELDS constants above for
// the threshold rationale):
//   - Skip blank lines.
//   - Parse the line as a CSV header row (parseCSVHeaderLine).
//   - Reject lines with fewer than MIN_HEADER_CELLS cells.
//   - Resolve via resolveHeaders(); if ≥ MIN_HEADER_FIELDS canonical fields
//     are matched, this is the header row.
// ---------------------------------------------------------------------------
function findHeaderRowIndex(lines) {
  for (let i = 0; i < Math.min(lines.length, MAX_PREAMBLE_ROWS); i++) {
    const line = lines[i];
    if (!line || line.trim() === '') continue;

    const cells = parseCSVHeaderLine(line);
    if (cells.length < MIN_HEADER_CELLS) continue;

    const { missing } = resolveHeaders(cells);
    const resolved = 4 - missing.length; // 4 canonical fields total
    if (resolved >= MIN_HEADER_FIELDS) return i;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// ingestCSV
//
// End-to-end CSV ingestion.  Replaces the bare parseCSV function in server.js.
//
// Steps:
//   1. Read the full file as a Buffer (sync-safe; ≤ 5 MB for all pilot use).
//   2. Detect encoding from BOM or UTF-8 byte validation.
//   3. Decode buffer → string using iconv-lite.
//   4. Normalise line endings; split into lines.
//   5. Find the column header row (skipping ERP metadata preamble if present).
//   6. Slice from the header row onward and pass to csv-parser via a Readable.
//
// Callback: (err: string|null, rows: object[], meta: IngestMeta)
//
//   err  — human-readable error message, or null on success
//   rows — parsed data row objects (populated only on success)
//   meta — always present; contains encoding details and preamble skip count
//          for inclusion in the server response and server-side logging
//
// IngestMeta shape:
//   { encoding: string, encodingMethod: string, preambleRowsSkipped: number }
// ---------------------------------------------------------------------------
function ingestCSV(filePath, callback) {
  const meta = {
    encoding:            'unknown',
    encodingMethod:      'unknown',
    preambleRowsSkipped: 0
  };

  // ── 1. Read entire file as Buffer ────────────────────────────────────────
  fs.readFile(filePath, (readErr, buf) => {
    if (readErr) {
      return callback(`Could not read the uploaded file: ${readErr.message}`, [], meta);
    }

    // ── 2. Detect encoding ────────────────────────────────────────────────
    const encResult = detectEncoding(buf);
    meta.encoding       = encResult.encoding  || 'unsupported';
    meta.encodingMethod = encResult.method;

    if (encResult.error) {
      return callback(encResult.error, [], meta);
    }

    // ── 3. Decode buffer → JS string ──────────────────────────────────────
    let decoded;
    try {
      decoded = iconv.decode(buf, encResult.encoding);
    } catch (decodeErr) {
      return callback(
        `Could not decode the file as ${encResult.encoding}: ${decodeErr.message}`,
        [], meta
      );
    }

    // Strip any BOM character that iconv may have left at position 0.
    // iconv-lite strips UTF-8 BOM natively, but this guard is inexpensive.
    if (decoded.charCodeAt(0) === 0xFEFF) decoded = decoded.slice(1);

    if (!decoded.trim()) {
      return callback('The uploaded file is empty.', [], meta);
    }

    // ── 4. Normalise line endings and split ──────────────────────────────
    const lines = decoded.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

    // ── 5. Find the column header row ────────────────────────────────────
    const headerIdx = findHeaderRowIndex(lines);

    if (headerIdx === -1) {
      return callback(
        `Could not find a valid column header row in the first ${MAX_PREAMBLE_ROWS} lines. ` +
        'The file may not be a standard inventory export, or the column names are not recognised. ' +
        'Required columns (any recognised alias is accepted): ' +
        'part number, on hand quantity, daily usage, and lead time.',
        [], meta
      );
    }

    if (headerIdx > 0) {
      console.log(`[ingestCSV] ${headerIdx} preamble row(s) skipped before column header`);
      meta.preambleRowsSkipped = headerIdx;
    }

    // ── 6. Reconstruct CSV string from header row onward and stream it ────
    const trimmedCSV = lines.slice(headerIdx).join('\n');

    const rows     = [];
    let   hadError = false;

    const readable = new Readable();
    readable.push(trimmedCSV);
    readable.push(null);

    readable
      .pipe(csv())
      .on('error', (parseErr) => {
        if (hadError) return;
        hadError = true;
        callback(
          `The file could not be parsed as a valid CSV: ${parseErr.message}`,
          [], meta
        );
      })
      .on('data', (row) => rows.push(row))
      .on('end', () => {
        if (!hadError) {
          hadError = true;
          callback(null, rows, meta);
        }
      });
  });
}

module.exports = {
  ingestCSV,
  // Exported individually for unit testing in _test_regression.js:
  detectEncoding,
  hasInvalidUTF8,
  findHeaderRowIndex,
  parseCSVHeaderLine,
};
