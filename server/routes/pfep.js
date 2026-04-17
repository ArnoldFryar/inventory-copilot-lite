'use strict';

// ---------------------------------------------------------------------------
// server/routes/pfep.js — PFEP (Plan For Every Part) page + API routes.
//
// Serves the PFEP HTML pages and the full API surface.
//
// API surface:
//   POST /api/pfep/upload         — validate + normalise + score a PFEP CSV
//   POST /api/pfep/runs           — persist a scored run (Pro, auth required)
//   GET  /api/pfep/runs           — list saved runs      (Pro, auth required)
//   GET  /api/pfep/runs/:id       — retrieve a full run  (Pro, auth required)
//   DELETE /api/pfep/runs/:id     — delete a run         (Pro, auth required)
//   GET  /api/pfep/parts          — list register parts  (Pro, auth required)
//   GET  /api/pfep/status         — health / feature-flag probe
// ---------------------------------------------------------------------------

const path      = require('path');
const express   = require('express');
const multer    = require('multer');
const fs        = require('fs');
const router    = express.Router();
const rateLimit = require('express-rate-limit');

const cfg                 = require('../../config');
const { ingestPFEPCsv }   = require('../lib/pfep/pfepIngest');
const { analyzeRegister } = require('../lib/pfep/pfepAnalyzer');
const requireAuth         = require('../middleware/requireAuth');
const {
  savePFEPRun,
  listPFEPParts,
  listPFEPRuns,
  getPFEPRun,
  deletePFEPRun,
} = require('../controllers/pfepController');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads');
const MAX_BYTES  = 5 * 1024 * 1024; // 5 MB

// ---------------------------------------------------------------------------
// Multer
// ---------------------------------------------------------------------------
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename:    (_req, file,  cb) => {
    const safe = Date.now() + '-pfep-' + path.basename(file.originalname);
    cb(null, safe);
  },
});

function csvFileFilter(_req, file, cb) {
  const ext    = path.extname(file.originalname).toLowerCase();
  const mime   = file.mimetype;
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
// Rate limiter
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
router.get('/pfep', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'pfep.html'));
});

router.get('/pfep/upload', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'pfep-upload.html'));
});

// ---------------------------------------------------------------------------
// POST /api/pfep/upload
//
// Accepts a multipart/form-data upload with field name `csvfile`.
// Returns:
//   200 { ok, rows, alerts, summary, meta, stats, warnings }
//   207 { ok, rows, alerts, summary, meta, stats, warnings, errors }  — partial
//   422 { ok: false, errors, warnings }  — schema or encoding error
//   400  — missing file / multer error
//   429  — rate limit
// ---------------------------------------------------------------------------
router.post('/api/pfep/upload', uploadLimiter, (req, res) => {
  res.setTimeout(30_000, () => {
    if (req.file) fs.unlink(req.file.path, () => {});
    if (!res.headersSent)
      res.status(503).json({ error: 'Analysis timed out. Try splitting the file into smaller batches.' });
  });

  const singleUpload = upload.single('csvfile');

  singleUpload(req, res, async (multerErr) => {
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

    const filePath  = req.file.path;
    const origName  = req.file.originalname;
    let ingestResult;

    try {
      ingestResult = await ingestPFEPCsv(filePath);
    } catch (e) {
      fs.unlink(filePath, () => {});
      console.error('[pfep/upload] ingestPFEPCsv threw:', e);
      return res.status(500).json({ error: 'Failed to parse PFEP file.' });
    } finally {
      fs.unlink(filePath, () => {});
    }

    if (res.headersSent) return;

    const { ok, errors, warnings, rows, meta, stats } = ingestResult;

    if (!ok && rows.length === 0) {
      return res.status(422).json({ ok: false, errors, warnings });
    }

    let analysis;
    try {
      analysis = analyzeRegister(rows);
    } catch (e) {
      console.error('[pfep/upload] analyzeRegister threw:', e);
      return res.status(500).json({ error: 'PFEP analysis failed.' });
    }

    const status = (ok && errors.length === 0) ? 200 : 207;
    return res.status(status).json({
      ok,
      module_key: 'pfep',
      file_name:  origName,
      meta,
      stats,
      warnings,
      errors,
      rows,
      alerts:  analysis.alerts,
      summary: analysis.summary,
    });
  });
});

// ---------------------------------------------------------------------------
// Authenticated persistence endpoints
// ---------------------------------------------------------------------------
router.post('/api/pfep/runs',      requireAuth, savePFEPRun);
router.get('/api/pfep/runs',       requireAuth, listPFEPRuns);
router.get('/api/pfep/runs/:id',   requireAuth, getPFEPRun);
router.delete('/api/pfep/runs/:id', requireAuth, deletePFEPRun);
router.get('/api/pfep/parts',      requireAuth, listPFEPParts);

// ---------------------------------------------------------------------------
// GET /api/pfep/status — health probe + feature-flag check
// ---------------------------------------------------------------------------
router.get('/api/pfep/status', (_req, res) => {
  res.json({
    module:  'pfep',
    enabled: true,
    version: '1.0.0',
    upload_limit_mb: MAX_BYTES / (1024 * 1024),
  });
});

module.exports = router;
