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
const MIN_HEADER_CELLS = 3;
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

function worksheetRowValues(worksheet, rowNumber) {
  const row = worksheet.getRow(rowNumber);
  const lastColumn = Math.min(row.cellCount || 0, MAX_COLUMNS);
  const values = [];
  for (let column = 1; column <= lastColumn; column++) {
    values.push(cellValueToScalar(row.getCell(column).value));
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
  const seen = new Map();
  return headers.map((header, index) => {
    const base = String(header ?? '').trim() || `Column ${index + 1}`;
    const count = seen.get(base) || 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base} (${count + 1})`;
  });
}

function worksheetToRows(worksheet, headerInfo) {
  const headers = uniqueHeaders(headerInfo.headers).slice(0, MAX_COLUMNS);
  const lastDataRow = worksheet.rowCount || 0;
  const dataRowCount = Math.max(0, lastDataRow - headerInfo.rowNumber);

  if (dataRowCount > MAX_DATA_ROWS) {
    throw new Error(
      `The worksheet "${worksheet.name}" contains more than ${MAX_DATA_ROWS.toLocaleString('en-US')} data rows. ` +
      'Split the export into smaller workbooks and try again.'
    );
  }

  const rows = [];
  for (let rowNumber = headerInfo.rowNumber + 1; rowNumber <= lastDataRow; rowNumber++) {
    const values = worksheetRowValues(worksheet, rowNumber);
    const row = {};
    for (let column = 0; column < headers.length; column++) {
      row[headers[column]] = column < values.length ? values[column] : '';
    }
    rows.push(row);
  }
  return rows;
}

async function parseWorkbook(filePath) {
  const buffer = await fs.promises.readFile(filePath);
  const workbook = new ExcelJS.Workbook();

  try {
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
  } catch (_error) {
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

  const candidates = workbook.worksheets
    .map(worksheet => ({ worksheet, header: findWorksheetHeader(worksheet) }))
    .filter(candidate => candidate.header);

  if (candidates.length === 0) {
    throw new Error(
      `Could not find a valid inventory header row in the first ${MAX_PREAMBLE_ROWS} rows of any worksheet. ` +
      'Required columns (recognized aliases are accepted): part number, on hand quantity, daily usage, and lead time.'
    );
  }

  const selected = candidates.find(candidate => candidate.worksheet.state === 'visible') || candidates[0];
  const rows = worksheetToRows(selected.worksheet, selected.header);

  return {
    rows,
    meta: {
      encoding: 'xlsx',
      encodingMethod: 'exceljs-workbook',
      preambleRowsSkipped: selected.header.rowNumber - 1,
      worksheet: selected.worksheet.name,
      worksheetsAvailable: workbook.worksheets.map(worksheet => worksheet.name),
    },
  };
}

function ingestXLSX(filePath, callback) {
  parseWorkbook(filePath)
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
