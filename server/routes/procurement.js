'use strict';

// ---------------------------------------------------------------------------
// server/routes/procurement.js — Procurement Copilot page + API routes.
//
// Serves the procurement HTML page shells and will host API endpoints
// (e.g. /api/procurement/upload) once ingestion is implemented.
// ---------------------------------------------------------------------------

const path    = require('path');
const express = require('express');
const router  = express.Router();

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

// ── Page routes ─────────────────────────────────────────────────────────────
// Serve static HTML shells for procurement pages.
// These are real page navigations (not SPA), consistent with how index.html
// and billing.html are served today.

router.get('/procurement', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'procurement.html'));
});

router.get('/procurement/upload', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'procurement-upload.html'));
});

// ── API routes (placeholder) ────────────────────────────────────────────────
// Future: POST /api/procurement/upload, GET /api/procurement/runs, etc.

router.get('/api/procurement/status', (_req, res) => {
  res.json({ module: 'procurement', status: 'coming_soon', version: '0.1.0' });
});

module.exports = router;
