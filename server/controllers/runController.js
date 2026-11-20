'use strict';

const { getPlanForUser } = require('../../plans');
const { supabaseAdmin } = require('../../supabaseClient');
const { compareRuns } = require('../../comparator');
const { MODULES } = require('../lib/modules');
const { read, forget } = require('../lib/runSnapshots');

const metadataColumns = 'id, file_name, uploaded_at, part_count, summary_json, plan_at_upload, source_type, module_key';
const runColumns = metadataColumns + ', results_json';
const validId = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);

function ownedRun(user, id, columns = runColumns) {
  return supabaseAdmin.from('analysis_runs').select(columns).eq('user_id', user).eq('id', id).maybeSingle();
}

function hasFullResults(run) {
  return Array.isArray(run?.results_json) && run.results_json.length === run.part_count &&
    run.summary_json?.completeness !== 'preview';
}

function sameBasis(current, baseline) {
  const a = current.summary_json;
  const b = baseline.summary_json;
  return current.module_key === baseline.module_key && current.source_type === baseline.source_type &&
    a?.ruleVersion && a.ruleVersion === b?.ruleVersion &&
    a.inputScope === 'ranked' && b.inputScope === 'ranked' &&
    a.coverageBasis === b.coverageBasis &&
    (a.worksheet || '') === (b.worksheet || '');
}

function unavailable(res) {
  if (supabaseAdmin) return false;
  res.status(503).json({ error: 'Saved history is temporarily unavailable.' });
  return true;
}

async function createRun(req, res) {
  if (unavailable(res)) return;
  const plan = await getPlanForUser(req.user.id, supabaseAdmin);
  if (!plan.savedHistory) return res.status(403).json({ error: 'Saving new runs requires Pro.' });
  const id = req.body?.analysisId;
  if (!validId(id)) return res.status(400).json({ error: 'Choose a current analysis to save.' });
  const existing = await ownedRun(req.user.id, id, metadataColumns);
  if (existing.error) throw new Error('Failed reading the saved run.');
  if (existing.data) return res.json(existing.data);

  const result = await read(req.user.id, id);
  if (!result || result.resultsTruncated || result.sourceType !== 'manual') {
    const duplicate = await ownedRun(req.user.id, id, metadataColumns);
    if (duplicate.data) return res.json(duplicate.data);
    return res.status(409).json({ error: 'This analysis is out of date. Analyze the source file again to save it.' });
  }

  const options = {
    counts: result.summary, thresholds: result.thresholds, topPriority: result.topPriority,
    analyzedAt: result.analyzedAt, columnAliases: result.columnAliases, columnMapping: result.columnMapping,
    worksheet: result.worksheet, ruleVersion: result.ruleVersion, inputScope: result.inputScope,
    missingColumns: result.missingColumns, usagePeriodDays: result.usagePeriodDays, leadTimeUnit: result.leadTimeUnit,
    duplicateCount: result.duplicateWarnings?.length || 0,
    coverageBasis: result.coverageBasis, completeness: 'full', sourceFormat: result.sourceFormat,
  };
  const { error } = await supabaseAdmin.from('analysis_runs').upsert({
    id, user_id: req.user.id, file_name: result.fileName, uploaded_at: result.analyzedAt,
    part_count: result.summary.total, summary_json: options, results_json: result.results,
    plan_at_upload: result.plan.key, source_type: 'manual', module_key: 'inventory',
  }, { onConflict: 'id', ignoreDuplicates: true });
  if (error) throw new Error('Failed saving the analysis.');
  const saved = await ownedRun(req.user.id, id, metadataColumns);
  if (saved.error || !saved.data) throw new Error('Failed reading the saved analysis.');
  forget(req.user.id, id);
  res.status(201).json(saved.data);
}

async function listRuns(req, res) {
  if (unavailable(res)) return;
  const page = Number(req.query.page || 1);
  if (!Number.isInteger(page) || page < 1 || page > 2000) {
    return res.status(400).json({ error: 'Choose a valid history page.' });
  }
  const limit = 50;
  let query = supabaseAdmin.from('analysis_runs').select(metadataColumns).eq('user_id', req.user.id);
  if (Object.hasOwn(MODULES, req.query.module || '')) query = query.eq('module_key', req.query.module);
  const { data, error } = await query.order('uploaded_at', { ascending: false })
    .order('id', { ascending: false }).range((page - 1) * limit, page * limit);
  if (error) throw new Error('Failed reading saved history.');
  res.set('X-History-Has-More', String(data.length > limit)).json(data.slice(0, limit));
}

async function compareRun(req, res) {
  if (unavailable(res)) return;
  const { id } = req.params;
  const baselineId = req.query.baseline;
  if (!validId(id) || (baselineId !== undefined && !validId(baselineId))) {
    return res.status(404).json({ error: 'Run could not be found.' });
  }
  const { data: target, error } = await ownedRun(req.user.id, id);
  if (error) throw new Error('Failed reading analysis.');
  if (!target) return res.status(404).json({ error: 'Run could not be found.' });
  if (!hasFullResults(target)) {
    return res.json({ hasPrior: false, reason: 'This saved run is incomplete. Reanalyze its source before comparing.' });
  }

  let baseline;
  if (baselineId) {
    const named = await ownedRun(req.user.id, baselineId);
    if (named.error) throw new Error('Failed reading baseline.');
    if (!named.data) return res.status(404).json({ error: 'Baseline could not be found.' });
    baseline = named.data;
  } else {
    const previous = await supabaseAdmin.from('analysis_runs').select(metadataColumns)
      .eq('user_id', req.user.id).eq('module_key', target.module_key).eq('source_type', target.source_type)
      .lt('uploaded_at', target.uploaded_at).order('uploaded_at', { ascending: false }).limit(50);
    if (previous.error) throw new Error('Failed reading saved baselines.');
    const compatible = previous.data.find(run => sameBasis(target, run));
    if (compatible) {
      const selected = await ownedRun(req.user.id, compatible.id);
      if (selected.error) throw new Error('Failed reading baseline.');
      baseline = selected.data;
    }
  }

  if (!baseline || baseline.uploaded_at >= target.uploaded_at ||
    !hasFullResults(baseline) || !sameBasis(target, baseline)) {
    return res.json({ hasPrior: false, reason: 'No earlier complete run with a matching inventory basis.' });
  }

  return res.json(Object.assign(compareRuns(target.results_json, baseline.results_json), {
    priorRunId: baseline.id, priorUploadedAt: baseline.uploaded_at, priorFileName: baseline.file_name,
  }));
}

async function getRun(req, res) {
  if (unavailable(res)) return;
  if (!validId(req.params.id)) return res.status(404).json({ error: 'Run could not be found.' });
  const { data, error } = await ownedRun(req.user.id, req.params.id);
  if (error) throw new Error('Failed reading analysis.');
  return data ? res.json({ ...data, completeness: hasFullResults(data) ? 'full' : 'preview' })
    : res.status(404).json({ error: 'Run could not be found.' });
}

async function deleteRun(req, res) {
  if (unavailable(res)) return;
  if (!validId(req.params.id)) return res.status(404).json({ error: 'Run could not be found.' });
  const { error } = await supabaseAdmin.from('analysis_runs').delete().eq('id', req.params.id).eq('user_id', req.user.id);
  if (error) throw new Error('Failed deleting analysis.');
  forget(req.user.id, req.params.id);
  res.status(204).end();
}

async function getAnalysis(user, id, saved) {
  if (!validId(id)) return null;
  if (!saved) return read(user, id);
  if (!supabaseAdmin) return null;
  const { data, error } = await ownedRun(user, id);
  if (error || !data || data.module_key !== 'inventory' || !hasFullResults(data)) return null;
  const options = data.summary_json || {};
  return {
    results: data.results_json, summary: options.counts || options,
    thresholds: options.thresholds, topPriority: options.topPriority,
    analyzedAt: options.analyzedAt || data.uploaded_at, fileName: data.file_name,
    sourceType: data.source_type, worksheet: options.worksheet, columnMapping: options.columnMapping,
    ruleVersion: options.ruleVersion, usagePeriodDays: options.usagePeriodDays, leadTimeUnit: options.leadTimeUnit,
  };
}

module.exports = { createRun, listRuns, compareRun, getRun, deleteRun, getAnalysis };
