/* pfepRegisterController.js — Hydrates the PFEP Register dashboard.
 *
 * Fetches saved data from the API and populates:
 *   - 6 KPI cards       (from the parts register)
 *   - Import History     (from the runs index)
 *   - Data Quality Alerts(from the most-recent run's summary_json)
 *   - Parts Register     (from saved parts)
 *
 * Auth behaviour:
 *   - Signed-in + Pro: full hydration from persisted data
 *   - Signed-in + Free: 403 → shows empty state (upgrade messaging via plan badge)
 *   - Not signed in:   shows guest prompts on all panels
 *
 * Dependencies (loaded before this script):
 *   - auth.js          (window.authModule)
 *   - Icon.js          (window.App.Icon)
 *   - pfepApp.js       (auth wiring)
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

  function fmtCost(n) {
    if (n == null || isNaN(n)) return '\u2014';
    return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
    totalParts:     document.getElementById('kpiTotalParts'),
    aClassParts:    document.getElementById('kpiAClassParts'),
    missingSupplier: document.getElementById('kpiMissingSupplier'),
    missingLeadTime: document.getElementById('kpiMissingLeadTime'),
    paramIssues:    document.getElementById('kpiParamIssues'),
    singleSourceA:  document.getElementById('kpiSingleSourceA'),
  };

  var pfepRunsList     = document.getElementById('pfepRunsList');
  var pfepRunsEmpty    = document.getElementById('pfepRunsEmpty');
  var pfepRunsGuest    = document.getElementById('pfepRunsGuest');

  var pfepAlertsList   = document.getElementById('pfepAlertsList');
  var pfepAlertsEmpty  = document.getElementById('pfepAlertsEmpty');
  var pfepAlertsGuest  = document.getElementById('pfepAlertsGuest');
  var pfepAlertsBadge  = document.getElementById('pfepAlertsBadge');

  var pfepTableBody    = document.getElementById('pfepTableBody');
  var pfepTableEmpty   = document.getElementById('pfepTableEmpty');
  var pfepTableGuest   = document.getElementById('pfepTableGuest');
  var pfepPartsBadge   = document.getElementById('pfepPartsBadge');
  var pfepSubtext      = document.getElementById('pfepRegisterSubtext');
  var searchInput      = document.getElementById('pfepSearch');

  var pfepGuestBanner  = document.getElementById('pfepGuestBanner');

  // ── State ────────────────────────────────────────────────────────────────
  var allParts = [];

  // ── KPI population ───────────────────────────────────────────────────────
  function setKpi(el, value) {
    if (!el) return;
    el.textContent = value;
    el.classList.remove('pco-value-placeholder');
    el.removeAttribute('aria-label');
  }

  function populateKpis(parts) {
    if (!parts || parts.length === 0) return;

    var total     = parts.length;
    var noSupp    = parts.filter(function (p) { return !p.supplier; }).length;
    var noLT      = parts.filter(function (p) { return p.lead_time_days == null; }).length;
    var aCount    = parts.filter(function (p) { return p.abc_class === 'A'; }).length;
    var singleSrcA = parts.filter(function (p) {
      return p.abc_class === 'A' && p.supplier && !p.secondary_supplier;
    }).length;

    // param issues: min >= max or pack_multiple mismatch
    var paramIssues = parts.filter(function (p) {
      if (p.min_qty != null && p.max_qty != null && p.min_qty >= p.max_qty) return true;
      if (p.min_qty != null && p.pack_multiple != null && p.pack_multiple > 0 && p.min_qty % p.pack_multiple !== 0) return true;
      return false;
    }).length;

    setKpi(kpiEls.totalParts,      fmt(total));
    setKpi(kpiEls.aClassParts,     fmt(aCount));
    setKpi(kpiEls.missingSupplier, fmt(noSupp));
    setKpi(kpiEls.missingLeadTime, fmt(noLT));
    setKpi(kpiEls.paramIssues,     fmt(paramIssues));
    setKpi(kpiEls.singleSourceA,   fmt(singleSrcA));
  }

  // ── ABC class badge ──────────────────────────────────────────────────────
  function abcBadge(cls) {
    if (!cls) return '<span class="pco-sev-pill pco-sev-pill--none">\u2014</span>';
    var sev = cls === 'A' ? 'high' : cls === 'B' ? 'medium' : 'low';
    return '<span class="pco-sev-pill pco-sev-pill--' + sev + '">' + escHtml(cls) + '</span>';
  }

  // ── Parts Register table ─────────────────────────────────────────────────
  function populateTable(parts) {
    if (!pfepTableBody || !parts || parts.length === 0) return;

    var html = '';
    var limit = Math.min(parts.length, 200);
    for (var i = 0; i < limit; i++) {
      var p = parts[i];
      html +=
        '<tr>' +
          '<td class="pco-td-supplier">' + escHtml(p.part_number || '\u2014') + '</td>' +
          '<td>' + escHtml(p.part_description || '\u2014') + '</td>' +
          '<td>' + escHtml(p.supplier || '\u2014') + '</td>' +
          '<td>' + abcBadge(p.abc_class) + '</td>' +
          '<td>' + escHtml(p.replenishment_method || '\u2014') + '</td>' +
          '<td class="pco-td-num">' + (p.lead_time_days != null ? p.lead_time_days + ' d' : '\u2014') + '</td>' +
          '<td class="pco-td-num">' + fmt(p.min_qty) + '</td>' +
          '<td class="pco-td-num">' + fmt(p.max_qty) + '</td>' +
          '<td class="pco-td-num">' + fmt(p.pack_multiple) + '</td>' +
          '<td>' + escHtml(p.unit_of_measure || '\u2014') + '</td>' +
          '<td class="pco-td-num">' + fmtCost(p.unit_cost) + '</td>' +
          '<td>' + escHtml(p.point_of_use || '\u2014') + '</td>' +
        '</tr>';
    }

    if (pfepTableEmpty) pfepTableEmpty.remove();
    pfepTableBody.innerHTML = html;

    if (pfepPartsBadge) {
      pfepPartsBadge.textContent = parts.length + ' part' + (parts.length === 1 ? '' : 's');
      show(pfepPartsBadge);
    }

    if (pfepSubtext) {
      pfepSubtext.textContent = 'Ranked by part number \u00b7 ' + fmt(parts.length) + ' total';
    }
  }

  // ── Search / filter ──────────────────────────────────────────────────────
  function filterAndRender(query) {
    if (!query) { populateTable(allParts); return; }
    var q = query.toLowerCase();
    var filtered = allParts.filter(function (p) {
      return (p.part_number      && p.part_number.toLowerCase().indexOf(q) !== -1)
          || (p.supplier         && p.supplier.toLowerCase().indexOf(q) !== -1)
          || (p.part_description && p.part_description.toLowerCase().indexOf(q) !== -1)
          || (p.abc_class        && p.abc_class.toLowerCase().indexOf(q) !== -1);
    });
    populateTable(filtered);
  }

  if (searchInput) {
    searchInput.addEventListener('input', function () {
      filterAndRender(searchInput.value.trim());
    });
  }

  // ── Import History (Recent Runs) ─────────────────────────────────────────
  function populateRuns(runs) {
    if (!pfepRunsList || !runs || runs.length === 0) return;

    var html = '<ul class="pco-runs-list">';
    var limit = Math.min(runs.length, 8);
    for (var i = 0; i < limit; i++) {
      var r = runs[i];
      var s = r.summary_json || {};
      var severity = 'Low';
      if ((s.data_gap_count || 0) > 0 || (s.alert_count || 0) > 3) severity = 'High';
      else if ((s.alert_count || 0) > 0) severity = 'Medium';

      html +=
        '<li class="pco-runs-item">' +
          '<div class="pco-runs-link">' +
            '<div class="pco-runs-item-main">' +
              '<span class="pco-runs-file">' + escHtml(r.file_name || 'Untitled') + '</span>' +
              '<span class="pco-runs-date">' + escHtml(fmtDate(r.uploaded_at)) + '</span>' +
            '</div>' +
            '<div class="pco-runs-item-meta">' +
              '<span class="pco-runs-lines">' + fmt(r.part_count) + ' parts</span>' +
              '<span class="pco-sev-dot pco-sev-dot--' + severity.toLowerCase() + '" title="' + escHtml(severity) + ' quality"></span>' +
            '</div>' +
          '</div>' +
        '</li>';
    }
    html += '</ul>';

    pfepRunsList.innerHTML = html;
    show(pfepRunsList);
    hide(pfepRunsEmpty);
    hide(pfepRunsGuest);
  }

  // ── Data Quality Alerts (from latest run summary) ────────────────────────
  function populateAlerts(summary) {
    if (!pfepAlertsList) return;

    // Build alerts from the most-recent run summary
    var alerts = [];
    var s = summary || {};

    if ((s.data_gap_count || 0) > 0) {
      alerts.push({ severity: 'High', title: 'Data Gaps', description: s.data_gap_count + ' part(s) missing supplier or lead time' });
    }
    if ((s.param_conflict_count || 0) > 0) {
      alerts.push({ severity: 'High', title: 'Parameter Conflicts', description: s.param_conflict_count + ' part(s) with min \u2265 max or pack-multiple mismatch' });
    }
    if ((s.single_source_a_count || 0) > 0) {
      alerts.push({ severity: 'Medium', title: 'Single-Source A-Class', description: s.single_source_a_count + ' A-class part(s) with no backup supplier' });
    }

    if (alerts.length === 0) return;

    var SEV_ORDER = { High: 0, Medium: 1, Low: 2 };
    alerts.sort(function (a, b) {
      return (SEV_ORDER[a.severity] || 2) - (SEV_ORDER[b.severity] || 2);
    });

    var html = '<ul class="pco-risks-list">';
    for (var i = 0; i < alerts.length; i++) {
      var a = alerts[i];
      var sev = (a.severity || 'Low').toLowerCase();
      html +=
        '<li class="pco-risk-item pco-risk-item--' + escHtml(sev) + '">' +
          '<div class="pco-risk-sev">' +
            '<span class="pco-sev-dot pco-sev-dot--' + escHtml(sev) + '"></span>' +
            '<span class="pco-risk-sev-label">' + escHtml(a.severity || 'Low') + '</span>' +
          '</div>' +
          '<div class="pco-risk-body">' +
            '<strong class="pco-risk-title">' + escHtml(a.title) + '</strong>' +
            (a.description ? '<p class="pco-risk-desc">' + escHtml(a.description) + '</p>' : '') +
          '</div>' +
        '</li>';
    }
    html += '</ul>';

    pfepAlertsList.innerHTML = html;
    show(pfepAlertsList);
    hide(pfepAlertsEmpty);

    if (pfepAlertsBadge) {
      pfepAlertsBadge.textContent = alerts.length + ' finding' + (alerts.length === 1 ? '' : 's');
      show(pfepAlertsBadge);
    }
  }

  // ── Show guest state (not signed in) ─────────────────────────────────────
  function showGuestState() {
    show(pfepGuestBanner);

    // Import History
    hide(pfepRunsEmpty);
    show(pfepRunsGuest);

    // Data Quality Alerts
    hide(pfepAlertsEmpty);
    show(pfepAlertsGuest);

    // Parts Register table
    hide(pfepTableEmpty);
    show(pfepTableGuest);

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
        console.warn('[pfepRegisterController] auth init failed:', err);
        showGuestState();
      });
  }

  function fetchDashboardData(token) {
    var headers = { 'Authorization': 'Bearer ' + token };

    // Fetch parts and runs in parallel
    var partsPromise = fetch('/api/pfep/parts', { headers: headers })
      .then(function (res) {
        if (res.status === 403) return { parts: [], forbidden: true };
        if (!res.ok) return { parts: [] };
        return res.json();
      })
      .catch(function () { return { parts: [] }; });

    var runsPromise = fetch('/api/pfep/runs', { headers: headers })
      .then(function (res) {
        if (!res.ok) return { runs: [] };
        return res.json();
      })
      .catch(function () { return { runs: [] }; });

    return Promise.all([partsPromise, runsPromise])
      .then(function (results) {
        var partsData = results[0];
        var runsData  = results[1];

        if (partsData.forbidden) {
          // 403 — show guest-like state but keep them signed in
          return;
        }

        // Parts register
        allParts = partsData.parts || [];
        populateKpis(allParts);
        populateTable(allParts);

        // Import history
        var runs = runsData.runs || [];
        if (runs.length > 0) {
          populateRuns(runs);

          // Alerts from most-recent run
          var latest = runs[0];
          var summary = latest.summary_json || {};
          populateAlerts(summary);
        }

        hydrateIcons();
      })
      .catch(function (err) {
        console.warn('[pfepRegisterController] fetch failed:', err);
      });
  }

  // ── Boot ─────────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', hydrate);
  } else {
    hydrate();
  }
})();
