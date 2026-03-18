/* OpsCopilot-Lite — frontend bootstrap (modular architecture)
 *
 * This file initialises the application by loading all modules in the correct
 * dependency order via script tags in index.html.  Each module registers itself
 * on window.App.  This bootstrap wires the final cross-module calls:
 *
 * 1. stateStore.js      — shared state, DOM cache, utility functions
 * 2. resultsRenderer.js — analysis result rendering pipeline
 * 3. comparisonRenderer.js — run-to-run comparison panel
 * 4. aiHelpersUI.js     — premium AI helper drafts panel
 * 5. historyManager.js  — saved analysis run history
 * 6. exportManager.js   — CSV/PDF export and billing/plan UI
 * 7. authUI.js          — authentication modal wiring
 * 8. uploadController.js — file upload, sample-data, live-demo
 *
 * Security note: ALL user-supplied data from the CSV is written via
 * element.textContent, NEVER via innerHTML.
 */
(function () {
  'use strict';

  var App = window.App;

  // ── Fetch AI helper availability on page load ─────────────────────────────
  fetch('/api/ai-helper/types')
    .then(function (res) { return res.ok ? res.json() : null; })
    .then(function (data) {
      if (data && data.configured) App.state.aiHelpersAvailable = true;
    })
    .catch(function () { /* AI helpers not available — that is fine */ });

  // ── Daily activity signal (localStorage-only, always available) ────────────
  if (App.dailySignal) App.dailySignal.refresh();

  // ── Auth initialization ───────────────────────────────────────────────────
  // Waits for authModule.init() to resolve, then wires the onAuthChange
  // listener.  If Supabase is not configured, fetches plan anonymously.
  if (window.authModule) {
    window.authModule.init().then(function () {
      if (!window.authModule.isConfigured()) {
        // Auth not configured — fetch plan anonymously
        App.exportManager.fetchPlan();
        return;
      }
      window.authModule.onAuthChange(App.authUI.onAuthStateChanged);
      // Retrieve existing session on page load
      window.authModule.getSession().then(function (session) {
        App.authUI.onAuthStateChanged('INITIAL_SESSION', session);
      });
    });
  } else {
    // No auth module at all — fetch plan anonymously
    App.exportManager.fetchPlan();
  }
})();
