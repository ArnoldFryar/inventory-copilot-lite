/* dailySignal.js — lightweight daily activity signal on the dashboard.
 *
 * Tracks upload runs per day in localStorage. Displays:
 *   - "Today: X runs · Last used: Yh ago" when there's activity
 *   - "No activity today — run a quick summary" when idle
 *
 * Exposes App.dailySignal.record() and App.dailySignal.refresh().
 */
(function () {
  'use strict';

  var App = window.App = window.App || {};
  var STORAGE_KEY = 'opscopilot_daily_signal';

  // ── Helpers ───────────────────────────────────────────────────────────────

  function todayKey() {
    return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  }

  function _read() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) { return null; }
  }

  function _write(obj) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(obj)); } catch (_) { /* quota */ }
  }

  function formatTimeAgo(isoString) {
    if (!isoString) return '';
    var diff = Date.now() - new Date(isoString).getTime();
    if (diff < 0) diff = 0;
    var mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    var hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    return Math.floor(hrs / 24) + 'd ago';
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /** Record a run (call after each successful upload). */
  function record() {
    var today = todayKey();
    var data = _read();
    if (!data || data.date !== today) {
      data = { date: today, runs: 0, lastUsed: null };
    }
    data.runs += 1;
    data.lastUsed = new Date().toISOString();
    _write(data);
    refresh();
  }

  /** Refresh the dashboard signal strip. */
  function refresh() {
    var el = document.getElementById('dailySignal');
    var content = document.getElementById('dailySignalContent');
    if (!el || !content) return;

    var today = todayKey();
    var data = _read();
    var hasActivity = data && data.date === today && data.runs > 0;

    if (hasActivity) {
      var runLabel = data.runs === 1 ? '1 run' : data.runs + ' runs';
      var ago = formatTimeAgo(data.lastUsed);
      content.innerHTML = '';
      content.className = 'daily-signal-content daily-signal-active';

      var dot = document.createElement('span');
      dot.className = 'daily-signal-dot';
      dot.setAttribute('aria-hidden', 'true');
      content.appendChild(dot);

      var txt = document.createTextNode('Today: ' + runLabel + ' \u00B7 Last used: ' + ago);
      content.appendChild(txt);
    } else {
      content.className = 'daily-signal-content daily-signal-idle';
      content.innerHTML = '';
      var idle = document.createTextNode('No activity today \u2014 ');
      content.appendChild(idle);

      var cta = document.createElement('button');
      cta.className = 'daily-signal-cta';
      cta.type = 'button';
      cta.textContent = 'run a quick summary';
      cta.addEventListener('click', function () {
        var sampleBtn = document.getElementById('loadSampleBtn');
        if (sampleBtn) sampleBtn.click();
      });
      content.appendChild(cta);
    }

    el.classList.remove('hidden');
  }

  // ── Expose ────────────────────────────────────────────────────────────────

  App.dailySignal = {
    record:  record,
    refresh: refresh,
  };
})();
