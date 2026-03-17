/* aiHelpersUI.js — premium AI helper drafts panel. */
(function () {
  'use strict';

  var App   = window.App;
  var dom   = App.dom;
  var state = App.state;
  var track = App.track;

  function showAiHelpersPanel() {
    if (!dom.aiHelpersSection) return;
    var isPro = state.currentPlan && state.currentPlan.plan === 'pro';
    if (isPro && state.aiHelpersAvailable && state.lastResponse) {
      dom.aiHelpersSection.classList.remove('hidden');
    } else {
      dom.aiHelpersSection.classList.add('hidden');
    }
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

    // Find and disable the clicked button
    var btn = dom.aiHelpersSection.querySelector('[data-helper="' + helperType + '"]');
    if (btn) { btn.disabled = true; btn.querySelector('.ai-helper-btn-label').textContent = 'Generating\u2026'; }

    // Hide previous result
    if (dom.aiHelperResult) dom.aiHelperResult.classList.add('hidden');

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
      if (dom.aiHelperResultLabel) dom.aiHelperResultLabel.textContent = data.label || helperType;
      if (dom.aiHelperResultText)  dom.aiHelperResultText.textContent  = data.text;
      if (dom.aiHelperResultModel) dom.aiHelperResultModel.textContent = 'Model: ' + (data.model || 'unknown');
      if (dom.aiHelperResult)      dom.aiHelperResult.classList.remove('hidden');

      // Telemetry
      track('ai_helper_used', { helper_type: helperType });
    } catch (err) {
      App.showError(err.message || 'AI helper failed. Please try again.');
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
