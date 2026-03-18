/* commandBar.js — Ctrl+K command palette for OpsCopilot
   Provides keyboard-driven quick actions and section navigation.
   Depends on: stateStore.js (for App.state), exportManager.js  */
(function () {
  'use strict';

  // ── Actions registry ─────────────────────────────────────────────────────
  // Each entry: { id, group, label, desc, icon (SVG string), keywords[], available?, run() }
  // `available` (optional) — fn returning false hides the item when bar is
  // opened with no query; it is shown (dimmed) only when searched.

  var ICON = {
    upload:    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/></svg>',
    risk:      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    summary:   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>',
    table:     '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/></svg>',
    ai:        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
    history:   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
    export:    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
    billing:   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="4" width="22" height="16" rx="2" ry="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>',
    dashboard: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>',
  };

  var ALL_ACTIONS = [
    // ── Navigate ──────────────────────────────────────────────────────────
    {
      id: 'dashboard',
      group: 'Navigate',
      label: 'Go to dashboard',
      desc: 'Return to the inventory triage home',
      icon: ICON.dashboard,
      keywords: ['dashboard', 'home', 'triage', 'main', 'start'],
      run: function () { window.location.href = '/'; },
    },
    {
      id: 'summary',
      group: 'Navigate',
      label: 'View executive summary',
      desc: 'Jump to health score and KPIs',
      icon: ICON.summary,
      keywords: ['exec', 'summary', 'health', 'score', 'kpi'],
      available: function () { return !hidden('execSummarySection'); },
      run: function () { scrollTo('execSummarySection'); },
    },
    {
      id: 'risks',
      group: 'Navigate',
      label: 'View top risks',
      desc: 'Jump to the priority items panel',
      icon: ICON.risk,
      keywords: ['risk', 'priority', 'urgent', 'stockout', 'danger', 'critical'],
      available: function () { return !hidden('prioritySection'); },
      run: function () { scrollTo('prioritySection'); },
    },
    {
      id: 'results',
      group: 'Navigate',
      label: 'View results table',
      desc: 'Jump to the full analysis table',
      icon: ICON.table,
      keywords: ['results', 'table', 'all', 'parts', 'data', 'detail'],
      available: function () { return !hidden('resultsSection'); },
      run: function () { scrollTo('resultsSection'); },
    },
    {
      id: 'ai',
      group: 'Navigate',
      label: 'Open AI helpers',
      desc: 'Jump to AI draft tools (Pro)',
      icon: ICON.ai,
      keywords: ['ai', 'helper', 'draft', 'email', 'escalation', 'talking', 'pro'],
      available: function () { return !hidden('aiHelpersSection'); },
      run: function () { scrollTo('aiHelpersSection'); },
    },
    {
      id: 'history',
      group: 'Navigate',
      label: 'Open history',
      desc: 'Browse saved analysis runs',
      icon: ICON.history,
      keywords: ['history', 'saved', 'past', 'runs', 'previous', 'archive'],
      run: function () {
        var el = document.getElementById('historySection');
        if (el) {
          el.classList.remove('hidden');
          el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      },
    },
    {
      id: 'billing',
      group: 'Navigate',
      label: 'Go to billing',
      desc: 'Manage your plan and subscription',
      icon: ICON.billing,
      keywords: ['billing', 'plan', 'upgrade', 'pro', 'payment', 'subscription'],
      run: function () { window.location.href = '/billing.html'; },
    },
    // ── Actions ───────────────────────────────────────────────────────────
    {
      id: 'upload',
      group: 'Actions',
      label: 'Analyze new upload',
      desc: 'Upload a new inventory CSV for triage',
      icon: ICON.upload,
      keywords: ['upload', 'analyze', 'csv', 'new', 'file', 'import', 'fresh'],
      run: function () {
        var section = document.querySelector('.upload-section');
        if (section) section.scrollIntoView({ behavior: 'smooth', block: 'center' });
        var input = document.getElementById('csvfile');
        if (input) setTimeout(function () { input.click(); }, 280);
      },
    },
    {
      id: 'export',
      group: 'Actions',
      label: 'Export CSV report',
      desc: 'Download the current analysis as CSV',
      icon: ICON.export,
      keywords: ['export', 'csv', 'download', 'report', 'save'],
      available: function () {
        return window.App && window.App.state && !!window.App.state.lastResponse;
      },
      run: function () {
        var btn = document.getElementById('exportBtn');
        if (btn) { btn.click(); return; }
        // Fallback: trigger via App.exportManager if available
        if (window.App && window.App.exportManager && typeof window.App.exportManager.triggerCsvExport === 'function') {
          window.App.exportManager.triggerCsvExport();
        }
      },
    },
  ];

  // ── Helpers ───────────────────────────────────────────────────────────────
  function hidden(id) {
    var el = document.getElementById(id);
    return !el || el.classList.contains('hidden');
  }

  function scrollTo(id) {
    var el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function escHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // ── DOM references ────────────────────────────────────────────────────────
  var overlay, panel, searchInput, resultsList;

  // ── State ─────────────────────────────────────────────────────────────────
  var isOpen       = false;
  var activeIdx    = 0;
  var visibleItems = [];

  // ── Core: open / close ────────────────────────────────────────────────────
  function open() {
    if (isOpen) return;
    isOpen = true;
    overlay.classList.add('is-open');
    overlay.removeAttribute('aria-hidden');
    searchInput.value = '';
    renderList('');
    requestAnimationFrame(function () { searchInput.focus(); });
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    overlay.classList.remove('is-open');
    overlay.setAttribute('aria-hidden', 'true');
  }

  // ── Rendering ─────────────────────────────────────────────────────────────
  function renderList(query) {
    var q = query.toLowerCase().trim();

    visibleItems = ALL_ACTIONS.filter(function (a) {
      var avail = typeof a.available !== 'function' || a.available();
      if (!q) return avail; // no query — show only available items
      // With query: include all matching items (available or not)
      var haystack = (a.label + ' ' + a.desc + ' ' + a.keywords.join(' ')).toLowerCase();
      return haystack.indexOf(q) !== -1;
    });

    // Stable sort: available items first, unavailable last (only relevant with query)
    if (q) {
      visibleItems.sort(function (a, b) {
        var aA = typeof a.available !== 'function' || a.available();
        var bA = typeof b.available !== 'function' || b.available();
        if (aA && !bA) return -1;
        if (!aA && bA) return 1;
        return 0;
      });
    }

    activeIdx = 0;
    buildDom();
  }

  function buildDom() {
    while (resultsList.firstChild) resultsList.removeChild(resultsList.firstChild);

    if (visibleItems.length === 0) {
      var empty = document.createElement('p');
      empty.className = 'cmd-empty';
      empty.textContent = 'No matching actions';
      resultsList.appendChild(empty);
      return;
    }

    var lastGroup = null;
    visibleItems.forEach(function (action, idx) {
      // Group header
      if (action.group !== lastGroup) {
        lastGroup = action.group;
        var grp = document.createElement('div');
        grp.className = 'cmd-group-label';
        grp.textContent = action.group;
        resultsList.appendChild(grp);
      }

      var isUnavail = typeof action.available === 'function' && !action.available();
      var isActive  = idx === activeIdx;

      var item = document.createElement('div');
      item.className = 'cmd-item' +
        (isActive  ? ' is-active' : '') +
        (isUnavail ? ' is-unavailable' : '');
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', isActive ? 'true' : 'false');
      item.setAttribute('data-cmd-idx', idx);
      item.tabIndex = -1;

      item.innerHTML =
        '<div class="cmd-item-icon" aria-hidden="true">' + action.icon + '</div>' +
        '<div class="cmd-item-body">' +
          '<div class="cmd-item-label">' + escHtml(action.label) + '</div>' +
          '<div class="cmd-item-desc">' + escHtml(action.desc) + '</div>' +
        '</div>';

      item.addEventListener('mousedown', function (e) {
        e.preventDefault(); // keep input focused
        activeIdx = idx;
        buildDom();
        execute();
      });

      item.addEventListener('mouseenter', function () {
        if (activeIdx !== idx) {
          activeIdx = idx;
          buildDom();
        }
      });

      resultsList.appendChild(item);
    });
  }

  // ── Navigation ────────────────────────────────────────────────────────────
  function moveFocus(delta) {
    if (visibleItems.length === 0) return;
    activeIdx = (activeIdx + delta + visibleItems.length) % visibleItems.length;
    buildDom();
    var el = resultsList.querySelector('.cmd-item.is-active');
    if (el) el.scrollIntoView({ block: 'nearest' });
  }

  function execute() {
    var action = visibleItems[activeIdx];
    if (!action) return;
    close();
    setTimeout(function () { action.run(); }, 50);
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  function init() {
    overlay     = document.getElementById('cmdOverlay');
    panel       = document.getElementById('cmdPanel');
    searchInput = document.getElementById('cmdInput');
    resultsList = document.getElementById('cmdResults');

    if (!overlay || !searchInput || !resultsList) return;

    // Search input
    searchInput.addEventListener('input', function () {
      renderList(searchInput.value);
    });

    // Backdrop click to dismiss
    overlay.addEventListener('mousedown', function (e) {
      if (!panel.contains(e.target)) close();
    });

    // Sidebar trigger button
    var triggerBtn = document.getElementById('cmdTriggerBtn');
    if (triggerBtn) {
      triggerBtn.addEventListener('click', function () {
        isOpen ? close() : open();
      });
    }

    // Global keyboard handler
    document.addEventListener('keydown', function (e) {
      // Ctrl+K / Cmd+K — open (suppress if inside a regular form input, but
      // not inside the cmd panel itself)
      var inFormInput = (function () {
        var el  = document.activeElement;
        var tag = el ? el.tagName : '';
        if (tag !== 'INPUT' && tag !== 'TEXTAREA') return false;
        return !el.closest('#cmdPanel');
      })();

      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        if (!inFormInput) {
          e.preventDefault();
          isOpen ? close() : open();
        }
        return;
      }

      if (!isOpen) return;

      if (e.key === 'Escape')    { e.preventDefault(); close();       return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); moveFocus(1);  return; }
      if (e.key === 'ArrowUp')   { e.preventDefault(); moveFocus(-1); return; }
      if (e.key === 'Enter')     { e.preventDefault(); execute();     return; }
      if (e.key === 'Tab')       { e.preventDefault(); moveFocus(e.shiftKey ? -1 : 1); return; }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
