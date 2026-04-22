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
      if (dom.aiHelpersLockedCta) dom.aiHelpersLockedCta.classList.add('hidden');
      if (dom.comparisonLockedCta) dom.comparisonLockedCta.classList.add('hidden');
      return;
    }

    // ── Analysis loaded, Pro plan: show active panel ────────────────────────
    if (isPro && state.aiHelpersAvailable) {
      dom.aiHelpersSection.classList.remove('hidden', 'ai-helpers-locked');
      if (dom.aiHelpersActions) dom.aiHelpersActions.classList.remove('hidden');
      if (dom.aiHelpersLockedCta) dom.aiHelpersLockedCta.classList.add('hidden');
      if (dom.comparisonLockedCta) dom.comparisonLockedCta.classList.add('hidden');
      renderHistory();
      return;
    }

    // ── Analysis loaded, NOT Pro: show buttons in locked state + upgrade modal on click
    dom.aiHelpersSection.classList.remove('hidden');
    dom.aiHelpersSection.classList.add('ai-helpers-locked');
    if (dom.aiHelpersActions) dom.aiHelpersActions.classList.remove('hidden');
    if (dom.aiHelperResult) dom.aiHelperResult.classList.add('hidden');

    var summary = state.lastResponse && state.lastResponse.summary ? state.lastResponse.summary : {};
    var urgent = summary.urgent_stockout || 0;
    var risk = summary.stockout_risk || 0;
    var excessExposure = (summary.excess || 0) + (summary.dead_stock || 0);

    if (dom.aiHelpersLockedCta) {
      dom.aiHelpersLockedCta.classList.remove('hidden');
      while (dom.aiHelpersLockedCta.firstChild) {
        dom.aiHelpersLockedCta.removeChild(dom.aiHelpersLockedCta.firstChild);
      }
      dom.aiHelpersLockedCta.appendChild(App.buildUpsellCta({
        icon: '\u2728',
        headline: urgent > 0 ? 'Draft supplier follow-up from this run' : 'Turn this report into leadership-ready follow-up',
        description: urgent > 0
          ? 'This run already identified ' + urgent + ' urgent item' + (urgent === 1 ? '' : 's') + ' and ' + risk + ' additional risk item' + (risk === 1 ? '' : 's') + '. Pro drafts expedite emails, escalation summaries, and meeting talking points grounded in the current analysis.'
          : 'Pro drafts buyer, supplier, and leadership follow-up from the same deterministic report your team is already reviewing.',
        features: [
          'Expedite email drafts tied to current urgent items',
          'Leadership-ready escalation summary',
          excessExposure > 0 ? 'Talking points for excess and dead-stock cleanup' : 'Meeting talking points for the next materials review'
        ],
        valueAnchor: urgent > 0
          ? 'The risky parts are already flagged. Pro turns them into ready-to-edit communications.'
          : 'Use the same report as the source for every follow-up message.',
        showBtn: !!state.billingConfigured,
        btnText: 'Unlock AI Follow-Up \u2014 $49/mo \u2192',
        upgradeSource: 'ai_helpers_locked'
      }));
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
        valueAnchor: urgent > 0
          ? 'Save this run now so the next upload shows exactly what changed for today\'s urgent items.'
          : 'The first saved run becomes the baseline for every future review.',
        showBtn: !!state.billingConfigured,
        btnText: 'Unlock Trend Comparison \u2014 $49/mo \u2192',
        upgradeSource: 'comparison_locked'
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
  var _pendingHelperType = null;

  /* ── Context input defaults (localStorage-backed) ───────────────── */
  var CTX_STORAGE_KEY = 'opscopilot_ai_ctx_defaults';

  var FIELD_MAP = {
    expedite_email:        { icon: '\u2709\uFE0F', title: 'Draft Expedite Email',   panel: 'aiCtxExpedite' },
    escalation_summary:    { icon: '\uD83D\uDEA8',  title: 'Escalation Summary',     panel: 'aiCtxEscalation' },
    meeting_talking_points: { icon: '\uD83D\uDCCB', title: 'Meeting Talking Points', panel: 'aiCtxMeeting' },
  };

  /** Read saved context defaults from localStorage. */
  function loadCtxDefaults() {
    try {
      var raw = localStorage.getItem(CTX_STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (_) { return {}; }
  }

  /** Persist current field values per helper type. */
  function saveCtxDefaults(helperType) {
    var saved = loadCtxDefaults();
    saved[helperType] = collectCtxFields(helperType);
    try { localStorage.setItem(CTX_STORAGE_KEY, JSON.stringify(saved)); } catch (_) {}
  }

  /** Collect field values for a given helper type. */
  function collectCtxFields(helperType) {
    if (helperType === 'expedite_email') {
      return {
        urgency:  dom.aiCtxUrgency  ? dom.aiCtxUrgency.value  : 'High',
        tone:     dom.aiCtxTone     ? dom.aiCtxTone.value     : 'Direct',
        supplier: dom.aiCtxSupplier ? dom.aiCtxSupplier.value.trim() : '',
        company:  dom.aiCtxCompanyExp ? dom.aiCtxCompanyExp.value.trim() : '',
      };
    }
    if (helperType === 'escalation_summary') {
      return {
        focus:   dom.aiCtxFocus      ? dom.aiCtxFocus.value.trim()      : '',
        company: dom.aiCtxCompanyEsc ? dom.aiCtxCompanyEsc.value.trim() : '',
      };
    }
    if (helperType === 'meeting_talking_points') {
      return {
        objective: dom.aiCtxObjective  ? dom.aiCtxObjective.value.trim()  : '',
        company:   dom.aiCtxCompanyMtg ? dom.aiCtxCompanyMtg.value.trim() : '',
      };
    }
    return {};
  }

  /** Prefill fields from saved defaults. */
  function prefillCtxFields(helperType) {
    var saved = loadCtxDefaults();
    var vals = saved[helperType] || {};

    if (helperType === 'expedite_email') {
      if (dom.aiCtxUrgency)    dom.aiCtxUrgency.value    = vals.urgency  || 'High';
      if (dom.aiCtxTone)       dom.aiCtxTone.value       = vals.tone     || 'Direct';
      if (dom.aiCtxSupplier)   dom.aiCtxSupplier.value   = vals.supplier || '';
      if (dom.aiCtxCompanyExp) dom.aiCtxCompanyExp.value  = vals.company  || '';
    } else if (helperType === 'escalation_summary') {
      if (dom.aiCtxFocus)      dom.aiCtxFocus.value      = vals.focus   || '';
      if (dom.aiCtxCompanyEsc) dom.aiCtxCompanyEsc.value  = vals.company || '';
    } else if (helperType === 'meeting_talking_points') {
      if (dom.aiCtxObjective)  dom.aiCtxObjective.value   = vals.objective || '';
      if (dom.aiCtxCompanyMtg) dom.aiCtxCompanyMtg.value  = vals.company   || '';
    }
  }

  /** Build the backend context object from current field values + analysis. */
  function buildContext(helperType) {
    var summary = (state.lastResponse && state.lastResponse.summary) || {};
    var urgentCount = summary.urgent_stockout || 0;
    var fields = collectCtxFields(helperType);
    var ctx = {};

    if (helperType === 'expedite_email') {
      ctx.urgency  = fields.urgency || (urgentCount > 0 ? 'High' : 'Standard');
      ctx.supplier = fields.supplier || '';
      ctx.company  = fields.company  || '';
      ctx.notes    = fields.tone ? 'Tone: ' + fields.tone : '';

      // Attach selected parts with supplier grouping
      var selected = App.getSelectedParts ? App.getSelectedParts() : [];
      if (selected.length > 0) {
        ctx.selectedParts = selected.map(function (r) {
          return {
            part_number: r.part_number,
            supplier:    r.supplier || '',
            status:      r.status,
            severity:    r.severity,
            coverage:    r.coverage,
            on_hand:     r.on_hand,
            daily_usage: r.daily_usage,
            lead_time:   r.lead_time,
            reason:      r.reason,
          };
        });
        // Auto-detect supplier groups
        var groups = groupBySupplier(selected);
        var supplierNames = Object.keys(groups);
        if (supplierNames.length > 1 || (supplierNames.length === 1 && supplierNames[0] !== 'Unknown Supplier')) {
          ctx.supplierGroups = {};
          for (var s = 0; s < supplierNames.length; s++) {
            ctx.supplierGroups[supplierNames[s]] = groups[supplierNames[s]].map(function (r) {
              return {
                part_number: r.part_number,
                status:      r.status,
                severity:    r.severity,
                coverage:    r.coverage,
                on_hand:     r.on_hand,
                daily_usage: r.daily_usage,
                lead_time:   r.lead_time,
                reason:      r.reason,
              };
            });
          }
        }
      }
    } else if (helperType === 'escalation_summary') {
      ctx.urgency = urgentCount > 0 ? 'High \u2014 ' + urgentCount + ' urgent stockout(s)' : 'Standard';
      ctx.company = fields.company || '';
      ctx.notes   = fields.focus   || '';
    } else if (helperType === 'meeting_talking_points') {
      ctx.urgency = urgentCount > 0 ? 'High \u2014 ' + urgentCount + ' urgent stockout(s)' : 'Standard';
      ctx.company = fields.company   || '';
      ctx.notes   = fields.objective || '';
    } else {
      ctx.urgency = urgentCount > 0 ? 'High \u2014 ' + urgentCount + ' urgent stockout(s)' : 'Standard';
    }

    return ctx;
  }

  /** Group an array of part rows by their supplier field. */
  function groupBySupplier(parts) {
    var groups = {};
    for (var i = 0; i < parts.length; i++) {
      var key = (parts[i].supplier && parts[i].supplier.trim()) || 'Unknown Supplier';
      if (!groups[key]) groups[key] = [];
      groups[key].push(parts[i]);
    }
    return groups;
  }

  /** Update the expedite context panel to reflect current part selection. */
  function updateExpediteSelectionUI() {
    var selected = App.getSelectedParts ? App.getSelectedParts() : [];
    var count = selected.length;

    // Selection badge
    if (dom.aiCtxSelectionInfo && dom.aiCtxSelectionBadge) {
      if (count > 0) {
        dom.aiCtxSelectionBadge.textContent = count + ' part' + (count !== 1 ? 's' : '') + ' selected';
        dom.aiCtxSelectionInfo.classList.remove('hidden');
      } else {
        dom.aiCtxSelectionBadge.textContent = 'No parts selected \u2014 all urgent parts will be used';
        dom.aiCtxSelectionInfo.classList.remove('hidden');
      }
    }

    // Detect suppliers from selection
    if (count > 0) {
      var groups = groupBySupplier(selected);
      var supplierNames = Object.keys(groups);
      var hasRealSupplier = supplierNames.some(function (n) { return n !== 'Unknown Supplier'; });

      if (hasRealSupplier && supplierNames.length >= 1) {
        // Show detected suppliers, hide manual input
        if (dom.aiCtxSupplierRow) dom.aiCtxSupplierRow.classList.add('hidden');
        if (dom.aiCtxSuppliersDetected && dom.aiCtxSuppliersList) {
          var labels = supplierNames.map(function (name) {
            var n = groups[name].length;
            return name + ' (' + n + ')';
          });
          dom.aiCtxSuppliersList.textContent = labels.join(', ');
          dom.aiCtxSuppliersDetected.classList.remove('hidden');
        }
      } else {
        // No supplier data — show manual input as before
        if (dom.aiCtxSupplierRow) dom.aiCtxSupplierRow.classList.remove('hidden');
        if (dom.aiCtxSuppliersDetected) dom.aiCtxSuppliersDetected.classList.add('hidden');
      }
    } else {
      // No selection — show manual input
      if (dom.aiCtxSupplierRow) dom.aiCtxSupplierRow.classList.remove('hidden');
      if (dom.aiCtxSuppliersDetected) dom.aiCtxSuppliersDetected.classList.add('hidden');
    }
  }

  // Listen for selection changes to update panel if it's open
  document.addEventListener('partSelectionChanged', function () {
    if (_pendingHelperType === 'expedite_email') {
      updateExpediteSelectionUI();
    }
  });

  /** Show the context panel for a given helper type. */
  function showContextPanel(helperType) {
    if (!dom.aiContextPanel) return;
    _pendingHelperType = helperType;

    // Show correct field group
    var info = FIELD_MAP[helperType] || {};
    if (dom.aiContextIcon)  dom.aiContextIcon.textContent  = info.icon  || '\u2728';
    if (dom.aiContextTitle) dom.aiContextTitle.textContent = info.title || helperType;

    var panels = ['aiCtxExpedite', 'aiCtxEscalation', 'aiCtxMeeting'];
    for (var i = 0; i < panels.length; i++) {
      var el = dom[panels[i]];
      if (el) el.classList.add('hidden');
    }
    if (info.panel && dom[info.panel]) dom[info.panel].classList.remove('hidden');

    // Prefill
    prefillCtxFields(helperType);

    // ── Expedite: update selection info and supplier detection ──────────
    if (helperType === 'expedite_email') {
      updateExpediteSelectionUI();
    }

    // Highlight selected button
    if (dom.aiHelpersActions) {
      var btns = dom.aiHelpersActions.querySelectorAll('.ai-helper-btn');
      for (var j = 0; j < btns.length; j++) btns[j].classList.remove('is-selected');
      var active = dom.aiHelpersActions.querySelector('[data-helper="' + helperType + '"]');
      if (active) active.classList.add('is-selected');
    }

    dom.aiContextPanel.classList.remove('hidden');
    // Smart autofocus: first empty text input, or Generate button if all filled
    setTimeout(function () {
      var fields = dom.aiContextPanel.querySelectorAll('.ai-ctx-fields:not(.hidden) input[type="text"]');
      var focused = false;
      for (var k = 0; k < fields.length; k++) {
        if (!fields[k].value.trim()) { fields[k].focus(); focused = true; break; }
      }
      if (!focused && dom.aiContextGenerate) dom.aiContextGenerate.focus();
    }, 80);
  }

  /** Hide the context panel. */
  function hideContextPanel() {
    if (dom.aiContextPanel) dom.aiContextPanel.classList.add('hidden');
    _pendingHelperType = null;
    // Remove button highlight
    if (dom.aiHelpersActions) {
      var btns = dom.aiHelpersActions.querySelectorAll('.ai-helper-btn');
      for (var i = 0; i < btns.length; i++) btns[i].classList.remove('is-selected');
    }
  }

  function setAllButtons(disabled) {
    if (!dom.aiHelpersActions) return;
    var btns = dom.aiHelpersActions.querySelectorAll('.ai-helper-btn');
    for (var i = 0; i < btns.length; i++) btns[i].disabled = disabled;
  }

  function showLoading(helperType) {
    closeRegenMenu();
    // Show the result container
    if (dom.aiHelperResult) {
      dom.aiHelperResult.classList.remove('hidden', 'ai-fade-in');
    }

    var hasExistingResult = dom.aiHelperResult && dom.aiHelperResult._rawText;

    if (hasExistingResult) {
      // Keep previous result visible but dimmed
      if (dom.aiHelperResultBody) dom.aiHelperResultBody.classList.add('ai-dimmed');
      // Hide action bar and refine panel during regeneration
      var hideIds = ['aiResultActions', 'aiRefinePanel'];
      for (var h = 0; h < hideIds.length; h++) {
        var hEl = document.getElementById(hideIds[h]);
        if (hEl) hEl.classList.add('hidden');
      }
    } else {
      hideContent();
    }

    if (dom.aiHelperLoading) dom.aiHelperLoading.classList.remove('hidden');
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
    // Remove dimmed state from previous result
    if (dom.aiHelperResultBody) dom.aiHelperResultBody.classList.remove('ai-dimmed');

    var hdr = dom.aiHelperResult ? dom.aiHelperResult.querySelector('.ai-result-card-header') : null;
    if (hdr) hdr.classList.remove('hidden');
    var strip = dom.aiHelperResult ? dom.aiHelperResult.querySelector('.ai-result-card-meta-strip') : null;
    if (strip) strip.classList.remove('hidden');
    // Clear refine input and autofocus for quick follow-up
    if (dom.aiRefineInput) {
      dom.aiRefineInput.value = '';
      dom.aiRefineInput.style.height = 'auto';
      setTimeout(function () { dom.aiRefineInput.focus(); }, 120);
    }
  }

  /** Format plain-text AI output into cleaner HTML. Preserves line breaks,
   *  bolds lines that look like headers (ALL-CAPS or ending with ':'),
   *  and renders '- ' or '• ' as bullet items.
   *  For multi-supplier expedite emails, splits on ===SUPPLIER: X=== delimiters
   *  and renders each section with a header and copy button. */
  function formatAiText(raw) {
    if (!raw) return '';

    // Detect multi-supplier delimiter
    var supplierSections = splitSupplierSections(raw);
    if (supplierSections.length > 1) {
      return renderSupplierSections(supplierSections);
    }

    return formatSingleSection(raw);
  }

  /** Split raw text by ===SUPPLIER: Name=== delimiters. */
  function splitSupplierSections(raw) {
    var re = /===\s*SUPPLIER:\s*(.+?)\s*===/g;
    var sections = [];
    var match;
    var lastIdx = 0;
    var lastSupplier = null;

    // Check if there's content before the first delimiter
    var firstMatch = re.exec(raw);
    if (!firstMatch) return [{ supplier: null, text: raw }];

    // If there's text before the first delimiter, add it as a preamble
    var preamble = raw.substring(0, firstMatch.index).trim();
    if (preamble) {
      sections.push({ supplier: null, text: preamble });
    }

    lastSupplier = firstMatch[1].trim();
    lastIdx = firstMatch.index + firstMatch[0].length;

    while ((match = re.exec(raw)) !== null) {
      var sectionText = raw.substring(lastIdx, match.index).trim();
      if (sectionText) {
        sections.push({ supplier: lastSupplier, text: sectionText });
      }
      lastSupplier = match[1].trim();
      lastIdx = match.index + match[0].length;
    }

    // Last section
    var remaining = raw.substring(lastIdx).trim();
    if (remaining) {
      sections.push({ supplier: lastSupplier, text: remaining });
    }

    return sections;
  }

  /** Render multi-supplier sections with headers and per-section copy buttons. */
  function renderSupplierSections(sections) {
    var html = [];
    for (var i = 0; i < sections.length; i++) {
      var sec = sections[i];
      if (sec.supplier) {
        html.push(
          '<div class="ai-supplier-section" data-supplier-idx="' + i + '">' +
            '<div class="ai-supplier-header">' +
              '<span class="ai-supplier-name">\u2709\uFE0F ' + escHtml(sec.supplier) + '</span>' +
              '<button type="button" class="ai-supplier-copy-btn" data-supplier-idx="' + i + '" title="Copy this email">' +
                '<span>Copy</span>' +
              '</button>' +
            '</div>' +
            '<div class="ai-supplier-body">' + formatSingleSection(sec.text) + '</div>' +
          '</div>'
        );
      } else {
        // Preamble (before any supplier section)
        html.push('<div class="ai-supplier-preamble">' + formatSingleSection(sec.text) + '</div>');
      }
    }
    return html.join('\n');
  }

  /** Format a single section of text (original logic). */
  function formatSingleSection(raw) {
    if (!raw) return '';
    var lines = raw.split('\n');
    var html = [];
    var inList = false;

    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      var trimmed = ln.trim();

      // Detect bullet lines
      var bulletMatch = trimmed.match(/^[-\u2022*]\s+(.*)$/);
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

    // Build business context from the context input fields
    var context = buildContext(helperType);

    // Save field values for next time
    saveCtxDefaults(helperType);

    // Hide context panel once generation starts
    hideContextPanel();

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
      if (dom.aiHelperResultBody) dom.aiHelperResultBody.classList.remove('ai-dimmed');
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

  // Wire AI helper buttons — show context panel instead of generating directly
  if (dom.aiHelpersSection) {
    dom.aiHelpersSection.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-helper]');
      if (btn && !btn.disabled) {
        if (dom.aiHelpersSection.classList.contains('ai-helpers-locked')) {
          track('helper_access_attempt', { helper_type: btn.getAttribute('data-helper') });
          App.openUpgradeModal();
          return;
        }
        showContextPanel(btn.getAttribute('data-helper'));
      }
    });
  }

  // Context panel: Generate button
  if (dom.aiContextGenerate) {
    dom.aiContextGenerate.addEventListener('click', function () {
      if (_pendingHelperType) requestAiHelper(_pendingHelperType);
    });
  }

  // Context panel: Close button
  if (dom.aiContextClose) {
    dom.aiContextClose.addEventListener('click', function () {
      hideContextPanel();
    });
  }

  // Allow Enter in context inputs to trigger generate
  if (dom.aiContextPanel) {
    dom.aiContextPanel.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && _pendingHelperType) {
        e.preventDefault();
        requestAiHelper(_pendingHelperType);
      }
    });
  }

  /* ── Toast helper ─────────────────────────────────────────────────── */
  var _toastContainer = document.getElementById('toastContainer');

  function showToast(msg, sub) {
    if (!_toastContainer) return;
    var el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML =
      '<span class="toast-icon">\u2705</span>' +
      '<span class="toast-msg">' + escHtml(msg) + '</span>' +
      (sub ? '<span class="toast-sub">\u00B7 ' + escHtml(sub) + '</span>' : '');
    _toastContainer.appendChild(el);
    // Auto-remove
    setTimeout(function () {
      el.classList.add('is-leaving');
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 200);
    }, 2400);
  }

  /* ── Daily copy counter (localStorage) ────────────────────────────── */
  var COPY_COUNT_KEY = 'opscopilot_copy_count';

  function getCopyCount() {
    try {
      var raw = localStorage.getItem(COPY_COUNT_KEY);
      if (!raw) return { date: '', count: 0 };
      var obj = JSON.parse(raw);
      var today = new Date().toISOString().slice(0, 10);
      if (obj.date !== today) return { date: today, count: 0 };
      return obj;
    } catch (_) { return { date: '', count: 0 }; }
  }

  function incrementCopyCount() {
    var today = new Date().toISOString().slice(0, 10);
    var data = getCopyCount();
    data.date = today;
    data.count = (data.count || 0) + 1;
    try { localStorage.setItem(COPY_COUNT_KEY, JSON.stringify(data)); } catch (_) {}
    return data.count;
  }

  // Copy to clipboard
  if (dom.aiHelperCopyBtn) {
    dom.aiHelperCopyBtn.addEventListener('click', function () {
      var raw = dom.aiHelperResult ? dom.aiHelperResult._rawText : '';
      if (raw && navigator.clipboard) {
        navigator.clipboard.writeText(raw).then(function () {
          // Button label feedback
          var lbl = dom.aiHelperCopyBtn.querySelector('span');
          if (lbl) { lbl.textContent = 'Copied \u2713'; setTimeout(function () { lbl.textContent = 'Copy'; }, 2000); }

          // Pulse animation on button
          dom.aiHelperCopyBtn.classList.add('copy-pulse');
          setTimeout(function () { dom.aiHelperCopyBtn.classList.remove('copy-pulse'); }, 400);

          // Increment daily counter & show toast
          var count = incrementCopyCount();
          var sub = count > 1 ? 'Copied ' + count + ' times today' : '';
          showToast('Copied \u2014 ready to send', sub);
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

  // Per-supplier copy buttons (event delegation on the result text container)
  var resultTextContainer = document.getElementById('aiHelperResultText');
  if (resultTextContainer) {
    resultTextContainer.addEventListener('click', function (e) {
      var copyBtn = e.target.closest('.ai-supplier-copy-btn');
      if (!copyBtn) return;
      var idx = parseInt(copyBtn.getAttribute('data-supplier-idx'), 10);
      var raw = dom.aiHelperResult ? dom.aiHelperResult._rawText : '';
      if (!raw) return;

      var sections = splitSupplierSections(raw);
      var section = sections[idx];
      if (!section || !section.text) return;

      if (navigator.clipboard) {
        navigator.clipboard.writeText(section.text).then(function () {
          var lbl = copyBtn.querySelector('span');
          if (lbl) { lbl.textContent = 'Copied \u2713'; setTimeout(function () { lbl.textContent = 'Copy'; }, 2000); }
          copyBtn.classList.add('copy-pulse');
          setTimeout(function () { copyBtn.classList.remove('copy-pulse'); }, 400);
          var count = incrementCopyCount();
          var sub = section.supplier ? section.supplier : '';
          showToast('Copied \u2014 ' + sub + ' email ready', count > 1 ? 'Copied ' + count + ' times today' : '');
        });
      }
    });
  }

  // Intent-based regenerate dropdown
  var regenMenu = document.getElementById('aiRegenMenu');
  var regenWrapper = dom.aiHelperRegenerateBtn ? dom.aiHelperRegenerateBtn.parentElement : null;

  function closeRegenMenu() {
    if (regenMenu) regenMenu.classList.add('hidden');
    if (regenWrapper) regenWrapper.classList.remove('open');
  }

  if (dom.aiHelperRegenerateBtn && regenMenu) {
    dom.aiHelperRegenerateBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      var isOpen = !regenMenu.classList.contains('hidden');
      if (isOpen) { closeRegenMenu(); return; }
      regenMenu.classList.remove('hidden');
      regenWrapper.classList.add('open');
    });

    regenMenu.addEventListener('click', function (e) {
      var opt = e.target.closest('[data-regen-intent]');
      if (!opt || !_lastHelperType) return;
      var intent = opt.getAttribute('data-regen-intent');
      closeRegenMenu();
      if (intent) {
        submitRefinement(intent);
      } else {
        requestAiHelper(_lastHelperType);
      }
    });

    document.addEventListener('click', function () { closeRegenMenu(); });
  }

  /* ── Refinement controls ──────────────────────────────────────────── */
  function setRefineControls(disabled) {
    if (dom.aiRefineInput) dom.aiRefineInput.disabled = disabled;
    if (dom.aiRefineSubmit) dom.aiRefineSubmit.disabled = disabled;
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

  // Refine textarea: Enter to submit, Shift+Enter for newline
  if (dom.aiRefineInput) {
    dom.aiRefineInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        var val = (dom.aiRefineInput.value || '').trim();
        if (val) submitRefinement(val);
      }
    });
    // Auto-resize textarea as user types
    dom.aiRefineInput.addEventListener('input', function () {
      this.style.height = 'auto';
      this.style.height = this.scrollHeight + 'px';
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
