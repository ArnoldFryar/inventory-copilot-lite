/* procurementApp.js — Procurement Copilot page bootstrap.
 *
 * Lightweight initialiser for procurement pages.  Wires shared
 * functionality (icons, auth, support modal) and provides a namespace
 * for future procurement-specific modules.
 *
 * Dependencies (loaded before this script via <script> tags):
 *   - auth.js          (window.authModule)
 *   - Icon.js          (window.App.Icon)
 *   - supportModal.js  (data-support-trigger handling)
 */
(function () {
  'use strict';

  var App = window.App = window.App || {};

  // ── Namespace ─────────────────────────────────────────────────────────────
  App.procurement = App.procurement || {};

  // ── Icon hydration ────────────────────────────────────────────────────────
  // Icon.js auto-hydrates [data-icon] elements on DOMContentLoaded.
  // If this script runs after that event (unlikely but safe), trigger manually.
  if (document.readyState !== 'loading' && App.Icon && App.Icon.hydrateAll) {
    App.Icon.hydrateAll();
  }

  // ── Auth initialisation (shared pattern from script.js) ───────────────────
  function handleAuthState(_event, session) {
    var accountMenu = document.getElementById('accountMenu');
    var signInBtn   = document.getElementById('signInBtn');
    var emailEl     = document.getElementById('accountEmail');
    var initialEl   = document.getElementById('accountInitial');
    var dropEmail   = document.getElementById('accountDropdownEmail');

    if (session && session.user) {
      var email = session.user.email || '';
      if (accountMenu) accountMenu.classList.remove('hidden');
      if (signInBtn)   signInBtn.classList.add('hidden');
      if (emailEl)     emailEl.textContent = email;
      if (initialEl)   initialEl.textContent = email.charAt(0).toUpperCase();
      if (dropEmail)   dropEmail.textContent = email;
    } else {
      if (accountMenu) accountMenu.classList.add('hidden');
      if (signInBtn)   signInBtn.classList.remove('hidden');
    }
  }

  if (window.authModule) {
    window.authModule.init().then(function () {
      if (!window.authModule.isConfigured()) return;

      window.authModule.onAuthChange(handleAuthState);

      window.authModule.getSession().then(function (session) {
        handleAuthState('INITIAL_SESSION', session);
      });
    });
  }

  // ── Account dropdown toggle ───────────────────────────────────────────────
  var avatarBtn = document.getElementById('accountAvatarBtn');
  var dropdown  = document.getElementById('accountDropdown');
  if (avatarBtn && dropdown) {
    avatarBtn.addEventListener('click', function () {
      var open = !dropdown.classList.contains('hidden');
      dropdown.classList.toggle('hidden', open);
      avatarBtn.setAttribute('aria-expanded', String(!open));
    });
    document.addEventListener('click', function (e) {
      if (!avatarBtn.contains(e.target) && !dropdown.contains(e.target)) {
        dropdown.classList.add('hidden');
        avatarBtn.setAttribute('aria-expanded', 'false');
      }
    });
  }

  // ── Sign-in redirect (auth modal lives on index.html) ─────────────────────
  var signInBtn = document.getElementById('signInBtn');
  if (signInBtn) {
    signInBtn.addEventListener('click', function () {
      window.location.href = '/?signin=1';
    });
  }

  // ── Sign-out wiring ───────────────────────────────────────────────────────
  var signOutBtn = document.getElementById('signOutBtn');
  if (signOutBtn && window.authModule) {
    signOutBtn.addEventListener('click', function () {
      window.authModule.signOut().then(function () {
        window.location.href = '/';
      });
    });
  }
})();
