/* startYourDay.js — persistent daily entry-point card. */
(function () {
  'use strict';

  var App   = window.App;
  var dom   = App.dom;
  var state = App.state;

  /* ── Visibility ──────────────────────────────────────────────────────── */

  function refreshCard() {
    var card = dom.startYourDay;
    if (!card) return;

    var hasUser     = !!state.currentUser;
    var isAdmin     = state.currentProfile && state.currentProfile.is_admin === true;
    var isPro       = (state.currentPlan && state.currentPlan.plan === 'pro') || isAdmin;
    var hasAnalysis = !!state.lastResponse;

    // Always visible for signed-in users
    if (!hasUser) { card.classList.add('hidden'); return; }
    card.classList.remove('hidden');

    // Locked state (not Pro)
    var existingLockBadge = card.querySelector('.syd-locked-badge');
    var existingNote      = card.querySelector('.syd-needs-analysis-note');
    if (existingLockBadge) existingLockBadge.remove();
    if (existingNote)      existingNote.remove();

    card.classList.remove('is-locked', 'needs-analysis');

    if (!isPro) {
      card.classList.add('is-locked');
      var badge = document.createElement('span');
      badge.className = 'syd-locked-badge';
      badge.textContent = '\u2728 Pro feature \u2014 upgrade to unlock';
      card.appendChild(badge);
    } else if (!hasAnalysis) {
      card.classList.add('needs-analysis');
      var note = document.createElement('p');
      note.className = 'syd-needs-analysis-note';
      note.textContent = 'Upload a CSV above to unlock quick actions';
      card.appendChild(note);
    }

    // Urgency cue
    updateLastRunCue();
  }

  /* ── Last-run urgency cue ────────────────────────────────────────────── */

  function updateLastRunCue() {
    var el = dom.sydLastRun;
    if (!el || !App.aiHistoryStore) return;

    var entries = App.aiHistoryStore.getEntries();
    el.className = 'syd-last-run'; // reset

    if (entries.length === 0) {
      el.className += ' syd-none';
      el.innerHTML = '<span class="syd-last-run-dot"></span>No runs today';
      return;
    }

    var latest = new Date(entries[0].timestamp);
    var now    = new Date();
    var diffH  = Math.floor((now - latest) / 3600000);

    if (diffH < 1) {
      el.className += ' syd-recent';
      el.innerHTML = '<span class="syd-last-run-dot"></span>Last run: just now';
    } else if (diffH < 24) {
      el.className += ' syd-stale';
      el.innerHTML = '<span class="syd-last-run-dot"></span>Last run: ' + diffH + 'h ago';
    } else {
      el.className += ' syd-none';
      el.innerHTML = '<span class="syd-last-run-dot"></span>No runs today';
    }
  }

  /* ── Quick-action buttons ────────────────────────────────────────────── */

  var card = dom.startYourDay;
  if (card) {
    card.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-syd-helper]');
      if (!btn || btn.disabled) return;

      var helperType = btn.getAttribute('data-syd-helper');
      if (!helperType) return;

      // Scroll to AI helpers section
      var aiSection = dom.aiHelpersSection;
      if (aiSection) {
        aiSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }

      // Trigger the matching AI helper button after scroll starts
      setTimeout(function () {
        if (!aiSection) return;
        var target = aiSection.querySelector('[data-helper="' + helperType + '"]');
        if (target && !target.disabled) target.click();
      }, 200);
    });
  }

  /* ── Expose ──────────────────────────────────────────────────────────── */

  App.startYourDay = {
    refresh: refreshCard,
  };
})();
