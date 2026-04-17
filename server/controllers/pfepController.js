'use strict';

// ---------------------------------------------------------------------------
// server/controllers/pfepController.js — persistence handlers for the PFEP
// (Plan For Every Part) register module.
//
// API surface (mounted by server/routes/pfep.js):
//   POST   /api/pfep/upload           — ingest + score a PFEP CSV (no auth req)
//   POST   /api/pfep/runs             — persist a PFEP import run (Pro, auth req)
//   GET    /api/pfep/parts            — list user's current register (Pro, auth req)
//   GET    /api/pfep/runs             — list import history runs (Pro, auth req)
//   GET    /api/pfep/runs/:id         — retrieve full run (Pro, auth req)
//   DELETE /api/pfep/runs/:id         — delete a run + associated parts if desired
//
// Persistence writes to:
//   1. analysis_runs   (module_key = 'pfep', summary + alert results)
//   2. pfep_parts      (upserted per part number — idempotent re-import)
//
// Auth: all *save* handlers assume requireAuth has set req.user.
// Plan: savedHistory required for persistence.
// ---------------------------------------------------------------------------

const { getPlanForUser }      = require('../../plans');
const { supabaseAdmin }       = require('../../supabaseClient');

function logAccessDenied(route, userId) {
  console.warn('[PFEP][ACCESS_DENIED]', route, { user_id: userId, reason: 'plan_not_pro' });
}

// ---------------------------------------------------------------------------
// POST /api/pfep/runs — persist a complete PFEP import run.
//
// Expects req.body:
//   { file_name, rows, alerts, summary, meta, stats, warnings, errors, source_type }
//
// Pipeline:
//   1. Insert analysis_runs row (module_key = 'pfep')
//   2. Upsert pfep_parts rows  (ON CONFLICT (user_id, part_number) — idempotent)
// ---------------------------------------------------------------------------
async function savePFEPRun(req, res) {
  try {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Database is not configured.' });
    }

    const plan = await getPlanForUser(req.user.id, supabaseAdmin);
    if (!plan.savedHistory) {
      logAccessDenied('POST /api/pfep/runs', req.user.id);
      return res.status(403).json({ error: 'Saved history is a Pro plan feature.' });
    }

    const {
      file_name   = 'unknown',
      rows        = [],
      alerts      = [],
      summary     = {},
      meta        = {},
      stats       = {},
      warnings    = [],
      errors      = [],
      source_type,
    } = req.body || {};

    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: 'No PFEP part rows provided.' });
    }

    const userId   = req.user.id;
    const fileName = typeof file_name === 'string' ? file_name.slice(0, 255) : 'unknown';
    const srcValid = source_type === 'sample' || source_type === 'manual';

    // ── 1. analysis_runs ─────────────────────────────────────────────────
    const summaryJson = {
      ...summary,
      meta,
      ingestStats:    stats,
      ingestWarnings: warnings,
      ingestErrors:   errors,
      alert_count:    alerts.length,
    };

    const { data: run, error: runErr } = await supabaseAdmin
      .from('analysis_runs')
      .insert({
        user_id:        userId,
        file_name:      fileName,
        part_count:     rows.length,
        summary_json:   summaryJson,
        results_json:   alerts,              // alerts are the "results" for PFEP runs
        plan_at_upload: plan.name || 'free',
        source_type:    srcValid ? source_type : 'manual',
        module_key:     'pfep',
      })
      .select('id, uploaded_at, module_key')
      .single();

    if (runErr) {
      console.error('[POST /api/pfep/runs] analysis_runs insert:', runErr.message);
      return res.status(500).json({ error: 'Failed to save PFEP run.' });
    }

    const runId = run.id;

    // ── 2. pfep_parts — upsert ────────────────────────────────────────────
    const partRows = rows.map(p => ({
      user_id:              userId,
      part_number:          p.part_number,
      part_description:     p.part_description     || null,
      commodity_class:      p.commodity_class       || null,
      abc_class:            p.abc_class             || null,
      supplier:             p.supplier              || null,
      secondary_supplier:   p.secondary_supplier    || null,
      supplier_part_number: p.supplier_part_number  || null,
      replenishment_method: p.replenishment_method  || 'min_max',
      lead_time_days:       p.lead_time_days        ?? null,
      reorder_point:        p.reorder_point         ?? null,
      min_qty:              p.min_qty               ?? null,
      max_qty:              p.max_qty               ?? null,
      pack_multiple:        p.pack_multiple         ?? null,
      standard_pack:        p.standard_pack         ?? null,
      unit_of_measure:      p.unit_of_measure       || null,
      unit_cost:            p.unit_cost             ?? null,
      annual_usage:         p.annual_usage          ?? null,
      point_of_use:         p.point_of_use          || null,
      plant:                p.plant                 || null,
      notes:                p.notes                 || null,
      source_run_id:        runId,
      imported_at:          new Date().toISOString(),
      updated_at:           new Date().toISOString(),
    }));

    // Batch in 500-row chunks to stay within Supabase payload limits.
    const BATCH = 500;
    for (let i = 0; i < partRows.length; i += BATCH) {
      const batch = partRows.slice(i, i + BATCH);
      const { error: upsertErr } = await supabaseAdmin
        .from('pfep_parts')
        .upsert(batch, { onConflict: 'user_id,part_number' });

      if (upsertErr) {
        console.error('[POST /api/pfep/runs] pfep_parts upsert:', upsertErr.message);
        // Best-effort: delete the analysis_runs row so the run is not orphaned.
        await supabaseAdmin.from('analysis_runs').delete().eq('id', runId);
        if (res.headersSent) return;
        return res.status(500).json({ error: 'Failed to save PFEP parts. Run was not persisted.' });
      }
    }

    return res.status(201).json({
      run_id:      runId,
      uploaded_at: run.uploaded_at,
      part_count:  rows.length,
      alert_count: alerts.length,
    });
  } catch (err) {
    console.error('[POST /api/pfep/runs] Unexpected error:', err);
    return res.status(500).json({ error: 'An unexpected error occurred.' });
  }
}

// ---------------------------------------------------------------------------
// GET /api/pfep/parts — list the user's current PFEP register.
// Returns all pfep_parts rows ordered by part_number.
// ---------------------------------------------------------------------------
async function listPFEPParts(req, res) {
  try {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Database is not configured.' });
    }

    const plan = await getPlanForUser(req.user.id, supabaseAdmin);
    if (!plan.savedHistory) {
      logAccessDenied('GET /api/pfep/parts', req.user.id);
      return res.status(403).json({ error: 'PFEP register is a Pro plan feature.' });
    }

    const { data, error } = await supabaseAdmin
      .from('pfep_parts')
      .select('*')
      .eq('user_id', req.user.id)
      .order('part_number', { ascending: true });

    if (error) {
      console.error('[GET /api/pfep/parts]', error.message);
      return res.status(500).json({ error: 'Failed to retrieve PFEP register.' });
    }

    return res.json({ parts: data || [], count: (data || []).length });
  } catch (err) {
    console.error('[GET /api/pfep/parts] Unexpected:', err);
    return res.status(500).json({ error: 'An unexpected error occurred.' });
  }
}

// ---------------------------------------------------------------------------
// GET /api/pfep/runs — list PFEP import history runs.
// ---------------------------------------------------------------------------
async function listPFEPRuns(req, res) {
  try {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Database is not configured.' });
    }

    const plan = await getPlanForUser(req.user.id, supabaseAdmin);
    if (!plan.savedHistory) {
      logAccessDenied('GET /api/pfep/runs', req.user.id);
      return res.status(403).json({ error: 'Saved history is a Pro plan feature.' });
    }

    const { data, error } = await supabaseAdmin
      .from('analysis_runs')
      .select('id, file_name, uploaded_at, part_count, summary_json, plan_at_upload, source_type')
      .eq('user_id', req.user.id)
      .eq('module_key', 'pfep')
      .order('uploaded_at', { ascending: false })
      .limit(50);

    if (error) {
      console.error('[GET /api/pfep/runs]', error.message);
      return res.status(500).json({ error: 'Failed to retrieve PFEP run history.' });
    }

    return res.json({ runs: data || [] });
  } catch (err) {
    console.error('[GET /api/pfep/runs] Unexpected:', err);
    return res.status(500).json({ error: 'An unexpected error occurred.' });
  }
}

// ---------------------------------------------------------------------------
// GET /api/pfep/runs/:id — retrieve a single PFEP run with its alerts.
// ---------------------------------------------------------------------------
async function getPFEPRun(req, res) {
  try {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Database is not configured.' });
    }

    const { id } = req.params;
    if (!id) return res.status(400).json({ error: 'Run ID is required.' });

    const plan = await getPlanForUser(req.user.id, supabaseAdmin);
    if (!plan.savedHistory) {
      logAccessDenied('GET /api/pfep/runs/:id', req.user.id);
      return res.status(403).json({ error: 'Saved history is a Pro plan feature.' });
    }

    const { data, error } = await supabaseAdmin
      .from('analysis_runs')
      .select('*')
      .eq('id', id)
      .eq('user_id', req.user.id)
      .eq('module_key', 'pfep')
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Run not found.' });
    }

    return res.json({ run: data });
  } catch (err) {
    console.error('[GET /api/pfep/runs/:id] Unexpected:', err);
    return res.status(500).json({ error: 'An unexpected error occurred.' });
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/pfep/runs/:id — delete a PFEP run from history.
// pfep_parts rows sourced from this run are NOT deleted — the register is
// additive and parts may have been updated by a later import.
// ---------------------------------------------------------------------------
async function deletePFEPRun(req, res) {
  try {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Database is not configured.' });
    }

    const { id } = req.params;
    if (!id) return res.status(400).json({ error: 'Run ID is required.' });

    const { data: run } = await supabaseAdmin
      .from('analysis_runs')
      .select('id, user_id, module_key')
      .eq('id', id)
      .eq('user_id', req.user.id)
      .eq('module_key', 'pfep')
      .single();

    if (!run) return res.status(404).json({ error: 'Run not found.' });

    const { error } = await supabaseAdmin
      .from('analysis_runs')
      .delete()
      .eq('id', id)
      .eq('user_id', req.user.id);

    if (error) {
      console.error('[DELETE /api/pfep/runs/:id]', error.message);
      return res.status(500).json({ error: 'Failed to delete run.' });
    }

    return res.json({ deleted: true, id });
  } catch (err) {
    console.error('[DELETE /api/pfep/runs/:id] Unexpected:', err);
    return res.status(500).json({ error: 'An unexpected error occurred.' });
  }
}

module.exports = {
  savePFEPRun,
  listPFEPParts,
  listPFEPRuns,
  getPFEPRun,
  deletePFEPRun,
};
