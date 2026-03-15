/* OpsCopilot-Lite — lightweight event telemetry
 *
 * Privacy contract:
 *   - Only enumerated event names and aggregate numeric / boolean props are sent.
 *   - No user identifiers, session IDs, file names, part numbers, or IP addresses
 *     are logged by this module.
 *   - All events are sent to the same-origin endpoint /api/event only.
 *   - Fire-and-forget: telemetry never blocks UI interaction or fails loudly.
 *
 * Usage (from script.js):
 *   const track = window.track || function () {};
 *   track('event_name', { key: value });
 */

(function () {
  'use strict';

  /**
   * Fire a telemetry event.
   *
   * @param {string} event  - Short snake_case event name (max 64 chars).
   * @param {object} [props] - Flat object of enumerated / numeric properties.
   *                           Must contain no PII. Callers are responsible
   *                           for passing only safe, pre-categorised values.
   */
  function track(event, props) {
    if (typeof event !== 'string' || !event) return;

    var payload = JSON.stringify({ event: event, props: props || {} });

    // Prefer sendBeacon: non-blocking, survives page unload (e.g. PDF print).
    // Blob wrapper sets Content-Type to application/json for the server.
    if (navigator.sendBeacon) {
      try {
        navigator.sendBeacon('/api/event', new Blob([payload], { type: 'application/json' }));
      } catch (_) { /* silent */ }
      return;
    }

    // Fallback: keepalive fetch so in-flight tab-closes still deliver the event.
    fetch('/api/event', {
      method:    'POST',
      headers:   { 'Content-Type': 'application/json' },
      body:      payload,
      keepalive: true
    }).catch(function () { /* telemetry failures are always silent */ });
  }

  // Expose to other scripts on the same page.
  window.track = track;

  // ── page_load ─────────────────────────────────────────────────────────────
  // Fired once per page view.  No props — no referrer, no user agent.
  track('page_load');

})();
