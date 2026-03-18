/* aiHelpersUI.js — premium AI helper drafts panel. */
(function () {
  'use strict';

  var App   = window.App;
  var dom   = App.dom;
  var state = App.state;
  var track = App.track;

  function showAiHelpersPanel() {
    if (!dom.aiHelpersSection) return;

    var hasAnalysis = !!state.lastResponse;
    var isAdmin = state.currentProfile && state.currentProfile.is_admin === true;
    var isPro = (state.currentPlan && state.currentPlan.plan === 'pro') || isAdmin;

    // ── No analysis yet: hide everything ───────────────────────────────────
    if (!hasAnalysis) {
      dom.aiHelpersSection.classList.add('hidden');
      if (dom.comparisonLockedCta) dom.comparisonLockedCta.classList.add('hidden');
      return;
    }

    // ── Analysis loaded, Pro plan: show active panel ────────────────────────
    if (isPro && state.aiHelpersAvailable) {
      dom.aiHelpersSection.classList.remove('hidden');
      if (dom.aiHelpersActions) dom.aiHelpersActions.classList.remove('hidden');
      if (dom.aiHelpersLockedCta) dom.aiHelpersLockedCta.classList.add('hidden');
      if (dom.comparisonLockedCta) dom.comparisonLockedCta.classList.add('hidden');
      return;
    }

    // ── Analysis loaded, NOT Pro: show locked CTA states ───────────────────
    // AI Helpers section — hide buttons, show upgrade CTA
    dom.aiHelpersSection.classList.remove('hidden');
    if (dom.aiHelpersActions) dom.aiHelpersActions.classList.add('hidden');
    if (dom.aiHelperResult) dom.aiHelperResult.classList.add('hidden');

    if (dom.aiHelpersLockedCta) {
      dom.aiHelpersLockedCta.classList.remove('hidden');
      while (dom.aiHelpersLockedCta.firstChild) {
        dom.aiHelpersLockedCta.removeChild(dom.aiHelpersLockedCta.firstChild);
      }
      var aiCta = App.buildUpsellCta({
        icon: '\u2728',
        headline: 'Turn Triage Into Action in Seconds',
        description: 'Generate ready-to-send expedite emails, leadership escalation briefs, and S&OP meeting prep \u2014 grounded in this analysis, not generic templates.',
        features: ['Supplier expedite emails', 'Escalation briefs for leadership', 'S&OP / materials review prep'],
        showBtn: state.billingConfigured !== false,
        btnText: 'Unlock AI Helpers \u2014 $49/mo \u2192',
      });
      dom.aiHelpersLockedCta.appendChild(aiCta);
    }

    // Comparison locked CTA — teaser for run-to-run comparison
    if (dom.comparisonLockedCta) {
      dom.comparisonLockedCta.classList.remove('hidden');
      while (dom.comparisonLockedCta.firstChild) {
        dom.comparisonLockedCta.removeChild(dom.comparisonLockedCta.firstChild);
      }
      var cmpCta = App.buildUpsellCta({
        icon: '\uD83D\uDCC8',
        headline: 'Prove Progress to Leadership',
        description: 'Compare this run to any prior analysis. Surface new urgent items, confirm resolved risks, and show measurable improvement \u2014 with data, not gut feel.',
        features: ['New urgent items flagged instantly', 'Resolved risks confirmed', 'Status shift deltas', 'Run-over-run trend visibility'],
        showBtn: state.billingConfigured !== false,
        btnText: 'Unlock Trend Comparison \u2014 $49/mo \u2192',
      });
      dom.comparisonLockedCta.appendChild(cmpCta);
    }
  }

  /* ── Label map ─────────────────────────────────────────────────────── */
  var LABELS = {
    expedite_email:        'Draft Expedite Email',
    escalation_summary:    'Escalation Summary',
    meeting_talking_points: 'Meeting Talking Points',
  };

  /* ── Internal helpers ─────────────────────────────────────────────── */
  var _progressTimer = null;

  function setAllButtons(disabled) {
    if (!dom.aiHelpersActions) return;
    var btns = dom.aiHelpersActions.querySelectorAll('.ai-helper-btn');
    for (var i = 0; i < btns.length; i++) btns[i].disabled = disabled;
  }

  function showLoading(helperType) {
    // Show the result container with only the skeleton visible
    if (dom.aiHelperResult) {
      dom.aiHelperResult.classList.remove('hidden', 'ai-fade-in');
    }
    if (dom.aiHelperLoading) dom.aiHelperLoading.classList.remove('hidden');

    // Hide result content and error
    hideContent();
    hideError();

    // Label
    if (dom.aiHelperResultLabel) dom.aiHelperResultLabel.textContent = LABELS[helperType] || helperType;
    if (dom.aiHelperCopyBtn) dom.aiHelperCopyBtn.classList.add('hidden');

    // Staged messages
    if (dom.aiHelperLoadingText) dom.aiHelperLoadingText.textContent = 'Analyzing data\u2026';
    clearTimeout(_progressTimer);
    _progressTimer = setTimeout(function () {
      if (dom.aiHelperLoadingText) dom.aiHelperLoadingText.textContent = 'Generating response\u2026';
    }, 3000);
  }

  function hideLoading() {
    clearTimeout(_progressTimer);
    if (dom.aiHelperLoading) dom.aiHelperLoading.classList.add('hidden');
  }

  function hideContent() {
    // Hide the actual result text elements (confidence, grounding, pre, meta)
    var els = dom.aiHelperResult
      ? dom.aiHelperResult.querySelectorAll('#aiConfidence, #aiResultGrounding, #aiHelperResultText, #aiHelperResultModel')
      : [];
    for (var i = 0; i < els.length; i++) els[i].classList.add('hidden');
  }

  function showContent() {
    var ids = ['aiConfidence', 'aiResultGrounding', 'aiHelperResultText', 'aiHelperResultModel'];
    for (var i = 0; i < ids.length; i++) {
      var el = document.getElementById(ids[i]);
      if (el) el.classList.remove('hidden');
    }
  }

  function showError(msg, helperType) {
    if (dom.aiHelperError) {
      dom.aiHelperErrorMsg.textContent = msg || 'Something went wrong.';
      dom.aiHelperError.classList.remove('hidden');
    }
    // Wire one-shot retry listener
    if (dom.aiHelperRetryBtn) {
      var handler = function () {
        dom.aiHelperRetryBtn.removeEventListener('click', handler);
        requestAiHelper(helperType);
      };
      dom.aiHelperRetryBtn.addEventListener('click', handler);
    }
    if (dom.aiHelperResult) dom.aiHelperResult.classList.remove('hidden');
  }

  function hideError() {
    if (dom.aiHelperError) dom.aiHelperError.classList.add('hidden');
  }

  async function requestAiHelper(helperType) {
    if (!state.lastResponse || !state.currentUser || !window.authModule) return;

    // Build the run data payload from the current analysis
    var runData = {
      summary:     state.lastResponse.summary,
      results:     state.lastResponse.results,
      topPriority: state.lastResponse.topPriority || [],
      analyzedAt:  state.lastResponse.analyzedAt,
      thresholds:  state.lastResponse.thresholds,
    };

    // Optional business context
    var summary = state.lastResponse.summary || {};
    var urgentCount = summary.urgent_stockout || 0;
    var context = {
      urgency: urgentCount > 0 ? 'High — ' + urgentCount + ' urgent stockout(s)' : 'Standard',
    };

    // Mark the clicked button loading & disable all buttons
    var btn = dom.aiHelpersSection.querySelector('[data-helper="' + helperType + '"]');
    if (btn) { btn.classList.add('is-loading'); btn.querySelector('.ai-helper-btn-label').textContent = 'Generating\u2026'; }
    setAllButtons(true);

    // Show skeleton loading
    showLoading(helperType);

    try {
      var token = await window.authModule.getToken();
      var res = await fetch('/api/ai-helper', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + token,
        },
        body: JSON.stringify({ helperType: helperType, runData: runData, context: context }),
      });

      if (!res.ok) {
        var errData = await res.json().catch(function () { return {}; });
        throw new Error(errData.error || 'AI helper request failed.');
      }

      var data = await res.json();

      // Derive confidence level and evidence grounding from the analysis data
      var summaryData = state.lastResponse.summary || {};
      var uCount  = summaryData.urgent_stockout || 0;
      var riskCount   = summaryData.stockout_risk   || 0;
      var totalCount  = summaryData.total           || 0;

      var confidenceLevel, confidenceText, groundingText;

      if (helperType === 'expedite_email') {
        confidenceLevel = uCount > 0 ? 'high' : 'medium';
        confidenceText  = uCount > 0 ? 'High confidence' : 'Medium confidence';
        groundingText   = uCount > 0
          ? 'Based on ' + uCount + ' urgent part' + (uCount === 1 ? '' : 's') + ' from this analysis'
          : 'No urgent parts detected \u2014 draft may be precautionary';
      } else if (helperType === 'escalation_summary') {
        var atRisk = uCount + riskCount;
        confidenceLevel = atRisk > 0 ? 'high' : 'medium';
        confidenceText  = atRisk > 0 ? 'High confidence' : 'Medium confidence';
        groundingText   = atRisk > 0
          ? 'Based on ' + atRisk + ' at-risk part' + (atRisk === 1 ? '' : 's') + ' (' + uCount + ' urgent, ' + riskCount + ' risk)'
          : 'No at-risk parts detected \u2014 summary reflects healthy inventory';
      } else {
        confidenceLevel = 'medium';
        confidenceText  = 'Medium confidence';
        groundingText   = 'Based on ' + totalCount + ' part' + (totalCount === 1 ? '' : 's') + ' from this analysis';
      }

      // Populate result elements
      if (dom.aiHelperResultLabel) dom.aiHelperResultLabel.textContent = data.label || helperType;
      if (dom.aiHelperResultText)  dom.aiHelperResultText.textContent  = data.text;
      if (dom.aiHelperResultModel) dom.aiHelperResultModel.textContent = 'Model: ' + (data.model || 'unknown');

      // Confidence indicator
      var confidenceEl = document.getElementById('aiConfidence');
      var confidenceLabelEl = document.getElementById('aiConfidenceLabel');
      if (confidenceEl) {
        confidenceEl.setAttribute('data-level', confidenceLevel);
      }
      if (confidenceLabelEl) confidenceLabelEl.textContent = confidenceText;

      // Grounding line
      var groundingEl = document.getElementById('aiResultGrounding');
      if (groundingEl) groundingEl.textContent = groundingText;

      // Swap skeleton → result with fade-in
      hideLoading();
      showContent();
      if (dom.aiHelperCopyBtn) dom.aiHelperCopyBtn.classList.remove('hidden');
      if (dom.aiHelperResult) {
        dom.aiHelperResult.classList.remove('ai-fade-in');
        // Force reflow for animation restart
        void dom.aiHelperResult.offsetWidth;
        dom.aiHelperResult.classList.add('ai-fade-in');
      }

      // Telemetry
      track('ai_helper_used', { helper_type: helperType });
    } catch (err) {
      hideLoading();
      hideContent();
      showError(err.message || 'AI helper failed. Please try again.', helperType);
      track('ai_helper_error', { helper_type: helperType });
    } finally {
      // Re-enable buttons
      setAllButtons(false);
      if (btn) {
        btn.classList.remove('is-loading');
        btn.querySelector('.ai-helper-btn-label').textContent = LABELS[helperType] || helperType;
      }
    }
  }

  // Wire AI helper buttons via event delegation
  if (dom.aiHelpersSection) {
    dom.aiHelpersSection.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-helper]');
      if (btn && !btn.disabled) {
        requestAiHelper(btn.getAttribute('data-helper'));
      }
    });
  }

  // Copy to clipboard
  if (dom.aiHelperCopyBtn) {
    dom.aiHelperCopyBtn.addEventListener('click', function () {
      var text = dom.aiHelperResultText ? dom.aiHelperResultText.textContent : '';
      if (text && navigator.clipboard) {
        navigator.clipboard.writeText(text).then(function () {
          dom.aiHelperCopyBtn.textContent = 'Copied \u2713';
          setTimeout(function () { dom.aiHelperCopyBtn.textContent = 'Copy to clipboard'; }, 2000);
        });
      }
    });
  }

  App.aiHelpersUI = {
    showAiHelpersPanel: showAiHelpersPanel,
  };
})();
