'use strict';

// ---------------------------------------------------------------------------
// server/routes/procurement.js — Procurement Copilot page + API routes.
//
// Serves the procurement HTML page shells, the CSV upload endpoint, and
// CRUD endpoints for persisting/retrieving procurement analysis runs.
//
// API surface:
//   POST /api/procurement/upload      — validate + normalise + score an Open PO CSV
//   POST /api/procurement/runs        — persist a scored run (Pro, auth required)
//   GET  /api/procurement/runs        — list saved runs      (Pro, auth required)
//   GET  /api/procurement/runs/:id    — retrieve a full run   (Pro, auth required)
//   DELETE /api/procurement/runs/:id  — delete a run          (Pro, auth required)
//   GET  /api/procurement/status      — health / feature-flag probe
// ---------------------------------------------------------------------------

const path      = require('path');
const express   = require('express');
const multer    = require('multer');
const fs        = require('fs');
const router    = express.Router();
const rateLimit = require('express-rate-limit');

const cfg                  = require('../../config');
const { ingestPOCsv }      = require('../lib/procurement/procurementIngest');
const { analyzeRows }      = require('../lib/procurement/procurementAnalyzer');
const requireAuth          = require('../middleware/requireAuth');
const {
  saveProcurementRun,
  listProcurementRuns,
  getProcurementRun,
  deleteProcurementRun,
}                          = require('../controllers/procurementRunController');

const PUBLIC_DIR  = path.join(__dirname, '..', '..', 'public');
const UPLOAD_DIR  = path.join(__dirname, '..', '..', 'uploads');
const MAX_BYTES   = 5 * 1024 * 1024; // 5 MB

// ---------------------------------------------------------------------------
// Multer configuration — shared with inventory upload, same constraints.
// ---------------------------------------------------------------------------
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename:    (_req, file,  cb) => {
    const safe = Date.now() + '-proc-' + path.basename(file.originalname);
    cb(null, safe);
  },
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

const upload = multer({ storage, limits: { fileSize: MAX_BYTES }, fileFilter: csvFileFilter });

// ---------------------------------------------------------------------------
// Rate limiter — procurement upload is gated independently of inventory.
// ---------------------------------------------------------------------------
const uploadLimiter = rateLimit({
  windowMs:        cfg.UPLOAD_RATE_WINDOW * 60 * 1000,
  max:             cfg.UPLOAD_RATE_MAX,
  standardHeaders: true,
  legacyHeaders:   false,
  validate:        { xForwardedForHeader: false },
  handler: (_req, res) => {
    res.status(429).json({
      error:
        `Upload limit reached. You can upload up to ${cfg.UPLOAD_RATE_MAX} files ` +
        `every ${cfg.UPLOAD_RATE_WINDOW} minutes. Please wait and try again.`,
    });
  },
});

// ---------------------------------------------------------------------------
// Page routes
// ---------------------------------------------------------------------------
router.get('/procurement', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'procurement.html'));
});

router.get('/procurement/upload', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'procurement-upload.html'));
});

// ---------------------------------------------------------------------------
// POST /api/procurement/upload
//
// Accepts a multipart form upload with field name `csvfile`.
// Returns:
//   200 { ok, rows, meta, stats, warnings }   — all valid (warnings may be non-empty)
//   207 { ok, rows, meta, stats, warnings, errors } — partial: some rows invalid
//   422 { ok: false, errors, warnings }        — schema or encoding error
//   400                                         — missing file / multer error
//   429                                         — rate limit
// ---------------------------------------------------------------------------
router.post('/api/procurement/upload', uploadLimiter, (req, res) => {
  res.setTimeout(30_000, () => {
    if (req.file) fs.unlink(req.file.path, () => {});
    if (!res.headersSent)
      res.status(503).json({ error: 'Analysis timed out. Try splitting the file into smaller batches.' });
  });

  const singleUpload = upload.single('csvfile');

  singleUpload(req, res, (multerErr) => {
    if (multerErr) {
      if (req.file) fs.unlink(req.file.path, () => {});
      const msg = multerErr instanceof multer.MulterError && multerErr.code === 'LIMIT_FILE_SIZE'
        ? `File is too large. Maximum allowed size is ${MAX_BYTES / (1024 * 1024)} MB.`
        : multerErr.message || 'File upload error.';
      return res.status(400).json({ error: msg });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No file was uploaded. Please select a CSV file.' });
    }

    const filePath = req.file.path;

    ingestPOCsv(filePath, (result) => {
      // Always clean up the temp file immediately.
      fs.unlink(filePath, () => {});

      const { ok, errors, warnings, rows, meta, stats } = result;

      // Hard failure — schema or encoding error, or zero usable rows.
      if (!ok && rows.length === 0) {
        return res.status(422).json({ ok: false, errors, warnings });
      }

      // Run the risk engine over the normalised rows.
      let analysis;
      try {
        analysis = analyzeRows(rows);
      } catch (analyzerErr) {
        console.error('[procurement/upload] analyzeRows threw:', analyzerErr);
        return res.status(500).json({ error: 'Risk analysis failed due to an internal error. Please try again.' });
      }

      // Partial success — some rows had blocking errors but enough are usable.
      const status = (ok && errors.length === 0) ? 200 : 207;
      return res.status(status).json({
        ok,
        module_key: 'procurement',
        file_name:  req.file ? req.file.originalname : 'unknown',
        meta,
        stats,
        warnings,
        errors,
        // Risk analysis results
        lines:            analysis.lines,
        supplierRollups:  analysis.supplierRollups,
        insights:         analysis.insights,
        actionCandidates: analysis.actionCandidates,
        summary:          analysis.summary,
      });
    });
  });
});

// ---------------------------------------------------------------------------
// GET /api/procurement/status
// ---------------------------------------------------------------------------
router.get('/api/procurement/status', (_req, res) => {
  res.json({ module: 'procurement', status: 'active', version: '0.3.0' });
});

// ---------------------------------------------------------------------------
// Run history CRUD — auth-gated, Pro-plan required (same as inventory runs).
// ---------------------------------------------------------------------------
router.post(  '/api/procurement/runs',     requireAuth, saveProcurementRun);
router.get(   '/api/procurement/runs',     requireAuth, listProcurementRuns);
router.get(   '/api/procurement/runs/:id', requireAuth, getProcurementRun);
router.delete('/api/procurement/runs/:id', requireAuth, deleteProcurementRun);

module.exports = router;
