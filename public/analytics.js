/* OpsCopilot-Lite — lightweight event telemetry
 *
 * Privacy contract:
 *   - Only enumerated event names and aggregate numeric / boolean props are sent.
 *   - No user identifiers, session IDs, file names, part numbers, or IP addresses
 *     are logged by this module.
 *   - All events are sent to the same-origin endpoint /api/events only.
 *   - Fire-and-forget: telemetry never blocks UI interaction or fails loudly.
 *
 * Usage (from script.js):
 *   const track = window.track || function () {};
 *   track('event_name', { key: value });
 */

(function () {
  'use strict';

  function postEvent(body, token) {
    var headers = { 'Content-Type': 'application/json' };

    if (!token && navigator.sendBeacon) {
      try {
        if (navigator.sendBeacon('/api/events', new Blob([body], { type: 'application/json' }))) {
          return;
        }
      } catch (_) { /* silent */ }
    }

    if (token) {
      headers.Authorization = 'Bearer ' + token;
    }

    fetch('/api/events', {
      method: 'POST',
      headers: headers,
      body: body,
      keepalive: true
    }).catch(function () { /* telemetry failures are always silent */ });
  }

  /**
   * Fire a telemetry event.
   *
   * @param {string} event  - Short snake_case event name (max 64 chars).
   * @param {object} [props] - Flat object of enumerated / numeric properties.
   * @param {string} [token] - Optional auth token for signed-in requests.
   *                           Must contain no PII. Callers are responsible
   *                           for passing only safe, pre-categorised values.
   */
  function track(event, props, token) {
    if (typeof event !== 'string' || !event) return;

    var payload = JSON.stringify({ event: event, properties: props || {} });
    postEvent(payload, token || '');
  }

  window.postEventTelemetry = postEvent;
  // Expose to other scripts on the same page.
  window.track = track;

  // ── page_load ─────────────────────────────────────────────────────────────
  // Fired once per page view.  No props — no referrer, no user agent.
  track('page_load');

})();
