/* authUI.js — authentication modal, sign-in/sign-up/sign-out wiring. */
(function () {
  'use strict';

  var App   = window.App;
  var dom   = App.dom;
  var state = App.state;

  // ── Open auth modal ───────────────────────────────────────────────────────
  dom.signInBtn.addEventListener('click', function () {
    setAuthMode('signin');
    dom.authModal.classList.remove('hidden');
    dom.authEmail.focus();
  });

  // ── Close auth modal ──────────────────────────────────────────────────────
  dom.authModalClose.addEventListener('click', closeAuthModal);
  dom.authModal.addEventListener('click', function (e) {
    if (e.target === dom.authModal) closeAuthModal();
  });

  function closeAuthModal() {
    dom.authModal.classList.add('hidden');
    dom.authError.classList.add('hidden');
    dom.authForm.reset();
  }

  // ── Toggle between sign in / sign up ──────────────────────────────────────
  dom.authToggleBtn.addEventListener('click', function () {
    setAuthMode(state.authMode === 'signin' ? 'signup' : 'signin');
  });

  function setAuthMode(mode) {
    state.authMode = mode;
    if (mode === 'signup') {
      dom.authModalTitle.textContent = 'Create account';
      dom.authSubmitBtn.textContent = 'Create account';
      dom.authToggleText.textContent = 'Already have an account?';
      dom.authToggleBtn.textContent = 'Sign in';
      dom.authPassword.setAttribute('autocomplete', 'new-password');
    } else {
      dom.authModalTitle.textContent = 'Sign in';
      dom.authSubmitBtn.textContent = 'Sign in';
      dom.authToggleText.textContent = 'No account?';
      dom.authToggleBtn.textContent = 'Create one';
      dom.authPassword.setAttribute('autocomplete', 'current-password');
    }
    dom.authError.classList.add('hidden');
  }

  // ── Submit auth form ──────────────────────────────────────────────────────
  dom.authForm.addEventListener('submit', async function (e) {
    e.preventDefault();
    dom.authError.classList.add('hidden');
    dom.authSubmitBtn.disabled = true;
    dom.authSubmitBtn.textContent = state.authMode === 'signup' ? 'Creating\u2026' : 'Signing in\u2026';

    try {
      if (state.authMode === 'signup') {
        await window.authModule.signUp(dom.authEmail.value, dom.authPassword.value);
      } else {
        await window.authModule.signIn(dom.authEmail.value, dom.authPassword.value);
      }
      closeAuthModal();
    } catch (err) {
      dom.authError.textContent = err.message || 'Authentication failed.';
      dom.authError.classList.remove('hidden');
    } finally {
      dom.authSubmitBtn.disabled = false;
      setAuthMode(state.authMode);
    }
  });

  // ── Sign out ──────────────────────────────────────────────────────────────
  dom.signOutBtn.addEventListener('click', async function () {
    await window.authModule.signOut();
    closeAccountDropdown();
  });

  // ── Account avatar dropdown ───────────────────────────────────────────────
  dom.accountAvatarBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    var isOpen = !dom.accountDropdown.classList.contains('hidden');
    if (isOpen) {
      closeAccountDropdown();
    } else {
      dom.accountDropdown.classList.remove('hidden');
      dom.accountAvatarBtn.setAttribute('aria-expanded', 'true');
    }
  });

  function closeAccountDropdown() {
    dom.accountDropdown.classList.add('hidden');
    dom.accountAvatarBtn.setAttribute('aria-expanded', 'false');
  }

  // Close dropdown when clicking outside
  document.addEventListener('click', function (e) {
    if (!dom.accountDropdown.classList.contains('hidden') &&
        !dom.accountDropdown.contains(e.target) &&
        e.target !== dom.accountAvatarBtn &&
        !dom.accountAvatarBtn.contains(e.target)) {
      closeAccountDropdown();
    }
  });

  // Close dropdown on Escape
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeAccountDropdown();
  });

  // ── Auth state change handler ─────────────────────────────────────────────
  function onAuthStateChanged(_event, session) {
    state.currentUser = session?.user || null;
    if (state.currentUser) {
      window.authModule.fetchProfile(state.currentUser.id).then(function (profile) {
        state.currentProfile = profile;
      });
    } else {
      state.currentProfile = null;
    }
    updateAccountUI();
    App.historyManager.refreshHistory();
    // Re-fetch plan to get per-user subscription state
    App.exportManager.fetchPlan();
  }

  function getInitial(email) {
    if (!email) return '?';
    return email.charAt(0).toUpperCase();
  }

  function updateAccountUI() {
    if (!window.authModule || !window.authModule.isConfigured()) {
      dom.accountMenu.classList.add('hidden');
      dom.signInBtn.classList.add('hidden');
      return;
    }
    if (state.currentUser) {
      var email = state.currentUser.email || 'Account';
      dom.accountEmail.textContent = email;
      dom.accountDropdownEmail.textContent = email;
      dom.accountInitial.textContent = getInitial(email);
      dom.accountMenu.classList.remove('hidden');
      dom.signInBtn.classList.add('hidden');
      closeAccountDropdown();
      if (dom.saveRunBtn && state.lastResponse) {
        var canSaveHistory = state.currentPlan && state.currentPlan.entitlements.savedHistory;
        if (canSaveHistory) dom.saveRunBtn.classList.remove('hidden');
      }
    } else {
      dom.accountMenu.classList.add('hidden');
      dom.signInBtn.classList.remove('hidden');
      closeAccountDropdown();
      if (dom.saveRunBtn) dom.saveRunBtn.classList.add('hidden');
    }
  }

  App.authUI = {
    onAuthStateChanged: onAuthStateChanged,
    updateAccountUI:    updateAccountUI,
  };
})();
