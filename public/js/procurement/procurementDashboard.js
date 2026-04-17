/* procurementDashboard.js — Hydrates the Procurement Copilot dashboard.
 *
 * Fetches saved runs from the API and populates:
 *   - 6 KPI cards      (from the most-recent run's summary_json)
 *   - Recent Runs list  (from the runs index)
 *   - Top Risks         (insights from latest run detail)
 *   - Supplier Breakdown (supplier_rollups from latest run detail)
 *
 * Auth behaviour:
 *   - Signed-in + Pro: full hydration from persisted runs
 *   - Signed-in + Free: 403 → shows empty state (upgrade messaging via plan badge)
 *   - Not signed in:   shows a guest prompt on the Recent Runs panel
 *
 * Dependencies (loaded before this script):
 *   - auth.js          (window.authModule)
 *   - Icon.js          (window.App.Icon)
 *   - procurementApp.js (auth wiring)
 */
(function () {
  'use strict';

  // ── Helpers ──────────────────────────────────────────────────────────────
  function escHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g,  '&amp;')
      .replace(/</g,  '&lt;')
      .replace(/>/g,  '&gt;')
      .replace(/"/g,  '&quot;')
      .replace(/'/g,  '&#39;');
  }

  function fmt(n) {
    if (n == null || isNaN(n)) return '\u2014';
    return Number(n).toLocaleString('en-US');
  }

  function fmtCurrency(value, currency) {
    if (value == null || isNaN(value)) return '\u2014';
    try {
      return Number(value).toLocaleString('en-US', {
        style: 'currency', currency: currency || 'USD',
        minimumFractionDigits: 0, maximumFractionDigits: 0,
      });
    } catch (_) {
      return '$' + fmt(Math.round(value));
    }
  }

  function fmtDate(iso) {
    if (!iso) return '\u2014';
    try {
      return new Date(iso).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
      });
    } catch (_) { return iso; }
  }

  function show(el) { if (el) el.classList.remove('hidden'); }
  function hide(el) { if (el) el.classList.add('hidden'); }

  function hydrateIcons() {
    var App = window.App || {};
    if (App.Icon && App.Icon.hydrateAll) App.Icon.hydrateAll();
  }

  // ── DOM refs ─────────────────────────────────────────────────────────────
  var kpiEls = {
    openPoLines:    document.getElementById('kpiOpenPoLines'),
    pastDueLines:   document.getElementById('kpiPastDueLines'),
    dueSoon:        document.getElementById('kpiDueSoon'),
    highRiskLines:  document.getElementById('kpiHighRiskLines'),
    suppliersAtRisk: document.getElementById('kpiSuppliersAtRisk'),
    dollarExposure: document.getElementById('kpiDollarExposure'),
  };

  var recentRunsList  = document.getElementById('recentRunsList');
  var recentRunsEmpty = document.getElementById('recentRunsEmpty');
  var recentRunsGuest = document.getElementById('recentRunsGuest');

  var topRisksList    = document.getElementById('topRisksList');
  var topRisksEmpty   = document.getElementById('topRisksEmpty');
  var topRisksGuest   = document.getElementById('topRisksGuest');
  var topRisksBadge   = document.getElementById('topRisksBadge');

  var supplierTableBody = document.getElementById('supplierTableBody');
  var supplierEmptyRow  = document.getElementById('supplierEmptyRow');
  var supplierGuestRow  = document.getElementById('supplierGuestRow');
  var supplierBadge     = document.getElementById('supplierBadge');

  var dashboardGuestBanner = document.getElementById('dashboardGuestBanner');

  // ── KPI population ──────────────────────────────────────────────────────
  function setKpi(el, value) {
    if (!el) return;
    el.textContent = value;
    el.classList.remove('pco-value-placeholder');
    el.removeAttribute('aria-label');
  }

  function populateKpis(summary) {
    if (!summary) return;
    var cur = summary.currency || 'USD';
    setKpi(kpiEls.openPoLines,    fmt(summary.total_lines));
    setKpi(kpiEls.pastDueLines,   fmt(summary.past_due_lines));
    setKpi(kpiEls.dueSoon,        fmt(summary.due_soon_lines));
    setKpi(kpiEls.highRiskLines,  fmt(summary.high_risk_lines != null ? summary.high_risk_lines : summary.flagged_lines));
    setKpi(kpiEls.suppliersAtRisk, fmt(summary.high_risk_suppliers));
    setKpi(kpiEls.dollarExposure, fmtCurrency(summary.dollar_exposure_at_risk, cur));
  }

  // ── Recent Runs list ────────────────────────────────────────────────────
  function populateRecentRuns(runs) {
    if (!recentRunsList || !runs || runs.length === 0) return;

    var html = '<ul class="pco-runs-list">';
    var limit = Math.min(runs.length, 8);
    for (var i = 0; i < limit; i++) {
      var r = runs[i];
      var s = r.summary_json || {};
      var severity = 'Low';
      if ((s.high_risk_suppliers || 0) > 0 || (s.past_due_lines || 0) > 0) severity = 'High';
      else if ((s.flagged_lines || 0) > 0) severity = 'Medium';

      html +=
        '<li class="pco-runs-item">' +
          '<a href="/procurement/runs/' + encodeURIComponent(r.id) + '" class="pco-runs-link">' +
            '<div class="pco-runs-item-main">' +
              '<span class="pco-runs-file">' + escHtml(r.file_name || 'Untitled') + '</span>' +
              '<span class="pco-runs-date">' + escHtml(fmtDate(r.uploaded_at)) + '</span>' +
            '</div>' +
            '<div class="pco-runs-item-meta">' +
              '<span class="pco-runs-lines">' + fmt(r.part_count) + ' lines</span>' +
              '<span class="pco-sev-dot pco-sev-dot--' + severity.toLowerCase() + '" title="' + escHtml(severity) + ' risk"></span>' +
            '</div>' +
          '</a>' +
        '</li>';
    }
    html += '</ul>';

    recentRunsList.innerHTML = html;
    show(recentRunsList);
    hide(recentRunsEmpty);
    hide(recentRunsGuest);
  }

  // ── Top Risks (insights from latest run) ────────────────────────────────
  function populateTopRisks(insights) {
    if (!topRisksList || !insights || insights.length === 0) return;

    var SEV_ORDER = { High: 0, Medium: 1, Low: 2 };
    insights.sort(function (a, b) {
      return (SEV_ORDER[a.severity] || 2) - (SEV_ORDER[b.severity] || 2);
    });

    var limit = Math.min(insights.length, 6);
    var html = '<ul class="pco-risks-list">';
    for (var i = 0; i < limit; i++) {
      var ins = insights[i];
      var sev = (ins.severity || 'Low').toLowerCase();
      html +=
        '<li class="pco-risk-item pco-risk-item--' + escHtml(sev) + '">' +
          '<div class="pco-risk-sev">' +
            '<span class="pco-sev-dot pco-sev-dot--' + escHtml(sev) + '"></span>' +
            '<span class="pco-risk-sev-label">' + escHtml(ins.severity || 'Low') + '</span>' +
          '</div>' +
          '<div class="pco-risk-body">' +
            '<strong class="pco-risk-title">' + escHtml(ins.title) + '</strong>' +
            (ins.description ? '<p class="pco-risk-desc">' + escHtml(ins.description) + '</p>' : '') +
          '</div>' +
        '</li>';
    }
    html += '</ul>';

    topRisksList.innerHTML = html;
    show(topRisksList);
    hide(topRisksEmpty);

    if (topRisksBadge) {
      topRisksBadge.textContent = insights.length + ' finding' + (insights.length === 1 ? '' : 's');
      show(topRisksBadge);
    }
  }

  // ── Supplier Risk Breakdown ─────────────────────────────────────────────
  function populateSuppliers(rollups, currency) {
    if (!supplierTableBody || !rollups || rollups.length === 0) return;

    var SEV_ORDER = { High: 0, Medium: 1, Low: 2 };
    rollups.sort(function (a, b) {
      return (SEV_ORDER[a.severity] || 2) - (SEV_ORDER[b.severity] || 2);
    });

    var cur = currency || 'USD';
    var html = '';
    var limit = Math.min(rollups.length, 10);
    for (var i = 0; i < limit; i++) {
      var r = rollups[i];
      var sev = (r.severity || 'Low').toLowerCase();
      html +=
        '<tr>' +
          '<td class="pco-td-supplier">' + escHtml(r.supplier) + '</td>' +
          '<td class="pco-td-num">' + fmt(r.line_count) + '</td>' +
          '<td class="pco-td-num">' + fmt(r.overdue_count) + '</td>' +
          '<td class="pco-td-num">' + fmt(r.flagged_count || r.high_risk_count) + '</td>' +
          '<td class="pco-td-num">' + fmtCurrency(r.past_due_dollars || r.total_spend, cur) + '</td>' +
          '<td><span class="pco-sev-pill pco-sev-pill--' + escHtml(sev) + '">' + escHtml(r.severity || 'Low') + '</span></td>' +
        '</tr>';
    }

    // Remove empty-state row and inject data rows
    if (supplierEmptyRow) supplierEmptyRow.remove();
    supplierTableBody.innerHTML = html;

    if (supplierBadge) {
      supplierBadge.textContent = rollups.length + ' supplier' + (rollups.length === 1 ? '' : 's');
      show(supplierBadge);
    }
  }

  // ── Show guest state (not signed in) ────────────────────────────────────
  // Locks all four data surfaces so signed-out users get intentional
  // empty states with sign-in CTAs, not confusing blank placeholders.
  function showGuestState() {
    // Top-level banner above KPI grid
    show(dashboardGuestBanner);

    // Recent Runs
    hide(recentRunsEmpty);
    show(recentRunsGuest);

    // Top Risks
    hide(topRisksEmpty);
    show(topRisksGuest);

    // Supplier Risk Breakdown
    hide(supplierEmptyRow);
    show(supplierGuestRow);

    hydrateIcons();
  }

  // ── Main hydration flow ─────────────────────────────────────────────────
  function hydrate() {
    if (!window.authModule) {
      showGuestState();
      return;
    }

    window.authModule.init()
      .then(function () {
        if (!window.authModule.isConfigured()) {
          showGuestState();
          return;
        }
        return window.authModule.getSession().then(function (session) {
          if (!session || !session.access_token) {
            showGuestState();
            return;
          }
          return fetchDashboardData(session.access_token);
        });
      })
      .catch(function (err) {
        console.warn('[procurementDashboard] auth init failed:', err);
        showGuestState();
      });
  }

  function fetchDashboardData(token) {
    var headers = { 'Authorization': 'Bearer ' + token };

    return fetch('/api/procurement/runs', { headers: headers })
      .then(function (res) {
        if (res.status === 403) return []; // Not Pro — treat as empty
        if (!res.ok) return [];
        return res.json();
      })
      .then(function (runs) {
        if (!Array.isArray(runs) || runs.length === 0) return;

        // Populate Recent Runs list
        populateRecentRuns(runs);

        // Populate KPIs from the most recent run's summary
        var latest = runs[0];
        var summary = latest.summary_json || {};
        populateKpis(summary);

        // Fetch the latest run's detail for Top Risks + Supplier Breakdown
        return fetch('/api/procurement/runs/' + encodeURIComponent(latest.id), { headers: headers })
          .then(function (res) {
            if (!res.ok) return null;
            return res.json();
          })
          .then(function (detail) {
            if (!detail) return;

            var currency = (detail.summary_json && detail.summary_json.currency) || 'USD';

            // Populate Top Risks from insights
            if (detail.insights && detail.insights.length > 0) {
              populateTopRisks(detail.insights);
            }

            // Populate Supplier Risk Breakdown
            if (detail.supplier_rollups && detail.supplier_rollups.length > 0) {
              populateSuppliers(detail.supplier_rollups, currency);
            }

            hydrateIcons();
          });
      })
      .catch(function (err) {
        console.warn('[procurementDashboard] fetch failed:', err);
      });
  }

  // ── Boot ─────────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', hydrate);
  } else {
    hydrate();
  }
})();
