'use strict';

// ---------------------------------------------------------------------------
// OpsCopilot-Lite — business thresholds
//
// All classification thresholds live here so operational teams can tune them
// without touching analysis logic. Each value is documented with its meaning
// and a realistic starting point for a discrete/mixed manufacturing context.
//
// To adjust for your environment:
//   URGENT_RATIO    — raise to 0.75 if your supply chain is less reliable
//   EXCESS_THRESHOLD — lower to 45 if you run lean / JIT
//   DEAD_STOCK_THRESH — lower to 120 for fast-moving SKUs
// ---------------------------------------------------------------------------

module.exports = {

  // ── Stockout thresholds (expressed as fractions of lead time) ──────────────
  //
  // CRITICAL_RATIO: coverage ≤ this fraction of lead time → crisis response.
  // At 25 % or less you cannot receive standard replenishment before running out;
  // line stoppage is imminent and air-freight / management escalation is required.
  // Default: 0.25 (25 %).
  CRITICAL_RATIO: 0.25,

  // URGENT_RATIO: coverage ≤ this fraction of lead time → urgent expedite.
  // At 50 % you are consuming the emergency buffer.  Standard expedite (bump
  // to next truck, priority scheduling with supplier) is required immediately.
  // Raise to 0.75 if your supply chain has frequent delays or long transit times.
  // Default: 0.5 (50 %).
  URGENT_RATIO: 0.5,

  // ── Excess / dead-stock thresholds (expressed as multiples of lead time) ───
  //
  // Ratio-based thresholds are far more defensible than absolute day counts:
  //   • a 7-day lead-time fastener should flag excess at ~14 days of stock
  //   • a 90-day lead-time forging should NOT flag excess at 160 days of stock
  // Absolute thresholds (the previous model) produced both false positives and
  // false negatives depending on the part's lead time.
  //
  // EXCESS_RATIO: coverage > this multiple of lead time → Excess Inventory.
  // "You have more than two full replenishment windows sitting on the shelf."
  // Lower to 1.5 for JIT / lean environments; raise to 3.0 for long lead-time
  // commodities where safety-stock requirements are higher.
  // Default: 2.0 (2× lead time).
  EXCESS_RATIO: 2.0,

  // DEAD_STOCK_RATIO: coverage > this multiple of lead time → Potential Dead Stock.
  // "You have more than six replenishment windows in stock — disposition review
  // required."  This threshold is intentionally high to avoid false positives on
  // parts with seasonal demand spikes or strategic buffer builds.
  // Default: 6.0 (6× lead time).
  DEAD_STOCK_RATIO: 6.0,

  // Maximum number of rows shown in the "Needs Attention Now" priority panel.
  // Keeps the urgent view scannable; full detail is always in the table.
  TOP_PRIORITY_MAX: 10,

  // ── Upload rate limiting ───────────────────────────────────────────────────
  //
  // Limits how many uploads a single IP address can make within a rolling window.
  // These defaults are intentionally conservative for a public beta with a small
  // user population.  A legitimate power user running a batch of 10 test files
  // comfortably fits within the window; automated abuse does not.
  //
  // Override via environment variables before deploying:
  //   UPLOAD_RATE_MAX    — maximum uploads per window (default: 10)
  //   UPLOAD_RATE_WINDOW — window length in minutes (default: 15)
  //
  // The window is rolling ("sliding window"), not fixed-clock.  This means a
  // user who hits the limit at minute 14 must wait for their oldest request to
  // age out of the window, not until the next clock boundary.
  UPLOAD_RATE_MAX:    parseInt(process.env.UPLOAD_RATE_MAX    || '10',  10),
  UPLOAD_RATE_WINDOW: parseInt(process.env.UPLOAD_RATE_WINDOW || '15',  10), // minutes

};
