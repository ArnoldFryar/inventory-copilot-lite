/* exportManager.js — CSV/PDF export and billing/plan integration. */
(function () {
  'use strict';

  var App   = window.App;
  var dom   = App.dom;
  var state = App.state;
  var track = App.track;
  var checkoutInFlight = false;

  const element = id => document.getElementById(id);
  const fields = ['part_number', 'site', 'uom', 'usage_uom', 'supplier', 'description', 'on_hand', 'daily_usage',
    'lead_time', 'coverage', 'lead_time_gap', 'status', 'severity', 'reason', 'recommended_action', 'source_row'];

  function csvCell(value) {
    let text = value == null ? '' : String(value);
    if (typeof value === 'string' && /^(?:[\s\uFEFF]*[=+@-]|[\t\r\n])/.test(text)) text = "'" + text;
    return /[,"\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
  }

  function saveBlob(blob, name) {
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function downloadCsv(header, rows, name) {
    const lines = [header, ...rows].map(row => row.map(csvCell).join(','));
    saveBlob(new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }), name);
  }

  function refreshExportOptions() {
    const plan = state.currentPlan?.entitlements || state.lastResponse?.plan?.entitlements;
    element('inventoryExports').classList.toggle('hidden', !plan?.csvExport);
    element('inventoryPlanLink').classList.toggle('hidden', !!plan?.csvExport);
    if (!plan?.csvExport) element('inventoryExports').open = false;
    if (dom.comparisonExportBtn) dom.comparisonExportBtn.disabled = !plan?.csvExport;
  }

  function allowed() {
    return Boolean((state.currentPlan?.entitlements || state.lastResponse?.plan?.entitlements)?.csvExport);
  }

  function exportRows(rows, scope) {
    if (!allowed() || !rows.length) return;
    const run = state.lastResponse;
    const header = [...fields, 'source_file', 'worksheet', 'analyzed_at', 'source_type', 'export_scope', 'run_rows', 'rule_version',
      'column_mapping', 'usage_period_days', 'lead_time_unit'];
    const mapping = JSON.stringify(run.columnMapping || {});
    downloadCsv(header, rows.map(row => [...fields.map(field => field === 'coverage' ?
      (row.coverage_raw ?? row.coverage) : row[field]), run.fileName, run.worksheet, run.analyzedAt,
      run.sourceType, scope, run.summary.total, run.ruleVersion, mapping, run.usagePeriodDays, run.leadTimeUnit]),
    'inventory-' + scope + '.csv');
    element('inventoryExports').open = false;
  }

  dom.exportBtn.addEventListener('click', () => exportRows(App.resultsRenderer.getFilteredResults(), 'filtered'));
  element('exportFullBtn').addEventListener('click', () => {
    if (!state.lastResponse?.resultsTruncated) exportRows(state.allResults, 'full');
  });
  dom.comparisonExportBtn.addEventListener('click', () => {
    if (!allowed() || !state.lastComparison) return;
    const labels = ['newUrgent', 'resolvedUrgent', 'worsened', 'improved', 'added', 'removed', 'couldNotVerify'];
    const rows = labels.flatMap(key => (state.lastComparison[key] || []).map(row =>
      [key, row.part_number, row.site, row.uom, row.prev_status, row.status, row.coverage, row.reason]));
    downloadCsv(['category', 'part_number', 'site', 'uom', 'previous_status', 'status', 'coverage', 'reason'],
      rows, 'inventory-comparison.csv');
  });

  element('exportWorkbookBtn').addEventListener('click', async event => {
    const button = event.currentTarget;
    const run = state.lastResponse;
    if (!allowed() || !run) return;
    button.disabled = true;
    try {
      const token = await window.authModule.getToken();
      const indices = new Map(run.results.map((row, index) => [row, String(index + 1)]));
      const rowIds = App.resultsRenderer.getFilteredResults().map(row => row.row_id || indices.get(row));
      const response = await fetch('/api/inventory/export.xlsx', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ analysisId: run.savedRunId || run.analysisId, saved: Boolean(run.savedRunId), rowIds }),
      });
      if (!response.ok) throw new Error((await response.json()).error || 'Could not export the workbook.');
      saveBlob(await response.blob(), 'inventory-filtered.xlsx');
      element('inventoryExports').open = false;
    } catch (error) { App.showError(error.message); }
    finally { button.disabled = false; }
  });

  dom.pdfBtn.addEventListener('click', () => {
    if (!allowed()) return;
    const run = state.lastResponse;
    const rows = App.resultsRenderer.getFilteredResults();
    const report = element('inventoryPrintReport');
    const heading = document.createElement('h1');
    heading.textContent = 'Inventory triage report';
    const subheading = document.createElement('p');
    subheading.textContent = [run.fileName, run.worksheet, run.analyzedAt, (run.sourceType === 'sample' ? 'Sample' : 'Customer analysis'),
      'Filtered view: ' + rows.length + ' of ' + run.summary.total + ' rows'].filter(Boolean).join(' · ');
    const table = document.createElement('table');
    const columns = ['part_number', 'site', 'on_hand', 'daily_usage', 'lead_time', 'coverage', 'status', 'recommended_action'];
    const titles = ['Part', 'Site', 'On hand', 'Daily usage', 'Lead days', 'Coverage days', 'Status', 'Next check'];
    const header = table.createTHead().insertRow();
    for (const title of titles) {
      const th = document.createElement('th');
      th.scope = 'col';
      th.textContent = title;
      header.append(th);
    }
    const body = table.createTBody();
    for (const row of rows) {
      const tr = body.insertRow();
      for (const field of columns) tr.insertCell().textContent =
        (field === 'coverage' ? (row.coverage_raw ?? row.coverage) : row[field]) ?? '';
    }
    const source = document.createElement('p');
    source.textContent = element('inventoryMappingSummary').textContent;
    report.replaceChildren(heading, subheading, source, table);
    report.hidden = false;
    document.body.classList.add('print-inventory');
    window.addEventListener('afterprint', () => {
      document.body.classList.remove('print-inventory');
      report.hidden = true;
      report.replaceChildren();
    }, { once: true });
    track('print_clicked');
    window.print();
  });

  // ── Billing helpers ───────────────────────────────────────────────────────

  async function startCheckout(source, options) {
    source = source || 'unknown';
    options = options || {};

    if (!state.billingConfigured) {
      App.showError('Online checkout is not configured yet. Contact support to upgrade.');
      return;
    }

    if (!state.currentUser || !window.authModule) {
      state.pendingCheckoutSource = source;
      track('upgrade_auth_required', { source: source });
      if (App.authUI && typeof App.authUI.openAuthModal === 'function') {
        App.authUI.openAuthModal('signup', {
          hint: 'Create an account or sign in to continue to Pro checkout. Your upgrade will resume automatically after authentication.'
        });
      } else if (dom.authModal) {
        dom.authModal.classList.remove('hidden');
      }
      return;
    }

    if (checkoutInFlight) return;
    checkoutInFlight = true;
    try {
      var token = await window.authModule.getToken();
      var res = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + token
        }
      });
      if (!res.ok) {
        var d = await res.json().catch(function () { return {}; });
        throw new Error(d.error || 'Checkout failed');
      }
      var data = await res.json();
      if (!options.resuming) track('checkout_started', { source: source });
      window.location.href = data.url;
    } catch (err) {
      checkoutInFlight = false;
      App.showError(err.message || 'Could not start checkout. Please try again.');
    }
  }

  function resumePendingCheckout() {
    var source = state.pendingCheckoutSource;
    if (!source || !state.currentUser || !state.billingConfigured) return;

    var isPro = state.currentPlan && state.currentPlan.plan === 'pro';
    if (isPro) {
      state.pendingCheckoutSource = null;
      return;
    }

    state.pendingCheckoutSource = null;
    window.setTimeout(function () {
      track('upgrade_checkout_resumed', { source: source });
      startCheckout(source, { resuming: true });
    }, 120);
  }

  async function openBillingPortal() {
    if (!state.currentUser || !window.authModule) return;
    try {
      var token = await window.authModule.getToken();
      var res = await fetch('/api/billing/portal', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + token
        }
      });
      if (!res.ok) {
        var d = await res.json().catch(function () { return {}; });
        throw new Error(d.error || 'Could not open billing portal.');
      }
      var data = await res.json();
      window.location.href = data.url;
    } catch (err) {
      App.showError(err.message || 'Could not open billing portal.');
    }
  }

  // Wire "Manage billing" button
  if (dom.manageBillingBtn) {
    dom.manageBillingBtn.addEventListener('click', openBillingPortal);
  }

  // Wire all [data-upgrade] buttons (static and dynamic)
  document.addEventListener('click', function (e) {
    var upgradeBtn = e.target.closest('[data-upgrade]');
    if (upgradeBtn) {
      e.preventDefault();
      track('upgrade_btn_clicked', {
        source: upgradeBtn.getAttribute('data-upgrade-source') || 'unknown'
      });
      startCheckout(upgradeBtn.getAttribute('data-upgrade-source') || 'unknown');
    }
  });

  // ── Plan UI ───────────────────────────────────────────────────────────────

  let billingChecks = 0;
  let billingCheckTimer;
  function showBillingReturn(plan) {
    const params = new URLSearchParams(location.search);
    const result = params.get('billing');
    if (!result) return;
    const status = element('billingReturnStatus');
    status.classList.remove('hidden');
    clearTimeout(billingCheckTimer);
    if (result === 'success' && plan.plan !== 'pro') {
      status.textContent = 'Checkout returned. Waiting for your subscription to be confirmed.';
      if (billingChecks++ < 5) billingCheckTimer = setTimeout(fetchPlan, 2000);
      return;
    }
    status.textContent = result === 'success' ? 'Your Pro plan is active.' : 'Checkout was cancelled.';
    params.delete('billing');
    history.replaceState(null, '', location.pathname + (params.size ? '?' + params.toString() : ''));
  }

  function applyPlanToUI(planData) {
    state.currentPlan = planData;
    state.billingConfigured = !!planData.billingConfigured;

    dom.planBadge.textContent = planData.name;
    dom.planBadge.className = 'plan-badge';
    dom.upgradeToProBtn.classList.toggle('hidden', !state.billingConfigured || planData.plan === 'pro');
    dom.manageBillingBtn.classList.toggle('hidden', !state.billingConfigured || !state.currentUser || planData.plan !== 'pro');
    refreshExportOptions();
    if (!planData.entitlements.savedHistory) dom.saveRunBtn.classList.add('hidden');
    App.aiHelpersUI.showAiHelpersPanel();
    showBillingReturn(planData);
    resumePendingCheckout();
  }

  // Fetches the plan from the server, optionally with auth token for per-user plans.
  async function fetchPlan() {
    try {
      const owner = state.currentUser?.id;
      var headers = {};
      if (state.currentUser && window.authModule) {
        var token = await window.authModule.getToken();
        if (token) headers['Authorization'] = 'Bearer ' + token;
      }
      var res = await fetch('/api/plan', { headers: headers });
      if (!res.ok) return;
      var data = await res.json();
      if (owner === state.currentUser?.id) applyPlanToUI(data);
    } catch (_) { /* fail silently */ }
  }

  App.exportManager = {
    startCheckout: startCheckout,
    refreshExportOptions,
    fetchPlan:     fetchPlan,
  };
})();
