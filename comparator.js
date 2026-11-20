'use strict';

const { inventoryKey } = require('./analyzer');

const STATUS_RISK = {
  'Urgent Stockout Risk': 0,
  'Stockout Risk': 1,
  'Potential Dead Stock': 2,
  'Excess Inventory': 3,
  'Healthy': 4,
};

function indexRows(rows) {
  const index = new Map();
  for (const row of rows) {
    if (!row.part_number || row.part_number === '(no part number)') continue;
    const key = inventoryKey(row);
    const existing = index.get(key);
    index.set(key, existing ? { row: existing.row, duplicate: true } : { row });
  }
  return index;
}

function compareRuns(currentRows, priorRows) {
  if (!Array.isArray(currentRows) || !Array.isArray(priorRows) || !priorRows.length) return { hasPrior: false };
  const prior = indexRows(priorRows);
  const current = indexRows(currentRows);
  const result = {
    hasPrior: true, newUrgent: [], resolvedUrgent: [], worsened: [], improved: [],
    added: [], removed: [], couldNotVerify: [], unchanged: 0, statusDeltas: {},
  };

  for (const key of new Set([...prior.keys(), ...current.keys()])) {
    const before = prior.get(key);
    const after = current.get(key);
    const prev = before?.row;
    const row = after?.row || prev;
    const item = {
      part_number: row.part_number, site: row.site || '', uom: row.uom || '', status: row.status,
      severity: row.severity, coverage: row.coverage, prev_status: prev?.status,
      prev_severity: prev?.severity, prev_coverage: prev?.coverage,
    };
    if (before?.duplicate || after?.duplicate) {
      result.couldNotVerify.push({ ...item, reason: 'Duplicate part, site and unit' });
    } else if (!before) {
      result.added.push(item);
      if (row.status === 'Urgent Stockout Risk') result.newUrgent.push(item);
    } else if (!after) {
      result.removed.push(item);
    } else if (STATUS_RISK[prev.status] === undefined || STATUS_RISK[row.status] === undefined) {
      if (prev.status === row.status) result.unchanged++;
      else result.couldNotVerify.push({ ...item, reason: 'Missing or invalid risk inputs' });
    } else if (prev.status === row.status) {
      result.unchanged++;
    } else {
      const worsened = STATUS_RISK[row.status] < STATUS_RISK[prev.status];
      result[worsened ? 'worsened' : 'improved'].push(item);
      if (worsened && row.status === 'Urgent Stockout Risk') result.newUrgent.push(item);
      if (!worsened && prev.status === 'Urgent Stockout Risk' && row.status !== 'Stockout Risk') {
        result.resolvedUrgent.push(item);
      }
    }
  }

  for (const status of [...Object.keys(STATUS_RISK), 'No Usage Data', 'Invalid']) {
    result.statusDeltas[status] = currentRows.filter(row => row.status === status).length -
      priorRows.filter(row => row.status === status).length;
  }
  const labels = [
    ['newUrgent', 'new urgent'], ['resolvedUrgent', 'resolved urgent'], ['worsened', 'worsened'],
    ['improved', 'improved'], ['added', 'new in file'], ['removed', 'no longer in file'],
    ['couldNotVerify', 'could not verify'],
  ].filter(([key]) => result[key].length).map(([key, label]) => `${result[key].length} ${label}`);
  result.leadershipSentence = labels.length ? `Since the last upload: ${labels.join(', ')}.` : 'No material changes since the last upload.';
  return result;
}

module.exports = { compareRuns, STATUS_RISK };
