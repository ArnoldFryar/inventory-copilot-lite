'use strict';

/**
 * XLSX ingestion for Inventory Copilot.
 *
 * Workbooks are converted to the same array-of-objects shape produced by the
 * CSV pipeline, so header resolution, validation, and analysis remain shared.
 * ExcelJS reads workbook data only; formulas are never evaluated and macros or
 * external links are never executed.
 */

const fs = require('fs');
const ExcelJS = require('exceljs');
const { resolveHeaders } = require('./columnMap');

const MAX_PREAMBLE_ROWS = 20;
const MAX_WORKSHEETS = 50;
const MAX_DATA_ROWS = 50_000;
const MAX_COLUMNS = 200;
const MIN_HEADER_CELLS = 2;
const MIN_HEADER_FIELDS = 2;

function cellValueToScalar(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'object') return value;

  // ExcelJS represents formula cells as { formula, result }. We intentionally
  // use only the cached result and never attempt to calculate the expression.
  if (Object.prototype.hasOwnProperty.call(value, 'formula') ||
      Object.prototype.hasOwnProperty.call(value, 'sharedFormula')) {
    return cellValueToScalar(value.result);
  }

  if (Array.isArray(value.richText)) {
    return value.richText.map(run => run && run.text ? run.text : '').join('');
  }

  // Hyperlink cells expose their display value as `text`.
  if (typeof value.text === 'string') return value.text;

  // Excel error cells and unknown object-valued cells are treated as blank so
  // they flow through the analyzer's existing invalid-row diagnostics.
  return '';
}

function worksheetRowValues(worksheet, rowNumber, idColumn = -1) {
  const row = worksheet.getRow(rowNumber);
  const lastColumn = Math.min(row.cellCount || 0, MAX_COLUMNS);
  const values = [];
  for (let column = 1; column <= lastColumn; column++) {
    const cell = row.getCell(column);
    const value = cellValueToScalar(cell.value);
    const mask = cell.numFmt;
    values.push(column !== idColumn || !Number.isSafeInteger(value) || value < 0 || !/^0{2,32}$/.test(mask || '')
      ? value : String(value).padStart(mask.length, '0'));
  }
  return values;
}

function findWorksheetHeader(worksheet) {
  const scanRows = Math.min(worksheet.rowCount || 0, MAX_PREAMBLE_ROWS);

  for (let rowNumber = 1; rowNumber <= scanRows; rowNumber++) {
    const values = worksheetRowValues(worksheet, rowNumber);
    if (values.length < MIN_HEADER_CELLS) continue;

    const headers = values.map(value => String(value ?? '').trim());
    const populated = headers.filter(Boolean);
    if (populated.length < MIN_HEADER_CELLS) continue;

    const { missing } = resolveHeaders(headers);
    if (4 - missing.length >= MIN_HEADER_FIELDS) {
      return { rowNumber, headers };
    }
  }

  return null;
}

function uniqueHeaders(headers) {
  const seen = new Set();
  return headers.map((header, index) => {
    const base = String(header ?? '').trim() || `Column ${index + 1}`;
    let key = base;
    for (let i = 2; seen.has(key.toLowerCase()); i++) key = `${base} (${i})`;
    seen.add(key.toLowerCase());
    return key;
  });
}

function worksheetToRows(worksheet, headerInfo, idHeader) {
  const headers = uniqueHeaders(headerInfo.headers).slice(0, MAX_COLUMNS);
  const lastDataRow = worksheet.rowCount || 0;
  const dataRowCount = Math.max(0, lastDataRow - headerInfo.rowNumber);

  if (dataRowCount > MAX_DATA_ROWS) {
    throw new Error(
      `The worksheet "${worksheet.name}" contains more than ${MAX_DATA_ROWS.toLocaleString('en-US')} data rows. ` +
      'Split the export into smaller workbooks and try again.'
    );
  }

  const idColumn = headers.indexOf(idHeader || resolveHeaders(headers).mapping.part_number) + 1;
  const rows = [];
  for (let rowNumber = headerInfo.rowNumber + 1; rowNumber <= lastDataRow; rowNumber++) {
    const values = worksheetRowValues(worksheet, rowNumber, idColumn);
    const row = Object.create(null);
    for (let column = 0; column < headers.length; column++) {
      row[headers[column]] = column < values.length ? values[column] : '';
    }
    rows.push(row);
  }
  return rows;
}

// Workbook containers must fit the expansion budget before ExcelJS builds its model.
function validateZipBudget(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0 || end + 22 > buffer.length) throw new Error('Invalid workbook container.');
  const entries = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  let expanded = 0;
  if (entries > 2048) throw new Error('The workbook contains too many items.');
  for (let index = 0; index < entries; index++) {
    if (offset + 46 > end || buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('Invalid workbook container.');
    }
    expanded += buffer.readUInt32LE(offset + 24);
    if (expanded > 64 * 1024 * 1024) throw new Error('The workbook expands beyond the 64 MB processing limit.');
    offset += 46 + buffer.readUInt16LE(offset + 28) + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32);
  }
}

async function parseWorkbook(filePath, options = {}) {
  const buffer = await fs.promises.readFile(filePath);
  const workbook = new ExcelJS.Workbook();

  try {
    validateZipBudget(buffer);
    await workbook.xlsx.load(buffer, {
      ignoreNodes: [
        'dataValidations',
        'extLst',
        'pageMargins',
        'pageSetup',
        'printOptions',
        'sheetPr',
      ],
    });
  } catch (error) {
    if (/processing limit|too many items/.test(error.message)) throw error;
    throw new Error(
      'The Excel workbook could not be opened. It may be corrupted, password-protected, or not a valid .xlsx file.'
    );
  }

  if (workbook.worksheets.length === 0) {
    throw new Error('The Excel workbook does not contain any worksheets.');
  }
  if (workbook.worksheets.length > MAX_WORKSHEETS) {
    throw new Error(
      `The Excel workbook contains more than ${MAX_WORKSHEETS} worksheets. ` +
      'Remove unused worksheets and try again.'
    );
  }

  const visible = workbook.worksheets.filter(sheet => sheet.state === 'visible');
  const explicitHeader = sheet => {
    if (!options.headerRow) return null;
    const headers = worksheetRowValues(sheet, options.headerRow);
    return headers.filter(value => String(value).trim()).length >= 2 ? { rowNumber: options.headerRow, headers } : null;
  };
  const fallbackHeader = sheet => {
    for (let rowNumber = 1; rowNumber <= Math.min(sheet.rowCount, MAX_PREAMBLE_ROWS); rowNumber++) {
      const headers = worksheetRowValues(sheet, rowNumber);
      if (headers.filter(value => String(value).trim()).length >= 2) return { rowNumber, headers };
    }
    return null;
  };
  const sheets = visible.map(worksheet => ({
    worksheet,
    detected: findWorksheetHeader(worksheet),
    fallback: options.allowCustomHeaders ? fallbackHeader(worksheet) : null,
  }));
  const candidates = sheets.filter(sheet => sheet.detected || sheet.fallback);
  const selected = options.worksheet
    ? sheets.find(sheet => sheet.worksheet.name === options.worksheet)
    : sheets.find(sheet => sheet.detected) || candidates[0];
  const header = selected && (options.headerRow ? explicitHeader(selected.worksheet) : selected.detected || selected.fallback);
  if (!header) {
    throw new Error('Could not find an inventory header in the selected worksheet. Check the first 20 rows.');
  }
  const rows = worksheetToRows(selected.worksheet, header, options.idHeader);

  return {
    rows,
    meta: {
      encoding: 'xlsx',
      encodingMethod: 'exceljs-workbook',
      preambleRowsSkipped: header.rowNumber - 1,
      headers: uniqueHeaders(header.headers),
      worksheetCandidates: candidates.map(sheet => sheet.worksheet.name),
      worksheet: selected.worksheet.name,
      worksheetsAvailable: workbook.worksheets.map(worksheet => worksheet.name),
    },
  };
}

function ingestXLSX(filePath, callback, options) {
  parseWorkbook(filePath, options)
    .then(({ rows, meta }) => callback(null, rows, meta))
    .catch(error => {
      const meta = {
        encoding: 'xlsx',
        encodingMethod: 'exceljs-workbook',
        preambleRowsSkipped: 0,
        worksheet: null,
        worksheetsAvailable: [],
      };
      callback(error.message || 'The Excel workbook could not be parsed.', [], meta);
    });
}

module.exports = {
  ingestXLSX,
  parseWorkbook,
  cellValueToScalar,
  findWorksheetHeader,
  worksheetToRows,
  MAX_DATA_ROWS,
  MAX_COLUMNS,
};
