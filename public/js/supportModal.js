/* supportModal.js — Contact Support modal.
 *
 * Works on both ops.html (landing page) and index.html (app).
 * Injects the modal DOM lazily on first open.
 * Entry points: any element with [data-support-trigger] attribute.
 *
 * Public API: window.SupportModal.open() / .close()
 */
(function () {
  'use strict';

  var MODAL_ID  = 'supportOverlay';
  var _injected = false;

  // ── Modal HTML (injected once into <body>) ────────────────────────────────
  var MODAL_HTML = [
    '<div id="supportOverlay" class="support-overlay" role="dialog" aria-modal="true" aria-labelledby="supportTitle" aria-hidden="true">',
    '  <div class="support-panel">',

    '    <!-- Header -->',
    '    <div class="support-header">',
    '      <h2 id="supportTitle" class="support-title">Contact Support</h2>',
    '      <button id="supportCloseBtn" class="support-close-btn" type="button" aria-label="Close">&times;</button>',
    '    </div>',

    '    <!-- Form view -->',
    '    <div id="supportFormView" class="support-body">',
    '      <p class="support-subtitle">We\u2019ll get back to you within one business day.</p>',
    '      <form id="supportForm" class="support-form" novalidate>',
    '        <div class="support-row">',
    '          <div class="support-field">',
    '            <label for="supportName" class="support-label">Name</label>',
    '            <input id="supportName" name="name" type="text" class="support-input" autocomplete="name" maxlength="120" required />',
    '          </div>',
    '          <div class="support-field">',
    '            <label for="supportEmail" class="support-label">Email</label>',
    '            <input id="supportEmail" name="email" type="email" class="support-input" autocomplete="email" maxlength="254" required />',
    '          </div>',
    '        </div>',
    '        <div class="support-field">',
    '          <label for="supportSubject" class="support-label">Subject</label>',
    '          <input id="supportSubject" name="subject" type="text" class="support-input" maxlength="200" required />',
    '        </div>',
    '        <div class="support-field">',
    '          <label for="supportMessage" class="support-label">Message</label>',
    '          <textarea id="supportMessage" name="message" class="support-textarea" maxlength="4000" rows="5" required></textarea>',
    '        </div>',
    '        <div id="supportError" class="support-error hidden"></div>',
    '        <div class="support-footer">',
    '          <button type="button" id="supportCancelBtn" class="support-cancel-btn">Cancel</button>',
    '          <button type="submit" id="supportSubmitBtn" class="support-submit-btn">Send message</button>',
    '        </div>',
    '      </form>',
    '    </div>',

    '    <!-- Success view -->',
    '    <div id="supportSuccessView" class="support-success hidden">',
    '      <span class="support-success-icon" aria-hidden="true">\u2705</span>',
    '      <h3>Message sent!</h3>',
    '      <p>Thanks for reaching out. We\u2019ll reply to your email address as soon as possible.</p>',
    '      <button type="button" id="supportSuccessDone" class="support-success-close">Done</button>',
    '    </div>',

    '  </div>',
    '</div>',
  ].join('\n');

  // ── Inject DOM ────────────────────────────────────────────────────────────
  function inject() {
    if (_injected) return;
    var div = document.createElement('div');
    div.innerHTML = MODAL_HTML;
    document.body.appendChild(div.firstElementChild);
    _injected = true;

    var overlay = getOverlay();

    // Backdrop click
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) close();
    });

    // Buttons
    document.getElementById('supportCloseBtn').addEventListener('click', close);
    document.getElementById('supportCancelBtn').addEventListener('click', close);
    document.getElementById('supportSuccessDone').addEventListener('click', close);

    // Escape key
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && getOverlay().classList.contains('is-open')) close();
    });

    // Form submit
    document.getElementById('supportForm').addEventListener('submit', function (e) {
      e.preventDefault();
      submitForm();
    });
  }

  // ── Helpers ──────────────────────────────────────────────────────────────
  function getOverlay() {
    return document.getElementById(MODAL_ID);
  }

  function showView(view) {
    var formView    = document.getElementById('supportFormView');
    var successView = document.getElementById('supportSuccessView');
    if (!formView || !successView) return;
    if (view === 'success') {
      formView.classList.add('hidden');
      successView.classList.remove('hidden');
    } else {
      formView.classList.remove('hidden');
      successView.classList.add('hidden');
    }
  }

  function setError(msg) {
    var el = document.getElementById('supportError');
    if (!el) return;
    if (msg) {
      el.textContent = msg;
      el.classList.remove('hidden');
    } else {
      el.textContent = '';
      el.classList.add('hidden');
    }
  }

  function resetForm() {
    var form      = document.getElementById('supportForm');
    var submitBtn = document.getElementById('supportSubmitBtn');
    if (form)      form.reset();
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Send message'; }
    setError('');
    showView('form');
  }

  // ── Open ─────────────────────────────────────────────────────────────────
  function open() {
    inject();
    resetForm();

    // Auto-fill email when signed in to the app
    var emailInput = document.getElementById('supportEmail');
    if (emailInput && !emailInput.value) {
      var appUser = window.App && window.App.state && window.App.state.currentUser;
      if (appUser && appUser.email) emailInput.value = appUser.email;
    }

    var overlay = getOverlay();
    overlay.classList.add('is-open');
    overlay.removeAttribute('aria-hidden');

    // Focus first empty field
    setTimeout(function () {
      var name = document.getElementById('supportName');
      var subj = document.getElementById('supportSubject');
      if (name && !name.value) { name.focus(); }
      else if (subj)           { subj.focus(); }
    }, 60);
  }

  // ── Close ─────────────────────────────────────────────────────────────────
  function close() {
    var overlay = getOverlay();
    if (!overlay) return;
    overlay.classList.remove('is-open');
    overlay.setAttribute('aria-hidden', 'true');
  }

  // ── Submit ────────────────────────────────────────────────────────────────
  function submitForm() {
    var name    = (document.getElementById('supportName').value    || '').trim();
    var email   = (document.getElementById('supportEmail').value   || '').trim();
    var subject = (document.getElementById('supportSubject').value || '').trim();
    var message = (document.getElementById('supportMessage').value || '').trim();

    if (!name || !email || !subject || !message) {
      setError('Please fill in all fields.');
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError('Please enter a valid email address.');
      return;
    }

    setError('');
    var submitBtn = document.getElementById('supportSubmitBtn');
    submitBtn.disabled    = true;
    submitBtn.textContent = 'Sending\u2026';

    var metadata = { pageUrl: window.location.href };
    var appUser  = window.App && window.App.state && window.App.state.currentUser;
    if (appUser && appUser.email) metadata.userEmail = appUser.email;

    fetch('/api/support', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ name: name, email: email, subject: subject, message: message, metadata: metadata }),
    })
    .then(function (res) {
      return res.json().then(function (data) { return { ok: res.ok, data: data }; });
    })
    .then(function (result) {
      if (result.ok && result.data.ok) {
        showView('success');
      } else {
        submitBtn.disabled    = false;
        submitBtn.textContent = 'Send message';
        setError(result.data.error || 'Something went wrong. Please try again.');
      }
    })
    .catch(function () {
      submitBtn.disabled    = false;
      submitBtn.textContent = 'Send message';
      setError('Network error. Please check your connection and try again.');
    });
  }

  // ── Wire [data-support-trigger] elements (both pages) ────────────────────
  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('[data-support-trigger]').forEach(function (el) {
      el.addEventListener('click', function (e) {
        e.preventDefault();
        open();
      });
    });
  });

  // ── Public API ────────────────────────────────────────────────────────────
  window.SupportModal = { open: open, close: close };
}());
