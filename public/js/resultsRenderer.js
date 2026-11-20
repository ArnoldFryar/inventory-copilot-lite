/* Inventory workbench: counts, ranked queue, filters, and row details. */
(function () {
  'use strict';

  const App = window.App;
  const { dom, state, track } = App;
  const element = id => document.getElementById(id);
  const PAGE_SIZE = 50;
  const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 });
  const selected = new Map();
  const unscored = row => row.status === 'Invalid' || row.status === 'No Usage Data';
  const excelNames = {
    part_number: 'Part number', on_hand: 'On hand', daily_usage: 'Usage', lead_time: 'Lead time',
    site: 'Site', uom: 'On-hand unit', usage_uom: 'Usage unit', supplier: 'Supplier', description: 'Description',
  };
  const statuses = {
    'Urgent Stockout Risk': ['Urgent', 'critical'],
    'Stockout Risk': ['Below lead time', 'warning'],
    'Potential Dead Stock': ['Possible dead stock', 'warning'],
    'Excess Inventory': ['Excess', 'warning'],
    'No Usage Data': ['Zero usage', 'unknown'],
    Invalid: ['Needs data', 'unknown'],
    Healthy: ['Healthy', 'healthy'],
  };

  let filtered = [];
  let page = 0;
  let sortField;
  let sortDirection = 1;
  let filterTimer;
  let activeDetail;
  let detailTrigger;

  function content(tag, value, className) {
    const node = document.createElement(tag);
    node.textContent = value;
    if (className) node.className = className;
    return node;
  }

  function days(value) {
    if (!Number.isFinite(value)) return '—';
    if (value > 0 && value < 0.1) return '<0.1 d';
    return number.format(value) + ' d';
  }

  function rowStatus(row) {
    const [label, tone] = statuses[row.status] || ['Needs data', 'unknown'];
    return content('span', label, 'inventory-status ' + tone);
  }

  function putCell(tr, heading, child, className) {
    const td = document.createElement('td');
    if (className) td.className = className;
    td.dataset.label = heading;
    td.append(child);
    tr.append(td);
  }

  function nextCheck(row) {
    const checks = {
      'Urgent Stockout Risk': 'Confirm open supply and expedite',
      'Stockout Risk': 'Check receipts against the gap',
      'Potential Dead Stock': 'Validate demand and disposition',
      'Excess Inventory': 'Confirm demand and reallocation',
      'No Usage Data': 'Verify the reported usage',
      'Invalid': 'Check the mapped source values',
      'Healthy': 'Monitor at the next review',
    };
    return checks[row.status] || row.recommended_action || 'Review the source file';
  }

  function showDetails(row, trigger) {
    activeDetail = row;
    detailTrigger = trigger;
    element('inventoryRowTitle').textContent = row.part_number;
    const body = element('inventoryRowBody');
    const status = content('p', '');
    status.append(rowStatus(row));
    const values = document.createElement('dl');
    [
      ['Source', state.lastResponse.fileName || 'Inventory file'],
      ['Worksheet', state.lastResponse.worksheet],
      ['Source row', row.source_row],
      ['Site', row.site], ['Unit', row.uom], ['Usage unit', row.usage_uom],
      ['Supplier', row.supplier], ['Description', row.description],
      ['On hand', row.on_hand], ['Usage per calendar day', row.daily_usage],
      ['Lead time', days(row.lead_time)], ['Coverage', days(row.coverage_raw ?? row.coverage)],
      ['Shortage gap', days(row.lead_time_gap > 0 ? row.lead_time_gap : null)],
    ].filter(([, value]) => value !== null && value !== undefined && value !== '')
      .forEach(([label, value]) => values.append(content('dt', label), content('dd', typeof value === 'number' ? number.format(value) : value)));
    body.replaceChildren(status, content('h3', 'Why this row was flagged'), content('p', row.reason || '—'),
      content('h3', 'Recommended next check'), content('p', nextCheck(row)), values);
    updateDetailSelection();
    element('inventoryRowDetails').showModal();
  }

  function updateDetailSelection() {
    const button = element('selectDraftPart');
    const canDraft = state.currentPlan?.plan === 'pro' && state.aiHelpersAvailable &&
      (state.lastResponse?.analysisId || state.lastResponse?.savedRunId);
    button.classList.toggle('hidden', !canDraft);
    button.textContent = selected.has(activeDetail) ? 'Remove from AI draft' : 'Select for AI draft';
  }

  element('selectDraftPart').addEventListener('click', () => {
    if (selected.has(activeDetail)) selected.delete(activeDetail);
    else if (selected.size < 100) selected.set(activeDetail, true);
    updateDetailSelection();
    document.dispatchEvent(new CustomEvent('partSelectionChanged', { detail: { count: selected.size } }));
  });
  element('inventoryRowDetails').addEventListener('close', () => {
    if (detailTrigger?.isConnected) detailTrigger.focus();
  });

  function renderPage() {
    const count = filtered.length;
    const pages = Math.max(1, Math.ceil(count / PAGE_SIZE));
    page = Math.min(page, pages - 1);
    const start = page * PAGE_SIZE;
    const fragment = document.createDocumentFragment();
    for (const row of filtered.slice(start, start + PAGE_SIZE)) {
      const tr = document.createElement('tr');
      const identity = content('span', row.part_number, 'inventory-part');
      if (row.site) identity.append(content('small', row.site));
      putCell(tr, 'Part / site', identity, 'part-cell');
      putCell(tr, 'Status', rowStatus(row), 'status-cell');
      putCell(tr, 'Coverage / lead', content('span', days(row.coverage_raw ?? row.coverage) + ' / ' + days(row.lead_time)), 'numeric paired-cell');
      putCell(tr, 'Gap', content('span', days(row.lead_time_gap > 0 ? row.lead_time_gap : null)), 'numeric gap-cell');
      putCell(tr, 'Next check', content('span', nextCheck(row)), 'next-check-cell');
      const button = content('button', 'Details', 'row-detail-button');
      button.type = 'button';
      const identityLabel = row.part_number + (row.site ? ' at ' + row.site : '');
      button.setAttribute('aria-label', 'Details for ' + identityLabel + (row.source_row ? ', source row ' + row.source_row : ''));
      button.addEventListener('click', () => showDetails(row, button));
      putCell(tr, '', button, 'details-cell');
      fragment.append(tr);
    }
    if (!count) {
      const tr = document.createElement('tr');
      const td = tr.insertCell();
      td.colSpan = 6;
      td.textContent = 'No rows match these filters.';
      fragment.append(tr);
    }
    dom.resultsBody.replaceChildren(fragment);
    element('previousResultsPage').disabled = page === 0;
    element('nextResultsPage').disabled = page >= pages - 1;
    element('resultsPageStatus').textContent = count ? number.format(start + 1) + '–' + number.format(Math.min(start + PAGE_SIZE, count)) + ' of ' + number.format(count) : 'No rows';
    dom.filterCount.textContent = number.format(count) + ' of ' + number.format(state.allResults.length) + ' available rows';
    dom.exportBtn.textContent = 'Export filtered rows (' + number.format(count) + ')';
    element('exportFullBtn').textContent = 'Export full run (' + number.format(state.lastResponse?.summary.total || 0) + ')';
    element('exportFullBtn').disabled = Boolean(state.lastResponse?.resultsTruncated);
    dom.exportBtn.disabled = !count;
    dom.pdfBtn.disabled = !count;
    element('exportWorkbookBtn').disabled = !count || !(state.lastResponse?.analysisId || state.lastResponse?.savedRunId);
  }

  function matches(row, filter) {
    if (!filter) return true;
    if (filter === 'exceptions') return row.status !== 'Healthy';
    if (filter === 'unscored') return unscored(row);
    if (filter === 'excess') return row.status === 'Potential Dead Stock' || row.status === 'Excess Inventory';
    if (filter === 'zero') return row.on_hand === 0 && row.part_number !== '(no part number)';
    return filter === row.status;
  }

  function applyFilters() {
    clearTimeout(filterTimer);
    filterTimer = undefined;
    const query = dom.filterPart.value.trim().toLowerCase();
    document.querySelectorAll('[data-inventory-filter]').forEach(button =>
      button.setAttribute('aria-pressed', String(button.dataset.inventoryFilter === dom.filterStatus.value)));
    filtered = state.allResults.filter(row => matches(row, dom.filterStatus.value) &&
      (!query || (row.part_number + ' ' + (row.site || '')).toLowerCase().includes(query)));
    if (sortField) {
      filtered.sort((first, second) => {
        const a = first[sortField], b = second[sortField];
        if (a == null || b == null) return a == null ? (b == null ? 0 : 1) : -1;
        return sortDirection * (typeof a === 'string' ? a.localeCompare(b, undefined, { numeric: true }) : a - b);
      });
    }
    page = 0;
    renderPage();
  }

  function markFilter(value) {
    dom.filterStatus.value = value;
    applyFilters();
    dom.filterStatus.focus();
  }

  dom.filterPart.addEventListener('input', () => {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(applyFilters, 140);
  });
  dom.filterStatus.addEventListener('change', applyFilters);
  element('clearInventoryFilters').addEventListener('click', () => {
    dom.filterPart.value = '';
    markFilter('');
  });
  element('previousResultsPage').addEventListener('click', () => { page--; renderPage(); });
  element('nextResultsPage').addEventListener('click', () => { page++; renderPage(); });
  document.querySelectorAll('[data-inventory-filter]').forEach(button => {
    button.addEventListener('click', () => markFilter(button.dataset.inventoryFilter));
  });
  const sortButtons = [...document.querySelectorAll('[data-sort]')];
  sortButtons.forEach(button => {
    button.addEventListener('click', () => {
      const key = button.dataset.sort;
      sortDirection = key === sortField ? -sortDirection : key === 'lead_time_gap' ? -1 : 1;
      sortField = key;
      sortButtons.forEach(other => other.closest('th').removeAttribute('aria-sort'));
      button.closest('th').setAttribute('aria-sort', sortDirection > 0 ? 'ascending' : 'descending');
      applyFilters();
    });
  });

  function renderAll(data) {
    if (!data?.summary || !Array.isArray(data.results)) return App.showError('The analysis returned an unexpected format.');
    state.lastResponse = data;
    state.allResults = data.results;
    state.lastComparison = null;
    selected.clear();
    element('previousRunNote').classList.add('hidden');
    dom.comparisonSection.classList.add('hidden');
    dom.aiHelperResult.classList.add('hidden');
    dom.aiHelperResult._rawText = '';
    const totals = data.summary;
    const needsData = (totals.invalid || 0) + (totals.no_usage || 0);
    const scored = totals.scored ?? Math.max(0, totals.total - needsData);
    const count = value => number.format(value || 0);
    dom.metricUrgent.textContent = scored ? count(totals.urgent_stockout) : '—';
    dom.metricStockout.textContent = scored ? count(totals.stockout_risk) : '—';
    dom.metricExcess.textContent = scored ? count((totals.excess || 0) + (totals.dead_stock || 0)) : '—';
    dom.metricInvalid.textContent = count(needsData);
    element('metricZero').textContent = totals.zero_on_hand === undefined && data.resultsTruncated ? '—' :
      count(totals.zero_on_hand ?? data.results.filter(row => row.on_hand === 0 && row.part_number !== '(no part number)').length);
    element('analysisTitle').textContent = data.sourceType === 'sample' || state.analysisSource === 'sample'
      ? 'Sample inventory review' : 'Inventory review';
    const date = data.analyzedAt ? new Date(data.analyzedAt).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) : '';
    element('actionBarTimestamp').textContent = [data.fileName || 'Inventory upload', data.worksheet,
      count(totals.total) + ' rows', count(scored) + ' scored', date].filter(Boolean).join(' · ');
    const messages = [];
    if (!scored) messages.push('No shortage rating is available. Review missing or invalid inputs.');
    else if (needsData) messages.push(count(needsData) + ' rows need data and have no shortage rating.');
    const duplicates = data.duplicateCount ?? data.duplicateWarnings?.length ?? 0;
    if (duplicates) messages.push(count(duplicates) + ' duplicate part, site and unit ' +
      (duplicates === 1 ? 'combination needs review.' : 'combinations need review.'));
    dom.warningBanner.textContent = messages.join(' ');
    dom.warningBanner.classList.toggle('hidden', !messages.length);
    const noShortages = element('noInventoryShortages');
    noShortages.classList.toggle('hidden', !scored || Boolean(totals.urgent_stockout || totals.stockout_risk));
    noShortages.textContent = 'No shortages detected in ' + count(scored) + (scored === 1 ? ' scored row.' : ' scored rows.');
    dom.tableLimitNotice.classList.toggle('hidden', !data.resultsTruncated);
    dom.tableLimitNotice.textContent = data.savedRunId
      ? 'Partial saved run. Only ' + count(data.results.length) + ' of ' + count(totals.total) + ' rows are available. Reanalyze the source to access omitted rows.'
      : 'Free preview. ' + count(data.results.length) + ' of ' + count(totals.total) + ' rows shown. Summary counts cover the full file.';
    const mapping = Object.entries(data.columnMapping || data.columnAliases || {}).map(([key, value]) => (excelNames[key] || key) + ' uses ' + value);
    if (data.usagePeriodDays > 1) mapping.push('Usage totals divided by ' + data.usagePeriodDays + ' calendar days');
    if (data.leadTimeUnit === 'calendar_weeks') mapping.push('Lead time converted from calendar weeks to days');
    element('inventoryMappingSummary').textContent = mapping.join(' · ');
    dom.filterPart.value = '';
    dom.filterStatus.value = totals.total > (totals.healthy || 0) && scored ? 'exceptions' : '';
    sortField = undefined;
    sortButtons.forEach(button => button.closest('th').removeAttribute('aria-sort'));
    element('analysisOverview').classList.remove('hidden');
    dom.resultsSection.classList.remove('hidden');
    dom.saveRunBtn.textContent = 'Save run';
    dom.saveRunBtn.disabled = false;
    dom.saveRunBtn.classList.toggle('hidden', !data.analysisId || Boolean(data.savedRunId));
    applyFilters();
    App.exportManager.refreshExportOptions();
    App.aiHelpersUI.showAiHelpersPanel();
    track('analysis_completed', { total: totals.total, urgent_stockout: totals.urgent_stockout, invalid: totals.invalid });
  }

  App.getSelectedParts = () => [...selected.keys()];
  App.clearPartSelection = () => {
    selected.clear();
    document.dispatchEvent(new CustomEvent('partSelectionChanged', { detail: { count: 0 } }));
  };
  App.resultsRenderer = {
    renderAll,
    applyFilters,
    getFilteredResults() {
      if (filterTimer !== undefined) applyFilters();
      return filtered;
    },
  };
})();
