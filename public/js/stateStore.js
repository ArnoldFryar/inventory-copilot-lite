/* stateStore.js — shared application state, DOM cache, and utility functions.
 *
 * Loaded first among the App modules. Every other module reads/writes through
 * window.App.state and window.App.dom to avoid duplicating references.
 *
 * Security note: ALL user-supplied data from the CSV is written via
 * element.textContent, NEVER via innerHTML. This prevents XSS even if a
 * CSV cell contains script tags or HTML entities.
 */
(function () {
  'use strict';

  var App = window.App = window.App || {};

  // ── Analytics ─────────────────────────────────────────────────────────────
  // Falls back to a no-op if analytics.js fails to load.
  App.track = window.track || function () {};

  // Converts a failed upload HTTP status + error message into a short,
  // non-PII error category for telemetry.  Never sends raw error text
  // (which could contain column-name fragments from the user's file).
  App.uploadErrorCategory = function (status, msg) {
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
  };

  // ── Shared mutable state ──────────────────────────────────────────────────
  App.state = {
    allResults:         [],
    lastResponse:       null,
    lastComparison:     null,
    inFlight:           false,
    currentPlan:        null,
    aiHelpersAvailable: false,
    authMode:           'signin',
    currentUser:        null,
    autoSaveInFlight:   false,
    billingConfigured:  false,
  };

  // ── DOM element cache ─────────────────────────────────────────────────────
  var $ = function (id) { return document.getElementById(id); };

  App.dom = {
    // Upload form
    form:            $('uploadForm'),
    fileInput:       $('csvfile'),
    fileLabel:       $('fileLabel'),
    submitBtn:       $('submitBtn'),
    submitLabel:     $('submitLabel'),
    loadSampleBtn:   $('loadSampleBtn'),
    liveDemoBtn:     $('liveDemoBtn'),
    demoBadge:       $('demoBadge'),
    errorBanner:     $('errorBanner'),
    warningBanner:   $('warningBanner'),

    // Executive summary
    execSummarySection: $('execSummarySection'),
    execScoreRing:      $('execScoreRing'),
    execScoreValue:     $('execScoreValue'),
    execScoreLabel:     $('execScoreLabel'),
    execUrgentCount:    $('execUrgentCount'),
    execExcessCount:    $('execExcessCount'),
    execTopRisk:        $('execTopRisk'),
    execTopOpp:         $('execTopOpp'),
    execNarrative:      $('execNarrative'),

    // Post-upload action bar
    actionBar:          $('actionBar'),
    actionBarTimestamp: $('actionBarTimestamp'),
    pdfBtn:             $('pdfBtn'),
    pdfUpgrade:         $('pdfUpgrade'),
    saveRunBtn:         $('saveRunBtn'),

    // Auth / account UI
    accountMenu:     $('accountMenu'),
    accountEmail:    $('accountEmail'),
    accountAvatarBtn: $('accountAvatarBtn'),
    accountInitial:  $('accountInitial'),
    accountDropdown: $('accountDropdown'),
    accountDropdownEmail: $('accountDropdownEmail'),
    signOutBtn:      $('signOutBtn'),
    signInBtn:       $('signInBtn'),
    authModal:       $('authModal'),
    authModalClose:  $('authModalClose'),
    authForm:        $('authForm'),
    authEmail:       $('authEmail'),
    authPassword:    $('authPassword'),
    authError:       $('authError'),
    authSubmitBtn:   $('authSubmitBtn'),
    authModalTitle:  $('authModalTitle'),
    authToggleText:  $('authToggleText'),
    authToggleBtn:   $('authToggleBtn'),

    // History panel
    historySection:  $('historySection'),
    historyList:     $('historyList'),
    historyEmpty:    $('historyEmpty'),
    historySignIn:   $('historySignIn'),
    historyUpgrade:  $('historyUpgrade'),
    historyToolbar:  $('historyToolbar'),
    historySearch:   $('historySearch'),
    historySort:     $('historySort'),
    historyCount:    $('historyCount'),

    // Comparison panel
    comparisonSection:        $('comparisonSection'),
    comparisonTitle:          $('comparisonTitle'),
    comparisonPrior:          $('comparisonPrior'),
    comparisonExportBtn:      $('comparisonExportBtn'),
    comparisonSentence:       $('comparisonSentence'),
    comparisonGrid:           $('comparisonGrid'),
    comparisonDetails:        $('comparisonDetails'),
    comparisonDetailsSummary: $('comparisonDetailsSummary'),
    comparisonDetailsBody:    $('comparisonDetailsBody'),

    // Summary
    summarySection:  $('summarySection'),
    metricTotal:     $('metricTotal'),
    metricUrgent:    $('metricUrgent'),
    metricStockout:  $('metricStockout'),
    metricNoUsage:   $('metricNoUsage'),
    metricExcess:    $('metricExcess'),
    metricDeadStock: $('metricDeadStock'),
    metricHealthy:   $('metricHealthy'),
    metricInvalid:   $('metricInvalid'),

    // Leadership summary
    leadershipSection:   $('leadershipSection'),
    leadershipNarrative: $('leadershipNarrative'),
    auditThresholds:     $('auditThresholds'),

    // Priority panel
    prioritySection:      $('prioritySection'),
    prioritySectionLabel: $('prioritySectionLabel'),
    priorityHint:         $('priorityHint'),
    priorityAllClear:     $('priorityAllClear'),
    priorityList:         $('priorityList'),

    // Results table + filters
    resultsSection:   $('resultsSection'),
    resultsBody:      $('resultsBody'),
    filterPart:       $('filterPart'),
    filterStatus:     $('filterStatus'),
    filterSeverity:   $('filterSeverity'),
    filterCount:      $('filterCount'),
    exportBtn:        $('exportBtn'),
    exportUpgrade:    $('exportUpgrade'),
    tableLimitNotice: $('tableLimitNotice'),
    planBadge:        $('planBadge'),
    upgradeToProBtn:  $('upgradeToProBtn'),
    manageBillingBtn: $('manageBillingBtn'),
    printFilterContext: $('printFilterContext'),

    // AI helpers panel
    aiHelpersSection:    $('aiHelpersSection'),
    aiHelpersActions:    $('aiHelpersActions'),
    aiHelpersLockedCta:  $('aiHelpersLockedCta'),
    comparisonLockedCta: $('comparisonLockedCta'),
    aiHelperResult:      $('aiHelperResult'),
    aiHelperResultLabel: $('aiHelperResultLabel'),
    aiHelperResultText:  $('aiHelperResultText'),
    aiHelperResultModel: $('aiHelperResultModel'),
    aiHelperCopyBtn:     $('aiHelperCopyBtn'),
  };

  // ── CSS class helpers ─────────────────────────────────────────────────────

  App.statusClass = function (status) {
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
  };

  /**
   * Builds a contextual upgrade CTA DOM node.
   * config: { icon, headline, description, features[], showBtn, btnText }
   * Call only after state.billingConfigured is known.
   */
  App.buildUpsellCta = function (config) {
    var wrap = document.createElement('div');
    wrap.className = 'upsell-cta';

    var iconEl = document.createElement('span');
    iconEl.className = 'upsell-cta-icon';
    iconEl.setAttribute('aria-hidden', 'true');
    iconEl.textContent = config.icon || '\uD83D\uDD12';
    wrap.appendChild(iconEl);

    var body = document.createElement('div');
    body.className = 'upsell-cta-body';

    var h = document.createElement('p');
    h.className = 'upsell-cta-headline';
    h.textContent = config.headline;
    body.appendChild(h);

    if (config.description) {
      var d = document.createElement('p');
      d.className = 'upsell-cta-desc';
      d.textContent = config.description;
      body.appendChild(d);
    }

    if (config.features && config.features.length) {
      var ul = document.createElement('ul');
      ul.className = 'upsell-cta-features';
      config.features.forEach(function (f) {
        var li = document.createElement('li');
        li.textContent = f;
        ul.appendChild(li);
      });
      body.appendChild(ul);
    }

    wrap.appendChild(body);

    if (config.valueAnchor) {
      var anchor = document.createElement('p');
      anchor.className = 'upsell-cta-value-anchor';
      anchor.textContent = config.valueAnchor;
      wrap.appendChild(anchor);
    }

    if (config.showBtn !== false) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'upsell-cta-btn';
      btn.setAttribute('data-upgrade', '');
      btn.textContent = config.btnText || 'Upgrade to Pro \u2014 $49/mo \u2192';
      wrap.appendChild(btn);
    }

    return wrap;
  };

  App.formatNumber = function (value) {
    if (value === null || value === undefined) return '\u2014';
    return value;
  };

  // ── Visibility helpers ────────────────────────────────────────────────────

  App.showError = function (message) {
    App.dom.errorBanner.textContent = message;
    App.dom.errorBanner.classList.remove('hidden');
    App.dom.errorBanner.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };

  App.hideError = function () {
    App.dom.errorBanner.textContent = '';
    App.dom.errorBanner.classList.add('hidden');
  };

  App.hideResults = function () {
    App.state.allResults   = [];
    App.state.lastResponse = null;
    if (App.dom.execSummarySection) App.dom.execSummarySection.classList.add('hidden');
    App.dom.summarySection.classList.add('hidden');
    App.dom.leadershipSection.classList.add('hidden');
    App.dom.prioritySection.classList.add('hidden');
    App.dom.resultsSection.classList.add('hidden');
    App.dom.actionBar.classList.add('hidden');
    App.dom.warningBanner.classList.add('hidden');
    if (App.dom.comparisonSection) App.dom.comparisonSection.classList.add('hidden');
    if (App.dom.saveRunBtn) {
      App.dom.saveRunBtn.classList.add('hidden');
      App.dom.saveRunBtn.textContent = 'Save to History';
      App.dom.saveRunBtn.disabled = false;
    }
    if (App.dom.tableLimitNotice) {
      App.dom.tableLimitNotice.textContent = '';
      App.dom.tableLimitNotice.classList.add('hidden');
    }
  };

  App.setLoading = function (isLoading) {
    App.dom.submitBtn.disabled = isLoading;
    if (isLoading) {
      App.dom.submitBtn.classList.add('is-loading');
      App.dom.submitLabel.textContent = 'Analyzing\u2026';
    } else {
      App.dom.submitBtn.classList.remove('is-loading');
      App.dom.submitLabel.textContent = 'Analyze';
    }
  };
})();
