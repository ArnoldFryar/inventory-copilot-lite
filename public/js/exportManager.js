/* exportManager.js — CSV/PDF export and billing/plan integration. */
(function () {
  'use strict';

  var App   = window.App;
  var dom   = App.dom;
  var state = App.state;
  var track = App.track;

  // ── Comparison CSV export ──────────────────────────────────────────────

  var COMPARISON_SECTIONS = [
    { key: 'newUrgent',      label: 'New Urgent',      showPrev: false },
    { key: 'resolvedUrgent', label: 'Resolved Urgent', showPrev: true  },
    { key: 'worsened',       label: 'Worsened',        showPrev: true  },
    { key: 'improved',       label: 'Improved',        showPrev: true  },
    { key: 'added',          label: 'New Parts',       showPrev: false },
    { key: 'removed',        label: 'Removed Parts',   showPrev: false },
  ];

  function downloadComparisonCSV(cmp) {
    var escape = function (val) {
      var s = (val === null || val === undefined) ? '' : String(val);
      return /[,"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };

    var header = 'category,part_number,prev_status,curr_status,coverage_days';
    var lines  = [];

    COMPARISON_SECTIONS.forEach(function (sec) {
      var items = cmp[sec.key] || [];
      items.forEach(function (item) {
        lines.push([
          escape(sec.label),
          escape(item.part_number),
          escape(sec.showPrev ? (item.prev_status || '') : ''),
          escape(item.status || ''),
          escape(item.coverage !== null && item.coverage !== undefined ? item.coverage : ''),
        ].join(','));
      });
    });

    var csv  = [header].concat(lines).join('\r\n');
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    var url  = URL.createObjectURL(blob);
    var a    = document.createElement('a');
    a.href     = url;
    var dateStr = state.lastResponse && state.lastResponse.analyzedAt
      ? (function () {
          var d = new Date(state.lastResponse.analyzedAt);
          return d.getFullYear() + '-' +
            String(d.getMonth() + 1).padStart(2, '0') + '-' +
            String(d.getDate()).padStart(2, '0');
        })()
      : new Date().toISOString().slice(0, 10);
    a.download = 'inventory_comparison_' + dateStr + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  if (dom.comparisonExportBtn) {
    dom.comparisonExportBtn.addEventListener('click', function () {
      var cmp = state.lastComparison;
      if (!cmp) return;
      track('export_comparison_csv_clicked', {
        new_urgent: (cmp.newUrgent || []).length,
        worsened:   (cmp.worsened  || []).length,
      });
      downloadComparisonCSV(cmp);
    });
  }

  // ── CSV export ────────────────────────────────────────────────────────────

  var EXPORT_COLUMNS = [
    'part_number', 'on_hand', 'daily_usage', 'lead_time',
    'coverage', 'status', 'severity', 'reason', 'recommended_action'
  ];

  /**
   * Builds a CSV string from the given rows and triggers a browser download.
   * Values are quoted and internal quotes are escaped per RFC 4180.
   */
  function downloadCSV(rows) {
    var escape = function (val) {
      var s = (val === null || val === undefined) ? '' : String(val);
      // Wrap in quotes if the value contains comma, quote, or newline
      return /[,"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };

    var header = EXPORT_COLUMNS.join(',');
    var lines  = rows.map(function (row) {
      return EXPORT_COLUMNS.map(function (col) { return escape(row[col]); }).join(',');
    });

    var csv  = [header].concat(lines).join('\r\n');
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    var url  = URL.createObjectURL(blob);

    var a = document.createElement('a');
    a.href     = url;
    // Use the server-side analyzedAt timestamp (local date) for the filename
    // so the export matches the analysis date shown in the report.
    // Falls back to the current local date only if analyzedAt is unavailable.
    var exportDateStr = state.lastResponse && state.lastResponse.analyzedAt
      ? (function () {
          var d = new Date(state.lastResponse.analyzedAt);
          var y = d.getFullYear();
          var m = String(d.getMonth() + 1).padStart(2, '0');
          var day = String(d.getDate()).padStart(2, '0');
          return y + '-' + m + '-' + day;
        })()
      : new Date().toISOString().slice(0, 10);
    a.download = 'inventory_triage_' + exportDateStr + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ── Export button ───────────────────────────────────────────────────────────
  dom.exportBtn.addEventListener('click', function () {
    if (state.currentPlan && !state.currentPlan.entitlements.csvExport) {
      if (state.billingConfigured) { startCheckout(); }
      else { App.showError('CSV export is available on the Pro plan.'); }
      return;
    }
    var visible = App.resultsRenderer.getFilteredResults();
    if (visible.length === 0) {
      App.showError('No rows to export with the current filter selection.');
      return;
    }
    track('export_csv_clicked', { row_count: visible.length });
    downloadCSV(visible);
  });

  // ── PDF download ──────────────────────────────────────────────────────────
  // Uses the browser's built-in print engine with the @media print stylesheet.
  // User selects 'Save as PDF' in the print dialog.
  dom.pdfBtn.addEventListener('click', function () {
    if (state.currentPlan && !state.currentPlan.entitlements.pdfExport) {
      if (state.billingConfigured) { startCheckout(); }
      else { App.showError('PDF export is available on the Pro plan.'); }
      return;
    }
    track('print_clicked');
    window.print();
  });

  // ── Billing helpers ───────────────────────────────────────────────────────

  async function startCheckout() {
    if (!state.currentUser || !window.authModule) {
      // Prompt sign-in first
      if (dom.authModal) dom.authModal.classList.remove('hidden');
      return;
    }
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
      window.location.href = data.url;
    } catch (err) {
      App.showError(err.message || 'Could not start checkout. Please try again.');
    }
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
    if (e.target.closest('[data-upgrade]')) {
      e.preventDefault();
      startCheckout();
    }
  });

  // ── Plan UI ───────────────────────────────────────────────────────────────

  function applyPlanToUI(planData) {
    state.currentPlan = planData;
    state.billingConfigured = !!planData.billingConfigured;

    if (dom.planBadge) {
      var isPro = planData.plan === 'pro';
      dom.planBadge.textContent = isPro ? 'Pro' : 'Free';
      dom.planBadge.className   = isPro ? 'plan-badge plan-badge-pro' : 'plan-badge plan-badge-free';
    }

    if (!planData.entitlements.csvExport) {
      dom.exportBtn.classList.add('locked');
      dom.exportBtn.setAttribute('title', 'CSV export is a Pro plan feature');
      if (dom.exportUpgrade) {
        while (dom.exportUpgrade.firstChild) dom.exportUpgrade.removeChild(dom.exportUpgrade.firstChild);
        dom.exportUpgrade.classList.remove('hidden');
        var csvLabel = document.createElement('span');
        csvLabel.className = 'upgrade-callout-label';
        csvLabel.textContent = 'Pro feature';
        dom.exportUpgrade.appendChild(csvLabel);
        if (state.billingConfigured) {
          var csvBtn = document.createElement('button');
          csvBtn.type = 'button';
          csvBtn.className = 'upgrade-callout-btn';
          csvBtn.setAttribute('data-upgrade', '');
          csvBtn.textContent = 'Unlock CSV Export \u2192';
          dom.exportUpgrade.appendChild(csvBtn);
        }
      }
    } else {
      dom.exportBtn.classList.remove('locked');
      dom.exportBtn.removeAttribute('title');
      if (dom.exportUpgrade) dom.exportUpgrade.classList.add('hidden');
    }

    if (!planData.entitlements.pdfExport) {
      dom.pdfBtn.classList.add('locked');
      dom.pdfBtn.setAttribute('title', 'PDF export is a Pro plan feature');
      if (dom.pdfUpgrade) {
        while (dom.pdfUpgrade.firstChild) dom.pdfUpgrade.removeChild(dom.pdfUpgrade.firstChild);
        dom.pdfUpgrade.classList.remove('hidden');
        var pdfLabel = document.createElement('span');
        pdfLabel.className = 'upgrade-callout-label';
        pdfLabel.textContent = 'Pro feature';
        dom.pdfUpgrade.appendChild(pdfLabel);
        if (state.billingConfigured) {
          var pdfBtn2 = document.createElement('button');
          pdfBtn2.type = 'button';
          pdfBtn2.className = 'upgrade-callout-btn';
          pdfBtn2.setAttribute('data-upgrade', '');
          pdfBtn2.textContent = 'Unlock PDF Export \u2192';
          dom.pdfUpgrade.appendChild(pdfBtn2);
        }
      }
    } else {
      dom.pdfBtn.classList.remove('locked');
      dom.pdfBtn.removeAttribute('title');
      if (dom.pdfUpgrade) dom.pdfUpgrade.classList.add('hidden');
    }

    // Show/hide manage-billing button
    if (dom.manageBillingBtn) {
      if (state.billingConfigured && state.currentUser && planData.plan === 'pro') {
        dom.manageBillingBtn.classList.remove('hidden');
      } else {
        dom.manageBillingBtn.classList.add('hidden');
      }
    }

    // Re-evaluate AI helpers visibility when plan changes
    App.aiHelpersUI.showAiHelpersPanel();
  }

  // Fetches the plan from the server, optionally with auth token for per-user plans.
  async function fetchPlan() {
    try {
      var headers = {};
      if (state.currentUser && window.authModule) {
        var token = await window.authModule.getToken();
        if (token) headers['Authorization'] = 'Bearer ' + token;
      }
      var res = await fetch('/api/plan', { headers: headers });
      if (!res.ok) return;
      var data = await res.json();
      applyPlanToUI(data);
    } catch (_) { /* fail silently */ }
  }

  App.exportManager = {
    startCheckout: startCheckout,
    fetchPlan:     fetchPlan,
  };
})();
