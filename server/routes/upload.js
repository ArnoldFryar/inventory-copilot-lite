'use strict';

// ---------------------------------------------------------------------------
// upload routes — CSV file upload + analysis pipeline.
//
// POST /upload — ingest a user-supplied CSV, run the triage engine, return results.
// ---------------------------------------------------------------------------

const express   = require('express');
const rateLimit = require('express-rate-limit');
const multer    = require('multer');
const fs        = require('fs');
const path      = require('path');
const router    = express.Router();

const { analyzeRows }                    = require('../../analyzer');
const cfg                                = require('../../config');
const { resolveHeaders, acceptedNames }  = require('../../columnMap');
const { ingestCSV }                      = require('../../csvIngest');
const { getPlan, getPlanForUser, applyPlanLimits } = require('../../plans');
const { supabaseAdmin, verifyToken }     = require('../../supabaseClient');

// ---------------------------------------------------------------------------
// Multer configuration
// ---------------------------------------------------------------------------
const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads');
const MAX_BYTES  = 5 * 1024 * 1024; // 5 MB

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename:    (_req, file,  cb) => {
    const safe = Date.now() + '-' + path.basename(file.originalname);
    cb(null, safe);
  }
});

function csvFileFilter(_req, file, cb) {
  const ext  = path.extname(file.originalname).toLowerCase();
  const mime = file.mimetype;

  const extOk  = ext === '.csv';
  const mimeOk = mime === 'text/csv' || mime === 'text/plain' ||
                 mime === 'application/vnd.ms-excel' ||
                 mime === 'application/octet-stream';

  if (extOk && mimeOk) {
    cb(null, true);
  } else {
    cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'Only .csv files are accepted.'));
  }
}

const upload = multer({
  storage,
  limits:     { fileSize: MAX_BYTES },
  fileFilter: csvFileFilter
});

// ---------------------------------------------------------------------------
// Rate limiter — applied only to /upload
// ---------------------------------------------------------------------------
const uploadLimiter = rateLimit({
  windowMs:        cfg.UPLOAD_RATE_WINDOW * 60 * 1000,
  max:             cfg.UPLOAD_RATE_MAX,
  standardHeaders: true,
  legacyHeaders:   false,
  validate: { xForwardedForHeader: false },
  handler: (_req, res) => {
    res.status(429).json({
      error:
        `Upload limit reached. You can upload up to ${cfg.UPLOAD_RATE_MAX} files ` +
        `every ${cfg.UPLOAD_RATE_WINDOW} minutes. Please wait a moment and try again.`
    });
  }
});

// ---------------------------------------------------------------------------
// POST /upload — main CSV ingestion endpoint
// ---------------------------------------------------------------------------
router.post('/upload', uploadLimiter, (req, res) => {
  // Hard timeout — 30 s is generous for any realistic upload size.
  res.setTimeout(30_000, () => {
    if (req.file) fs.unlink(req.file.path, () => {});
    if (!res.headersSent)
      res.status(503).json({ error: 'Analysis timed out. The 5 MB limit supports roughly 50,000 rows. Try splitting the file into smaller batches (e.g. one product family or site at a time) and re-uploading.' });
  });

  const singleUpload = upload.single('csvfile');

  singleUpload(req, res, (err) => {
    // --- multer / pre-parse errors -------------------------------------------
    if (err) {
      if (err instanceof multer.MulterError) {
        if (req.file) fs.unlink(req.file.path, () => {});
        const msg = err.code === 'LIMIT_FILE_SIZE'
          ? `File is too large. Maximum allowed size is ${MAX_BYTES / (1024 * 1024)} MB.`
          : err.message || 'File upload error.';
        return res.status(400).json({ error: msg });
      }
      if (req.file) fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: err.message || 'File upload error.' });
    }

    // --- empty / missing upload ----------------------------------------------
    if (!req.file) {
      return res.status(400).json({ error: 'No file was uploaded. Please select a CSV file.' });
    }

    const filePath = req.file.path;

    // --- parse & analyze -----------------------------------------------------
    ingestCSV(filePath, async (parseErr, rows, ingestMeta) => {
      fs.unlink(filePath, () => {});

      if (parseErr) {
        return res.status(422).json({ error: parseErr });
      }

      if (rows.length === 0) {
        return res.status(422).json({ error: 'The uploaded CSV contains no data rows.' });
      }

      const dataRows = rows.filter(row =>
        Object.values(row).some(v => v !== null && String(v).trim() !== '')
      );

      if (dataRows.length === 0) {
        return res.status(422).json({ error: 'The uploaded CSV contains no data rows.' });
      }

      // Delimiter detection
      const parsedKeys = Object.keys(dataRows[0]);
      if (parsedKeys.length === 1) {
        const singleKey = parsedKeys[0];
        if (/;/.test(singleKey)) {
          return res.status(422).json({
            error:
              'This file appears to use semicolons (;) as the column delimiter. ' +
              'OpsCopilot-Lite expects standard comma-separated CSV. ' +
              'In Excel: File → Save As → "CSV (Comma delimited) (*.csv)". ' +
              'In SAP: set the field delimiter to comma before exporting.'
          });
        }
        if (/\t/.test(singleKey)) {
          return res.status(422).json({
            error:
              'This file appears to use tabs as the column delimiter. ' +
              'OpsCopilot-Lite expects comma-separated CSV. ' +
              'Open the file in Excel and save as "CSV (Comma delimited) (*.csv)".'
          });
        }
        if (/\|/.test(singleKey)) {
          return res.status(422).json({
            error:
              'This file appears to use pipes (|) as the column delimiter. ' +
              'OpsCopilot-Lite expects comma-separated CSV. ' +
              'Open the file in Excel or a text editor and save as comma-delimited CSV.'
          });
        }
      }

      // Schema validation
      const { mapping, aliases, missing } = resolveHeaders(Object.keys(dataRows[0]));
      if (missing.length > 0) {
        const FRIENDLY_FIELD = {
          part_number: 'Part Number',
          on_hand:     'Quantity on Hand',
          daily_usage: 'Daily Usage',
          lead_time:   'Lead Time (calendar days)'
        };
        const FIELD_EXAMPLES = {
          part_number: 'Part No, Item, SKU, Material',
          on_hand:     'QTY ON HAND, On Hand, Stock, Balance',
          daily_usage: 'Avg Daily Usage, ADU, Consumption',
          lead_time:   'Lead Time, LT, LT Days'
        };
        const hints = missing
          .map(f => `${FRIENDLY_FIELD[f] || f} (e.g. ${FIELD_EXAMPLES[f] || acceptedNames(f)})`)
          .join('; ');
        return res.status(422).json({
          error:
            `This file is missing required column${missing.length > 1 ? 's' : ''}: ${hints}. ` +
            `Download the sample CSV for the full list of accepted column names.`
        });
      }

      // Run the analyzer
      let result;
      try {
        result = analyzeRows(dataRows, { mapping, aliases });
      } catch (analyzeErr) {
        console.error('[/upload] analyzeRows threw:', analyzeErr);
        return res.status(500).json({ error: 'Analysis failed due to an internal error. Please try again.' });
      }

      // Apply plan limits
      const authHeader = req.headers.authorization || '';
      const authToken  = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
      let uploadPlan = getPlan();
      try {
        if (authToken && supabaseAdmin) {
          const { user: authUser } = await verifyToken(authToken);
          if (authUser) uploadPlan = await getPlanForUser(authUser.id, supabaseAdmin);
        }
      } catch (planErr) {
        console.error('[/upload] plan resolution error:', planErr.message);
      }
      applyPlanLimits(uploadPlan, result);

      result.preambleRowsSkipped = ingestMeta.preambleRowsSkipped;
      result.encodingDetected    = ingestMeta.encoding;
      // module_key is carried through so the client can tag any auto-save
      // it performs with the correct module.  Inventory upload always sets
      // 'inventory'; procurement will override this when its route lands.
      result.module_key          = 'inventory';

      return res.json(result);
    });
  });
});

module.exports = router;
