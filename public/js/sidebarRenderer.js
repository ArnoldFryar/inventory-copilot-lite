/* sidebarRenderer.js — Shared sidebar navigation renderer.
 *
 * Builds the sidebar DOM from a client-side module registry so that every
 * page (index, procurement, procurement-upload, …) shares a single source
 * of navigation markup instead of duplicating ~55 lines of HTML each.
 *
 * Usage:
 *   <nav id="appSidebar" class="app-sidebar" aria-label="Application navigation"></nav>
 *   <script src="/js/sidebarRenderer.js"></script>
 *
 * Add  data-sidebar-cmd-bar  to the <nav> to include the command-bar trigger
 * (only needed on pages that also load commandBar.js).
 */
(function () {
  'use strict';

  var nav = document.getElementById('appSidebar');
  if (!nav) return;

  // ── Client-side module registry (mirrors server/lib/modules.js) ─────────
  var MODULES = [
    {
      key: 'inventory', name: 'Inventory', shortName: 'Inventory Suite',
      icon: 'summary', path: '/',
      subPages: [
        { key: 'triage',  name: 'Triage',      path: '/',                icon: 'summary' },
        { key: 'history', name: 'History',      path: '#historySection',  icon: 'history' },
        { key: 'ai',      name: 'AI Helpers',   path: '#aiHelpersSection', icon: 'ai', badge: 'Pro' }
      ]
    },
    {
      key: 'procurement', name: 'Procurement Copilot', shortName: 'Procurement',
      icon: 'package', path: '/procurement', badge: 'New',
      subPages: [
        { key: 'overview', name: 'Overview',   path: '/procurement',        icon: 'dashboard' },
        { key: 'upload',   name: 'Upload POs', path: '/procurement/upload', icon: 'upload' }
      ]
    }
  ];

  var pathname   = window.location.pathname;
  var showCmdBar = nav.hasAttribute('data-sidebar-cmd-bar');

  // ── Helpers ─────────────────────────────────────────────────────────────
  function esc(str) {
    var d = document.createElement('div');
    d.appendChild(document.createTextNode(str));
    return d.innerHTML;
  }

  function getCurrentModule() {
    for (var i = MODULES.length - 1; i >= 0; i--) {
      if (MODULES[i].path !== '/' && pathname.startsWith(MODULES[i].path)) {
        return MODULES[i];
      }
    }
    return MODULES[0];
  }

  function isSubPageActive(sp) {
    if (sp.path.charAt(0) === '#') return pathname === '/';
    return pathname === sp.path;
  }

  function icon(name, size) {
    return '<span data-icon="' + esc(name) + '" data-icon-size="' + (size || 15) + '" data-icon-class="sidebar-nav-icon"></span>';
  }

  // ── Build ───────────────────────────────────────────────────────────────
  var current = getCurrentModule();
  var h = '';

  // Brand
  h += '<div class="sidebar-brand">';
  h += '<div class="sidebar-logo">';
  h += '<div class="sidebar-logo-mark" aria-hidden="true">';
  h += '<img src="/assets/logo/opscopilot-mark-white.svg" width="18" height="18" alt="" draggable="false">';
  h += '</div>';
  h += '<div class="sidebar-logo-copy">';
  h += '<span class="sidebar-logo-name">OpsCopilot</span>';
  h += '<span class="sidebar-logo-module">' + esc(current.shortName) + '</span>';
  h += '</div></div></div>';

  // Nav
  h += '<div class="sidebar-nav">';
  h += '<div class="sidebar-section-label">Modules</div>';

  for (var i = 0; i < MODULES.length; i++) {
    var m = MODULES[i];
    var active = m.key === current.key;
    h += '<a href="' + esc(m.path) + '" class="sidebar-nav-item' + (active ? ' is-active' : '') + '"';
    if (active) h += ' aria-current="page"';
    h += '>';
    h += icon(m.icon);
    h += '<span>' + esc(m.shortName.split(' ')[0]) + '</span>';
    if (m.badge) h += '<span class="sidebar-nav-badge">' + esc(m.badge) + '</span>';
    h += '</a>';
  }

  h += '<div class="sidebar-divider"></div>';

  // Sub-pages for current module
  if (current.subPages) {
    h += '<div class="sidebar-section-label">' + esc(current.shortName.split(' ')[0]) + '</div>';
    for (var j = 0; j < current.subPages.length; j++) {
      var sp = current.subPages[j];
      var spActive = isSubPageActive(sp);
      h += '<a href="' + esc(sp.path) + '" class="sidebar-nav-item sidebar-nav-sub' + (spActive ? ' is-active' : '') + '"';
      h += ' data-nav="' + esc(current.key + '-' + sp.key) + '">';
      h += icon(sp.icon);
      h += '<span>' + esc(sp.name) + '</span>';
      if (sp.badge) h += '<span class="sidebar-nav-badge">' + esc(sp.badge) + '</span>';
      h += '</a>';
    }
    h += '<div class="sidebar-divider"></div>';
  }

  // Static links
  h += '<a href="/billing.html" class="sidebar-nav-item">';
  h += icon('billing');
  h += '<span>Billing &amp; Plan</span></a>';

  h += '<button type="button" class="sidebar-nav-item" data-support-trigger aria-label="Contact Support">';
  h += icon('info');
  h += '<span>Support</span></button>';

  h += '</div>'; // .sidebar-nav

  // Footer
  h += '<div class="sidebar-foot">';
  if (showCmdBar) {
    h += '<button id="cmdTriggerBtn" class="cmd-trigger-btn" type="button" aria-label="Open command bar">';
    h += '<span class="cmd-trigger-label">';
    h += '<span data-icon="search" data-icon-size="13" aria-hidden="true"></span>';
    h += 'Quick actions</span>';
    h += '<span class="cmd-trigger-shortcut">Ctrl K</span>';
    h += '</button>';
  }
  h += '<div class="sidebar-status-row">';
  h += '<span class="sidebar-status-dot" aria-hidden="true"></span>';
  h += '<span class="sidebar-status-text">System online</span>';
  h += '</div></div>';

  nav.innerHTML = h;
})();
