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
      renderHistory();
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

  var ICONS = {
    expedite_email:        '\u2709\uFE0F',
    escalation_summary:    '\uD83D\uDEA8',
    meeting_talking_points: '\uD83D\uDCCB',
  };

  /* ── Internal helpers ─────────────────────────────────────────────── */
  var _progressTimer = null;
  var _lastHelperType = null;
  var _lastRunData = null;
  var _lastContext = null;

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

    // Label (visible during loading in the card header is hidden, but pre-set)
    if (dom.aiHelperResultLabel) dom.aiHelperResultLabel.textContent = LABELS[helperType] || helperType;

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
    var ids = ['aiConfidence', 'aiResultGrounding', 'aiHelperResultBody', 'aiResultActions', 'aiRefinePanel'];
    for (var i = 0; i < ids.length; i++) {
      var el = document.getElementById(ids[i]);
      if (el) el.classList.add('hidden');
    }
    // Hide the card header's content-dependent parts
    var hdr = dom.aiHelperResult ? dom.aiHelperResult.querySelector('.ai-result-card-header') : null;
    if (hdr) hdr.classList.add('hidden');
    var strip = dom.aiHelperResult ? dom.aiHelperResult.querySelector('.ai-result-card-meta-strip') : null;
    if (strip) strip.classList.add('hidden');
  }

  function showContent() {
    var ids = ['aiConfidence', 'aiResultGrounding', 'aiHelperResultBody', 'aiResultActions', 'aiRefinePanel'];
    for (var i = 0; i < ids.length; i++) {
      var el = document.getElementById(ids[i]);
      if (el) el.classList.remove('hidden');
    }
    var hdr = dom.aiHelperResult ? dom.aiHelperResult.querySelector('.ai-result-card-header') : null;
    if (hdr) hdr.classList.remove('hidden');
    var strip = dom.aiHelperResult ? dom.aiHelperResult.querySelector('.ai-result-card-meta-strip') : null;
    if (strip) strip.classList.remove('hidden');
    // Clear refine input for next iteration
    if (dom.aiRefineInput) dom.aiRefineInput.value = '';
  }

  /** Format plain-text AI output into cleaner HTML. Preserves line breaks,
   *  bolds lines that look like headers (ALL-CAPS or ending with ':'),
   *  and renders '- ' or '• ' as bullet items. */
  function formatAiText(raw) {
    if (!raw) return '';
    var lines = raw.split('\n');
    var html = [];
    var inList = false;

    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      var trimmed = ln.trim();

      // Detect bullet lines
      var bulletMatch = trimmed.match(/^[-•*]\s+(.*)$/);
      if (bulletMatch) {
        if (!inList) { html.push('<ul>'); inList = true; }
        html.push('<li>' + escHtml(bulletMatch[1]) + '</li>');
        continue;
      }

      // Close open list
      if (inList) { html.push('</ul>'); inList = false; }

      // Empty line → spacer
      if (trimmed === '') { html.push('<br>'); continue; }

      // Header-like lines: ALL-CAPS or ends with ':'
      var isHeader = /^[A-Z][A-Z /&\-:]{3,}$/.test(trimmed) || /^[A-Z].*:$/.test(trimmed);
      if (isHeader) {
        html.push('<strong>' + escHtml(trimmed) + '</strong>');
      } else {
        html.push('<span>' + escHtml(trimmed) + '</span>');
      }
    }
    if (inList) html.push('</ul>');
    return html.join('\n');
  }

  function escHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function formatTimestamp() {
    var d = new Date();
    var h = d.getHours(); var m = d.getMinutes();
    var ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return h + ':' + (m < 10 ? '0' : '') + m + ' ' + ampm;
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

  async function requestAiHelper(helperType, refinement) {
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
      urgency: urgentCount > 0 ? 'High \u2014 ' + urgentCount + ' urgent stockout(s)' : 'Standard',
    };

    // Persist for refinement iterations
    _lastRunData = runData;
    _lastContext = context;

    // Mark the clicked button loading & disable all buttons
    var btn = dom.aiHelpersSection.querySelector('[data-helper="' + helperType + '"]');
    if (btn) { btn.classList.add('is-loading'); btn.querySelector('.ai-helper-btn-label').textContent = 'Generating\u2026'; }
    setAllButtons(true);
    setRefineControls(true);

    // Show skeleton loading
    showLoading(helperType);
    // Tweak staged messages for refinement
    if (refinement) {
      if (dom.aiHelperLoadingText) dom.aiHelperLoadingText.textContent = 'Refining draft\u2026';
      clearTimeout(_progressTimer);
      _progressTimer = setTimeout(function () {
        if (dom.aiHelperLoadingText) dom.aiHelperLoadingText.textContent = 'Generating improved version\u2026';
      }, 3000);
    }

    // Build request body
    var reqBody = { helperType: helperType, runData: runData, context: context };
    if (refinement) reqBody.refinement = refinement;

    try {
      var token = await window.authModule.getToken();
      var res = await fetch('/api/ai-helper', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + token,
        },
        body: JSON.stringify(reqBody),
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
      if (dom.aiHelperResultLabel) dom.aiHelperResultLabel.textContent = data.label || LABELS[helperType] || helperType;
      if (dom.aiResultCardIcon) dom.aiResultCardIcon.textContent = ICONS[helperType] || '\u2728';

      // Formatted text body
      var resultTextEl = document.getElementById('aiHelperResultText');
      if (resultTextEl) resultTextEl.innerHTML = formatAiText(data.text);
      // Store raw text for copy/download
      if (dom.aiHelperResult) dom.aiHelperResult._rawText = data.text || '';

      if (dom.aiHelperResultModel) dom.aiHelperResultModel.textContent = 'Model: ' + (data.model || 'unknown');

      // Timestamp
      if (dom.aiResultTimestamp) dom.aiResultTimestamp.textContent = formatTimestamp();

      // Track last helper for regenerate
      _lastHelperType = helperType;

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
      if (dom.aiHelperResult) {
        dom.aiHelperResult.classList.remove('ai-fade-in');
        void dom.aiHelperResult.offsetWidth;
        dom.aiHelperResult.classList.add('ai-fade-in');
      }

      // Telemetry
      track('ai_helper_used', { helper_type: helperType, refined: !!refinement });

      // Save to local history
      if (App.aiHistoryStore) {
        App.aiHistoryStore.saveEntry({
          helperType: helperType,
          label: LABELS[helperType] || helperType,
          output: data.text || '',
        });
        renderHistory();
      }
    } catch (err) {
      hideLoading();
      hideContent();
      showError(err.message || 'AI helper failed. Please try again.', helperType);
      track('ai_helper_error', { helper_type: helperType, refined: !!refinement });
    } finally {
      // Re-enable buttons
      setAllButtons(false);
      setRefineControls(false);
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
      var raw = dom.aiHelperResult ? dom.aiHelperResult._rawText : '';
      if (raw && navigator.clipboard) {
        navigator.clipboard.writeText(raw).then(function () {
          var lbl = dom.aiHelperCopyBtn.querySelector('span');
          if (lbl) { lbl.textContent = 'Copied \u2713'; setTimeout(function () { lbl.textContent = 'Copy'; }, 2000); }
        });
      }
    });
  }

  // Download as .txt
  if (dom.aiHelperDownloadBtn) {
    dom.aiHelperDownloadBtn.addEventListener('click', function () {
      var raw = dom.aiHelperResult ? dom.aiHelperResult._rawText : '';
      if (!raw) return;
      var filename = (_lastHelperType || 'ai-output') + '.txt';
      var blob = new Blob([raw], { type: 'text/plain' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    });
  }

  // Regenerate
  if (dom.aiHelperRegenerateBtn) {
    dom.aiHelperRegenerateBtn.addEventListener('click', function () {
      if (_lastHelperType) requestAiHelper(_lastHelperType);
    });
  }

  /* ── Refinement controls ──────────────────────────────────────────── */
  function setRefineControls(disabled) {
    if (dom.aiRefineInput) dom.aiRefineInput.disabled = disabled;
    if (dom.aiRefineSubmit) dom.aiRefineSubmit.disabled = disabled;
    var chips = dom.aiRefinePanel ? dom.aiRefinePanel.querySelectorAll('.ai-refine-chip') : [];
    for (var i = 0; i < chips.length; i++) chips[i].disabled = disabled;
  }

  function submitRefinement(instruction) {
    if (!_lastHelperType || !instruction) return;
    var previousOutput = dom.aiHelperResult ? dom.aiHelperResult._rawText : '';
    if (!previousOutput) return;
    requestAiHelper(_lastHelperType, {
      previousOutput: previousOutput,
      instruction: instruction,
    });
  }

  // Refine form submit
  if (dom.aiRefineForm) {
    dom.aiRefineForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var val = (dom.aiRefineInput.value || '').trim();
      if (val) submitRefinement(val);
    });
  }

  // Quick-action chips (event delegation on the refine panel)
  if (dom.aiRefinePanel) {
    dom.aiRefinePanel.addEventListener('click', function (e) {
      var chip = e.target.closest('[data-refine]');
      if (chip && !chip.disabled) {
        submitRefinement(chip.getAttribute('data-refine'));
      }
    });
  }

  /* ── AI Draft History ─────────────────────────────────────────────── */

  var HISTORY_ICONS = {
    expedite_email:       '\u2709\uFE0F',
    escalation_summary:   '\uD83D\uDEA8',
    meeting_talking_points: '\uD83D\uDCCB',
  };

  function escHistHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function formatHistoryTime(iso) {
    try {
      var d = new Date(iso);
      var now = new Date();
      var diffMs = now - d;
      var diffMin = Math.floor(diffMs / 60000);
      if (diffMin < 1) return 'Just now';
      if (diffMin < 60) return diffMin + 'm ago';
      var diffHr = Math.floor(diffMin / 60);
      if (diffHr < 24) return diffHr + 'h ago';
      var diffDay = Math.floor(diffHr / 24);
      if (diffDay < 7) return diffDay + 'd ago';
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    } catch (_) { return ''; }
  }

  function renderHistory() {
    if (!dom.aiHistoryList || !App.aiHistoryStore) return;

    var entries = App.aiHistoryStore.getEntries();

    // Update count badge
    if (dom.aiHistoryCount) dom.aiHistoryCount.textContent = entries.length || '';

    // Show/hide history panel based on entries
    if (dom.aiHistoryPanel) {
      if (entries.length > 0) {
        dom.aiHistoryPanel.classList.remove('hidden');
      } else {
        dom.aiHistoryPanel.classList.add('hidden');
      }
    }

    if (entries.length === 0) {
      dom.aiHistoryList.innerHTML = '<p style="font-size:12px;color:var(--ink-200);text-align:center;padding:12px 0;">No drafts saved yet.</p>';
      return;
    }

    // Group by helperType
    var grouped = App.aiHistoryStore.getGrouped();
    var groupOrder = ['expedite_email', 'escalation_summary', 'meeting_talking_points'];
    var html = [];

    for (var g = 0; g < groupOrder.length; g++) {
      var type = groupOrder[g];
      var items = grouped[type];
      if (!items || items.length === 0) continue;
      html.push('<div class="ai-history-group-header">' + escHistHtml(LABELS[type] || type) + '</div>');
      for (var i = 0; i < items.length; i++) {
        var e = items[i];
        var preview = (e.output || '').substring(0, 80).replace(/\n/g, ' ');
        html.push(
          '<div class="ai-history-entry" data-history-id="' + escHistHtml(e.id) + '">' +
            '<div class="ai-history-entry-header">' +
              '<span class="ai-history-entry-icon">' + (HISTORY_ICONS[e.helperType] || '\u2728') + '</span>' +
              '<span class="ai-history-entry-title">' + escHistHtml(preview || e.label) + '</span>' +
              '<span class="ai-history-entry-time">' + escHistHtml(formatHistoryTime(e.timestamp)) + '</span>' +
              '<svg class="ai-history-entry-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>' +
            '</div>' +
            '<div class="ai-history-entry-body">' +
              '<div class="ai-history-entry-text">' + escHistHtml(e.output || '') + '</div>' +
              '<div class="ai-history-entry-actions">' +
                '<button class="ai-history-reuse-btn" type="button" data-reuse-id="' + escHistHtml(e.id) + '">Use this again</button>' +
                '<button class="ai-history-delete-btn" type="button" data-delete-id="' + escHistHtml(e.id) + '">Delete</button>' +
              '</div>' +
            '</div>' +
          '</div>'
        );
      }
    }

    dom.aiHistoryList.innerHTML = html.join('');
  }

  // Toggle history panel open/closed
  if (dom.aiHistoryToggle) {
    dom.aiHistoryToggle.addEventListener('click', function () {
      if (!dom.aiHistoryPanel || !dom.aiHistoryBody) return;
      var isOpen = dom.aiHistoryPanel.classList.toggle('is-open');
      if (isOpen) {
        dom.aiHistoryBody.classList.remove('hidden');
        renderHistory();
      } else {
        dom.aiHistoryBody.classList.add('hidden');
      }
    });
  }

  // Event delegation for history list: expand, reuse, delete
  if (dom.aiHistoryList) {
    dom.aiHistoryList.addEventListener('click', function (e) {
      // Reuse button
      var reuseBtn = e.target.closest('[data-reuse-id]');
      if (reuseBtn) {
        var id = reuseBtn.getAttribute('data-reuse-id');
        var entries = App.aiHistoryStore.getEntries();
        var entry = null;
        for (var i = 0; i < entries.length; i++) {
          if (entries[i].id === id) { entry = entries[i]; break; }
        }
        if (entry) {
          // Populate the result card with the stored output
          if (dom.aiHelperResultLabel) dom.aiHelperResultLabel.textContent = entry.label || LABELS[entry.helperType] || entry.helperType;
          if (dom.aiResultCardIcon) dom.aiResultCardIcon.textContent = ICONS[entry.helperType] || '\u2728';
          var resultTextEl = document.getElementById('aiHelperResultText');
          if (resultTextEl) resultTextEl.innerHTML = formatAiText(entry.output);
          if (dom.aiHelperResult) dom.aiHelperResult._rawText = entry.output || '';
          if (dom.aiHelperResultModel) dom.aiHelperResultModel.textContent = '';
          if (dom.aiResultTimestamp) dom.aiResultTimestamp.textContent = formatHistoryTime(entry.timestamp);
          _lastHelperType = entry.helperType;
          hideError();
          hideLoading();
          showContent();
          if (dom.aiHelperResult) {
            dom.aiHelperResult.classList.remove('ai-fade-in');
            void dom.aiHelperResult.offsetWidth;
            dom.aiHelperResult.classList.add('ai-fade-in');
          }
          // Scroll to the result card
          if (dom.aiHelperResult) dom.aiHelperResult.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
        return;
      }

      // Delete button
      var delBtn = e.target.closest('[data-delete-id]');
      if (delBtn) {
        App.aiHistoryStore.removeEntry(delBtn.getAttribute('data-delete-id'));
        renderHistory();
        return;
      }

      // Expand/collapse entry header
      var header = e.target.closest('.ai-history-entry-header');
      if (header) {
        var entry = header.closest('.ai-history-entry');
        if (entry) entry.classList.toggle('is-expanded');
      }
    });
  }

  // Clear all history
  if (dom.aiHistoryClear) {
    dom.aiHistoryClear.addEventListener('click', function () {
      App.aiHistoryStore.clearHistory();
      renderHistory();
    });
  }

  App.aiHelpersUI = {
    showAiHelpersPanel: showAiHelpersPanel,
    renderHistory: renderHistory,
  };
})();
