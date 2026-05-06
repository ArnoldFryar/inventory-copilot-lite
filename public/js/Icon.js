/* Icon.js — Centralised icon factory for OpsCopilot
 *
 * Provides reusable icons for UI contexts (inline SVG, inherits currentColor)
 * and brand assets (<img> referencing files in /assets/).
 *
 * Registration: window.App.Icon
 *
 * API:
 *   App.Icon.html(name, opts?)  → HTML string (safe for innerHTML in trusted
 *                                  developer-controlled contexts)
 *   App.Icon.el(name, opts?)    → HTMLElement ready to append to the DOM
 *
 * opts: {
 *   size?:      number   — width/height in px  (default: 16)
 *   className?: string   — extra CSS classes to add
 * }
 *
 * ── UI icons (inline SVG, stroke-based, inherits currentColor) ────────────
 *   alert, chart, upload, risk, summary, table, ai, history, export,
 *   billing, dashboard, check, close, info, search, plus, minus, dots,
 *   chevron-down, chevron-up, chevron-right, chevron-left,
 *   settings, user, filter, download, copy, flag, arrow-up, arrow-down
 *
 * ── Brand icons (rendered as <img> from /assets/) ─────────────────────────
 *   monogram, monogram-gradient,
 *   mark-gradient, mark-white, mark-black, mark-teal,
 *   mark-outline-light, mark-outline-dark, mark-figma
 *
 * Usage examples:
 *
 *   // Insert HTML string (trusted context — no user data involved)
 *   btn.innerHTML = App.Icon.html('alert') + ' View risks';
 *   badgeEl.innerHTML = App.Icon.html('check', { size: 14, className: 'inline' });
 *
 *   // Append DOM element
 *   panel.appendChild(App.Icon.el('chart', { size: 20 }));
 *   header.appendChild(App.Icon.el('mark-gradient', { size: 40, className: 'brand-logo' }));
 *
 *   // Brand monogram at icon size
 *   navEl.appendChild(App.Icon.el('monogram-gradient', { size: 32 }));
 *
 * Security note: `name` is always resolved against an allow-list.
 * `size` is coerced to a safe integer. `className` is attribute-escaped.
 * This module never touches user-supplied CSV data.
 */
(function () {
  'use strict';

  var App = window.App = window.App || {};

  var DEFAULT_SIZE = 16;

  // ── Inline path data for stroke-based UI icons ──────────────────────────
  // Each value is the inner SVG markup only (no <svg> wrapper).
  // All icons use viewBox "0 0 24 24", stroke="currentColor".
  var UI_PATHS = {
    alert:
      '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>' +
      '<line x1="12" y1="9" x2="12" y2="13"/>' +
      '<line x1="12" y1="17" x2="12.01" y2="17"/>',

    chart:
      '<rect x="2" y="14" width="4" height="7"/>' +
      '<rect x="9" y="9" width="4" height="12"/>' +
      '<rect x="16" y="3" width="4" height="18"/>',

    upload:
      '<polyline points="16 16 12 12 8 16"/>' +
      '<line x1="12" y1="12" x2="12" y2="21"/>' +
      '<path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/>',

    risk:
      '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>' +
      '<line x1="12" y1="9" x2="12" y2="13"/>' +
      '<line x1="12" y1="17" x2="12.01" y2="17"/>',

    summary:
      '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',

    table:
      '<rect x="3" y="3" width="18" height="18" rx="2"/>' +
      '<line x1="3" y1="9" x2="21" y2="9"/>' +
      '<line x1="3" y1="15" x2="21" y2="15"/>' +
      '<line x1="9" y1="3" x2="9" y2="21"/>',

    list:
      '<line x1="8" y1="6" x2="21" y2="6"/>' +
      '<line x1="8" y1="12" x2="21" y2="12"/>' +
      '<line x1="8" y1="18" x2="21" y2="18"/>' +
      '<line x1="3" y1="6" x2="3.01" y2="6"/>' +
      '<line x1="3" y1="12" x2="3.01" y2="12"/>' +
      '<line x1="3" y1="18" x2="3.01" y2="18"/>',

    ai:
      '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',

    history:
      '<circle cx="12" cy="12" r="10"/>' +
      '<polyline points="12 6 12 12 16 14"/>',

    export:
      '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>' +
      '<polyline points="7 10 12 15 17 10"/>' +
      '<line x1="12" y1="15" x2="12" y2="3"/>',

    billing:
      '<rect x="1" y="4" width="22" height="16" rx="2" ry="2"/>' +
      '<line x1="1" y1="10" x2="23" y2="10"/>',

    dashboard:
      '<rect x="3" y="3" width="7" height="7"/>' +
      '<rect x="14" y="3" width="7" height="7"/>' +
      '<rect x="14" y="14" width="7" height="7"/>' +
      '<rect x="3" y="14" width="7" height="7"/>',

    check:
      '<polyline points="20 6 9 17 4 12"/>',

    close:
      '<line x1="18" y1="6" x2="6" y2="18"/>' +
      '<line x1="6" y1="6" x2="18" y2="18"/>',

    info:
      '<circle cx="12" cy="12" r="10"/>' +
      '<line x1="12" y1="16" x2="12" y2="12"/>' +
      '<line x1="12" y1="8" x2="12.01" y2="8"/>',

    search:
      '<circle cx="11" cy="11" r="8"/>' +
      '<line x1="21" y1="21" x2="16.65" y2="16.65"/>',

    plus:
      '<line x1="12" y1="5" x2="12" y2="19"/>' +
      '<line x1="5" y1="12" x2="19" y2="12"/>',

    minus:
      '<line x1="5" y1="12" x2="19" y2="12"/>',

    dots:
      '<circle cx="12" cy="12" r="1"/>' +
      '<circle cx="19" cy="12" r="1"/>' +
      '<circle cx="5" cy="12" r="1"/>',

    'chevron-down':
      '<polyline points="6 9 12 15 18 9"/>',

    'chevron-up':
      '<polyline points="18 15 12 9 6 15"/>',

    'chevron-right':
      '<polyline points="9 18 15 12 9 6"/>',

    'chevron-left':
      '<polyline points="15 18 9 12 15 6"/>',

    settings:
      '<circle cx="12" cy="12" r="3"/>' +
      '<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',

    user:
      '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>' +
      '<circle cx="12" cy="7" r="4"/>',

    filter:
      '<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>',

    download:
      '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>' +
      '<polyline points="7 10 12 15 17 10"/>' +
      '<line x1="12" y1="15" x2="12" y2="3"/>',

    copy:
      '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>' +
      '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',

    flag:
      '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/>' +
      '<line x1="4" y1="22" x2="4" y2="15"/>',

    'arrow-up':
      '<line x1="12" y1="19" x2="12" y2="5"/>' +
      '<polyline points="5 12 12 5 19 12"/>',

    'arrow-down':
      '<line x1="12" y1="5" x2="12" y2="19"/>' +
      '<polyline points="19 12 12 19 5 12"/>',
    bolt:
      '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',

    'check-circle':
      '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>' +
      '<polyline points="22 4 12 14.01 9 11.01"/>',

    currency:
      '<circle cx="12" cy="12" r="10"/>' +
      '<path d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8v1m0 8v1"/>',

    package:
      '<line x1="16.5" y1="9.4" x2="7.5" y2="4.21"/>' +
      '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>' +
      '<polyline points="3.27 6.96 12 12.01 20.73 6.96"/>' +
      '<line x1="12" y1="22.08" x2="12" y2="12"/>',

    'trending-down':
      '<polyline points="23 18 13.5 8.5 8.5 13.5 1 6"/>' +
      '<polyline points="17 18 23 18 23 12"/>',

    play:
      '<polygon points="5 3 19 12 5 21 5 3"/>',

    shield:
      '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  };

  // ── Brand asset paths (served from /assets/) ─────────────────────────────
  var BRAND_PATHS = {
    'monogram':            '/assets/icons/opscopilot-monogram.svg',
    'monogram-gradient':   '/assets/icons/opscopilot-monogram-gradient.svg',
    'mark-gradient':       '/assets/logo/opscopilot-mark-gradient.svg',
    'mark-white':          '/assets/logo/opscopilot-mark-white.svg',
    'mark-black':          '/assets/logo/opscopilot-mark-black.svg',
    'mark-teal':           '/assets/logo/opscopilot-mark-teal.svg',
    'mark-outline-light':  '/assets/logo/opscopilot-mark-outline-light.svg',
    'mark-outline-dark':   '/assets/logo/opscopilot-mark-outline-dark.svg',
    'mark-figma':          '/assets/logo/opscopilot-mark-figma.svg',
  };

  // ── Helpers ──────────────────────────────────────────────────────────────

  // Coerce size to a safe positive integer.
  function safeSize(size) {
    var n = parseInt(size, 10);
    return (n > 0 && n <= 512) ? n : DEFAULT_SIZE;
  }

  // Escape a string for use as an HTML attribute value.
  function escAttr(str) {
    return String(str)
      .replace(/&/g,  '&amp;')
      .replace(/"/g,  '&quot;')
      .replace(/</g,  '&lt;')
      .replace(/>/g,  '&gt;');
  }

  // Build the class attribute fragment (may be empty).
  function classAttr(className) {
    if (!className) return '';
    return ' class="' + escAttr(className) + '"';
  }

  // ── Core builders ────────────────────────────────────────────────────────

  function buildUIHtml(paths, size, className) {
    var px = safeSize(size);
    return '<svg xmlns="http://www.w3.org/2000/svg"' +
      ' width="' + px + '" height="' + px + '"' +
      ' viewBox="0 0 24 24"' +
      ' fill="none"' +
      ' stroke="currentColor"' +
      ' stroke-width="2"' +
      ' stroke-linecap="round"' +
      ' stroke-linejoin="round"' +
      classAttr(className) +
      ' aria-hidden="true"' +
      ' focusable="false">' +
      paths +
      '</svg>';
  }

  function buildBrandHtml(src, size, className) {
    var px = safeSize(size);
    return '<img src="' + escAttr(src) + '"' +
      ' width="' + px + '" height="' + px + '"' +
      classAttr(className) +
      ' alt=""' +
      ' aria-hidden="true"' +
      ' draggable="false">';
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Icon.html(name, opts?)
   * Returns an HTML string for the named icon.
   * Safe to inject via innerHTML in developer-controlled contexts ONLY
   * (icon names and options must not come from untrusted user input).
   *
   * @param {string} name
   * @param {{ size?: number, className?: string }} [opts]
   * @returns {string}
   */
  function html(name, opts) {
    opts = opts || {};
    var size      = opts.size;
    var className = opts.className;

    if (Object.prototype.hasOwnProperty.call(UI_PATHS, name)) {
      return buildUIHtml(UI_PATHS[name], size, className);
    }
    if (Object.prototype.hasOwnProperty.call(BRAND_PATHS, name)) {
      return buildBrandHtml(BRAND_PATHS[name], size, className);
    }
    // Unknown icon — return an empty, same-sized placeholder so layout holds.
    var px = safeSize(size);
    return '<span style="display:inline-block;width:' + px + 'px;height:' + px + 'px;"' +
      ' aria-hidden="true"></span>';
  }

  /**
   * Icon.el(name, opts?)
   * Returns a detached DOM element for the named icon.
   *
   * @param {string} name
   * @param {{ size?: number, className?: string }} [opts]
   * @returns {Element}
   */
  function el(name, opts) {
    var wrapper = document.createElement('span');
    wrapper.innerHTML = html(name, opts);
    return wrapper.firstChild;
  }

  /**
   * Icon.names()
   * Returns a sorted list of all registered icon names (useful for debugging).
   *
   * @returns {string[]}
   */
  function names() {
    return Object.keys(UI_PATHS).concat(Object.keys(BRAND_PATHS)).sort();
  }

  /**
   * Icon.init(root?)
   * Hydrates all [data-icon] elements under `root` (default: document).
   * Replace each <span data-icon="name" data-icon-size="N" data-icon-class="..."> with the
   * corresponding SVG or img element.
   *
   * @param {Document|Element} [root]
   */
  function init(root) {
    var scope = root || document;
    var nodes = scope.querySelectorAll('[data-icon]');
    for (var i = 0; i < nodes.length; i++) {
      var node  = nodes[i];
      var name  = node.getAttribute('data-icon');
      var size  = node.getAttribute('data-icon-size');
      var cls   = node.getAttribute('data-icon-class') || '';
      var opts  = {};
      if (size) opts.size = parseInt(size, 10);
      if (cls)  opts.className = cls;
      var svgEl = el(name, opts);
      if (svgEl && node.parentNode) node.parentNode.replaceChild(svgEl, node);
    }
  }

  // ── Register on window.App ────────────────────────────────────────────────
  App.Icon = { html: html, el: el, names: names, init: init };

  // Auto-hydrate data-icon elements when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { init(); });
  } else {
    init();
  }

}());

/*
 * ══ Usage examples ══════════════════════════════════════════════════════════
 *
 * 1. Inline in an existing button (HTML string):
 *      btn.innerHTML = App.Icon.html('upload', { size: 14 }) + ' Upload CSV';
 *
 * 2. Alert badge:
 *      badge.innerHTML = App.Icon.html('alert', { size: 14, className: 'icon-risk' });
 *
 * 3. Append a DOM node:
 *      cardHeader.appendChild(App.Icon.el('chart', { size: 20 }));
 *
 * 4. Brand mark in the nav:
 *      navLogo.appendChild(App.Icon.el('mark-gradient', { size: 36 }));
 *
 * 5. Monogram favicon/avatar:
 *      avatarEl.appendChild(App.Icon.el('monogram-gradient', { size: 32, className: 'rounded' }));
 *
 * 6. Swap a command-palette icon at runtime:
 *      item.querySelector('.icon-slot').innerHTML = App.Icon.html('history');
 *
 * 7. List every registered name (devtools):
 *      console.log(App.Icon.names());
 * ════════════════════════════════════════════════════════════════════════════
 */
