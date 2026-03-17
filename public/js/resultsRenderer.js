/* resultsRenderer.js — analysis result rendering pipeline.
 *
 * Responsible for all DOM rendering after a successful upload response:
 * executive summary, metric cards, priority panel, leadership narrative,
 * full results table (with filtering), and print-header population.
 */
(function () {
  'use strict';

  var App   = window.App;
  var dom   = App.dom;
  var state = App.state;
  var track = App.track;

  // ── Executive summary renderer ─────────────────────────────────────────

  function renderExecSummary(data) {
    if (!dom.execSummarySection || typeof buildExecutiveSummary !== 'function') return;

    var brief = buildExecutiveSummary(data);

    // Score ring
    dom.execScoreRing.className = 'exec-score-ring ' + brief.colorClass;
    dom.execScoreValue.textContent = brief.score;
    dom.execScoreLabel.textContent = brief.label;

    // KPI counts
    dom.execUrgentCount.textContent = brief.urgent;
    dom.execExcessCount.textContent = brief.excess;

    // Top Risk
    dom.execTopRisk.textContent = brief.topRisk ? brief.topRisk.detail : 'None identified';

    // Top Opportunity
    dom.execTopOpp.textContent = brief.topOpp ? brief.topOpp.detail : 'None identified';

    // Narrative
    dom.execNarrative.textContent = brief.narrative;
  }

  // ── Main render ───────────────────────────────────────────────────────────

  /**
   * Entry point after a successful upload response.
   * @param {{ summary, topPriority, results, analyzedAt, thresholds }} data
   */
  function renderAll(data) {
    // Defensive guard: verify the server returned the expected shape before
    // any render function touches the DOM.
    if (!data || !Array.isArray(data.results) || !data.summary || !data.thresholds) {
      App.showError('The server returned an unexpected response format. Please try again.');
      return;
    }

    state.lastResponse = data;
    state.allResults   = data.results;

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
    var dups           = Array.isArray(data.duplicateWarnings) ? data.duplicateWarnings : [];
    var preambleCount  = (typeof data.preambleRowsSkipped === 'number') ? data.preambleRowsSkipped : 0;
    var isWin1252      = data.encodingDetected === 'win1252';

    var notices = [];

    if (preambleCount > 0) {
      notices.push(
        preambleCount + ' metadata row' + (preambleCount > 1 ? 's' : '') + ' skipped before the column header \u2014 standard in ERP exports.'
      );
    }

    if (isWin1252) {
      notices.push(
        'Decoded as Windows-1252. Verify accented characters in part numbers are correct.'
      );
    }

    if (dups.length > 0) {
      notices.push(
        dups.length + ' duplicate part number' + (dups.length > 1 ? 's' : '') + ' found (' +
        dups.slice(0, 5).join(', ') + (dups.length > 5 ? '\u2026' : '') + '). ' +
        'Each is analyzed independently \u2014 de-duplicate before acting on results.'
      );
    }

    if (notices.length > 0) {
      dom.warningBanner.textContent = '';
      if (notices.length === 1) {
        dom.warningBanner.textContent = notices[0];
      } else {
        var ul = document.createElement('ul');
        ul.className = 'warning-list';
        notices.forEach(function (msg) {
          var li = document.createElement('li');
          li.textContent = msg;
          ul.appendChild(li);
        });
        dom.warningBanner.appendChild(ul);
      }
      dom.warningBanner.classList.remove('hidden');
    } else {
      dom.warningBanner.textContent = '';
      dom.warningBanner.classList.add('hidden');
    }

    // Reset filters whenever new data is loaded
    dom.filterPart.value     = '';
    dom.filterStatus.value   = '';
    dom.filterSeverity.value = '';

    applyFilters();

    // Show action bar with timestamp and row count
    var ts = data.analyzedAt
      ? new Date(data.analyzedAt).toLocaleString(undefined, {
          dateStyle: 'medium', timeStyle: 'short'
        })
      : 'just now';
    var total = data.summary?.total ?? 0;
    dom.actionBarTimestamp.textContent =
      'Analysis complete \u00b7 ' + total + ' row' + (total !== 1 ? 's' : '') + ' processed \u00b7 ' + ts;
    dom.actionBar.classList.remove('hidden');

    // Plan-aware truncation notice
    if (dom.tableLimitNotice) {
      if (data.resultsTruncated && data.plan) {
        var shown = data.results.length;
        var beforeTrunc = data.totalBeforeTruncation;
        dom.tableLimitNotice.textContent =
          'Free plan: showing ' + shown + ' of ' + beforeTrunc + ' parts. ' +
          'Upgrade to Pro ($49/mo) for full results, CSV/PDF export, and run history.';
        dom.tableLimitNotice.classList.remove('hidden');
      } else {
        dom.tableLimitNotice.textContent = '';
        dom.tableLimitNotice.classList.add('hidden');
      }
    }

    // Populate the print-only report header so the PDF output is self-contained.
    var printTimestamp = document.getElementById('printTimestamp');
    var printFilename  = document.getElementById('printFilename');
    var printMethod    = document.getElementById('printMethod');
    var printFooter    = document.getElementById('printFooter');
    var fname = dom.fileInput.files[0] ? dom.fileInput.files[0].name : 'inventory export';
    if (printTimestamp) printTimestamp.textContent = 'Generated: ' + ts;
    if (printFilename)  printFilename.textContent  = 'Source: ' + fname;
    if (printMethod && data.thresholds) {
      var thr = data.thresholds;
      var crPct = Math.round((thr.CRITICAL_RATIO ?? 0.25) * 100);
      var urPct = Math.round((thr.URGENT_RATIO   ?? 0.5)  * 100);
      var exR   = thr.EXCESS_RATIO      ?? 2.0;
      var dsR   = thr.DEAD_STOCK_RATIO  ?? 6.0;
      printMethod.textContent =
        'Coverage = on-hand \u00f7 daily usage. ' +
        'Critical \u2264' + crPct + '% of lead time \u00b7 ' +
        'Urgent \u2264' + urPct + '% \u00b7 ' +
        'Excess >' + exR + '\u00d7 lead time \u00b7 ' +
        'Dead stock >' + dsR + '\u00d7 lead time.';
    }
    if (printFooter) {
      var leftSpan  = document.createElement('span');
      var rightSpan = document.createElement('span');
      leftSpan.textContent  = 'OpsCopilot-Lite \u00b7 Inventory Triage Report \u00b7 ' + ts;
      rightSpan.textContent = 'Internal Use Only';
      while (printFooter.firstChild) printFooter.removeChild(printFooter.firstChild);
      printFooter.appendChild(leftSpan);
      printFooter.appendChild(rightSpan);
    }
    if (dom.execSummarySection) dom.execSummarySection.classList.remove('hidden');
    dom.summarySection.classList.remove('hidden');
    dom.resultsSection.classList.remove('hidden');

    // Show "Save to History" button if user is signed in and plan allows history
    var canSave = state.currentUser && state.currentPlan && state.currentPlan.entitlements.savedHistory;
    if (dom.saveRunBtn && canSave) dom.saveRunBtn.classList.remove('hidden');

    // Show AI helpers panel if Pro + AI configured + analysis loaded
    App.aiHelpersUI.showAiHelpersPanel();
    // Hide any previous AI helper result when new data is loaded
    if (dom.aiHelperResult) dom.aiHelperResult.classList.add('hidden');
  }

  // ── Summary ───────────────────────────────────────────────────────────────

  function renderSummary(s) {
    dom.metricTotal.textContent     = s.total          ?? '\u2014';
    dom.metricUrgent.textContent    = s.urgent_stockout ?? '\u2014';
    dom.metricStockout.textContent  = s.stockout_risk   ?? '\u2014';
    dom.metricNoUsage.textContent   = s.no_usage        ?? '\u2014';
    dom.metricExcess.textContent    = s.excess          ?? '\u2014';
    dom.metricDeadStock.textContent = s.dead_stock      ?? '\u2014';
    dom.metricHealthy.textContent   = s.healthy         ?? '\u2014';
    dom.metricInvalid.textContent   = s.invalid         ?? '\u2014';
  }

  // ── Top-priority panel ────────────────────────────────────────────────────

  /**
   * Renders the "Needs Attention Now" list.
   * Shows up to 10 High/Medium rows already sorted by the backend.
   * If there are no such rows, the section stays hidden.
   */
  function renderPriorityPanel(items) {
    while (dom.priorityList.firstChild) {
      dom.priorityList.removeChild(dom.priorityList.firstChild);
    }

    if (!items || items.length === 0) {
      dom.priorityHint.textContent = '';
      dom.prioritySectionLabel.textContent = 'All Clear';
      dom.prioritySectionLabel.className = 'section-label section-label-ok';
      dom.priorityAllClear.classList.remove('hidden');
      dom.prioritySection.classList.remove('hidden');
      return;
    }

    // Reset all-clear state for this render pass
    dom.priorityAllClear.classList.add('hidden');
    dom.prioritySectionLabel.textContent = 'Action Required';
    dom.prioritySectionLabel.className = 'section-label';

    var highCount   = items.filter(function (i) { return i.severity === 'High'; }).length;
    var mediumCount = items.length - highCount;

    if (highCount > 0 && mediumCount > 0) {
      dom.priorityHint.textContent =
        highCount + ' part' + (highCount > 1 ? 's are' : ' is') + ' at critical coverage levels and need immediate action; ' +
        mediumCount + ' additional part' + (mediumCount > 1 ? 's' : '') + ' should be reviewed with purchasing this cycle.';
    } else if (highCount > 0) {
      dom.priorityHint.textContent =
        highCount + ' part' + (highCount > 1 ? 's are' : ' is') + ' at or below the emergency coverage threshold' +
        ' \u2014 confirm open PO status and escalate to buyers immediately.';
    } else {
      dom.priorityHint.textContent =
        'No urgent stockout risk detected. ' + items.length + ' part' + (items.length > 1 ? 's have' : ' has') +
        ' coverage below lead time \u2014 review open POs and confirm replenishment timing with purchasing.';
    }

    items.forEach(function (row) {
      var li = document.createElement('li');
      li.className = 'priority-item ' + App.statusClass(row.status);

      // Severity dot
      var dot = document.createElement('span');
      dot.className   = 'sev-dot sev-' + row.severity.toLowerCase();
      dot.textContent = row.severity;
      li.appendChild(dot);

      // Part number
      var part = document.createElement('span');
      part.className   = 'priority-part';
      part.textContent = row.part_number;
      li.appendChild(part);

      // Status badge
      var badge = document.createElement('span');
      badge.className   = 'badge ' + App.statusClass(row.status);
      badge.textContent = row.status;
      li.appendChild(badge);

      // Coverage / stock context
      var blurb = document.createElement('span');
      blurb.className = 'priority-detail';
      if (row.coverage !== null) {
        blurb.textContent = 'Coverage: ' + row.coverage + ' days \u00b7 Lead time: ' + row.lead_time + ' days';
      } else {
        var oh = row.on_hand !== null ? row.on_hand + ' units on hand' : 'on hand unknown';
        blurb.textContent = oh + ' \u00b7 Lead time: ' + row.lead_time + ' days';
      }
      li.appendChild(blurb);

      // Action
      var action = document.createElement('span');
      action.className   = 'priority-action';
      action.textContent = row.recommended_action;
      li.appendChild(action);

      dom.priorityList.appendChild(li);
    });

    dom.prioritySection.classList.remove('hidden');
  }

  // ── Filtering ─────────────────────────────────────────────────────────────

  /** Returns only the rows that match all active filter criteria. */
  function getFilteredResults() {
    var partQuery   = dom.filterPart.value.trim().toLowerCase();
    var statusVal   = dom.filterStatus.value;
    var severityVal = dom.filterSeverity.value;

    return state.allResults.filter(function (row) {
      if (partQuery  && !row.part_number.toLowerCase().includes(partQuery)) return false;
      if (statusVal  && row.status   !== statusVal)   return false;
      if (severityVal && row.severity !== severityVal) return false;
      return true;
    });
  }

  /** Triggered on every filter change — re-renders the table body. */
  function applyFilters() {
    var filtered = getFilteredResults();
    renderTable(filtered);

    var partVal     = dom.filterPart.value.trim();
    var statusVal   = dom.filterStatus.value;
    var severityVal = dom.filterSeverity.value;
    var isFiltered  = partVal || statusVal || severityVal;

    if (isFiltered) {
      dom.filterCount.textContent = 'Showing ' + filtered.length + ' of ' + state.allResults.length + ' rows';
      dom.filterCount.classList.remove('hidden');
    } else {
      dom.filterCount.classList.add('hidden');
    }

    // Reflect active filters in the print/PDF header so exported PDFs are
    // self-documenting when a subset of rows is being printed.
    if (dom.printFilterContext) {
      if (isFiltered) {
        var parts = [];
        if (partVal)     parts.push('Part: \u201c' + partVal + '\u201d');
        if (statusVal)   parts.push('Status: ' + statusVal);
        if (severityVal) parts.push('Severity: ' + severityVal);
        dom.printFilterContext.textContent =
          'Table filtered to: ' + parts.join(' \u00b7 ') +
          ' \u2014 ' + filtered.length + ' of ' + state.allResults.length + ' rows shown.';
      } else {
        dom.printFilterContext.textContent = '';
      }
    }
  }

  // ── Table rendering ───────────────────────────────────────────────────────

  function renderTable(rows) {
    while (dom.resultsBody.firstChild) {
      dom.resultsBody.removeChild(dom.resultsBody.firstChild);
    }

    if (rows.length === 0) {
      var tr = document.createElement('tr');
      var td = document.createElement('td');
      td.colSpan = 9;
      td.className = 'table-no-results';
      td.textContent = 'No rows match the current filters. Clear a filter to see more results.';
      tr.appendChild(td);
      dom.resultsBody.appendChild(tr);
      return;
    }

    rows.forEach(function (row) {
      var tr = document.createElement('tr');
      tr.className = App.statusClass(row.status);

      appendCell(tr, row.part_number);
      appendCell(tr, App.formatNumber(row.coverage));
      appendStatusCell(tr, row.status);
      appendSeverityCell(tr, row.severity);
      appendCell(tr, App.formatNumber(row.on_hand));
      appendCell(tr, App.formatNumber(row.daily_usage));
      appendCell(tr, App.formatNumber(row.lead_time));
      appendCell(tr, row.reason);
      appendCell(tr, row.recommended_action);

      dom.resultsBody.appendChild(tr);
    });
  }

  // ── DOM cell helpers ──────────────────────────────────────────────────────

  function appendCell(tr, value) {
    var td = document.createElement('td');
    td.textContent = (value === null || value === undefined) ? '\u2014' : value;
    tr.appendChild(td);
  }

  function appendStatusCell(tr, status) {
    var td    = document.createElement('td');
    var badge = document.createElement('span');
    badge.className   = 'badge ' + App.statusClass(status);
    badge.textContent = status;
    td.appendChild(badge);
    tr.appendChild(td);
  }

  function appendSeverityCell(tr, severity) {
    var td    = document.createElement('td');
    var badge = document.createElement('span');
    badge.className   = 'sev-badge sev-' + (severity || '').toLowerCase();
    badge.textContent = severity || '\u2014';
    td.appendChild(badge);
    tr.appendChild(td);
  }

  // ── Leadership summary ──────────────────────────────────────────────────────────────

  /**
   * Renders the executive narrative and auditability note.
   */
  function renderLeadershipSummary(summary, topPriority, analyzedAt, thresholds, columnAliases) {
    var t = thresholds ?? {};
    var criticalRatioPct = Math.round((t.CRITICAL_RATIO ?? 0.25) * 100);
    var urgentRatioPct   = Math.round((t.URGENT_RATIO   ?? 0.5)  * 100);
    var excessRatio      = t.EXCESS_RATIO      ?? 2.0;
    var deadStockRatio   = t.DEAD_STOCK_RATIO  ?? 6.0;

    var dateStr = analyzedAt
      ? new Date(analyzedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
      : 'today';

    var urgentN  = summary.urgent_stockout ?? 0;
    var riskN    = summary.stockout_risk   ?? 0;
    var noUsageN = summary.no_usage        ?? 0;
    var excessN  = summary.excess          ?? 0;
    var deadN    = summary.dead_stock      ?? 0;
    var invalidN = summary.invalid         ?? 0;
    var healthyN = summary.healthy         ?? 0;
    var totalN   = summary.total           ?? 0;

    var paras = [];

    // ── Opening: scope and date
    paras.push(
      totalN + ' inventory line' + (totalN !== 1 ? 's' : '') + ' reviewed as of ' + dateStr + '.'
    );

    // ── Supply risk
    if (urgentN > 0 || riskN > 0) {
      var clauses = [];

      if (urgentN > 0) {
        var criticalN = (topPriority || []).filter(function (r) {
          return r.status === 'Urgent Stockout Risk' &&
            r.coverage !== null && r.lead_time > 0 &&
            r.coverage <= r.lead_time * (t.CRITICAL_RATIO ?? 0.25);
        }).length;

        if (criticalN > 0 && criticalN < urgentN) {
          clauses.push(
            criticalN + ' part' + (criticalN > 1 ? 's are' : ' is') + ' critically short' +
            ' \u2014 under ' + criticalRatioPct + '% of lead time in stock' +
            ' \u2014 and ' + (urgentN - criticalN) + ' more ' + ((urgentN - criticalN) > 1 ? 'are' : 'is') +
            ' below the ' + urgentRatioPct + '% emergency threshold'
          );
        } else if (criticalN > 0) {
          clauses.push(
            urgentN + ' part' + (urgentN > 1 ? 's are' : ' is') + ' critically short' +
            ' \u2014 under ' + criticalRatioPct + '% of lead time in stock'
          );
        } else {
          clauses.push(
            urgentN + ' part' + (urgentN > 1 ? 's are' : ' is') + ' below the emergency coverage threshold' +
            ' \u2014 under ' + urgentRatioPct + '% of lead time remaining'
          );
        }
      }

      if (riskN > 0)
        clauses.push(
          riskN + ' additional part' + (riskN > 1 ? 's are' : ' is') + ' below replenishment lead time' +
          ' \u2014 purchasing should confirm open PO status'
        );

      paras.push(clauses.join('; ') + '.');
    }

    // ── No usage data
    if (noUsageN > 0)
      paras.push(
        noUsageN + ' part' + (noUsageN > 1 ? 's have' : ' has') + ' no demand signal on record.' +
        ' Coverage cannot be assessed.' +
        ' Confirm whether ' + (noUsageN > 1 ? 'these are' : 'this is') + ' active, seasonal, or consigned' +
        ' before drawing down safety stock.'
      );

    // ── Excess capital / potential dead stock
    if (deadN > 0)
      paras.push(
        deadN + ' part' + (deadN > 1 ? 's exceed' : ' exceeds') + ' ' + deadStockRatio + '\u00d7 their lead time in stock' +
        ' \u2014 disposition review warranted (return, reallocation, or write-off).'
      );

    if (excessN > 0)
      paras.push(
        excessN + ' part' + (excessN > 1 ? 's carry' : ' carries') + ' more than ' + excessRatio + '\u00d7' +
        ' their lead time in stock.' +
        ' Candidates for demand pull-in or return to supplier.'
      );

    // ── Data quality
    if (invalidN > 0)
      paras.push(
        invalidN + ' row' + (invalidN > 1 ? 's' : '') + ' could not be classified' +
        ' \u2014 required fields are missing or unreadable.' +
        ' Listed in the detail table for master data correction.'
      );

    // ── Healthy coverage
    if (healthyN > 0)
      paras.push(
        healthyN + ' part' + (healthyN > 1 ? 's are' : ' is') + ' adequately stocked against' +
        ' ' + (healthyN > 1 ? 'their' : 'its') + ' lead time.'
      );

    // ── No-risk conclusion
    if (urgentN === 0 && riskN === 0 && noUsageN === 0 && invalidN === 0)
      paras.push('No supply risks or data quality issues identified in this export.');

    dom.leadershipNarrative.textContent = paras.join('\n');

    // ── Audit note
    var auditText =
      'Results produced by fixed coverage rules applied uniformly to every row \u2014 ' +
      'no manual adjustments or external data. ' +
      'Coverage = on-hand \u00f7 daily usage = days of stock remaining. ' +
      'Critical: \u2264' + criticalRatioPct + '% of lead time. ' +
      'Urgent: \u2264' + urgentRatioPct + '% of lead time. ' +
      'Excess: >' + excessRatio + '\u00d7 lead time. ' +
      'Dead stock: >' + deadStockRatio + '\u00d7 lead time.';

    var FRIENDLY_CANONICAL = {
      part_number: 'Part Number',
      on_hand:     'Quantity on Hand',
      daily_usage: 'Daily Usage',
      lead_time:   'Lead Time',
    };
    var aliasEntries = columnAliases && typeof columnAliases === 'object'
      ? Object.entries(columnAliases) : [];
    if (aliasEntries.length > 0) {
      var aliasNote = aliasEntries
        .map(function (entry) { return '\u201c' + entry[1] + '\u201d \u2192 ' + (FRIENDLY_CANONICAL[entry[0]] || entry[0]); })
        .join(', ');
      auditText += ' Column names remapped from source: ' + aliasNote + '.';
    }

    dom.auditThresholds.textContent = auditText;
    dom.leadershipSection.classList.remove('hidden');
  }

  // ── Wire filter listeners ─────────────────────────────────────────────────
  dom.filterPart.addEventListener('input',    applyFilters);
  dom.filterStatus.addEventListener('change', applyFilters);
  dom.filterSeverity.addEventListener('change', applyFilters);

  // ── Public API ────────────────────────────────────────────────────────────
  App.resultsRenderer = {
    renderAll:          renderAll,
    applyFilters:       applyFilters,
    getFilteredResults: getFilteredResults,
  };
})();
