/* procurementRunDetail.js — Run Detail page controller.
 *
 * Reads the run ID from the URL path (/procurement/runs/:id),
 * fetches GET /api/procurement/runs/:id, then renders all six
 * sections of the run detail page.
 *
 * Dependencies (loaded before this script via <script> tags):
 *   - auth.js          (window.authModule)
 *   - Icon.js          (window.App.Icon)
 *   - procurementApp.js (auth wiring, icon hydration, account menu)
 */
(function () {
  'use strict';

  var App = window.App = window.App || {};
  App.procurement = App.procurement || {};

  // ── Constants ────────────────────────────────────────────────────────────
  var MAX_PO_ROWS_DEFAULT = 50; // rows shown before "Show all" toggle

  // ── DOM refs ─────────────────────────────────────────────────────────────
  var loadingEl     = document.getElementById('runLoadingState');
  var errorEl       = document.getElementById('runErrorState');
  var errorTitleEl  = document.getElementById('runErrorTitle');
  var errorMsgEl    = document.getElementById('runErrorMsg');
  var contentEl     = document.getElementById('runContent');
  var pageTitleEl   = document.getElementById('runDetailTitle');

  // ── Helpers ──────────────────────────────────────────────────────────────
  function show(el) { el && el.classList.remove('hidden'); }
  function hide(el) { el && el.classList.add('hidden'); }

  function formatCurrency(value, currency) {
    if (value == null || isNaN(value)) return '—';
    var cur = (currency || 'USD').toUpperCase();
    try {
      return new Intl.NumberFormat('en-US', {
        style: 'currency', currency: cur,
        maximumFractionDigits: 0,
      }).format(value);
    } catch (_) {
      return cur + ' ' + Number(value).toLocaleString('en-US', { maximumFractionDigits: 0 });
    }
  }

  function formatNumber(value) {
    if (value == null || isNaN(value)) return '—';
    return Number(value).toLocaleString('en-US');
  }

  function formatDate(iso) {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleDateString('en-US', {
        year: 'numeric', month: 'short', day: 'numeric',
      });
    } catch (_) {
      return iso;
    }
  }

  function escHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function severityClass(sev) {
    switch ((sev || '').toLowerCase()) {
      case 'high':   return 'pco-sev--high';
      case 'medium': return 'pco-sev--medium';
      case 'low':    return 'pco-sev--low';
      default:       return 'pco-sev--none';
    }
  }

  function severityLabel(sev) {
    var s = (sev || '').toLowerCase();
    return s.charAt(0).toUpperCase() + s.slice(1) || 'Unknown';
  }

  function deliveryBadgeClass(status) {
    switch ((status || '').toLowerCase()) {
      case 'overdue':    return 'pco-del--overdue';
      case 'confirmed':  return 'pco-del--confirmed';
      case 'pending':    return 'pco-del--pending';
      case 'shipped':    return 'pco-del--shipped';
      default:           return 'pco-del--default';
    }
  }

  function statusClass(status) {
    switch ((status || '').toLowerCase()) {
      case 'open':        return 'pco-status--open';
      case 'in_progress': return 'pco-status--in_progress';
      case 'done':        return 'pco-status--done';
      default:            return 'pco-status--open';
    }
  }

  function hydrateIcons() {
    if (App.Icon && App.Icon.hydrateAll) App.Icon.hydrateAll();
  }

  // ── URL parsing ──────────────────────────────────────────────────────────
  // Extracts the last path segment from /procurement/runs/:id
  function getRunIdFromPath() {
    var parts = window.location.pathname.split('/').filter(Boolean);
    var idx = parts.indexOf('runs');
    if (idx !== -1 && parts[idx + 1]) {
      return parts[idx + 1];
    }
    return null;
  }

  // ── Error display ────────────────────────────────────────────────────────
  function showError(title, msg) {
    hide(loadingEl);
    hide(contentEl);
    if (errorTitleEl) errorTitleEl.textContent = title;
    if (errorMsgEl)   errorMsgEl.textContent = msg;
    show(errorEl);
  }

  // ── Section renderers ────────────────────────────────────────────────────

  function renderExecSummary(run, summary) {
    var fileNameEl       = document.getElementById('runFileName');
    var dateEl           = document.getElementById('runDate');
    var lineCountEl      = document.getElementById('runLineCount');
    var supplierCountEl  = document.getElementById('runSupplierCount');
    var sevBadgeEl       = document.getElementById('runSeverityBadge');
    var warnBannerEl     = document.getElementById('ingestWarningsBanner');
    var warnTextEl       = document.getElementById('ingestWarningsText');

    if (fileNameEl)      fileNameEl.textContent = run.file_name || 'Unnamed file';
    if (dateEl)          dateEl.textContent = formatDate(run.uploaded_at || run.created_at);
    if (lineCountEl)     lineCountEl.textContent = formatNumber(summary.total_lines) + ' lines';
    if (supplierCountEl) supplierCountEl.textContent = formatNumber(summary.supplier_count) + ' suppliers';

    // Page <title>
    document.title = 'OpsCopilot · ' + escHtml(run.file_name || 'Run Detail');
    if (pageTitleEl) pageTitleEl.textContent = run.file_name || 'Run Detail';

    // Derive overall run severity from summary flags
    var overallSev = 'low';
    if (summary.high_risk_suppliers > 0 || (summary.past_due_lines > 0)) overallSev = 'high';
    else if (summary.flagged_lines > 0) overallSev = 'medium';

    if (sevBadgeEl) {
      sevBadgeEl.className = 'pco-severity-badge ' + severityClass(overallSev);
      sevBadgeEl.textContent = severityLabel(overallSev) + ' Risk';
    }

    // Ingest warnings
    var warnings = (summary.ingestWarnings || []);
    if (warnings.length > 0 && warnBannerEl && warnTextEl) {
      warnTextEl.textContent = warnings.length === 1
        ? warnings[0]
        : warnings.length + ' ingestion warnings: ' + warnings.slice(0, 2).join('; ') +
          (warnings.length > 2 ? ' …' : '');
      show(warnBannerEl);
    }
  }

  function renderKpis(summary, currency) {
    var set = function (id, value) {
      var el = document.getElementById(id);
      if (!el) return;
      el.textContent = value;
      el.classList.remove('pco-value-placeholder');
    };

    set('kpiTotalLines',       formatNumber(summary.total_lines));
    set('kpiPastDue',          formatNumber(summary.past_due_lines));
    set('kpiPastDueDollars',   formatCurrency(summary.past_due_dollars, currency));
    set('kpiFlaggedLines',     formatNumber(summary.flagged_lines));
    set('kpiHighRiskSuppliers', formatNumber(summary.high_risk_suppliers));
    set('kpiDollarExposure',   formatCurrency(summary.dollar_exposure_at_risk, currency));
  }

  function renderInsights(insights) {
    var container = document.getElementById('insightsList');
    var badgeEl   = document.getElementById('insightsBadge');
    if (!container) return;

    if (!insights || insights.length === 0) {
      container.innerHTML =
        '<div class="pco-empty-state" style="padding: var(--space-8) var(--space-6);">' +
          '<p class="pco-empty-title">No insights generated</p>' +
          '<p class="pco-empty-sub">Insights appear when the risk engine detects patterns across suppliers or lines.</p>' +
        '</div>';
      return;
    }

    if (badgeEl) {
      badgeEl.textContent = insights.length;
      show(badgeEl);
    }

    var html = '';
    insights.forEach(function (ins) {
      var sevLow  = (ins.severity || 'low').toLowerCase();
      var metricHtml = '';
      if (ins.metric_value != null) {
        metricHtml =
          '<div class="pco-insight-meta">' +
            '<span class="pco-insight-metric">' + escHtml(String(ins.metric_value)) + '</span>' +
            (ins.metric_label
              ? '<span class="pco-insight-metric-label">' + escHtml(ins.metric_label) + '</span>'
              : '') +
          '</div>';
      }

      var actionHtml = ins.recommended_action
        ? '<p class="pco-insight-action">' + escHtml(ins.recommended_action) + '</p>'
        : '';

      html +=
        '<div class="pco-insight-item pco-ins--' + escHtml(sevLow) + '">' +
          '<div class="pco-insight-sev-stripe"></div>' +
          '<div class="pco-insight-body">' +
            '<p class="pco-insight-title">' + escHtml(ins.title || 'Untitled') + '</p>' +
            '<p class="pco-insight-desc">' + escHtml(ins.description || '') + '</p>' +
            actionHtml +
          '</div>' +
          metricHtml +
        '</div>';
    });

    container.innerHTML = html;
  }

  function renderActionQueue(actionItems) {
    var container = document.getElementById('actionQueueBody');
    var badgeEl   = document.getElementById('actionBadge');
    if (!container) return;

    var open = (actionItems || []).filter(function (a) {
      return (a.status || '').toLowerCase() !== 'done';
    });

    if (badgeEl && open.length > 0) {
      badgeEl.textContent = open.length;
      show(badgeEl);
    }

    if (!actionItems || actionItems.length === 0) {
      container.innerHTML =
        '<div class="pco-empty-state" style="padding: var(--space-8) var(--space-4);">' +
          '<p class="pco-empty-title">No action items</p>' +
          '<p class="pco-empty-sub">Action items are generated when the risk engine detects high-priority findings.</p>' +
        '</div>';
      return;
    }

    var html = '<div class="pco-action-list">';
    actionItems.forEach(function (action) {
      var status = action.status || 'open';
      html +=
        '<div class="pco-action-item">' +
          '<span class="pco-action-title">' + escHtml(action.title || 'Untitled action') + '</span>' +
          '<span class="pco-action-status ' + escHtml(statusClass(status)) + '">' +
            escHtml(status.replace(/_/g, ' ')) +
          '</span>' +
        '</div>';
    });
    html += '</div>';
    container.innerHTML = html;
  }

  function renderSupplierRollups(rollups, currency) {
    var tbody   = document.getElementById('supplierRollupBody');
    var badgeEl = document.getElementById('supplierBadge');
    if (!tbody) return;

    if (!rollups || rollups.length === 0) {
      tbody.innerHTML =
        '<tr><td colspan="6" class="pco-table-empty-cell">' +
          '<div class="pco-table-empty-inner">' +
            '<span data-icon="user" data-icon-size="18" aria-hidden="true"></span>' +
            '<span>No supplier rollup data.</span>' +
          '</div>' +
        '</td></tr>';
      return;
    }

    if (badgeEl) {
      badgeEl.textContent = rollups.length;
      show(badgeEl);
    }

    // Sort: severity High first, then by total_spend desc
    var sevOrder = { high: 0, medium: 1, low: 2 };
    var sorted = rollups.slice().sort(function (a, b) {
      var sa = sevOrder[(a.severity || 'low').toLowerCase()] || 2;
      var sb = sevOrder[(b.severity || 'low').toLowerCase()] || 2;
      if (sa !== sb) return sa - sb;
      return (b.total_spend || 0) - (a.total_spend || 0);
    });

    var html = '';
    sorted.forEach(function (row) {
      var spendPct = row.spend_share_pct != null
        ? Number(row.spend_share_pct).toFixed(1) + '%'
        : '—';

      html +=
        '<tr>' +
          '<td>' + escHtml(row.supplier || '—') + '</td>' +
          '<td class="pco-td-num">' + formatNumber(row.line_count) + '</td>' +
          '<td class="pco-td-num">' + formatNumber(row.overdue_count) + '</td>' +
          '<td class="pco-td-num">' + formatCurrency(row.past_due_dollars, currency) + '</td>' +
          '<td class="pco-td-num">' + escHtml(spendPct) + '</td>' +
          '<td>' +
            '<span class="pco-severity-badge ' + severityClass(row.severity) + '">' +
              severityLabel(row.severity) +
            '</span>' +
          '</td>' +
        '</tr>';
    });

    tbody.innerHTML = html;
  }

  function renderPOLines(poLines, currency) {
    var tbody        = document.getElementById('poLinesBody');
    var countEl      = document.getElementById('poLinesShowing');
    var toggleBtn    = document.getElementById('poLinesToggle');
    if (!tbody) return;

    if (!poLines || poLines.length === 0) {
      tbody.innerHTML =
        '<tr><td colspan="8" class="pco-table-empty-cell">' +
          '<div class="pco-table-empty-inner">' +
            '<span data-icon="table" data-icon-size="18" aria-hidden="true"></span>' +
            '<span>No PO line data found in this run.</span>' +
          '</div>' +
        '</td></tr>';
      return;
    }

    // Sort: high severity first, then by risk_score desc
    var sevOrder = { high: 0, medium: 1, low: 2 };
    var sorted = poLines.slice().sort(function (a, b) {
      var sa = sevOrder[(a.severity || 'low').toLowerCase()] || 2;
      var sb = sevOrder[(b.severity || 'low').toLowerCase()] || 2;
      if (sa !== sb) return sa - sb;
      return (b.risk_score || 0) - (a.risk_score || 0);
    });

    var showAll  = false;
    var limit    = MAX_PO_ROWS_DEFAULT;
    var total    = sorted.length;

    function buildRows(rows) {
      return rows.map(function (row) {
        // Rule chips
        var rules = (row.applied_rules || []);
        var ruleChips = rules.length > 0
          ? '<div class="pco-rule-chips">' +
              rules.map(function (r) {
                return '<span class="pco-rule-chip">' + escHtml(r) + '</span>';
              }).join('') +
            '</div>'
          : '<span class="pco-td-muted">—</span>';

        var poRef = escHtml(row.po_number || '—') +
          (row.line_number != null ? '&nbsp;<span class="pco-td-muted">#' + escHtml(String(row.line_number)) + '</span>' : '');

        var daysVar = row.days_variance != null
          ? (row.days_variance > 0 ? '+' : '') + row.days_variance + 'd'
          : '—';
        var daysClass = row.days_variance > 0 ? 'style="color:var(--red-400)"' : '';

        return '<tr>' +
          '<td class="pco-td-po">' + poRef + '</td>' +
          '<td>' + escHtml(row.supplier || '—') + '</td>' +
          '<td class="pco-td-desc" title="' + escHtml(row.item_description || '') + '">' +
            escHtml(row.item_description || '—') +
          '</td>' +
          '<td class="pco-td-num">' + formatCurrency(row.line_amount, currency) + '</td>' +
          '<td class="pco-td-num" ' + daysClass + '>' + escHtml(daysVar) + '</td>' +
          '<td>' +
            '<span class="pco-delivery-badge ' + deliveryBadgeClass(row.delivery_status) + '">' +
              escHtml(row.delivery_status || 'Unknown') +
            '</span>' +
          '</td>' +
          '<td>' +
            '<span class="pco-severity-badge ' + severityClass(row.severity) + '">' +
              severityLabel(row.severity) +
            '</span>' +
          '</td>' +
          '<td>' + ruleChips + '</td>' +
        '</tr>';
      }).join('');
    }

    function render() {
      var visible = showAll ? sorted : sorted.slice(0, limit);
      tbody.innerHTML = buildRows(visible);

      if (countEl) {
        countEl.textContent = 'Showing ' + visible.length + ' of ' + total;
      }

      if (total > limit && toggleBtn) {
        show(toggleBtn);
        toggleBtn.textContent = showAll ? 'Show top ' + limit : 'Show all ' + total + ' lines';
      }

      hydrateIcons();
    }

    if (toggleBtn) {
      toggleBtn.addEventListener('click', function () {
        showAll = !showAll;
        render();
      });
    }

    render();
  }

  // ── AI Summary renderer ───────────────────────────────────────────────
  function renderAiSummary(summary) {
    var section  = document.getElementById('aiSummarySection');
    var bodyEl   = document.getElementById('aiSummaryBody');
    var metaEl   = document.getElementById('aiSummaryMeta');
    var modelEl  = document.getElementById('aiSummaryModel');
    var dateEl   = document.getElementById('aiSummaryDate');
    if (!section || !bodyEl) return;

    var ai = summary.ai_summary;
    if (!ai || !ai.text) return;

    // Convert markdown-style headings and bullets to HTML
    var html = escHtml(ai.text)
      // ## Headings
      .replace(/^## (.+)$/gm, '<h3 class="pco-ai-heading">$1</h3>')
      // Numbered lists: "1. Item"
      .replace(/^(\d+)\.\s+(.+)$/gm, '<div class="pco-ai-numbered"><span class="pco-ai-num">$1.</span> $2</div>')
      // Bullet lists: "- Item"
      .replace(/^- (.+)$/gm, '<div class="pco-ai-bullet"><span class="pco-ai-bullet-dot" aria-hidden="true">&bull;</span> $1</div>')
      // Paragraphs: wrap consecutive non-tag lines
      .replace(/\n{2,}/g, '</p><p class="pco-ai-para">')
      // Single newlines within paragraphs
      .replace(/\n/g, '<br>');
    html = '<p class="pco-ai-para">' + html + '</p>';
    // Clean up empty paragraphs
    html = html.replace(/<p class="pco-ai-para"><\/p>/g, '');

    bodyEl.innerHTML = html;

    // Metadata
    if (metaEl) {
      if (modelEl && ai.model) modelEl.textContent = 'Model: ' + ai.model;
      if (dateEl && ai.generated_at) dateEl.textContent = formatDate(ai.generated_at);
      show(metaEl);
    }

    show(section);
  }

  // ── Main render ──────────────────────────────────────────────────────────
  function renderRun(data) {
    var run      = data;
    var summary  = {};
    try { summary = (typeof run.summary_json === 'string')
      ? JSON.parse(run.summary_json)
      : (run.summary_json || {});
    } catch (_) { summary = {}; }

    var currency = summary.currency || 'USD';

    renderExecSummary(run, summary);
    renderKpis(summary, currency);
    renderAiSummary(summary);
    renderInsights(run.insights || []);
    renderActionQueue(run.action_items || []);
    renderSupplierRollups(run.supplier_rollups || [], currency);
    renderPOLines(run.po_lines || [], currency);

    hide(loadingEl);
    show(contentEl);
    hydrateIcons();
  }

  // ── Fetch ────────────────────────────────────────────────────────────────
  function fetchRun(runId, token) {
    var url = '/api/procurement/runs/' + encodeURIComponent(runId);
    fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type':  'application/json',
      },
    })
      .then(function (res) {
        if (res.status === 404) {
          throw { code: 404, message: 'Run not found. It may have been deleted.' };
        }
        if (res.status === 403) {
          throw { code: 403, message: 'This feature requires a Pro plan. Upgrade to access saved runs.' };
        }
        if (res.status === 401) {
          throw { code: 401, message: 'Please sign in to view this run.' };
        }
        if (!res.ok) {
          throw { code: res.status, message: 'Server error (' + res.status + '). Please try again.' };
        }
        return res.json();
      })
      .then(function (json) {
        if (!json || !json.id) {
          throw { code: 0, message: 'The server returned an unexpected response.' };
        }
        renderRun(json);
      })
      .catch(function (err) {
        var title = err.code === 404 ? 'Run Not Found'
                  : err.code === 403 ? 'Pro Plan Required'
                  : err.code === 401 ? 'Sign In Required'
                  : 'Could Not Load Run';
        showError(title, err.message || 'An unexpected error occurred.');
      });
  }

  // ── Init ─────────────────────────────────────────────────────────────────
  function init() {
    var runId = getRunIdFromPath();
    if (!runId) {
      showError('Invalid URL', 'No run ID found in the URL. Please navigate from the Procurement dashboard.');
      return;
    }

    if (!window.authModule) {
      showError('Auth Not Available', 'Authentication module failed to load. Please refresh the page.');
      return;
    }

    window.authModule.init().then(function () {
      if (!window.authModule.isConfigured()) {
        // Supabase not configured — attempt unauthenticated fetch; server will reject if needed
        fetchRun(runId, '');
        return;
      }

      window.authModule.getSession().then(function (session) {
        if (!session || !session.access_token) {
          window.location.href = '/?signin=1&return=' + encodeURIComponent(window.location.pathname);
          return;
        }
        fetchRun(runId, session.access_token);
      }).catch(function () {
        showError('Session Error', 'Could not retrieve your session. Please sign in again.');
      });
    }).catch(function () {
      showError('Auth Error', 'Authentication failed to initialise. Please refresh the page.');
    });
  }

  // Run after DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  App.procurement.runDetail = { init: init };
})();
