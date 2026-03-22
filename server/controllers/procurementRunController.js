'use strict';

// ---------------------------------------------------------------------------
// procurementRunController.js — persistence handlers for Procurement Copilot.
//
// Mirrors the inventory runController pattern:
//   POST   /api/procurement/runs      → saveProcurementRun   (create)
//   GET    /api/procurement/runs      → listProcurementRuns  (index)
//   GET    /api/procurement/runs/:id  → getProcurementRun    (show)
//   DELETE /api/procurement/runs/:id  → deleteProcurementRun (destroy)
//
// Persistence writes to FIVE tables in a single request:
//   1. analysis_runs           (module_key = 'procurement', summary + results)
//   2. procurement_po_lines    (one row per scored PO line)
//   3. procurement_supplier_rollups
//   4. procurement_insights
//   5. procurement_action_items (one per action candidate)
//
// Auth: all handlers assume requireAuth middleware has already attached req.user.
// Plan: saved history requires Pro plan (same gate as inventory).
// ---------------------------------------------------------------------------

const { getPlanForUser }               = require('../../plans');
const { supabaseAdmin }                = require('../../supabaseClient');

function logAccessDenied(route, userId, plan) {
  console.warn('[ACCESS_DENIED]', route, {
    user_id:    userId,
    sub_status: plan._debug?.sub_status ?? 'unknown',
    is_admin:   plan._debug?.is_admin   ?? false,
    reason:     'plan_not_pro',
  });
}

// ---------------------------------------------------------------------------
// POST /api/procurement/runs — persist a complete procurement analysis run.
//
// Expects req.body to carry the full payload produced by the upload endpoint:
//   { file_name, lines, supplierRollups, insights, actionCandidates, summary,
//     meta, stats, warnings, errors, source_type }
//
// Pipeline:
//   1. Insert analysis_runs row (module_key = 'procurement')
//   2. Bulk-insert procurement_po_lines
//   3. Bulk-insert procurement_supplier_rollups
//   4. Bulk-insert procurement_insights
//   5. Bulk-insert procurement_action_items from actionCandidates
//
// If any child-table insert fails, the analysis_runs row is deleted
// (best-effort cleanup) and a 500 is returned.  This is not a true
// transaction (Supabase JS client does not support multi-table txns)
// but provides idempotent retry safety because the run row is the FK
// parent — CASCADE deletes will clean up any partial children.
// ---------------------------------------------------------------------------
async function saveProcurementRun(req, res) {
  try {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Database is not configured.' });
    }

    const plan = await getPlanForUser(req.user.id, supabaseAdmin);
    if (!plan.savedHistory) {
      logAccessDenied('POST /api/procurement/runs', req.user.id, plan);
      return res.status(403).json({ error: 'Saved history is a Pro plan feature.' });
    }

    const {
      file_name,
      lines            = [],
      supplierRollups  = [],
      insights         = [],
      actionCandidates = [],
      summary          = {},
      meta             = {},
      stats            = {},
      warnings         = [],
      errors           = [],
      source_type,
    } = req.body || {};

    if (!Array.isArray(lines) || lines.length === 0) {
      return res.status(400).json({ error: 'No scored PO lines provided.' });
    }

    const userId   = req.user.id;
    const fileName = typeof file_name === 'string' ? file_name.slice(0, 255) : 'unknown';
    const srcValid = source_type === 'sample' || source_type === 'manual';

    // ── 1. analysis_runs ──────────────────────────────────────────────────
    const summaryJson = {
      ...summary,
      meta,
      ingestStats: stats,
      ingestWarnings: warnings,
      ingestErrors:   errors,
    };

    const { data: run, error: runErr } = await supabaseAdmin
      .from('analysis_runs')
      .insert({
        user_id:        userId,
        file_name:      fileName,
        part_count:     lines.length,
        summary_json:   summaryJson,
        results_json:   lines,             // full scored lines for detail page
        plan_at_upload: plan.name || 'free',
        source_type:    srcValid ? source_type : 'manual',
        module_key:     'procurement',
      })
      .select('id, uploaded_at, module_key')
      .single();

    if (runErr) {
      console.error('[POST /api/procurement/runs] analysis_runs insert:', runErr.message);
      return res.status(500).json({ error: 'Failed to save analysis run.' });
    }

    const runId = run.id;

    // Helper: best-effort cleanup on child-table failure.
    async function rollback(table, childErr) {
      console.error(`[POST /api/procurement/runs] ${table} insert:`, childErr.message);
      await supabaseAdmin.from('analysis_runs').delete().eq('id', runId);
      return res.status(500).json({ error: `Failed to save ${table}. Run was not persisted.` });
    }

    // ── 2. procurement_po_lines ───────────────────────────────────────────
    const poLineRows = lines.map((l, idx) => ({
      run_id:           runId,
      user_id:          userId,
      po_number:        l.po_number,
      line_number:      l.line_number     || null,
      supplier:         l.supplier,
      item_code:        l.item_code       || null,
      item_description: l.item_description || null,
      quantity_ordered: l.quantity_ordered  ?? null,
      quantity_received: l.quantity_received ?? null,
      unit_price:       l.unit_price       ?? null,
      line_amount:      l.line_amount      ?? 0,
      order_date:       l.order_date       || null,
      requested_date:   l.requested_date   || null,
      confirmed_date:   l.confirmed_date   || null,
      actual_date:      l.actual_date      || null,
      delivery_status:  l.delivery_status  || 'pending',
      days_variance:    l.days_variance    ?? null,
      category:         l.category         || null,
      buyer:            l.buyer            || null,
      plant:            l.plant            || null,
      risk_score:       l.risk_score       ?? 0,
      severity:         l.severity         || 'Low',
      risk_flags:       l.risk_flags       || [],
      applied_rules:    l.applied_rules    || [],
      row_index:        l._row_index       ?? idx,
    }));

    // Supabase JS has a max payload size; batch in chunks of 500.
    const PO_BATCH = 500;
    for (let i = 0; i < poLineRows.length; i += PO_BATCH) {
      const batch = poLineRows.slice(i, i + PO_BATCH);
      const { error: plErr } = await supabaseAdmin
        .from('procurement_po_lines')
        .insert(batch);
      if (plErr) return rollback('procurement_po_lines', plErr);
    }

    // ── 3. procurement_supplier_rollups ───────────────────────────────────
    if (supplierRollups.length > 0) {
      const rollupRows = supplierRollups.map(r => ({
        run_id:           runId,
        user_id:          userId,
        supplier:         r.supplier,
        line_count:       r.line_count        ?? 0,
        po_count:         r.po_count          ?? 0,
        total_spend:      r.total_spend       ?? 0,
        spend_share_pct:  r.spend_share_pct   ?? null,
        on_time_rate_pct: r.on_time_rate_pct  ?? null,
        avg_days_variance: r.avg_days_variance ?? null,
        item_count:       r.item_count        ?? 0,
        overdue_count:    r.overdue_count     ?? 0,
        high_risk_count:  r.high_risk_count   ?? 0,
        flagged_count:    r.flagged_count     ?? 0,
        due_soon_count:   r.due_soon_count    ?? 0,
        past_due_dollars: r.past_due_dollars  ?? 0,
        max_days_overdue: r.max_days_overdue  ?? null,
        risk_flags:       r.risk_flags        || [],
        severity:         r.severity          || 'Low',
      }));

      const { error: srErr } = await supabaseAdmin
        .from('procurement_supplier_rollups')
        .insert(rollupRows);
      if (srErr) return rollback('procurement_supplier_rollups', srErr);
    }

    // ── 4. procurement_insights ───────────────────────────────────────────
    if (insights.length > 0) {
      const insightRows = insights.map(i => ({
        run_id:             runId,
        user_id:            userId,
        insight_key:        i.id,
        category:           i.category,
        severity:           i.severity,
        title:              i.title,
        description:        i.description        || null,
        affected_supplier:  i.affected_supplier  || null,
        affected_items:     i.affected_items     || [],
        metric_value:       i.metric_value       ?? null,
        metric_label:       i.metric_label       || null,
        risk_flags:         i.risk_flags         || [],
        recommended_action: i.recommended_action || null,
        rule_details:       {},
      }));

      const { error: iErr } = await supabaseAdmin
        .from('procurement_insights')
        .insert(insightRows);
      if (iErr) return rollback('procurement_insights', iErr);
    }

    // ── 5. procurement_action_items ───────────────────────────────────────
    if (actionCandidates.length > 0) {
      const actionRows = actionCandidates.map(a => ({
        run_id:   runId,
        user_id:  userId,
        title:    `${a.po_number || 'PO'} / ${a.supplier || 'Supplier'} — ${a.severity || 'Review'}`,
        status:   'open',
      }));

      const { error: aErr } = await supabaseAdmin
        .from('procurement_action_items')
        .insert(actionRows);
      if (aErr) return rollback('procurement_action_items', aErr);
    }

    // ── Done ──────────────────────────────────────────────────────────────
    res.status(201).json({
      id:          run.id,
      uploaded_at: run.uploaded_at,
      module_key:  run.module_key,
      line_count:  lines.length,
    });

  } catch (err) {
    console.error('[POST /api/procurement/runs] unhandled:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'An unexpected error occurred.' });
  }
}

// ---------------------------------------------------------------------------
// GET /api/procurement/runs — list the authenticated user's procurement runs.
// ---------------------------------------------------------------------------
async function listProcurementRuns(req, res) {
  try {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Database is not configured.' });
    }

    const plan = await getPlanForUser(req.user.id, supabaseAdmin);
    if (!plan.savedHistory) {
      logAccessDenied('GET /api/procurement/runs', req.user.id, plan);
      return res.status(403).json({ error: 'Saved history is a Pro plan feature.' });
    }

    const { data, error } = await supabaseAdmin
      .from('analysis_runs')
      .select('id, file_name, uploaded_at, part_count, summary_json, plan_at_upload, source_type, module_key')
      .eq('user_id', req.user.id)
      .eq('module_key', 'procurement')
      .order('uploaded_at', { ascending: false })
      .limit(50);

    if (error) {
      console.error('[GET /api/procurement/runs]', error.message);
      return res.status(500).json({ error: 'Failed to load procurement runs.' });
    }

    res.json(data);
  } catch (err) {
    console.error('[GET /api/procurement/runs] unhandled:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'An unexpected error occurred.' });
  }
}

// ---------------------------------------------------------------------------
// GET /api/procurement/runs/:id — retrieve a single run with all child data.
//
// Returns the analysis_runs row plus:
//   po_lines          — all scored PO lines for the run
//   supplier_rollups  — aggregated supplier-level metrics
//   insights          — actionable findings
//   action_items      — mutable action queue
// ---------------------------------------------------------------------------
async function getProcurementRun(req, res) {
  try {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Database is not configured.' });
    }

    const plan = await getPlanForUser(req.user.id, supabaseAdmin);
    if (!plan.savedHistory) {
      logAccessDenied('GET /api/procurement/runs/:id', req.user.id, plan);
      return res.status(403).json({ error: 'Saved history is a Pro plan feature.' });
    }

    const runId = req.params.id;
    const userId = req.user.id;

    // Fetch the run header.
    const { data: run, error: runErr } = await supabaseAdmin
      .from('analysis_runs')
      .select('*')
      .eq('id', runId)
      .eq('user_id', userId)
      .eq('module_key', 'procurement')
      .single();

    if (runErr || !run) {
      return res.status(404).json({ error: 'Run not found.' });
    }

    // Fetch child data in parallel.
    const [poRes, srRes, inRes, aiRes] = await Promise.all([
      supabaseAdmin.from('procurement_po_lines')
        .select('*').eq('run_id', runId).order('row_index', { ascending: true }),
      supabaseAdmin.from('procurement_supplier_rollups')
        .select('*').eq('run_id', runId).order('severity', { ascending: true }),
      supabaseAdmin.from('procurement_insights')
        .select('*').eq('run_id', runId).order('severity', { ascending: true }),
      supabaseAdmin.from('procurement_action_items')
        .select('*').eq('run_id', runId).order('created_at', { ascending: false }),
    ]);

    // Tolerate partial child-fetch failure — the run header is still useful.
    res.json({
      ...run,
      po_lines:         poRes.data  || [],
      supplier_rollups: srRes.data  || [],
      insights:         inRes.data  || [],
      action_items:     aiRes.data  || [],
    });
  } catch (err) {
    console.error('[GET /api/procurement/runs/:id] unhandled:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'An unexpected error occurred.' });
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/procurement/runs/:id — delete a saved procurement run.
// CASCADE on all child tables means a single delete cleans everything.
// ---------------------------------------------------------------------------
async function deleteProcurementRun(req, res) {
  try {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Database is not configured.' });
    }

    const plan = await getPlanForUser(req.user.id, supabaseAdmin);
    if (!plan.savedHistory) {
      logAccessDenied('DELETE /api/procurement/runs/:id', req.user.id, plan);
      return res.status(403).json({ error: 'Saved history is a Pro plan feature.' });
    }

    const { error } = await supabaseAdmin
      .from('analysis_runs')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .eq('module_key', 'procurement');

    if (error) {
      console.error('[DELETE /api/procurement/runs/:id]', error.message);
      return res.status(500).json({ error: 'Failed to delete run.' });
    }

    res.status(204).end();
  } catch (err) {
    console.error('[DELETE /api/procurement/runs/:id] unhandled:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'An unexpected error occurred.' });
  }
}

module.exports = {
  saveProcurementRun,
  listProcurementRuns,
  getProcurementRun,
  deleteProcurementRun,
};
