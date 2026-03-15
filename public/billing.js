/* OpsCopilot-Lite — Billing Dashboard client logic
 *
 * Fetches the user's plan from GET /api/user/plan and renders the billing UI.
 * Handles Stripe Checkout and Customer Portal redirects.
 * Relies on auth.js (shared with the main app) for session management.
 */

(function () {
  'use strict';

  // ── DOM refs ────────────────────────────────────────────────────────
  var $loading    = document.getElementById('billingLoading');
  var $error      = document.getElementById('billingError');
  var $errorMsg   = document.getElementById('billingErrorMsg');
  var $success    = document.getElementById('billingSuccess');
  var $successMsg = document.getElementById('billingSuccessMsg');
  var $content    = document.getElementById('billingContent');

  var $planLabel  = document.getElementById('planLabel');
  var $statusBadge = document.getElementById('statusBadge');
  var $planMessage = document.getElementById('planMessage');
  var $renewalInfo = document.getElementById('renewalInfo');

  var $upgradeBtn  = document.getElementById('upgradeBtn');
  var $manageBtn   = document.getElementById('manageBtn');
  var $actionSpinner = document.getElementById('actionSpinner');

  var $accountMenu = document.getElementById('accountMenu');
  var $accountEmail = document.getElementById('accountEmail');
  var $signOutBtn  = document.getElementById('signOutBtn');
  var $signInBtn   = document.getElementById('signInBtn');

  // ── State ───────────────────────────────────────────────────────────
  var _redirecting = false;

  // ── Helpers ─────────────────────────────────────────────────────────
  function show(el) { el.classList.remove('hidden'); }
  function hide(el) { el.classList.add('hidden'); }

  function showError(msg) {
    $errorMsg.textContent = msg;
    show($error);
  }

  function formatDate(iso) {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleDateString(undefined, {
        year: 'numeric', month: 'long', day: 'numeric'
      });
    } catch (_) {
      return iso;
    }
  }

  // ── Auth helpers ────────────────────────────────────────────────────
  async function getAuthHeaders() {
    if (!window.authModule || !window.authModule.isConfigured()) return null;
    var token = await window.authModule.getToken();
    if (!token) return null;
    return { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  }

  // ── Render plan state ──────────────────────────────────────────────
  function renderPlan(data) {
    var plan   = data.plan || 'free';
    var status = data.subscriptionStatus || 'inactive';
    var end    = data.currentPeriodEnd || null;

    // Plan label
    $planLabel.textContent = plan === 'pro' ? 'Pro' : 'Free';

    // Status badge
    $statusBadge.textContent = status;
    $statusBadge.className = 'billing-status-badge billing-status--' + status;

    // Plan message
    var messages = {
      'free|inactive':  'You are currently using the Free plan.',
      'free|canceled':  'Your Pro subscription has been canceled. You are now on the Free plan.',
      'pro|active':     'Your Pro subscription is active.',
      'pro|canceled':   'Your Pro plan will end at the end of the billing period.',
      'free|past_due':  'Your payment is past due. Please update your payment method.',
      'pro|past_due':   'Your payment is past due. Please update your payment method.'
    };
    var key = plan + '|' + status;
    $planMessage.textContent = messages[key] || 'You are on the ' + plan.charAt(0).toUpperCase() + plan.slice(1) + ' plan.';

    // Renewal info
    if (end && (status === 'active' || status === 'canceled')) {
      var label = status === 'active' ? 'Renews' : 'Access ends';
      $renewalInfo.textContent = label + ': ' + formatDate(end);
      show($renewalInfo);
    } else {
      hide($renewalInfo);
    }

    // Action buttons
    if (plan === 'pro' && status === 'active') {
      hide($upgradeBtn);
      show($manageBtn);
    } else if (plan === 'pro' && status === 'canceled') {
      hide($upgradeBtn);
      show($manageBtn);
    } else {
      show($upgradeBtn);
      hide($manageBtn);
    }

    // Show content
    hide($loading);
    show($content);
  }

  // ── Fetch billing data ─────────────────────────────────────────────
  async function loadBillingData() {
    var headers = await getAuthHeaders();
    if (!headers) {
      hide($loading);
      showError('Please sign in to view your billing information.');
      show($signInBtn);
      return;
    }

    try {
      var res = await fetch('/api/user/plan', { headers: headers });
      if (res.status === 401) {
        hide($loading);
        showError('Your session has expired. Please sign in again.');
        show($signInBtn);
        return;
      }
      if (!res.ok) {
        var errBody = await res.json().catch(function () { return {}; });
        throw new Error(errBody.error || 'Failed to load billing data.');
      }
      var data = await res.json();
      renderPlan(data);
    } catch (err) {
      hide($loading);
      showError(err.message || 'Could not load billing information.');
    }
  }

  // ── Stripe Checkout (upgrade) ──────────────────────────────────────
  async function handleUpgrade() {
    if (_redirecting) return;
    _redirecting = true;
    $upgradeBtn.disabled = true;
    show($actionSpinner);

    try {
      var headers = await getAuthHeaders();
      if (!headers) throw new Error('Not authenticated.');

      var res = await fetch('/api/billing/create-checkout-session', {
        method: 'POST',
        headers: headers
      });

      if (!res.ok) {
        var body = await res.json().catch(function () { return {}; });
        throw new Error(body.error || 'Could not start checkout.');
      }

      var data = await res.json();
      if (data.url) {
        window.location.href = data.url;
        return; // page will navigate away
      }
      throw new Error('No checkout URL returned.');
    } catch (err) {
      _redirecting = false;
      $upgradeBtn.disabled = false;
      hide($actionSpinner);
      showError(err.message);
    }
  }

  // ── Stripe Portal (manage) ─────────────────────────────────────────
  async function handleManage() {
    if (_redirecting) return;
    _redirecting = true;
    $manageBtn.disabled = true;
    show($actionSpinner);

    try {
      var headers = await getAuthHeaders();
      if (!headers) throw new Error('Not authenticated.');

      var res = await fetch('/api/billing/create-portal-session', {
        method: 'POST',
        headers: headers
      });

      if (!res.ok) {
        var body = await res.json().catch(function () { return {}; });
        throw new Error(body.error || 'Could not open billing portal.');
      }

      var data = await res.json();
      if (data.url) {
        window.location.href = data.url;
        return;
      }
      throw new Error('No portal URL returned.');
    } catch (err) {
      _redirecting = false;
      $manageBtn.disabled = false;
      hide($actionSpinner);
      showError(err.message);
    }
  }

  // ── URL query string banners ───────────────────────────────────────
  function checkReturnParams() {
    var params = new URLSearchParams(window.location.search);
    if (params.get('billing') === 'success') {
      $successMsg.textContent = 'Welcome to Pro! Your subscription is now active.';
      show($success);
      // Clean up the URL
      window.history.replaceState({}, '', window.location.pathname);
    } else if (params.get('billing') === 'cancelled') {
      showError('Checkout was cancelled. No changes were made.');
      window.history.replaceState({}, '', window.location.pathname);
    }
  }

  // ── Auth UI (header menu) ──────────────────────────────────────────
  function setupAuthUI() {
    if (!window.authModule || !window.authModule.isConfigured()) {
      show($signInBtn);
      return;
    }

    window.authModule.onAuthChange(async function (_event, session) {
      if (session) {
        $accountEmail.textContent = session.user.email || '';
        show($accountMenu);
        hide($signInBtn);
      } else {
        hide($accountMenu);
        show($signInBtn);
      }
    });

    // Sign out
    $signOutBtn.addEventListener('click', async function () {
      await window.authModule.signOut();
      window.location.href = '/';
    });

    // Sign in — redirect to main app where the auth modal lives
    $signInBtn.addEventListener('click', function () {
      window.location.href = '/';
    });
  }

  // ── Init ───────────────────────────────────────────────────────────
  async function init() {
    checkReturnParams();

    // Wire up buttons
    $upgradeBtn.addEventListener('click', handleUpgrade);
    $manageBtn.addEventListener('click', handleManage);

    // Init auth module
    if (window.authModule) {
      await window.authModule.init();
    }

    setupAuthUI();

    // Load billing data
    await loadBillingData();
  }

  // Kick off once DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
