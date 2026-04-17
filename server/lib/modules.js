'use strict';

// ---------------------------------------------------------------------------
// modules.js — Centralised module registry.
//
// Every OpsCopilot product module (Inventory, Procurement, …) is declared
// here.  The registry drives sidebar navigation, route mounting, and
// feature-flag checks across the app.
//
// To add a new module:
//   1. Add an entry to MODULES below.
//   2. Create its page shell in public/<slug>.html
//   3. Create its route file in server/routes/<slug>.js (optional)
//   4. Navigation is auto-generated from this registry.
// ---------------------------------------------------------------------------

const MODULES = {
  inventory: {
    key:         'inventory',
    name:        'Inventory',
    shortName:   'Inventory Suite',
    icon:        'summary',
    path:        '/',                           // index.html — the original app page
    enabled:     true,
    description: 'Triage inventory risk, excess, and dead stock from ERP exports.',
    subPages: [
      { key: 'triage',  name: 'Triage',      path: '/',                icon: 'summary' },
      { key: 'history', name: 'History',      path: '#historySection',  icon: 'history' },
      { key: 'ai',      name: 'AI Helpers',   path: '#aiHelpersSection', icon: 'ai', badge: 'Pro' },
    ],
  },
  procurement: {
    key:         'procurement',
    name:        'Procurement Copilot',
    shortName:   'Procurement',
    icon:        'package',
    path:        '/procurement',
    enabled:     true,
    badge:       'New',
    description: 'Analyse purchase orders and supplier performance.',
    subPages: [
      { key: 'overview',  name: 'Overview',    path: '/procurement',           icon: 'dashboard' },
      { key: 'upload',    name: 'Upload POs',  path: '/procurement/upload',    icon: 'upload' },
    ],
  },
  pfep: {
    key:         'pfep',
    name:        'PFEP Register',
    shortName:   'PFEP',
    icon:        'list',
    path:        '/pfep',
    enabled:     true,
    badge:       'New',
    description: 'Manage your Plan For Every Part register — replenishment parameters, lead times, and supplier data for every SKU.',
    subPages: [
      { key: 'register', name: 'Register',    path: '/pfep',         icon: 'summary' },
      { key: 'upload',   name: 'Import PFEP', path: '/pfep/upload',  icon: 'upload' },
    ],
  },
};

/**
 * Returns an array of all enabled modules (insertion-order stable).
 * Each module object includes its key.
 */
function getEnabledModules() {
  return Object.values(MODULES).filter(function (m) { return m.enabled; });
}

/**
 * Look up a single module by key.  Returns undefined if not found.
 */
function getModule(key) {
  return MODULES[key] || undefined;
}

module.exports = { MODULES, getEnabledModules, getModule };
