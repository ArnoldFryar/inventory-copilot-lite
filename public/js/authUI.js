/* authUI.js — authentication modal, sign-in/sign-up/sign-out wiring. */
(function () {
  'use strict';

  var App   = window.App;
  var dom   = App.dom;
  var state = App.state;
  var DEFAULT_AUTH_HINT = 'Sign in to access your saved runs and Pro features.';
  const forgot = document.getElementById('authForgot');
  const emailLabel = dom.authForm.querySelector('[for=authEmail]');
  const passwordLabel = dom.authForm.querySelector('[for=authPassword]');
  const toggleRow = dom.authToggleBtn.closest('p');
  const labels = { signin: 'Sign in', signup: 'Create account', reset: 'Send reset link', recovery: 'Update password' };

  function feedback(message, success) {
    dom.authError.textContent = message;
    dom.authError.classList.toggle('auth-success', Boolean(success));
    dom.authError.classList.toggle('hidden', !message);
    dom.authError.setAttribute('role', success ? 'status' : 'alert');
    dom.authEmail.setAttribute('aria-describedby', 'authError');
    dom.authPassword.setAttribute('aria-describedby', 'authError');
  }

  // ── Open auth modal ───────────────────────────────────────────────────────
  dom.signInBtn.addEventListener('click', function () {
    openAuthModal('signin');
  });

  // ── Close auth modal ──────────────────────────────────────────────────────
  dom.authModalClose.addEventListener('click', closeAuthModal);
  dom.authModal.addEventListener('click', function (e) {
    if (e.target === dom.authModal) closeAuthModal();
  });
  dom.authModal.addEventListener('keydown', function (e) {
    App.modalManager.handleKeydown(e, dom.authModal, closeAuthModal);
  });

  function closeAuthModal() {
    App.modalManager.close(dom.authModal);
    dom.authError.classList.add('hidden');
    if (dom.authModalHint) {
      dom.authModalHint.textContent = DEFAULT_AUTH_HINT;
      dom.authModalHint.removeAttribute('data-contextual');
    }
    dom.authForm.reset();
  }

  // ── Toggle between sign in / sign up ──────────────────────────────────────
  dom.authToggleBtn.addEventListener('click', function () {
    setAuthMode(state.authMode === 'signin' ? 'signup' : 'signin');
    dom.authModalHint.textContent = DEFAULT_AUTH_HINT;
  });

  function setAuthMode(mode) {
    state.authMode = mode;
    dom.authModalTitle.textContent = labels[mode];
    dom.authSubmitBtn.textContent = labels[mode];
    dom.authToggleText.textContent = mode === 'signin' ? 'No account?' : 'Back to your account';
    dom.authToggleBtn.textContent = mode === 'signin' ? 'Create one' : 'Sign in';
    dom.authEmail.required = mode !== 'recovery';
    dom.authEmail.classList.toggle('hidden', mode === 'recovery');
    emailLabel.classList.toggle('hidden', mode === 'recovery');
    dom.authPassword.required = mode !== 'reset';
    dom.authPassword.classList.toggle('hidden', mode === 'reset');
    passwordLabel.classList.toggle('hidden', mode === 'reset');
    forgot.classList.toggle('hidden', mode !== 'signin');
    toggleRow.classList.toggle('hidden', mode === 'recovery');
    dom.authPassword.setAttribute('autocomplete', ['signup', 'recovery'].includes(mode) ? 'new-password' : 'current-password');
    feedback('', false);
  }

  forgot.addEventListener('click', function () {
    setAuthMode('reset');
    dom.authModalHint.textContent = 'Enter your account email to receive a password reset link.';
    dom.authEmail.focus();
  });

  function openAuthModal(mode, options) {
    options = options || {};
    setAuthMode(mode || 'signin');
    if (dom.authModalHint) {
      dom.authModalHint.textContent = options.hint || DEFAULT_AUTH_HINT;
      if (options.hint) dom.authModalHint.setAttribute('data-contextual', 'true');
      else dom.authModalHint.removeAttribute('data-contextual');
    }
    App.modalManager.open(dom.authModal, mode === 'recovery' ? dom.authPassword : dom.authEmail);
  }

  // ── Submit auth form ──────────────────────────────────────────────────────
  dom.authForm.addEventListener('submit', async function (e) {
    e.preventDefault();
    const mode = state.authMode;
    feedback('', false);
    dom.authSubmitBtn.disabled = true;
    dom.authSubmitBtn.textContent = 'Working…';

    try {
      if (mode === 'reset') {
        await window.authModule.resetPassword(dom.authEmail.value);
        feedback('Check your inbox for the password reset link.', true);
        return;
      }
      if (mode === 'recovery') {
        await window.authModule.updatePassword(dom.authPassword.value);
        closeAuthModal();
        history.replaceState(null, '', window.location.pathname);
        return;
      }
      if (mode === 'signup') {
        const result = await window.authModule.signUp(dom.authEmail.value, dom.authPassword.value);
        if (!result.session) {
          feedback('Check your inbox to confirm your email and activate your account.', true);
          return;
        }
      } else await window.authModule.signIn(dom.authEmail.value, dom.authPassword.value);
      closeAuthModal();
    } catch (err) {
      feedback(err.message || 'Account request failed. Please try again.', false);
    } finally {
      dom.authSubmitBtn.disabled = false;
      dom.authSubmitBtn.textContent = labels[state.authMode];
      if (!dom.authModal.classList.contains('hidden') && !dom.authModal.contains(document.activeElement)) {
        dom.authSubmitBtn.focus();
      }
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
  function onAuthStateChanged(event, session) {
    const previous = state.currentUser?.id;
    state.currentUser = session?.user || null;
    if (previous !== state.currentUser?.id) {
      state.currentPlan = null;
      if (previous) {
        App.hideResults();
        App.resetInventoryUpload?.();
      }
    }
    updateAccountUI();
    if (event === 'PASSWORD_RECOVERY') {
      openAuthModal('recovery', { hint: 'Choose a new password for your account.' });
    }
    if (previous !== state.currentUser?.id || event === 'INITIAL_SESSION') {
      App.historyManager.refreshHistory();
      setTimeout(App.exportManager.fetchPlan, 0);
    }
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
    } else {
      dom.accountMenu.classList.add('hidden');
      dom.signInBtn.classList.remove('hidden');
      closeAccountDropdown();
      if (dom.saveRunBtn) dom.saveRunBtn.classList.add('hidden');
      // Auto-open sign-in modal when redirected from another page
      var params = new URLSearchParams(window.location.search);
      if (params.get('signin') === '1') {
        openAuthModal('signin');
        history.replaceState(null, '', window.location.pathname);
      }
    }
  }

  App.authUI = {
    onAuthStateChanged: onAuthStateChanged,
    updateAccountUI:    updateAccountUI,
    openAuthModal:      openAuthModal,
  };
})();
