'use strict';

// ---------------------------------------------------------------------------
// system routes — public/infra endpoints that don't require authentication.
//
// GET /api/health       — liveness probe
// GET /api/health/deps  — dependency configuration diagnostics (no secrets)
// GET /api/config       — business thresholds
// GET /api/auth-config  — public Supabase credentials for the frontend SDK
// POST /api/event       — client-side telemetry sink
// GET /sample-data      — bundled demo CSV download
// GET /api/demo-analysis — demo triage run without file upload
// ---------------------------------------------------------------------------

const express = require('express');
const path    = require('path');
const router  = express.Router();

const cfg                      = require('../../config');
const { analyzeRows }          = require('../../analyzer');
const { stripeConfigured }     = require('../../plans');
const {
  isConfigured: supabaseConfigured,
  SUPABASE_URL,
  SUPABASE_ANON_KEY
}                              = require('../../supabaseClient');

const demoRows = require('../demo/sampleInventory.json');

// ---------------------------------------------------------------------------
// GET /api/health — lightweight liveness probe.
// ---------------------------------------------------------------------------
router.get('/api/health', (_req, res) => {
  try {
    res.json({ status: 'ok', timestamp: Date.now() });
  } catch (_) {
    res.status(500).json({ status: 'error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/health/deps — dependency diagnostics (configuration presence only).
// ---------------------------------------------------------------------------
router.get('/api/health/deps', (_req, res) => {
  try {
    res.json({
      server:             'ok',
      stripeConfigured:   stripeConfigured,
      supabaseConfigured: supabaseConfigured,
      openaiConfigured:   Boolean((process.env.OPENAI_API_KEY || '').trim()),
      env: {
        NODE_ENV: process.env.NODE_ENV || 'development'
      }
    });
  } catch (_) {
    res.status(500).json({ status: 'error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/config — exposes active business thresholds to the frontend.
// ---------------------------------------------------------------------------
router.get('/api/config', (_req, res) => {
  res.json({
    critical_ratio:   cfg.CRITICAL_RATIO,
    urgent_ratio:     cfg.URGENT_RATIO,
    excess_ratio:     cfg.EXCESS_RATIO,
    dead_stock_ratio: cfg.DEAD_STOCK_RATIO,
    top_priority_max: cfg.TOP_PRIORITY_MAX
  });
});

// ---------------------------------------------------------------------------
// GET /api/auth-config — exposes public Supabase credentials to the frontend.
// ---------------------------------------------------------------------------
router.get('/api/auth-config', (_req, res) => {
  if (!supabaseConfigured) {
    return res.json({ configured: false });
  }
  res.json({
    configured:      true,
    supabaseUrl:     SUPABASE_URL,
    supabaseAnonKey: SUPABASE_ANON_KEY
  });
});

// ---------------------------------------------------------------------------
// POST /api/event — client-side telemetry sink.
// Only enumerated event names and aggregate numeric props are logged.
// ---------------------------------------------------------------------------
router.post('/api/event', (req, res) => {
  const { event, props } = req.body || {};
  if (typeof event !== 'string' || event.length < 1 || event.length > 64) {
    return res.status(400).json({ error: 'Invalid event.' });
  }
  const safe = {
    ts:    new Date().toISOString(),
    event: event.replace(/[^\w._-]/g, ''),
    props: (props && typeof props === 'object' && !Array.isArray(props)) ? props : {}
  };
  console.log('EVENT', JSON.stringify(safe));
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// GET /sample-data — serves the bundled demo CSV as a file download.
// ---------------------------------------------------------------------------
router.get('/sample-data', (_req, res) => {
  const filePath = path.join(__dirname, '..', '..', 'public', 'sample.csv');
  res.download(filePath, 'sample_inventory.csv', (err) => {
    if (err && !res.headersSent) {
      res.status(500).json({ error: 'Sample file not available.' });
    }
  });
});

// ---------------------------------------------------------------------------
// GET /api/demo-analysis — runs the triage engine on the bundled sample data.
// ---------------------------------------------------------------------------
router.get('/api/demo-analysis', (_req, res) => {
  try {
    const result = analyzeRows(demoRows);
    res.json(result);
  } catch (err) {
    console.error('[demo-analysis] error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Demo analysis failed.' });
    }
  }
});

// ---------------------------------------------------------------------------
// GET /api/modules — lists enabled product modules.
// ---------------------------------------------------------------------------
const { getEnabledModules } = require('../lib/modules');

router.get('/api/modules', (_req, res) => {
  var modules = getEnabledModules().map(function (m) {
    var mod = { key: m.key, name: m.name, shortName: m.shortName, icon: m.icon, path: m.path, description: m.description };
    if (m.badge) mod.badge = m.badge;
    if (m.subPages) mod.subPages = m.subPages;
    return mod;
  });
  res.json({ modules: modules });
});

module.exports = router;
