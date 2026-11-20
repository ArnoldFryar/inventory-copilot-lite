'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { analyzeRows, normalizeUnit } = require('../../analyzer');
const cfg = require('../../config');
const { ALIASES, REQUIRED_FIELDS, resolveHeaders } = require('../../columnMap');
const { ingestCSV } = require('../../csvIngest');
const { parseWorkbook, MAX_DATA_ROWS } = require('../../xlsxIngest');
const { getPlan, getPlanForUser, applyPlanLimits } = require('../../plans');
const { supabaseAdmin, verifyToken } = require('../../supabaseClient');
const { retain } = require('../lib/runSnapshots');

const router = express.Router();
const MAX_BYTES = 5 * 1024 * 1024;
const uploadDirectory = path.join(os.tmpdir(), 'opscopilot-inventory-' + process.getuid?.());
const MANDATORY = ['part_number', 'on_hand'];
const UNSPECIFIC_HEADERS = new Set(['quantity', 'qty', 'available', 'available qty', 'available_qty',
  'available to promise', 'atp', 'consumption', 'avg usage', 'average usage', 'avg demand', 'average demand', 'usage rate', 'lt']);
const storage = multer.diskStorage({
  destination: (_req, _file, callback) => fs.mkdir(uploadDirectory, { recursive: true, mode: 0o700 })
    .then(() => callback(null, uploadDirectory), callback),
  filename: (_req, _file, callback) => callback(null, randomUUID()),
});
const upload = multer({
  storage,
  limits: { fileSize: MAX_BYTES, files: 1, fields: 8, fieldSize: 24 * 1024 },
  fileFilter: (_req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    callback(['.csv', '.xlsx'].includes(extension) ? null : new multer.MulterError('LIMIT_UNEXPECTED_FILE'), true);
  },
}).single('csvfile');

const limitUploads = rateLimit({
  windowMs: cfg.UPLOAD_RATE_WINDOW * 60 * 1000,
  max: cfg.UPLOAD_RATE_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
  message: { error: 'Upload limit reached. Please wait and try again.' },
});

async function expireAbandonedUploads() {
  const filenames = await fs.readdir(uploadDirectory).catch(() => []);
  for (const filename of filenames) {
    const location = path.join(uploadDirectory, filename);
    const stat = await fs.stat(location).catch(() => null);
    if (stat?.isFile() && Date.now() - stat.mtimeMs > 60 * 60 * 1000) {
      await fs.unlink(location).catch(() => {});
    }
  }
}
expireAbandonedUploads();
setInterval(expireAbandonedUploads, 15 * 60 * 1000).unref();

function readOptions(body) {
  const value = body.mapping ? JSON.parse(body.mapping) : null;
  if (value && (typeof value !== 'object' || Array.isArray(value))) throw new Error('Choose a valid column mapping.');
  const headerRow = body.headerRow ? Number(body.headerRow) : undefined;
  if (headerRow !== undefined && (!Number.isInteger(headerRow) || headerRow < 1 || headerRow > 20)) {
    throw new Error('Choose a header row within the first 20 rows.');
  }
  const usagePeriodDays = body.usagePeriodDays ? Number(body.usagePeriodDays) : 1;
  if (!Number.isInteger(usagePeriodDays) || usagePeriodDays < 1 || usagePeriodDays > 3660) {
    throw new Error('Enter the number of calendar days covered by the usage column.');
  }
  const leadTimeUnit = body.leadTimeUnit || 'calendar_days';
  if (!['calendar_days', 'calendar_weeks', 'unavailable'].includes(leadTimeUnit)) {
    throw new Error('Use calendar days or calendar weeks for lead time.');
  }
  return { supplied: value,
    headerRow, usagePeriodDays, leadTimeUnit, worksheet: body.worksheet || undefined };
}

function parseInventory(filePath, format, options) {
  const settings = { ...options, allowCustomHeaders: true, maxRows: MAX_DATA_ROWS, idHeader: options.supplied?.part_number };
  if (format === 'xlsx') return parseWorkbook(filePath, settings);
  return new Promise((resolve, reject) => ingestCSV(filePath, (err, rows, meta) => {
    if (err) reject(new Error(err));
    else resolve({ rows, meta });
  }, settings));
}

function reviewColumns(headers, options) {
  const { mapping, candidates } = resolveHeaders(headers);
  if (options.supplied !== null) {
    for (const field of Object.keys(ALIASES)) {
      delete mapping[field];
      const choice = options.supplied[field];
      if (choice === undefined || choice === null || choice === '') continue;
      if (typeof choice !== 'string' || !headers.includes(choice)) throw new Error('A selected column is absent. Choose its current name.');
      mapping[field] = choice;
    }
  }
  if (options.leadTimeUnit === 'unavailable') delete mapping.lead_time;
  const missing = REQUIRED_FIELDS.filter(field => !mapping[field]);
  const ambiguous = [...REQUIRED_FIELDS, 'site', 'uom', 'usage_uom'].filter(field =>
    candidates[field].length > 1 || UNSPECIFIC_HEADERS.has(mapping[field]?.trim().toLowerCase()));
  if (new Set(Object.values(mapping)).size !== Object.values(mapping).length) {
    throw new Error('Use a different source column for each inventory field.');
  }
  const aliases = Object.fromEntries(Object.entries(mapping).filter(([key, value]) => key !== value));
  return { mapping, candidates, missing, ambiguous, aliases };
}

async function analyzeUpload(req, res) {
  res.set('Cache-Control', 'no-store');
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'Choose a CSV or XLSX inventory file.' });
  try {
    const options = readOptions(req.body || {});
    const format = path.extname(file.originalname).toLowerCase().slice(1);
    const { rows, meta } = await parseInventory(file.path, format, options);
    const entries = rows.map((row, index) => [row, index + (meta.preambleRowsSkipped || 0) + 2])
      .filter(([row]) => Object.values(row).some(value => String(value ?? '').trim()));
    if (!entries.length) return res.status(422).json({ error: 'This file has a header but no inventory rows.' });

    const headers = meta.headers || Object.keys(entries[0][0]);
    const review = reviewColumns(headers, options);
    const needsSheet = !options.worksheet && meta.worksheetCandidates?.length > 1;
    const needsReview = options.supplied === null &&
      (review.missing.length || review.ambiguous.length || needsSheet);
    if (req.body.inspect === 'true' || needsReview) {
      return res.status(req.body.inspect === 'true' ? 200 : 422).json({
        code: 'mapping_required',
        error: needsSheet ? 'Choose the inventory worksheet.' : 'Review column mapping before analyzing.',
        headers, requiresReview: Boolean(needsReview), mapping: review.mapping, candidates: review.candidates, missing: review.missing,
        worksheet: meta.worksheet, worksheets: meta.worksheetsAvailable,
        headerRow: (meta.preambleRowsSkipped || 0) + 1,
        examples: entries.slice(0, 3).map(([row]) => headers.map(header => String(row[header] ?? '').slice(0, 90))),
        rowCount: entries.length,
      });
    }
    if (MANDATORY.some(field => !review.mapping[field])) {
      return res.status(422).json({ error: 'Map a part number column and an on-hand quantity column.' });
    }

    let owner = null;
    const token = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
    if (token) {
      const { user } = await verifyToken(token);
      if (!user) return res.status(401).json({ error: 'Your session has expired. Sign in again to analyze this file.' });
      owner = user.id;
    }
    const plan = owner ? await getPlanForUser(owner, supabaseAdmin) : getPlan();
    if (entries.some(([row]) => Object.values(review.mapping).some(header => String(row[header] ?? '').length > 500))) {
      return res.status(422).json({ error: 'A mapped field contains more than 500 characters. Select inventory fields or shorten long descriptions.' });
    }
    const result = analyzeRows(entries.map(([row]) => row), {
      ...review, ...options, sourceRows: entries.map(([, index]) => index),
    });
    const locations = [...new Set(result.results.map(row => String(row.site || '').toUpperCase()))].sort();
    const units = [...new Set(result.results.map(row => normalizeUnit(row.uom)))].sort();
    const stockBasis = /available|\batp\b|unrestricted/i.test(review.mapping.on_hand) ? 'available' : 'on-hand';
    const coverageBasis = JSON.stringify([locations, units, options.usagePeriodDays, stockBasis]);
    applyPlanLimits(plan, result);
    Object.assign(result, {
      sourceFormat: format, worksheet: meta.worksheet, worksheetsAvailable: meta.worksheetsAvailable,
      encodingDetected: meta.encoding, preambleRowsSkipped: meta.preambleRowsSkipped,
      module_key: 'inventory', fileName: file.originalname.slice(0, 255),
      sourceType: /^sample_inventory\.csv$/i.test(file.originalname) && req.body.sample === 'true' ? 'sample' : 'manual',
      inputScope: review.missing.length ? 'limited' : 'ranked',
      missingColumns: review.missing, columnMapping: review.mapping, coverageBasis,
      usagePeriodDays: options.usagePeriodDays, leadTimeUnit: options.leadTimeUnit,
    });
    if (owner && plan.savedHistory && !result.resultsTruncated && result.sourceType === 'manual') {
      result.analysisId = await retain(owner, result);
    }
    if (!res.destroyed && !res.headersSent) res.json(result);
  } finally {
    await fs.unlink(file.path).catch(() => {});
  }
}

router.post('/upload', limitUploads, (req, res) => {
  res.setTimeout(30_000, () => {
    if (!res.headersSent && !res.destroyed) res.status(503).json({ error: 'Analysis took too long. Try a smaller file.' });
  });
  upload(req, res, error => {
    if (error) {
      const message = error.code === 'LIMIT_FILE_SIZE' ? 'The file exceeds the 5 MB upload limit.' :
        error.code === 'LIMIT_UNEXPECTED_FILE' ? 'Only .csv and .xlsx files are accepted.' : 'The file could not be uploaded.';
      return res.status(400).json({ error: message });
    }
    analyzeUpload(req, res).catch(error => {
      if (res.headersSent || res.destroyed) return;
      res.status(422).json({ error: error instanceof SyntaxError ? 'The column mapping is invalid.' : error.message });
    });
  });
});

module.exports = router;
