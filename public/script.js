/* OpsCopilot-Lite — frontend controller (Phase 3)
 *
 * Security note: ALL user-supplied data from the CSV is written via
 * element.textContent, NEVER via innerHTML. This prevents XSS even if a
 * CSV cell contains script tags or HTML entities.
 */

(function () {
  'use strict';

  // ── Analytics ─────────────────────────────────────────────────────────────
  // Falls back to a no-op if analytics.js fails to load.
  var track = window.track || function () {};

  // Converts a failed upload HTTP status + error message into a short,
  // non-PII error category for telemetry.  Never sends raw error text
  // (which could contain column-name fragments from the user's file).
  function uploadErrorCategory(status, msg) {
    if (!status) return 'network_error';
    if (status >= 500) return 'server_error';
    var m = msg ? msg.toLowerCase() : '';
    if (m.indexOf('utf-16') !== -1 || m.indexOf('encoding') !== -1) return 'invalid_encoding';
    if (m.indexOf('semicolon') !== -1 || m.indexOf('tab') !== -1 ||
        m.indexOf('pipe') !== -1     || m.indexOf('delimiter') !== -1) return 'invalid_delimiter';
    if (m.indexOf('missing required column') !== -1 ||
        m.indexOf('missing columns') !== -1)           return 'missing_columns';
    if (m.indexOf('no data rows') !== -1)              return 'no_data_rows';
    if (m.indexOf('too large') !== -1)                 return 'file_too_large';
    return 'upload_error';
  }

  // ── DOM references ────────────────────────────────────────────────────────
  const form            = document.getElementById('uploadForm');
  const fileInput       = document.getElementById('csvfile');
  const fileLabel       = document.getElementById('fileLabel');
  const submitBtn       = document.getElementById('submitBtn');
  const submitLabel     = document.getElementById('submitLabel');
  const loadSampleBtn   = document.getElementById('loadSampleBtn');
  const liveDemoBtn     = document.getElementById('liveDemoBtn');
  const demoBadge       = document.getElementById('demoBadge');
  const errorBanner     = document.getElementById('errorBanner');
  const warningBanner   = document.getElementById('warningBanner');

  // Executive summary
  const execSummarySection = document.getElementById('execSummarySection');
  const execScoreRing      = document.getElementById('execScoreRing');
  const execScoreValue     = document.getElementById('execScoreValue');
  const execScoreLabel     = document.getElementById('execScoreLabel');
  const execUrgentCount    = document.getElementById('execUrgentCount');
  const execExcessCount    = document.getElementById('execExcessCount');
  const execTopRisk        = document.getElementById('execTopRisk');
  const execTopOpp         = document.getElementById('execTopOpp');
  const execNarrative      = document.getElementById('execNarrative');

  // Post-upload action bar
  const actionBar          = document.getElementById('actionBar');
  const actionBarTimestamp = document.getElementById('actionBarTimestamp');
  const pdfBtn             = document.getElementById('pdfBtn');
  const pdfUpgrade         = document.getElementById('pdfUpgrade');
  const saveRunBtn         = document.getElementById('saveRunBtn');

  // Auth / account UI
  const accountMenu       = document.getElementById('accountMenu');
  const accountEmail      = document.getElementById('accountEmail');
  const signOutBtn        = document.getElementById('signOutBtn');
  const signInBtn         = document.getElementById('signInBtn');
  const authModal         = document.getElementById('authModal');
  const authModalClose    = document.getElementById('authModalClose');
  const authForm          = document.getElementById('authForm');
  const authEmail         = document.getElementById('authEmail');
  const authPassword      = document.getElementById('authPassword');
  const authError         = document.getElementById('authError');
  const authSubmitBtn     = document.getElementById('authSubmitBtn');
  const authModalTitle    = document.getElementById('authModalTitle');
  const authToggleText    = document.getElementById('authToggleText');
  const authToggleBtn     = document.getElementById('authToggleBtn');

  // History panel
  const historySection    = document.getElementById('historySection');
  const historyList       = document.getElementById('historyList');
  const historyEmpty      = document.getElementById('historyEmpty');
  const historySignIn     = document.getElementById('historySignIn');
  const historyUpgrade    = document.getElementById('historyUpgrade');

  // Comparison panel
  const comparisonSection        = document.getElementById('comparisonSection');
  const comparisonTitle          = document.getElementById('comparisonTitle');
  const comparisonPrior          = document.getElementById('comparisonPrior');
  const comparisonSentence       = document.getElementById('comparisonSentence');
  const comparisonGrid           = document.getElementById('comparisonGrid');
  const comparisonDetails        = document.getElementById('comparisonDetails');
  const comparisonDetailsSummary = document.getElementById('comparisonDetailsSummary');
  const comparisonDetailsBody    = document.getElementById('comparisonDetailsBody');

  // Summary
  const summarySection  = document.getElementById('summarySection');
  const metricTotal     = document.getElementById('metricTotal');
  const metricUrgent    = document.getElementById('metricUrgent');
  const metricStockout  = document.getElementById('metricStockout');
  const metricNoUsage   = document.getElementById('metricNoUsage');
  const metricExcess    = document.getElementById('metricExcess');
  const metricDeadStock = document.getElementById('metricDeadStock');
  const metricHealthy   = document.getElementById('metricHealthy');
  const metricInvalid   = document.getElementById('metricInvalid');

  // Leadership summary
  const leadershipSection   = document.getElementById('leadershipSection');
  const leadershipNarrative = document.getElementById('leadershipNarrative');
  const auditThresholds     = document.getElementById('auditThresholds');

  // Priority panel
  const prioritySection      = document.getElementById('prioritySection');
  const prioritySectionLabel = document.getElementById('prioritySectionLabel');
  const priorityHint         = document.getElementById('priorityHint');
  const priorityAllClear     = document.getElementById('priorityAllClear');
  const priorityList         = document.getElementById('priorityList');

  // Results table + filters
  const resultsSection  = document.getElementById('resultsSection');
  const resultsBody     = document.getElementById('resultsBody');
  const filterPart      = document.getElementById('filterPart');
  const filterStatus    = document.getElementById('filterStatus');
  const filterSeverity  = document.getElementById('filterSeverity');
  const filterCount     = document.getElementById('filterCount');
  const exportBtn       = document.getElementById('exportBtn');
  const exportUpgrade    = document.getElementById('exportUpgrade');
  const tableLimitNotice = document.getElementById('tableLimitNotice');
  const planBadge        = document.getElementById('planBadge');
  const manageBillingBtn = document.getElementById('manageBillingBtn');

  // AI helpers panel
  const aiHelpersSection    = document.getElementById('aiHelpersSection');
  const aiHelperResult      = document.getElementById('aiHelperResult');
  const aiHelperResultLabel = document.getElementById('aiHelperResultLabel');
  const aiHelperResultText  = document.getElementById('aiHelperResultText');
  const aiHelperResultModel = document.getElementById('aiHelperResultModel');
  const aiHelperCopyBtn     = document.getElementById('aiHelperCopyBtn');

  // ── Module-level state ────────────────────────────────────────────────────
  // Holds the full sorted results array from the last successful upload so
  // that filtering and export operate without another server round-trip.
  let allResults   = [];
  let lastResponse = null;  // full server response (summary, thresholds, etc.)
  // Prevent concurrent uploads: if a request is already in-flight, a second
  // submit (e.g. double-click, or "Load sample" while upload is running) is
  // silently ignored rather than racing with the first.
  let inFlight = false;
  // Active plan fetched from /api/plan on page load.
  // null until resolved; plan gating is skipped gracefully if fetch fails.
  let currentPlan = null;
  // Whether AI helpers are available on the backend.
  let aiHelpersAvailable = false;
  // Auth state: 'signin' or 'signup'; controls modal behaviour.
  let authMode = 'signin';
  // Whether the current user is signed in.
  let currentUser = null;

  // ── File selection ────────────────────────────────────────────────────────
  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (file) {
      fileLabel.textContent = file.name;
      submitBtn.disabled = false;
    } else {
      fileLabel.textContent = 'Choose a CSV file…';
      submitBtn.disabled = true;
    }
    hideError();
    hideResults();
  });

  // ── Form submit ───────────────────────────────────────────────────────────
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    hideError();
    hideResults();
    if (demoBadge) demoBadge.classList.add('hidden');

    const file = fileInput.files[0];
    if (!file) {
      showError('Please select a CSV file before submitting.');
      return;
    }

    // Client-side file-size guard MUST run before the inFlight flag is set.
    // If the size check fires and we return early, the finally block below
    // does NOT run — inFlight would never be reset, permanently locking the
    // tool until the user refreshes.
    const MAX_MB    = 5;
    const MAX_BYTES = MAX_MB * 1024 * 1024;
    if (file.size > MAX_BYTES) {
      track('upload_failed', { reason: 'file_too_large_client' });
      showError(`File is too large. Maximum allowed size is ${MAX_MB} MB.`);
      return;
    }

    // Prevent double-submit: guard against concurrent in-flight requests
    // (e.g. rapid double-click, or loadSampleBtn triggering while upload runs).
    if (inFlight) return;
    inFlight = true;
    setLoading(true);
    track('upload_started');

    const formData = new FormData();
    formData.append('csvfile', file);

    try {
      const response = await fetch('/upload', { method: 'POST', body: formData });

      let data;
      try {
        data = await response.json();
      } catch (_) {
        throw new Error('The server returned an unexpected response. Please try again.');
      }

      if (!response.ok) {
        const errMsg = (data && data.error) ? data.error : '';
        track('upload_failed', { reason: uploadErrorCategory(response.status, errMsg), http_status: response.status });
        showError(errMsg || `Server error (${response.status}).`);
        return;
      }

      renderAll(data);
      autoSaveRun(data);

    } catch (err) {
      track('upload_failed', { reason: 'network_error' });
      showError(err.message || 'A network error occurred. Please check your connection.');
    } finally {
      inFlight = false;
      setLoading(false);
    }
  });

  // ── Filter listeners ──────────────────────────────────────────────────────
  // All three filters call applyFilters() on every change; no debounce needed
  // for the dataset sizes this tool targets.
  filterPart.addEventListener('input',    applyFilters);
  filterStatus.addEventListener('change', applyFilters);
  filterSeverity.addEventListener('change', applyFilters);

  // ── Export ────────────────────────────────────────────────────────────────
  exportBtn.addEventListener('click', () => {
    if (currentPlan && !currentPlan.entitlements.csvExport) {
      if (billingConfigured) { startCheckout(); }
      else { showError('CSV export is available on the Pro plan.'); }
      return;
    }
    const visible = getFilteredResults();
    if (visible.length === 0) {
      showError('No rows to export with the current filter selection.');
      return;
    }
    track('export_csv_clicked', { row_count: visible.length });
    downloadCSV(visible);
  });
  // ── Load sample data ──────────────────────────────────────────────────────────────
  // Fetches the bundled demo CSV from /sample-data, injects it into the file
  // input via DataTransfer, then fires the form submit automatically.
  loadSampleBtn.addEventListener('click', async () => {
    if (inFlight) {
      showError('An upload is already in progress. Please wait for it to complete.');
      return;
    }
    loadSampleBtn.disabled    = true;
    loadSampleBtn.textContent = 'Loading\u2026';
    hideError();

    try {
      const response = await fetch('/sample-data');
      if (!response.ok) throw new Error('Could not load the sample file.');

      const blob = await response.blob();
      const file = new File([blob], 'sample_inventory.csv', { type: 'text/csv' });

      // Programmatically populate the file input
      const dt = new DataTransfer();
      dt.items.add(file);
      fileInput.files = dt.files;

      // Sync the label and submit button state, then auto-submit
      fileInput.dispatchEvent(new Event('change'));
      track('sample_loaded');
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    } catch (err) {
      showError(err.message || 'Failed to load sample data.');
    } finally {
      loadSampleBtn.disabled    = false;
      loadSampleBtn.textContent = 'Load sample data';
    }
  });

  // ── PDF download ───────────────────────────────────────────────────────────────────
  // Uses the browser's built-in print engine with the @media print stylesheet.
  // User selects 'Save as PDF' in the print dialog.
  // No external PDF library needed; output is always in sync with the data.
  pdfBtn.addEventListener('click', () => {
    if (currentPlan && !currentPlan.entitlements.pdfExport) {
      if (billingConfigured) { startCheckout(); }
      else { showError('PDF export is available on the Pro plan.'); }
      return;
    }
    track('print_clicked');
    window.print();
  });

  // ── Sample CSV download link ──────────────────────────────────────────────
  // The anchor fires a static file download; track it separately from the
  // in-page Load Sample button (which also runs the analysis).
  const sampleDownloadLink = document.getElementById('sampleDownloadLink');
  if (sampleDownloadLink) {
    sampleDownloadLink.addEventListener('click', function () {
      track('sample_csv_downloaded');
    });
  }

  // ── Live demo ─────────────────────────────────────────────────────────────
  // Fetches pre-analyzed sample data from /api/demo-analysis and renders it
  // directly — no file upload round-trip required.
  if (liveDemoBtn) {
    liveDemoBtn.addEventListener('click', async () => {
      if (inFlight) {
        showError('An upload is already in progress. Please wait for it to complete.');
        return;
      }
      inFlight = true;
      liveDemoBtn.disabled    = true;
      liveDemoBtn.textContent = 'Loading\u2026';
      hideError();
      hideResults();
      if (demoBadge) demoBadge.classList.add('hidden');

      try {
        const response = await fetch('/api/demo-analysis');
        if (!response.ok) throw new Error('Could not load the demo analysis.');

        const data = await response.json();
        if (demoBadge) demoBadge.classList.remove('hidden');
        track('demo_loaded');
        renderAll(data);
      } catch (err) {
        showError(err.message || 'Failed to load demo analysis.');
      } finally {
        inFlight = false;
        liveDemoBtn.disabled    = false;
        liveDemoBtn.textContent = '\u25B6 Try Live Demo';
      }
    });
  }

  // ── Executive summary renderer ─────────────────────────────────────────

  function renderExecSummary(data) {
    if (!execSummarySection || typeof buildExecutiveSummary !== 'function') return;

    var brief = buildExecutiveSummary(data);

    // Score ring
    execScoreRing.className = 'exec-score-ring ' + brief.colorClass;
    execScoreValue.textContent = brief.score;
    execScoreLabel.textContent = brief.label;

    // KPI counts
    execUrgentCount.textContent = brief.urgent;
    execExcessCount.textContent = brief.excess;

    // Top Risk
    execTopRisk.textContent = brief.topRisk ? brief.topRisk.detail : 'None identified';

    // Top Opportunity
    execTopOpp.textContent = brief.topOpp ? brief.topOpp.detail : 'None identified';

    // Narrative
    execNarrative.textContent = brief.narrative;
  }

  // ── Main render ───────────────────────────────────────────────────────────

  /**
   * Entry point after a successful upload response.
   * @param {{ summary, topPriority, results, analyzedAt, thresholds }} data
   */
  function renderAll(data) {
    // Defensive guard: verify the server returned the expected shape before
    // any render function touches the DOM.  A partial or malformed 200 response
    // (e.g. an uncaught server exception that still serialises) must show an
    // error banner rather than leaving the page in a half-rendered state.
    if (!data || !Array.isArray(data.results) || !data.summary || !data.thresholds) {
      showError('The server returned an unexpected response format. Please try again.');
      return;
    }

    lastResponse = data;
    allResults   = data.results;

    track('analysis_completed', {
      total:                data.summary.total,
      urgent_stockout:      data.summary.urgent_stockout,
      stockout_risk:        data.summary.stockout_risk,
      excess:               data.summary.excess,
      dead_stock:           data.summary.dead_stock,
      no_usage:             data.summary.no_usage,
      invalid:              data.summary.invalid,
      preamble_rows_skipped: data.preambleRowsSkipped || 0,
      encoding:             data.encodingDetected || 'utf8'
    });

    renderExecSummary(data);
    renderSummary(data.summary);
    renderLeadershipSummary(data.summary, data.topPriority, data.analyzedAt, data.thresholds, data.columnAliases);
    renderPriorityPanel(data.topPriority);

    // Data quality warnings (non-blocking — analysis succeeded but something
    // in the data warrants the user's attention before acting on results).
    // Multiple warning types are combined into a single banner message.
    const dups           = Array.isArray(data.duplicateWarnings) ? data.duplicateWarnings : [];
    const preambleCount  = (typeof data.preambleRowsSkipped === 'number') ? data.preambleRowsSkipped : 0;
    const isWin1252      = data.encodingDetected === 'win1252';

    const notices = [];

    if (preambleCount > 0) {
      notices.push(
        `${preambleCount} metadata row${preambleCount > 1 ? 's were' : ' was'} skipped before the ` +
        `column header \u2014 common in ERP report exports.`
      );
    }

    if (isWin1252) {
      notices.push(
        'File was decoded as Windows-1252 (legacy encoding detected). ' +
        'Verify that accented characters in part numbers are correct.'
      );
    }

    if (dups.length > 0) {
      notices.push(
        `${dups.length} part number${dups.length > 1 ? 's appear' : ' appears'} more than once ` +
        `in this export (${dups.slice(0, 5).join(', ')}${dups.length > 5 ? '\u2026' : ''}). ` +
        'Each occurrence is analyzed independently. De-duplicate the source file before acting on these results.'
      );
    }

    if (notices.length > 0) {
      warningBanner.textContent = '';
      if (notices.length === 1) {
        warningBanner.textContent = notices[0];
      } else {
        const ul = document.createElement('ul');
        ul.className = 'warning-list';
        notices.forEach(function (msg) {
          const li = document.createElement('li');
          li.textContent = msg;
          ul.appendChild(li);
        });
        warningBanner.appendChild(ul);
      }
      warningBanner.classList.remove('hidden');
    } else {
      warningBanner.textContent = '';
      warningBanner.classList.add('hidden');
    }

    // Reset filters whenever new data is loaded
    filterPart.value     = '';
    filterStatus.value   = '';
    filterSeverity.value = '';

    applyFilters();

    // Show action bar with timestamp and row count
    const ts = data.analyzedAt
      ? new Date(data.analyzedAt).toLocaleString(undefined, {
          dateStyle: 'medium', timeStyle: 'short'
        })
      : 'just now';
    const total = data.summary?.total ?? 0;
    actionBarTimestamp.textContent =
      `Analysis complete \u00b7 ${total} row${total !== 1 ? 's' : ''} processed \u00b7 ${ts}`;
    actionBar.classList.remove('hidden');

    // Plan-aware truncation notice
    if (tableLimitNotice) {
      if (data.resultsTruncated && data.plan) {
        const shown = data.results.length;
        const total = data.totalBeforeTruncation;
        tableLimitNotice.textContent =
          `Free plan: showing ${shown} of ${total} parts. ` +
          `Upgrade to Pro for full results, CSV export, and PDF reports.`;
        tableLimitNotice.classList.remove('hidden');
      } else {
        tableLimitNotice.textContent = '';
        tableLimitNotice.classList.add('hidden');
      }
    }

    // Populate the print-only report header so the PDF output is self-contained.
    const printTimestamp = document.getElementById('printTimestamp');
    const printFilename  = document.getElementById('printFilename');
    const printMethod    = document.getElementById('printMethod');
    const printFooter    = document.getElementById('printFooter');
    const fname = fileInput.files[0] ? fileInput.files[0].name : 'inventory export';
    if (printTimestamp) printTimestamp.textContent = `Generated: ${ts}`;
    if (printFilename)  printFilename.textContent  = `Source: ${fname}`;
    if (printMethod && data.thresholds) {
      const thr = data.thresholds;
      const crPct = Math.round((thr.CRITICAL_RATIO ?? 0.25) * 100);
      const urPct = Math.round((thr.URGENT_RATIO   ?? 0.5)  * 100);
      const exR   = thr.EXCESS_RATIO      ?? 2.0;
      const dsR   = thr.DEAD_STOCK_RATIO  ?? 6.0;
      printMethod.textContent =
        `Coverage = on-hand \u00f7 daily usage. ` +
        `Critical \u2264${crPct}% of lead time \u00b7 ` +
        `Urgent \u2264${urPct}% \u00b7 ` +
        `Excess >${exR}\u00d7 lead time \u00b7 ` +
        `Dead stock >${dsR}\u00d7 lead time.`;
    }
    if (printFooter) {
      const leftSpan  = document.createElement('span');
      const rightSpan = document.createElement('span');
      leftSpan.textContent  = `OpsCopilot-Lite \u00b7 Inventory Triage Report \u00b7 ${ts}`;
      rightSpan.textContent = 'Internal Use Only';
      while (printFooter.firstChild) printFooter.removeChild(printFooter.firstChild);
      printFooter.appendChild(leftSpan);
      printFooter.appendChild(rightSpan);
    }
    if (execSummarySection) execSummarySection.classList.remove('hidden');
    summarySection.classList.remove('hidden');
    resultsSection.classList.remove('hidden');

    // Show "Save to History" button if user is signed in and plan allows history
    const canSave = currentUser && currentPlan && currentPlan.entitlements.savedHistory;
    if (saveRunBtn && canSave) saveRunBtn.classList.remove('hidden');

    // Show AI helpers panel if Pro + AI configured + analysis loaded
    showAiHelpersPanel();
    // Hide any previous AI helper result when new data is loaded
    if (aiHelperResult) aiHelperResult.classList.add('hidden');
  }

  // ── Summary ───────────────────────────────────────────────────────────────

  function renderSummary(s) {
    metricTotal.textContent     = s.total          ?? '—';
    metricUrgent.textContent    = s.urgent_stockout ?? '—';
    metricStockout.textContent  = s.stockout_risk   ?? '—';
    metricNoUsage.textContent   = s.no_usage        ?? '—';
    metricExcess.textContent    = s.excess          ?? '—';
    metricDeadStock.textContent = s.dead_stock      ?? '—';
    metricHealthy.textContent   = s.healthy         ?? '—';
    metricInvalid.textContent   = s.invalid         ?? '—';
  }

  // ── Top-priority panel ────────────────────────────────────────────────────

  /**
   * Renders the "Needs Attention Now" list.
   * Shows up to 10 High/Medium rows already sorted by the backend.
   * If there are no such rows, the section stays hidden.
   */
  function renderPriorityPanel(items) {
    while (priorityList.firstChild) {
      priorityList.removeChild(priorityList.firstChild);
    }

    if (!items || items.length === 0) {
      // All-clear: show the panel with a positive confirmation instead of hiding it.
      // priorityList is already cleared above — no second clear needed.
      priorityHint.textContent = '';
      prioritySectionLabel.textContent = 'All Clear';
      prioritySectionLabel.className = 'section-label section-label-ok';
      priorityAllClear.classList.remove('hidden');
      prioritySection.classList.remove('hidden');
      return;
    }

    // Reset all-clear state for this render pass
    priorityAllClear.classList.add('hidden');
    prioritySectionLabel.textContent = 'Action Required';
    prioritySectionLabel.className = 'section-label';

    const highCount   = items.filter(i => i.severity === 'High').length;
    const mediumCount = items.length - highCount;

    if (highCount > 0 && mediumCount > 0) {
      priorityHint.textContent =
        `${highCount} part${highCount > 1 ? 's are' : ' is'} at critical coverage levels; ` +
        `${mediumCount} additional part${mediumCount > 1 ? 's' : ''} flagged for purchasing review.`;
    } else if (highCount > 0) {
      priorityHint.textContent =
        `${highCount} part${highCount > 1 ? 's are' : ' is'} at or below the emergency coverage threshold` +
        ` — open PO status should be confirmed now.`;
    } else {
      priorityHint.textContent =
        `No urgent stockout risk. ${items.length} part${items.length > 1 ? 's have' : ' has'} coverage below its lead time — confirm open PO status with purchasing.`;
    }

    items.forEach((row) => {
      const li = document.createElement('li');
      li.className = 'priority-item ' + statusClass(row.status);

      // Severity dot
      const dot = document.createElement('span');
      dot.className   = 'sev-dot sev-' + row.severity.toLowerCase();
      dot.textContent = row.severity;
      li.appendChild(dot);

      // Part number
      const part = document.createElement('span');
      part.className   = 'priority-part';
      part.textContent = row.part_number;
      li.appendChild(part);

      // Status badge
      const badge = document.createElement('span');
      badge.className   = 'badge ' + statusClass(row.status);
      badge.textContent = row.status;
      li.appendChild(badge);

      // Coverage / stock context
      // Show lead time alongside coverage so the reader can immediately assess
      // the gap without referencing a separate column.
      const blurb = document.createElement('span');
      blurb.className = 'priority-detail';
      if (row.coverage !== null) {
        blurb.textContent = `Coverage: ${row.coverage} days \u00b7 Lead time: ${row.lead_time} days`;
      } else {
        // No Usage Data: show on_hand so the viewer has some inventory signal.
        const oh = row.on_hand !== null ? `${row.on_hand} units on hand` : 'on hand unknown';
        blurb.textContent = `${oh} \u00b7 Lead time: ${row.lead_time} days`;
      }
      li.appendChild(blurb);

      // Action
      const action = document.createElement('span');
      action.className   = 'priority-action';
      action.textContent = row.recommended_action;
      li.appendChild(action);

      priorityList.appendChild(li);
    });

    prioritySection.classList.remove('hidden');
  }

  // ── Filtering ─────────────────────────────────────────────────────────────

  /** Returns only the rows that match all active filter criteria. */
  function getFilteredResults() {
    const partQuery  = filterPart.value.trim().toLowerCase();
    const statusVal  = filterStatus.value;
    const severityVal = filterSeverity.value;

    return allResults.filter((row) => {
      if (partQuery  && !row.part_number.toLowerCase().includes(partQuery)) return false;
      if (statusVal  && row.status   !== statusVal)   return false;
      if (severityVal && row.severity !== severityVal) return false;
      return true;
    });
  }

  /** Triggered on every filter change — re-renders the table body. */
  function applyFilters() {
    const filtered = getFilteredResults();
    renderTable(filtered);

    const isFiltered = filterPart.value || filterStatus.value || filterSeverity.value;
    if (isFiltered) {
      filterCount.textContent = `Showing ${filtered.length} of ${allResults.length} rows`;
      filterCount.classList.remove('hidden');
    } else {
      filterCount.classList.add('hidden');
    }
  }

  // ── Table rendering ───────────────────────────────────────────────────────

  function renderTable(rows) {
    while (resultsBody.firstChild) {
      resultsBody.removeChild(resultsBody.firstChild);
    }

    if (rows.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 9;
      td.className = 'table-no-results';
      td.textContent = 'No rows match the current filters. Clear a filter to see more results.';
      tr.appendChild(td);
      resultsBody.appendChild(tr);
      return;
    }

    rows.forEach((row) => {
      const tr = document.createElement('tr');
      tr.className = statusClass(row.status);

      appendCell(tr, row.part_number);
      appendCell(tr, formatNumber(row.coverage));
      appendStatusCell(tr, row.status);
      appendSeverityCell(tr, row.severity);
      appendCell(tr, formatNumber(row.on_hand));
      appendCell(tr, formatNumber(row.daily_usage));
      appendCell(tr, formatNumber(row.lead_time));
      appendCell(tr, row.reason);
      appendCell(tr, row.recommended_action);

      resultsBody.appendChild(tr);
    });
  }

  // ── CSV export ────────────────────────────────────────────────────────────

  const EXPORT_COLUMNS = [
    'part_number', 'on_hand', 'daily_usage', 'lead_time',
    'coverage', 'status', 'severity', 'reason', 'recommended_action'
  ];

  /**
   * Builds a CSV string from the given rows and triggers a browser download.
   * Values are quoted and internal quotes are escaped per RFC 4180.
   */
  function downloadCSV(rows) {
    const escape = (val) => {
      const s = (val === null || val === undefined) ? '' : String(val);
      // Wrap in quotes if the value contains comma, quote, or newline
      return /[,"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };

    const header = EXPORT_COLUMNS.join(',');
    const lines  = rows.map(row =>
      EXPORT_COLUMNS.map(col => escape(row[col])).join(',')
    );

    const csv  = [header, ...lines].join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href     = url;
    // Use the server-side analyzedAt timestamp (local date) for the filename
    // so the export matches the analysis date shown in the report.
    // Falls back to the current local date only if analyzedAt is unavailable.
    const exportDateStr = lastResponse && lastResponse.analyzedAt
      ? (() => {
          const d = new Date(lastResponse.analyzedAt);
          const y = d.getFullYear();
          const m = String(d.getMonth() + 1).padStart(2, '0');
          const day = String(d.getDate()).padStart(2, '0');
          return `${y}-${m}-${day}`;
        })()
      : new Date().toISOString().slice(0, 10);
    a.download = 'inventory_triage_' + exportDateStr + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ── DOM cell helpers ──────────────────────────────────────────────────────

  function appendCell(tr, value) {
    const td = document.createElement('td');
    td.textContent = (value === null || value === undefined) ? '—' : value;
    tr.appendChild(td);
  }

  function appendStatusCell(tr, status) {
    const td    = document.createElement('td');
    const badge = document.createElement('span');
    badge.className   = 'badge ' + statusClass(status);
    badge.textContent = status;
    td.appendChild(badge);
    tr.appendChild(td);
  }

  function appendSeverityCell(tr, severity) {
    const td    = document.createElement('td');
    const badge = document.createElement('span');
    badge.className   = 'sev-badge sev-' + (severity || '').toLowerCase();
    badge.textContent = severity || '—';
    td.appendChild(badge);
    tr.appendChild(td);
  }

  // ── CSS class helpers ─────────────────────────────────────────────────────

  function statusClass(status) {
    switch (status) {
      case 'Urgent Stockout Risk': return 'status-urgent';
      case 'Stockout Risk':        return 'status-risk';
      case 'No Usage Data':        return 'status-no-usage';
      case 'Potential Dead Stock': return 'status-dead-stock';
      case 'Excess Inventory':     return 'status-excess';
      case 'Healthy':              return 'status-healthy';
      case 'Invalid':              return 'status-invalid';
      default:                     return '';
    }
  }

  function formatNumber(value) {
    if (value === null || value === undefined) return '—';
    return value;
  }

  // ── Visibility helpers ────────────────────────────────────────────────────

  function showError(message) {
    errorBanner.textContent = message;
    errorBanner.classList.remove('hidden');
    errorBanner.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function hideError() {
    errorBanner.textContent = '';
    errorBanner.classList.add('hidden');
  }

  function hideResults() {
    allResults   = [];
    lastResponse = null;
    if (execSummarySection) execSummarySection.classList.add('hidden');
    summarySection.classList.add('hidden');
    leadershipSection.classList.add('hidden');
    prioritySection.classList.add('hidden');
    resultsSection.classList.add('hidden');
    actionBar.classList.add('hidden');
    warningBanner.classList.add('hidden');
    if (comparisonSection) comparisonSection.classList.add('hidden');
    if (saveRunBtn) {
      saveRunBtn.classList.add('hidden');
      saveRunBtn.textContent = 'Save to History';
      saveRunBtn.disabled = false;
    }
    if (tableLimitNotice) {
      tableLimitNotice.textContent = '';
      tableLimitNotice.classList.add('hidden');
    }
  }

  function setLoading(isLoading) {
    submitBtn.disabled = isLoading;
    if (isLoading) {
      submitBtn.classList.add('is-loading');
      submitLabel.textContent = 'Analyzing…';  // read by screen readers even when hidden visually
    } else {
      submitBtn.classList.remove('is-loading');
      submitLabel.textContent = 'Analyze';
    }
  }

  // ── Leadership summary ──────────────────────────────────────────────────────────────

  /**
   * Renders the executive narrative and auditability note.
   *
   * Design rules:
   *  - Lead with urgency: most critical finding first.
   *  - Plain business language — no emoji, no all-caps status names.
   *  - One topic per paragraph, separated by \n (rendered via pre-line CSS).
   *  - Avoid stating certainty the rules cannot provide ("will stockout").
   *  - Audit note is a single sentence: formula + thresholds + any column aliases.
   */
  function renderLeadershipSummary(summary, topPriority, analyzedAt, thresholds, columnAliases) {
    const t = thresholds ?? {};
    const criticalRatioPct = Math.round((t.CRITICAL_RATIO ?? 0.25) * 100);
    const urgentRatioPct   = Math.round((t.URGENT_RATIO   ?? 0.5)  * 100);
    const excessRatio      = t.EXCESS_RATIO      ?? 2.0;
    const deadStockRatio   = t.DEAD_STOCK_RATIO  ?? 6.0;

    const dateStr = analyzedAt
      ? new Date(analyzedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
      : 'today';

    const urgentN  = summary.urgent_stockout ?? 0;
    const riskN    = summary.stockout_risk   ?? 0;
    const noUsageN = summary.no_usage        ?? 0;
    const excessN  = summary.excess          ?? 0;
    const deadN    = summary.dead_stock      ?? 0;
    const invalidN = summary.invalid         ?? 0;
    const healthyN = summary.healthy         ?? 0;
    const totalN   = summary.total           ?? 0;

    // Each entry becomes its own visual paragraph (white-space: pre-line in CSS).
    const paras = [];

    // ── Opening: scope and date ────────────────────────────────────────────
    // Lead with the scope of the analysis, not the method.
    paras.push(
      `${totalN} inventory line${totalN !== 1 ? 's' : ''} reviewed as of ${dateStr}.`
    );

    // ── Supply risk ────────────────────────────────────────────────────────
    // Separate critical (≤CRITICAL_RATIO) from standard urgent (≤URGENT_RATIO)
    // so the reader can distinguish "call supplier now" from "check open POs."
    // Avoid "requires" — the tool sees coverage, not open PO status.
    if (urgentN > 0 || riskN > 0) {
      const clauses = [];

      if (urgentN > 0) {
        // Identify critical subset from topPriority (coverage ≤ CRITICAL_RATIO × lead_time)
        const criticalN = (topPriority || []).filter(r =>
          r.status === 'Urgent Stockout Risk' &&
          r.coverage !== null && r.lead_time > 0 &&
          r.coverage <= r.lead_time * (t.CRITICAL_RATIO ?? 0.25)
        ).length;

        if (criticalN > 0 && criticalN < urgentN) {
          clauses.push(
            `${criticalN} part${criticalN > 1 ? 's are' : ' is'} critically short` +
            ` — under ${criticalRatioPct}% of lead time in stock` +
            ` — and ${urgentN - criticalN} more ${urgentN - criticalN > 1 ? 'are' : 'is'}` +
            ` below the ${urgentRatioPct}% emergency threshold`
          );
        } else if (criticalN > 0) {
          clauses.push(
            `${urgentN} part${urgentN > 1 ? 's are' : ' is'} critically short` +
            ` — under ${criticalRatioPct}% of lead time in stock`
          );
        } else {
          clauses.push(
            `${urgentN} part${urgentN > 1 ? 's are' : ' is'} below the emergency coverage threshold` +
            ` — under ${urgentRatioPct}% of lead time remaining`
          );
        }
      }

      if (riskN > 0)
        clauses.push(
          `${riskN} additional part${riskN > 1 ? 's are' : ' is'} below replenishment lead time` +
          ` — purchasing should confirm open PO status`
        );

      paras.push(clauses.join('; ') + '.');
    }

    // ── No usage data ──────────────────────────────────────────────────────
    if (noUsageN > 0)
      paras.push(
        `${noUsageN} part${noUsageN > 1 ? 's have' : ' has'} no demand signal on record.` +
        ` Coverage cannot be assessed.` +
        ` Confirm whether ${noUsageN > 1 ? 'these are' : 'this is'} active, seasonal, or consigned` +
        ` before drawing down safety stock.`
      );

    // ── Excess capital / potential dead stock ──────────────────────────────
    if (deadN > 0)
      paras.push(
        `${deadN} part${deadN > 1 ? 's exceed' : ' exceeds'} ${deadStockRatio}\u00d7 their lead time in stock` +
        ` — disposition review warranted (return, reallocation, or write-off).`
      );

    if (excessN > 0)
      paras.push(
        `${excessN} part${excessN > 1 ? 's carry' : ' carries'} more than ${excessRatio}\u00d7` +
        ` their lead time in stock.` +
        ` Candidates for demand pull-in or return to supplier.`
      );

    // ── Data quality ───────────────────────────────────────────────────────
    if (invalidN > 0)
      paras.push(
        `${invalidN} row${invalidN > 1 ? 's' : ''} could not be classified` +
        ` — required fields are missing or unreadable.` +
        ` Listed in the detail table for master data correction.`
      );

    // ── Healthy coverage ───────────────────────────────────────────────────
    if (healthyN > 0)
      paras.push(
        `${healthyN} part${healthyN > 1 ? 's are' : ' is'} adequately stocked against` +
        ` ${healthyN > 1 ? 'their' : 'its'} lead time.`
      );

    // ── No-risk conclusion ─────────────────────────────────────────────────
    if (urgentN === 0 && riskN === 0 && noUsageN === 0 && invalidN === 0)
      paras.push('No supply risks or data quality issues identified in this export.');

    // Paragraphs separated by \n; white-space: pre-line in CSS renders these
    // as distinct visual blocks without using innerHTML.
    leadershipNarrative.textContent = paras.join('\n');

    // ── Audit note ─────────────────────────────────────────────────────────
    // State the method first, then the thresholds — not a formula sheet.
    let auditText =
      `Results produced by fixed coverage rules applied uniformly to every row — ` +
      `no manual adjustments or external data. ` +
      `Coverage = on-hand \u00f7 daily usage = days of stock remaining. ` +
      `Critical: \u2264${criticalRatioPct}% of lead time. ` +
      `Urgent: \u2264${urgentRatioPct}% of lead time. ` +
      `Excess: >${excessRatio}\u00d7 lead time. ` +
      `Dead stock: >${deadStockRatio}\u00d7 lead time.`;

    const FRIENDLY_CANONICAL = {
      part_number: 'Part Number',
      on_hand:     'Quantity on Hand',
      daily_usage: 'Daily Usage',
      lead_time:   'Lead Time',
    };
    const aliasEntries = columnAliases && typeof columnAliases === 'object'
      ? Object.entries(columnAliases) : [];
    if (aliasEntries.length > 0) {
      const aliasNote = aliasEntries
        .map(([canonical, raw]) => `\u201c${raw}\u201d \u2192 ${FRIENDLY_CANONICAL[canonical] || canonical}`)
        .join(', ');
      auditText += ` Column names remapped from source: ${aliasNote}.`;
    }

    auditThresholds.textContent = auditText;
    leadershipSection.classList.remove('hidden');
  }

  // ── Auth UI wiring ─────────────────────────────────────────────────────

  // Open auth modal
  signInBtn.addEventListener('click', () => {
    setAuthMode('signin');
    authModal.classList.remove('hidden');
    authEmail.focus();
  });

  // Close auth modal
  authModalClose.addEventListener('click', closeAuthModal);
  authModal.addEventListener('click', (e) => {
    if (e.target === authModal) closeAuthModal();
  });

  function closeAuthModal() {
    authModal.classList.add('hidden');
    authError.classList.add('hidden');
    authForm.reset();
  }

  // Toggle between sign in / sign up
  authToggleBtn.addEventListener('click', () => {
    setAuthMode(authMode === 'signin' ? 'signup' : 'signin');
  });

  function setAuthMode(mode) {
    authMode = mode;
    if (mode === 'signup') {
      authModalTitle.textContent = 'Create account';
      authSubmitBtn.textContent = 'Create account';
      authToggleText.textContent = 'Already have an account?';
      authToggleBtn.textContent = 'Sign in';
      authPassword.setAttribute('autocomplete', 'new-password');
    } else {
      authModalTitle.textContent = 'Sign in';
      authSubmitBtn.textContent = 'Sign in';
      authToggleText.textContent = 'No account?';
      authToggleBtn.textContent = 'Create one';
      authPassword.setAttribute('autocomplete', 'current-password');
    }
    authError.classList.add('hidden');
  }

  // Submit auth form
  authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    authError.classList.add('hidden');
    authSubmitBtn.disabled = true;
    authSubmitBtn.textContent = authMode === 'signup' ? 'Creating…' : 'Signing in…';

    try {
      if (authMode === 'signup') {
        await window.authModule.signUp(authEmail.value, authPassword.value);
      } else {
        await window.authModule.signIn(authEmail.value, authPassword.value);
      }
      closeAuthModal();
    } catch (err) {
      authError.textContent = err.message || 'Authentication failed.';
      authError.classList.remove('hidden');
    } finally {
      authSubmitBtn.disabled = false;
      setAuthMode(authMode);
    }
  });

  // Sign out
  signOutBtn.addEventListener('click', async () => {
    await window.authModule.signOut();
  });

  // Respond to auth state changes
  function onAuthStateChanged(_event, session) {
    currentUser = session?.user || null;
    updateAccountUI();
    refreshHistory();
    // Re-fetch plan to get per-user subscription state
    fetchPlan();
  }

  function updateAccountUI() {
    if (!window.authModule || !window.authModule.isConfigured()) {
      // Auth not configured — hide all auth UI elements
      accountMenu.classList.add('hidden');
      signInBtn.classList.add('hidden');
      return;
    }
    if (currentUser) {
      accountEmail.textContent = currentUser.email || 'Account';
      accountMenu.classList.remove('hidden');
      signInBtn.classList.add('hidden');
      if (saveRunBtn && lastResponse) {
        const canSaveHistory = currentPlan && currentPlan.entitlements.savedHistory;
        if (canSaveHistory) saveRunBtn.classList.remove('hidden');
      }
    } else {
      accountMenu.classList.add('hidden');
      signInBtn.classList.remove('hidden');
      if (saveRunBtn) saveRunBtn.classList.add('hidden');
    }
  }

  // ── Save to History ──────────────────────────────────────────────────────

  saveRunBtn.addEventListener('click', async () => {
    if (!lastResponse || !currentUser) return;
    saveRunBtn.disabled = true;
    saveRunBtn.textContent = 'Saving…';

    try {
      const token = await window.authModule.getToken();
      const fname = fileInput.files[0] ? fileInput.files[0].name : 'unknown';
      const isSample = fname === 'sample_inventory.csv';
      const body = {
        file_name: fname,
        part_count: lastResponse.summary?.total || 0,
        summary_json: {
          counts: lastResponse.summary,
          topPriority: lastResponse.topPriority || [],
          thresholds: lastResponse.thresholds || {},
          columnAliases: lastResponse.columnAliases || {}
        },
        results_json: lastResponse.results,
        plan_at_upload: currentPlan?.plan || 'free',
        source_type: isSample ? 'sample' : 'manual'
      };
      const res = await fetch('/api/runs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + token
        },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Save failed');
      }
      saveRunBtn.textContent = 'Saved ✓';
      track('run_saved');
      refreshHistory();
      setTimeout(() => { saveRunBtn.textContent = 'Save to History'; saveRunBtn.disabled = false; }, 2000);
    } catch (err) {
      showError(err.message || 'Could not save analysis run.');
      saveRunBtn.textContent = 'Save to History';
      saveRunBtn.disabled = false;
    }
  });

  // Fire-and-forget auto-save after fresh uploads for signed-in Pro users.
  // On success, also trigger a comparison against the previous run.
  let autoSaveInFlight = false;
  function autoSaveRun(data) {
    if (!currentUser) return;
    if (!currentPlan || !currentPlan.entitlements.savedHistory) return;
    if (!window.authModule || !window.authModule.isConfigured()) return;
    if (autoSaveInFlight) return;
    autoSaveInFlight = true;

    (async () => {
      try {
        const token = await window.authModule.getToken();
        if (!token) return;
        const fname = fileInput.files[0] ? fileInput.files[0].name : 'unknown';
        const isSample = fname === 'sample_inventory.csv';
        const body = {
          file_name: fname,
          part_count: data.summary?.total || 0,
          summary_json: {
            counts: data.summary,
            topPriority: data.topPriority || [],
            thresholds: data.thresholds || {},
            columnAliases: data.columnAliases || {}
          },
          results_json: data.results,
          plan_at_upload: currentPlan?.plan || 'free',
          source_type: isSample ? 'sample' : 'manual'
        };
        const res = await fetch('/api/runs', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + token
          },
          body: JSON.stringify(body)
        });
        if (res.ok) {
          const saved = await res.json().catch(() => null);
          if (saveRunBtn) {
            saveRunBtn.textContent = 'Saved \u2713';
            saveRunBtn.disabled = true;
          }
          track('run_auto_saved');
          refreshHistory();
          // Fetch comparison against the prior run (silent on failure)
          if (saved && saved.id) {
            fetchAndRenderComparison(saved.id, token);
          }
        }
      } catch (_) {
        // Silent — user can retry with the manual Save button.
      } finally {
        autoSaveInFlight = false;
      }
    })();
  }

  // ── Comparison panel ─────────────────────────────────────────────────────

  /**
   * Fetches comparison data for a given run ID and renders the panel.
   * Silent on failure — the comparison panel simply stays hidden.
   */
  async function fetchAndRenderComparison(runId, token) {
    try {
      if (!token) token = await window.authModule.getToken();
      if (!token) return;
      const res = await fetch('/api/runs/' + encodeURIComponent(runId) + '/compare', {
        headers: { 'Authorization': 'Bearer ' + token }
      });
      if (!res.ok) return;
      const comparison = await res.json();
      renderComparison(comparison);
    } catch (_) {
      // Silent — comparison is supplementary.
    }
  }

  /**
   * Renders the "Changes Since Last Upload" panel from comparison data.
   * Hides the panel if hasPrior is false (first run).
   */
  function renderComparison(cmp) {
    if (!comparisonSection) return;
    if (!cmp || !cmp.hasPrior) {
      comparisonSection.classList.add('hidden');
      return;
    }

    // Title / prior run context
    if (comparisonPrior && cmp.priorFileName) {
      const d = cmp.priorUploadedAt
        ? new Date(cmp.priorUploadedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
        : '';
      comparisonPrior.textContent = 'vs. ' + cmp.priorFileName + (d ? ' \u00b7 ' + d : '');
    }

    // Leadership sentence
    if (comparisonSentence) {
      comparisonSentence.textContent = cmp.leadershipSentence || '';
    }

    // Summary grid: compact stat cards for key change categories
    if (comparisonGrid) {
      while (comparisonGrid.firstChild) comparisonGrid.removeChild(comparisonGrid.firstChild);

      const cards = [
        { label: 'New Urgent',      value: cmp.newUrgent?.length      || 0, cls: 'cmp-urgent' },
        { label: 'Resolved Urgent', value: cmp.resolvedUrgent?.length || 0, cls: 'cmp-resolved' },
        { label: 'Worsened',        value: cmp.worsened?.length       || 0, cls: 'cmp-worsened' },
        { label: 'Improved',        value: cmp.improved?.length       || 0, cls: 'cmp-improved' },
        { label: 'New Parts',       value: cmp.added?.length          || 0, cls: 'cmp-added' },
        { label: 'Removed',         value: cmp.removed?.length        || 0, cls: 'cmp-removed' }
      ];

      cards.forEach(function (c) {
        const div = document.createElement('div');
        div.className = 'cmp-card ' + c.cls;
        const valEl = document.createElement('span');
        valEl.className = 'cmp-card-value';
        valEl.textContent = c.value;
        const lblEl = document.createElement('span');
        lblEl.className = 'cmp-card-label';
        lblEl.textContent = c.label;
        div.appendChild(valEl);
        div.appendChild(lblEl);
        comparisonGrid.appendChild(div);
      });

      // Status deltas row
      if (cmp.statusDeltas) {
        const deltaRow = document.createElement('div');
        deltaRow.className = 'cmp-deltas';
        const buckets = [
          ['Urgent Stockout Risk', 'Urgent'],
          ['Stockout Risk',        'At Risk'],
          ['Potential Dead Stock', 'Dead Stock'],
          ['Excess Inventory',     'Excess'],
          ['Healthy',              'Healthy']
        ];
        buckets.forEach(function (b) {
          const delta = cmp.statusDeltas[b[0]] || 0;
          if (delta === 0) return;
          const chip = document.createElement('span');
          chip.className = 'cmp-delta-chip ' + (delta > 0 ? 'cmp-delta-up' : 'cmp-delta-down');
          chip.textContent = b[1] + ' ' + (delta > 0 ? '+' : '') + delta;
          deltaRow.appendChild(chip);
        });
        if (deltaRow.children.length > 0) {
          comparisonGrid.appendChild(deltaRow);
        }
      }
    }

    // Expandable detail list of changed items
    if (comparisonDetails && comparisonDetailsBody) {
      while (comparisonDetailsBody.firstChild) comparisonDetailsBody.removeChild(comparisonDetailsBody.firstChild);

      const sections = [
        { title: 'New Urgent Items',      items: cmp.newUrgent,      showPrev: true },
        { title: 'Resolved Urgent Items', items: cmp.resolvedUrgent, showPrev: true },
        { title: 'Worsened',              items: cmp.worsened,       showPrev: true },
        { title: 'Improved',              items: cmp.improved,       showPrev: true },
        { title: 'New Parts',             items: cmp.added,          showPrev: false },
        { title: 'Removed Parts',         items: cmp.removed,        showPrev: false }
      ];

      let hasItems = false;
      sections.forEach(function (sec) {
        if (!sec.items || sec.items.length === 0) return;
        hasItems = true;

        const h4 = document.createElement('h4');
        h4.className = 'cmp-detail-heading';
        h4.textContent = sec.title + ' (' + sec.items.length + ')';
        comparisonDetailsBody.appendChild(h4);

        const ul = document.createElement('ul');
        ul.className = 'cmp-detail-list';
        sec.items.forEach(function (item) {
          const li = document.createElement('li');
          const pn = document.createElement('strong');
          pn.textContent = item.part_number;
          li.appendChild(pn);

          if (sec.showPrev && item.prev_status) {
            const arrow = document.createTextNode(' ' + item.prev_status + ' \u2192 ' + item.status);
            li.appendChild(arrow);
          } else {
            const st = document.createTextNode(' \u2014 ' + item.status);
            li.appendChild(st);
          }

          if (item.coverage !== null && item.coverage !== undefined) {
            const cov = document.createTextNode(' \u00b7 ' + item.coverage + ' days coverage');
            li.appendChild(cov);
          }
          ul.appendChild(li);
        });
        comparisonDetailsBody.appendChild(ul);
      });

      if (hasItems) {
        comparisonDetails.classList.remove('hidden');
      } else {
        comparisonDetails.classList.add('hidden');
      }
    }

    comparisonSection.classList.remove('hidden');
    track('comparison_shown', {
      new_urgent: cmp.newUrgent?.length || 0,
      worsened: cmp.worsened?.length || 0,
      improved: cmp.improved?.length || 0
    });
  }

  // ── History panel ────────────────────────────────────────────────────────

  async function refreshHistory() {
    if (!window.authModule || !window.authModule.isConfigured()) {
      historySection.classList.add('hidden');
      return;
    }

    const canAccess = currentPlan && currentPlan.entitlements.savedHistory;

    // Show the section to prompt sign-in or upgrade
    historySection.classList.remove('hidden');

    if (!currentUser) {
      while (historyList.firstChild) historyList.removeChild(historyList.firstChild);
      historyEmpty.classList.add('hidden');
      if (historyUpgrade) historyUpgrade.classList.add('hidden');
      historySignIn.classList.remove('hidden');
      return;
    }

    historySignIn.classList.add('hidden');

    if (!canAccess) {
      while (historyList.firstChild) historyList.removeChild(historyList.firstChild);
      historyEmpty.classList.add('hidden');
      if (historyUpgrade) historyUpgrade.classList.remove('hidden');
      return;
    }
    if (historyUpgrade) historyUpgrade.classList.add('hidden');

    try {
      const token = await window.authModule.getToken();
      const res = await fetch('/api/runs', {
        headers: { 'Authorization': 'Bearer ' + token }
      });
      if (!res.ok) throw new Error('fetch failed');
      const runs = await res.json();
      renderHistoryList(runs);
    } catch (_) {
      historyEmpty.textContent = 'Could not load history.';
      historyEmpty.classList.remove('hidden');
    }
  }

  function renderHistoryList(runs) {
    while (historyList.firstChild) historyList.removeChild(historyList.firstChild);

    if (!runs || runs.length === 0) {
      historyEmpty.classList.remove('hidden');
      return;
    }
    historyEmpty.classList.add('hidden');

    runs.forEach((run) => {
      const li = document.createElement('li');
      li.className = 'history-item';

      const info = document.createElement('div');
      info.className = 'history-item-info';

      // File name + optional source badge
      const nameRow = document.createElement('span');
      nameRow.className = 'history-item-name';
      nameRow.textContent = run.file_name || 'Untitled';
      if (run.source_type === 'sample') {
        const badge = document.createElement('span');
        badge.className = 'history-source-badge';
        badge.textContent = 'sample';
        nameRow.appendChild(document.createTextNode(' '));
        nameRow.appendChild(badge);
      }
      info.appendChild(nameRow);

      // Date + part count
      const meta = document.createElement('span');
      meta.className = 'history-item-meta';
      const d = run.uploaded_at ? new Date(run.uploaded_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
      meta.textContent = `${run.part_count || 0} parts \u00b7 ${d}`;
      info.appendChild(meta);

      // Summary counts (compact one-liner of non-zero categories)
      const sj = run.summary_json || {};
      const counts = sj.counts || sj;
      const chips = [];
      if (counts.urgent_stockout) chips.push(`${counts.urgent_stockout} urgent`);
      if (counts.stockout_risk)   chips.push(`${counts.stockout_risk} at risk`);
      if (counts.excess)          chips.push(`${counts.excess} excess`);
      if (counts.dead_stock)      chips.push(`${counts.dead_stock} dead stock`);
      if (counts.no_usage)        chips.push(`${counts.no_usage} no usage`);
      if (counts.healthy)         chips.push(`${counts.healthy} healthy`);
      if (counts.invalid)         chips.push(`${counts.invalid} invalid`);
      if (chips.length > 0) {
        const countsEl = document.createElement('span');
        countsEl.className = 'history-item-counts';
        countsEl.textContent = chips.join(' \u00b7 ');
        info.appendChild(countsEl);
      }

      li.appendChild(info);

      const actions = document.createElement('div');
      actions.className = 'history-item-actions';

      const loadBtn = document.createElement('button');
      loadBtn.className = 'link-btn';
      loadBtn.textContent = 'Load';
      loadBtn.type = 'button';
      loadBtn.addEventListener('click', () => loadHistoryRun(run.id));
      actions.appendChild(loadBtn);

      const delBtn = document.createElement('button');
      delBtn.className = 'link-btn history-delete-btn';
      delBtn.textContent = 'Delete';
      delBtn.type = 'button';
      delBtn.addEventListener('click', () => deleteHistoryRun(run.id, li));
      actions.appendChild(delBtn);

      li.appendChild(actions);
      historyList.appendChild(li);
    });
  }

  async function loadHistoryRun(runId) {
    try {
      const token = await window.authModule.getToken();
      const res = await fetch('/api/runs/' + encodeURIComponent(runId), {
        headers: { 'Authorization': 'Bearer ' + token }
      });
      if (!res.ok) throw new Error('Not found');
      const run = await res.json();
      // Reconstruct a data shape compatible with renderAll()
      if (run.results_json && run.summary_json) {
        // Reconstruct from the richer summary_json format.
        // Backward compat: old rows store flat counts directly in summary_json.
        const sj = run.summary_json;
        const counts = sj.counts || sj;
        const data = {
          summary: counts,
          results: run.results_json,
          analyzedAt: run.uploaded_at,
          topPriority: sj.topPriority || [],
          thresholds: sj.thresholds || lastResponse?.thresholds || {},
          columnAliases: sj.columnAliases || {},
          resultsTruncated: false
        };
        renderAll(data);
        // Hide save button — this run is already persisted
        if (saveRunBtn) saveRunBtn.classList.add('hidden');
        track('history_run_loaded');
        // Fetch comparison against the run's predecessor
        fetchAndRenderComparison(run.id, token);
      }
    } catch (err) {
      showError('Could not load saved run.');
    }
  }

  async function deleteHistoryRun(runId, listItem) {
    try {
      const token = await window.authModule.getToken();
      const res = await fetch('/api/runs/' + encodeURIComponent(runId), {
        method: 'DELETE',
        headers: { 'Authorization': 'Bearer ' + token }
      });
      if (!res.ok) throw new Error('Delete failed');
      if (listItem && listItem.parentNode) listItem.parentNode.removeChild(listItem);
      // Check if list is now empty
      if (historyList.children.length === 0) {
        historyEmpty.classList.remove('hidden');
      }
      track('history_run_deleted');
    } catch (err) {
      showError('Could not delete saved run.');
    }
  }

  // ── AI Helper Actions ────────────────────────────────────────────────────
  // Premium, optional AI drafts grounded in the current run's actual data.
  // These never reclassify parts — they're downstream of the deterministic engine.

  function showAiHelpersPanel() {
    if (!aiHelpersSection) return;
    const isPro = currentPlan && currentPlan.plan === 'pro';
    if (isPro && aiHelpersAvailable && lastResponse) {
      aiHelpersSection.classList.remove('hidden');
    } else {
      aiHelpersSection.classList.add('hidden');
    }
  }

  async function requestAiHelper(helperType) {
    if (!lastResponse || !currentUser || !window.authModule) return;

    // Build the run data payload from the current analysis
    const runData = {
      summary:     lastResponse.summary,
      results:     lastResponse.results,
      topPriority: lastResponse.topPriority || [],
      analyzedAt:  lastResponse.analyzedAt,
      thresholds:  lastResponse.thresholds,
    };

    // Find and disable the clicked button
    var btn = aiHelpersSection.querySelector('[data-helper="' + helperType + '"]');
    if (btn) { btn.disabled = true; btn.querySelector('.ai-helper-btn-label').textContent = 'Generating…'; }

    // Hide previous result
    if (aiHelperResult) aiHelperResult.classList.add('hidden');

    try {
      var token = await window.authModule.getToken();
      var res = await fetch('/api/ai-helper', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + token,
        },
        body: JSON.stringify({ helperType: helperType, runData: runData }),
      });

      if (!res.ok) {
        var errData = await res.json().catch(function () { return {}; });
        throw new Error(errData.error || 'AI helper request failed.');
      }

      var data = await res.json();

      // Show result
      if (aiHelperResultLabel) aiHelperResultLabel.textContent = data.label || helperType;
      if (aiHelperResultText)  aiHelperResultText.textContent  = data.text;
      if (aiHelperResultModel) aiHelperResultModel.textContent = 'Model: ' + (data.model || 'unknown');
      if (aiHelperResult)      aiHelperResult.classList.remove('hidden');

      // Telemetry
      track('ai_helper_used', { helper_type: helperType });
    } catch (err) {
      showError(err.message || 'AI helper failed. Please try again.');
      track('ai_helper_error', { helper_type: helperType });
    } finally {
      // Re-enable button
      if (btn) {
        btn.disabled = false;
        var labels = { expedite_email: 'Draft Expedite Email', escalation_summary: 'Escalation Summary', meeting_talking_points: 'Meeting Talking Points' };
        btn.querySelector('.ai-helper-btn-label').textContent = labels[helperType] || helperType;
      }
    }
  }

  // Wire AI helper buttons via event delegation
  if (aiHelpersSection) {
    aiHelpersSection.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-helper]');
      if (btn && !btn.disabled) {
        requestAiHelper(btn.getAttribute('data-helper'));
      }
    });
  }

  // Copy to clipboard
  if (aiHelperCopyBtn) {
    aiHelperCopyBtn.addEventListener('click', function () {
      var text = aiHelperResultText ? aiHelperResultText.textContent : '';
      if (text && navigator.clipboard) {
        navigator.clipboard.writeText(text).then(function () {
          aiHelperCopyBtn.textContent = 'Copied ✓';
          setTimeout(function () { aiHelperCopyBtn.textContent = 'Copy to clipboard'; }, 2000);
        });
      }
    });
  }

  // Fetch AI helper availability on page load
  fetch('/api/ai-helper/types')
    .then(function (res) { return res.ok ? res.json() : null; })
    .then(function (data) {
      if (data && data.configured) aiHelpersAvailable = true;
    })
    .catch(function () { /* AI helpers not available — that's fine */ });

  // ── Plan initialization ───────────────────────────────────────────────────
  // Fetches /api/plan on page load and wires up plan-aware UI state.
  // Fails silently — if the request fails all gating is skipped (open access).

  // Whether Stripe billing is configured on the backend.
  let billingConfigured = false;

  // ── Billing helpers ─────────────────────────────────────────────────────
  async function startCheckout() {
    if (!currentUser || !window.authModule) {
      // Prompt sign-in first
      if (authModal) authModal.classList.remove('hidden');
      return;
    }
    try {
      const token = await window.authModule.getToken();
      const res = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + token
        }
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || 'Checkout failed');
      }
      const { url } = await res.json();
      window.location.href = url;
    } catch (err) {
      showError(err.message || 'Could not start checkout. Please try again.');
    }
  }

  async function openBillingPortal() {
    if (!currentUser || !window.authModule) return;
    try {
      const token = await window.authModule.getToken();
      const res = await fetch('/api/billing/portal', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + token
        }
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || 'Could not open billing portal.');
      }
      const { url } = await res.json();
      window.location.href = url;
    } catch (err) {
      showError(err.message || 'Could not open billing portal.');
    }
  }

  // Wire "Manage billing" button
  if (manageBillingBtn) {
    manageBillingBtn.addEventListener('click', openBillingPortal);
  }

  // Wire all [data-upgrade] buttons (static and dynamic)
  document.addEventListener('click', function (e) {
    if (e.target.closest('[data-upgrade]')) {
      e.preventDefault();
      startCheckout();
    }
  });

  function applyPlanToUI(planData) {
    currentPlan = planData;
    billingConfigured = !!planData.billingConfigured;

    if (planBadge) {
      const isPro = planData.plan === 'pro';
      planBadge.textContent = isPro ? 'Pro' : 'Free';
      planBadge.className   = isPro ? 'plan-badge plan-badge-pro' : 'plan-badge plan-badge-free';
    }

    if (!planData.entitlements.csvExport) {
      exportBtn.classList.add('locked');
      exportBtn.setAttribute('title', 'CSV export is a Pro plan feature');
      if (exportUpgrade) {
        while (exportUpgrade.firstChild) exportUpgrade.removeChild(exportUpgrade.firstChild);
        exportUpgrade.classList.remove('hidden');
        if (billingConfigured) {
          var btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'upgrade-link-btn';
          btn.setAttribute('data-upgrade', '');
          btn.textContent = 'Upgrade to Pro';
          exportUpgrade.appendChild(btn);
        } else {
          exportUpgrade.textContent = 'Pro feature';
        }
      }
    } else {
      exportBtn.classList.remove('locked');
      exportBtn.removeAttribute('title');
      if (exportUpgrade) exportUpgrade.classList.add('hidden');
    }

    if (!planData.entitlements.pdfExport) {
      pdfBtn.classList.add('locked');
      pdfBtn.setAttribute('title', 'PDF export is a Pro plan feature');
      if (pdfUpgrade) {
        while (pdfUpgrade.firstChild) pdfUpgrade.removeChild(pdfUpgrade.firstChild);
        pdfUpgrade.classList.remove('hidden');
        if (billingConfigured) {
          var btn2 = document.createElement('button');
          btn2.type = 'button';
          btn2.className = 'upgrade-link-btn';
          btn2.setAttribute('data-upgrade', '');
          btn2.textContent = 'Upgrade to Pro';
          pdfUpgrade.appendChild(btn2);
        } else {
          pdfUpgrade.textContent = 'Pro feature';
        }
      }
    } else {
      pdfBtn.classList.remove('locked');
      pdfBtn.removeAttribute('title');
      if (pdfUpgrade) pdfUpgrade.classList.add('hidden');
    }

    // Show/hide manage-billing button
    if (manageBillingBtn) {
      if (billingConfigured && currentUser && planData.plan === 'pro') {
        manageBillingBtn.classList.remove('hidden');
      } else {
        manageBillingBtn.classList.add('hidden');
      }
    }

    // Re-evaluate AI helpers visibility when plan changes
    showAiHelpersPanel();
  }

  // Fetches the plan from the server, optionally with auth token for per-user plans.
  async function fetchPlan() {
    try {
      var headers = {};
      if (currentUser && window.authModule) {
        var token = await window.authModule.getToken();
        if (token) headers['Authorization'] = 'Bearer ' + token;
      }
      var res = await fetch('/api/plan', { headers: headers });
      if (!res.ok) return;
      var data = await res.json();
      applyPlanToUI(data);
    } catch (_) { /* fail silently */ }
  }

  // Don't fetch plan eagerly — wait for auth to resolve first so the token
  // is available and we get the per-user plan in a single request instead
  // of briefly showing "Free" and then correcting to "Pro".

  // ── Auth initialization ────────────────────────────────────────────────────
  // Waits for authModule.init() to resolve, then wires the onAuthChange
  // listener.  If Supabase isn't configured, fetches plan anonymously.
  if (window.authModule) {
    window.authModule.init().then(function () {
      if (!window.authModule.isConfigured()) {
        // Auth not configured — fetch plan anonymously
        fetchPlan();
        return;
      }
      window.authModule.onAuthChange(onAuthStateChanged);
      // Retrieve existing session on page load
      window.authModule.getSession().then(function (session) {
        onAuthStateChanged('INITIAL_SESSION', session);
      });
    });
  } else {
    // No auth module at all — fetch plan anonymously
    fetchPlan();
  }

})();

