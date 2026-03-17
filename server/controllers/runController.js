'use strict';

// ---------------------------------------------------------------------------
// runController — request handlers for the /api/runs history endpoints.
//
// All handlers rely on supabaseAdmin and getPlanForUser which are module-level
// singletons initialised before the first request arrives.
// ---------------------------------------------------------------------------

const { getPlanForUser } = require('../../plans');
const { supabaseAdmin }  = require('../../supabaseClient');
const { compareRuns }    = require('../../comparator');

// POST /api/runs — save an analysis run
async function createRun(req, res) {
  if (!supabaseAdmin) {
    return res.status(503).json({ error: 'Database is not configured.' });
  }

  const plan = await getPlanForUser(req.user.id, supabaseAdmin);
  if (!plan.savedHistory) {
    return res.status(403).json({ error: 'Saved history is a Pro plan feature.' });
  }

  const { file_name, part_count, summary_json, results_json, plan_at_upload, source_type } = req.body || {};

  if (!summary_json || !results_json) {
    return res.status(400).json({ error: 'summary_json and results_json are required.' });
  }

  const sourceValid = source_type === 'sample' || source_type === 'manual';

  const { data, error } = await supabaseAdmin
    .from('analysis_runs')
    .insert({
      user_id:        req.user.id,
      file_name:      typeof file_name === 'string' ? file_name.slice(0, 255) : 'unknown',
      part_count:     Number.isFinite(part_count) ? part_count : 0,
      summary_json:   summary_json,
      results_json:   results_json,
      plan_at_upload: typeof plan_at_upload === 'string' ? plan_at_upload.slice(0, 16) : 'free',
      source_type:    sourceValid ? source_type : 'manual'
    })
    .select('id, uploaded_at')
    .single();

  if (error) {
    console.error('[POST /api/runs]', error.message);
    return res.status(500).json({ error: 'Failed to save analysis run.' });
  }

  res.status(201).json(data);
}

// GET /api/runs — list the authenticated user's saved runs (most recent first)
async function listRuns(req, res) {
  if (!supabaseAdmin) {
    return res.status(503).json({ error: 'Database is not configured.' });
  }

  const plan = await getPlanForUser(req.user.id, supabaseAdmin);
  if (!plan.savedHistory) {
    return res.status(403).json({ error: 'Saved history is a Pro plan feature.' });
  }

  const { data, error } = await supabaseAdmin
    .from('analysis_runs')
    .select('id, file_name, uploaded_at, part_count, summary_json, plan_at_upload, source_type')
    .eq('user_id', req.user.id)
    .order('uploaded_at', { ascending: false })
    .limit(50);

  if (error) {
    console.error('[GET /api/runs]', error.message);
    return res.status(500).json({ error: 'Failed to load history.' });
  }

  res.json(data);
}

// GET /api/runs/:id/compare — compare a run against its immediate predecessor.
// MUST be registered BEFORE getRun so Express matches /compare before :id.
async function compareRun(req, res) {
  if (!supabaseAdmin) {
    return res.status(503).json({ error: 'Database is not configured.' });
  }

  const plan = await getPlanForUser(req.user.id, supabaseAdmin);
  if (!plan.savedHistory) {
    return res.status(403).json({ error: 'Saved history is a Pro plan feature.' });
  }

  // Load the target run
  const { data: targetRun, error: e1 } = await supabaseAdmin
    .from('analysis_runs')
    .select('id, uploaded_at, results_json')
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
    .single();

  if (e1 || !targetRun) {
    return res.status(404).json({ error: 'Run not found.' });
  }

  // Find the most recent run BEFORE this one for the same user
  const { data: priorRuns, error: e2 } = await supabaseAdmin
    .from('analysis_runs')
    .select('id, uploaded_at, results_json, file_name')
    .eq('user_id', req.user.id)
    .lt('uploaded_at', targetRun.uploaded_at)
    .order('uploaded_at', { ascending: false })
    .limit(1);

  if (e2) {
    console.error('[GET /api/runs/:id/compare]', e2.message);
    return res.status(500).json({ error: 'Failed to load comparison data.' });
  }

  if (!priorRuns || priorRuns.length === 0) {
    return res.json({ hasPrior: false });
  }

  const priorRun    = priorRuns[0];
  const comparison  = compareRuns(
    targetRun.results_json || [],
    priorRun.results_json  || []
  );
  comparison.priorRunId      = priorRun.id;
  comparison.priorUploadedAt = priorRun.uploaded_at;
  comparison.priorFileName   = priorRun.file_name;

  return res.json(comparison);
}

// GET /api/runs/:id — retrieve a single saved run (with full results)
async function getRun(req, res) {
  if (!supabaseAdmin) {
    return res.status(503).json({ error: 'Database is not configured.' });
  }

  const plan = await getPlanForUser(req.user.id, supabaseAdmin);
  if (!plan.savedHistory) {
    return res.status(403).json({ error: 'Saved history is a Pro plan feature.' });
  }

  const { data, error } = await supabaseAdmin
    .from('analysis_runs')
    .select('*')
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
    .single();

  if (error || !data) {
    return res.status(404).json({ error: 'Run not found.' });
  }

  res.json(data);
}

// DELETE /api/runs/:id — delete a saved run
async function deleteRun(req, res) {
  if (!supabaseAdmin) {
    return res.status(503).json({ error: 'Database is not configured.' });
  }

  const plan = await getPlanForUser(req.user.id, supabaseAdmin);
  if (!plan.savedHistory) {
    return res.status(403).json({ error: 'Saved history is a Pro plan feature.' });
  }

  const { error } = await supabaseAdmin
    .from('analysis_runs')
    .delete()
    .eq('id', req.params.id)
    .eq('user_id', req.user.id);

  if (error) {
    console.error('[DELETE /api/runs/:id]', error.message);
    return res.status(500).json({ error: 'Failed to delete run.' });
  }

  res.status(204).end();
}

module.exports = { createRun, listRuns, compareRun, getRun, deleteRun };
