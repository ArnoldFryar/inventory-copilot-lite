'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const ExcelJS = require('exceljs');
const requireAuth = require('../middleware/requireAuth');
const { getAnalysis } = require('../controllers/runController');
const { getPlanForUser } = require('../../plans');
const { supabaseAdmin } = require('../../supabaseClient');

const router = express.Router();
const fields = ['part_number', 'site', 'uom', 'usage_uom', 'supplier', 'description', 'on_hand',
  'daily_usage', 'lead_time', 'coverage_raw', 'lead_time_gap', 'status', 'severity', 'reason',
  'recommended_action', 'source_row'];

router.post('/api/inventory/export.xlsx', requireAuth, rateLimit({
  windowMs: 60_000, limit: 10, keyGenerator: req => req.user.id,
}), async (req, res, next) => {
  try {
    const plan = await getPlanForUser(req.user.id, supabaseAdmin);
    if (!plan.csvExport) return res.status(403).json({ error: 'Workbook export requires Pro.' });
    const { analysisId, saved, rowIds } = req.body || {};
    if (!Array.isArray(rowIds) || !rowIds.length || rowIds.length > 50_000 ||
      rowIds.some(id => typeof id !== 'string' || !/^\d{1,6}$/.test(id))) {
      return res.status(400).json({ error: 'Choose inventory rows to export.' });
    }
    const analysis = await getAnalysis(req.user.id, analysisId, saved === true);
    if (!analysis) return res.status(404).json({ error: 'Open or reanalyze the source inventory before exporting.' });
    const lookup = new Map(analysis.results.map((row, index) => [row.row_id || String(index + 1), row]));
    const rows = [...new Set(rowIds)].map(id => lookup.get(id));
    if (rows.some(row => !row)) return res.status(400).json({ error: 'Some rows are no longer in this analysis.' });
    res.set('Cache-Control', 'no-store');
    res.attachment('inventory-triage.xlsx');
    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res });
    const sheet = workbook.addWorksheet('Inventory');
    sheet.addRow(fields).commit();
    for (const row of rows) {
      sheet.addRow(fields.map(field => field === 'part_number' ? String(row.part_number) :
        field === 'coverage_raw' ? (row.coverage_raw ?? row.coverage ?? '') : (row[field] ?? ''))).commit();
    }
    const metadata = workbook.addWorksheet('Source');
    const sourceRows = [
      ['File', analysis.fileName], ['Worksheet', analysis.worksheet || ''], ['Analyzed', analysis.analyzedAt],
      ['Exported rows', rows.length], ['Run total', analysis.summary?.total || analysis.results.length],
      ['Source type', analysis.sourceType], ['Rule version', analysis.ruleVersion || 'Legacy'],
      ['Usage calendar days per period', analysis.usagePeriodDays || 1],
      ['Lead time input basis', analysis.leadTimeUnit || 'calendar_days'],
      ...Object.entries(analysis.columnMapping || {}).map(([key, value]) => ['Column: ' + key, value]),
    ];
    for (const row of sourceRows) metadata.addRow(row).commit();
    metadata.commit();
    await workbook.commit();
  } catch (error) {
    next(error);
  }
});

module.exports = router;
