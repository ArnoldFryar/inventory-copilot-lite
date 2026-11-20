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
  var activeDialog = null;

  var supportCopy = {
    title: 'Contact Support',
    subtitle: 'We\u2019ll get back to you within one business day.',
    messageLabel: 'Message',
    submitLabel: 'Send message',
    successTitle: 'Message sent!',
  };
  var inquiryCopy = {
    'guided-review': {
      title: 'Request a guided review',
      subject: 'OpsCopilot guided review request',
      subtitle: 'Tell us what your materials team reviews today. We\u2019ll email you to arrange a walkthrough.',
      messageLabel: 'Company and what you\u2019d like to review',
      submitLabel: 'Send review request',
      successTitle: 'Review request sent',
    },
    'plant-pilot': {
      title: 'Ask about the plant pilot',
      subject: 'OpsCopilot plant pilot inquiry',
      subtitle: 'Tell us about your site and the inventory or purchasing workflow you want to improve.',
      messageLabel: 'Company, site, and what you\u2019d like to improve',
      submitLabel: 'Send pilot inquiry',
      successTitle: 'Pilot inquiry sent',
    },
  };

  // ── Modal HTML (injected once into <body>) ────────────────────────────────
  var MODAL_HTML = [
    '<div id="supportOverlay" class="support-overlay" role="dialog" aria-modal="true" aria-labelledby="supportTitle" aria-describedby="supportSubtitle" aria-hidden="true" inert>',
    '  <div class="support-panel">',

    '    <!-- Header -->',
    '    <div class="support-header">',
    '      <h2 id="supportTitle" class="support-title">Contact Support</h2>',
    '      <button id="supportCloseBtn" class="support-close-btn" type="button" aria-label="Close">&times;</button>',
    '    </div>',

    '    <!-- Form view -->',
    '    <div id="supportFormView" class="support-body">',
    '      <p id="supportSubtitle" class="support-subtitle"></p>',
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
    '        <div id="supportSubjectField" class="support-field">',
    '          <label for="supportSubject" class="support-label">Subject</label>',
    '          <input id="supportSubject" name="subject" type="text" class="support-input" maxlength="200" required />',
    '        </div>',
    '        <div class="support-field">',
    '          <label id="supportMessageLabel" for="supportMessage" class="support-label">Message</label>',
    '          <textarea id="supportMessage" name="message" class="support-textarea" maxlength="4000" rows="5" required></textarea>',
    '        </div>',
    '        <div id="supportError" class="support-error hidden" role="alert"></div>',
    '        <div class="support-footer">',
    '          <button type="button" id="supportCancelBtn" class="support-cancel-btn">Cancel</button>',
    '          <button type="submit" id="supportSubmitBtn" class="support-submit-btn">Send message</button>',
    '        </div>',
    '      </form>',
    '    </div>',

    '    <!-- Success view -->',
    '    <div id="supportSuccessView" class="support-success hidden">',
    '      <span class="support-success-icon" aria-hidden="true">\u2705</span>',
    '      <h3 id="supportSuccessTitle">Message sent!</h3>',
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

  function resetForm(copy) {
    document.getElementById('supportForm').reset();
    document.getElementById('supportTitle').textContent = copy.title;
    document.getElementById('supportSubtitle').textContent = copy.subtitle;
    document.getElementById('supportSubjectField').hidden = Boolean(copy.subject);
    document.getElementById('supportSubject').value = copy.subject || '';
    document.getElementById('supportMessageLabel').textContent = copy.messageLabel;
    document.getElementById('supportSuccessTitle').textContent = copy.successTitle;
    var submitBtn = document.getElementById('supportSubmitBtn');
    submitBtn.disabled = false;
    submitBtn.textContent = copy.submitLabel;
    setError('');
    showView('form');
  }

  // ── Open ─────────────────────────────────────────────────────────────────
  function open(trigger) {
    inject();
    var source = trigger && typeof trigger.getAttribute === 'function' ? trigger : document.activeElement;
    var mode = source && source.getAttribute('data-support-trigger');
    var copy = Object.prototype.hasOwnProperty.call(inquiryCopy, mode) ? inquiryCopy[mode] : supportCopy;
    var dialog = { copy: copy, trigger: source };
    activeDialog = dialog;
    resetForm(copy);

    // Auto-fill email when signed in to the app
    var emailInput = document.getElementById('supportEmail');
    if (emailInput && !emailInput.value) {
      var appUser = window.App && window.App.state && window.App.state.currentUser;
      if (appUser && appUser.email) emailInput.value = appUser.email;
    }

    var overlay = getOverlay();
    overlay.classList.add('is-open');
    overlay.removeAttribute('aria-hidden');
    overlay.removeAttribute('inert');

    // Focus first empty field
    setTimeout(function () {
      if (activeDialog === dialog) document.getElementById('supportName').focus();
    }, 60);
  }

  // ── Close ─────────────────────────────────────────────────────────────────
  function close() {
    var overlay = getOverlay();
    if (!overlay || !activeDialog) return;
    var trigger = activeDialog.trigger;
    activeDialog = null;
    overlay.classList.remove('is-open');
    overlay.setAttribute('aria-hidden', 'true');
    overlay.setAttribute('inert', '');
    if (trigger && trigger.isConnected) trigger.focus();
  }

  // ── Submit ────────────────────────────────────────────────────────────────
  function submitForm() {
    var dialog = activeDialog;
    var submitBtn = document.getElementById('supportSubmitBtn');
    if (!dialog || submitBtn.disabled) return;
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
    submitBtn.disabled    = true;
    submitBtn.textContent = 'Sending\u2026';

    var metadata = { pageUrl: window.location.href };
    var appUser  = window.App && window.App.state && window.App.state.currentUser;
    if (appUser && appUser.email) metadata.userEmail = appUser.email;

    var url = '/api/support';
    console.debug('[support] submit start \u2192', url);
    var sent = false;

    var controller = new AbortController();
    var fetchTimeout = setTimeout(function () { controller.abort(); }, 20000);

    fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ name: name, email: email, subject: subject, message: message, metadata: metadata }),
      signal:  controller.signal,
    })
    .then(function (res) {
      console.debug('[support] response status:', res.status, res.statusText);
      return res.text().then(function (raw) {
        console.debug('[support] response body:', raw.slice(0, 300));
        var data;
        try { data = JSON.parse(raw); } catch (_) { data = { error: 'Server returned an invalid response (status ' + res.status + ').' }; }
        return { ok: res.ok, data: data };
      });
    })
    .then(function (result) {
      if (activeDialog !== dialog) return;
      if (result.ok && result.data && result.data.ok) {
        console.debug('[support] success');
        sent = true;
        showView('success');
        document.getElementById('supportSuccessDone').focus();
      } else {
        var msg = (result.data && result.data.error) || 'Something went wrong. Please try again.';
        console.warn('[support] server error:', msg);
        setError(msg);
      }
    })
    .catch(function (err) {
      if (activeDialog !== dialog) return;
      console.error('[support] fetch error:', err);
      if (err.name === 'AbortError') {
        setError('Request timed out. Please try again.');
      } else {
        setError('Network error. Please check your connection and try again.');
      }
    })
    .finally(function () {
      clearTimeout(fetchTimeout);
      if (activeDialog === dialog && !sent) {
        submitBtn.disabled    = false;
        submitBtn.textContent = dialog.copy.submitLabel;
      }
    });
  }

  // ── Wire [data-support-trigger] elements (both pages) ────────────────────
  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('[data-support-trigger]').forEach(function (el) {
      el.addEventListener('click', function (e) {
        e.preventDefault();
        open(el);
      });
    });
  });

  // ── Public API ────────────────────────────────────────────────────────────
  window.SupportModal = { open: open, close: close };
}());
