/* executiveSummary.js — deterministic executive-summary builder
 *
 * Consumes the same analysis result shape produced by analyzeRows() and
 * returns a structured executive brief: health score, top risk, top
 * opportunity, and a plain-language summary paragraph.
 *
 * All text is built from deterministic templates — no AI inference.
 */

// eslint-disable-next-line no-unused-vars
var buildExecutiveSummary = (function () {
  'use strict';

  // ── Health Score (0–100) ──────────────────────────────────────────────
  //
  // Starts at 100 and subtracts penalty points based on the concentration
  // of problem categories relative to the total part count.  Using ratios
  // rather than raw counts prevents small files from over-penalizing and
  // large files from under-penalizing.
  //
  //   Urgent stockout  : −5 per item  (highest impact — imminent line risk)
  //   Stockout risk    : −3 per item  (material but less immediate)
  //   Excess inventory : −2 per item  (financial waste, not line-stoppage)
  //   Dead stock       : −2 per item  (financial waste, disposition needed)
  //   Invalid rows     : −1 per item  (data quality — limits visibility)
  //
  // Final score is clamped to [0, 100].

  function computeHealthScore(summary) {
    var score = 100;
    score -= (summary.urgent_stockout || 0) * 5;
    score -= (summary.stockout_risk   || 0) * 3;
    score -= (summary.excess          || 0) * 2;
    score -= (summary.dead_stock      || 0) * 2;
    score -= (summary.invalid         || 0) * 1;
    return Math.max(0, Math.min(100, Math.round(score)));
  }

  // ── scoreLabel — human-readable tier ──────────────────────────────────

  function scoreLabel(score) {
    if (score >= 80) return 'Strong';
    if (score >= 60) return 'Fair';
    if (score >= 40) return 'At Risk';
    return 'Critical';
  }

  // ── scoreColor — CSS class suffix for the score ring ──────────────────

  function scoreColorClass(score) {
    if (score >= 80) return 'score-strong';
    if (score >= 60) return 'score-fair';
    if (score >= 40) return 'score-at-risk';
    return 'score-critical';
  }

  // ── Top Risk ──────────────────────────────────────────────────────────
  // The most critical supply-risk item: among urgent/stockout-risk parts,
  // choose the one with the highest daily_usage (biggest operational
  // impact if it runs out).  Tie-break on lowest coverage.

  function findTopRisk(results) {
    var candidates = results.filter(function (r) {
      return r.status === 'Urgent Stockout Risk' || r.status === 'Stockout Risk';
    });
    if (candidates.length === 0) return null;

    // Tier 1 — active stockouts (coverage at or below zero: on hand is depleted).
    // Tier 2 — imminent risks  (coverage positive but below lead time).
    // Always prefer a Tier 1 item; fall back to the full candidate pool only
    // when no active stockout exists.
    var tier1 = candidates.filter(function (r) {
      return r.coverage !== null && r.coverage !== undefined && r.coverage <= 0;
    });
    var pool = tier1.length > 0 ? tier1 : candidates;

    pool.sort(function (a, b) {
      var usageA = (a.daily_usage != null) ? a.daily_usage : 0;
      var usageB = (b.daily_usage != null) ? b.daily_usage : 0;
      if (usageB !== usageA) return usageB - usageA;          // higher usage first
      var covA = (a.coverage != null) ? a.coverage : Infinity;
      var covB = (b.coverage != null) ? b.coverage : Infinity;
      return covA - covB;                                      // lower coverage first
    });

    var r = pool[0];
    return {
      part:    r.part_number,
      status:  r.status,
      detail:  r.part_number + ' — ' + (r.coverage != null ? r.coverage + ' days coverage' : 'no coverage data') +
               ', usage ' + (r.daily_usage != null ? r.daily_usage + '/day' : 'unknown')
    };
  }

  // ── Top Opportunity ───────────────────────────────────────────────────
  // The most impactful excess / dead-stock item: highest on-hand value
  // among excess + dead-stock rows (proxy for working-capital exposure).
  // Tie-break on highest coverage.

  function findTopOpportunity(results) {
    var candidates = results.filter(function (r) {
      return r.status === 'Excess Inventory' || r.status === 'Potential Dead Stock';
    });
    if (candidates.length === 0) return null;

    candidates.sort(function (a, b) {
      var ohA = (a.on_hand != null) ? a.on_hand : 0;
      var ohB = (b.on_hand != null) ? b.on_hand : 0;
      if (ohB !== ohA) return ohB - ohA;                       // higher on-hand first
      var covA = (a.coverage != null) ? a.coverage : 0;
      var covB = (b.coverage != null) ? b.coverage : 0;
      return covB - covA;                                      // higher coverage first
    });

    var r = candidates[0];
    return {
      part:    r.part_number,
      status:  r.status,
      detail:  r.part_number + ' — ' + (r.on_hand != null ? r.on_hand.toLocaleString() + ' units on hand' : 'unknown qty') +
               ', ' + (r.coverage != null ? r.coverage + ' days coverage' : 'no coverage data')
    };
  }

  // ── Executive Summary Paragraph ───────────────────────────────────────
  // Built from deterministic templates. Tone: professional, direct,
  // suitable for plant managers and materials managers.

  function buildNarrative(summary, score, topRisk, topOpp) {
    var total   = summary.total          || 0;
    var urgent  = summary.urgent_stockout || 0;
    var risk    = summary.stockout_risk   || 0;
    var excess  = summary.excess          || 0;
    var dead    = summary.dead_stock      || 0;
    var healthy = summary.healthy         || 0;
    var invalid = summary.invalid         || 0;
    var noUsage = summary.no_usage        || 0;

    var sentences = [];

    // Opening — overall posture
    var healthyPct = total > 0 ? Math.round((healthy / total) * 100) : 0;
    var supplyRisk = urgent + risk;

    if (score >= 80) {
      sentences.push('Inventory is in strong position with ' + healthyPct + '% of parts adequately stocked.');
    } else if (score >= 60) {
      sentences.push('Inventory is generally stable but warrants attention on several parts.');
    } else if (score >= 40) {
      sentences.push('Inventory health is below target with notable supply risk exposure.');
    } else {
      sentences.push('Inventory is in a critical state requiring immediate review.');
    }

    // Supply-risk detail
    if (supplyRisk > 0) {
      sentences.push(
        supplyRisk + ' part' + (supplyRisk !== 1 ? 's' : '') +
        (urgent > 0 ? ' (' + urgent + ' urgent)' : '') +
        ' ' + (supplyRisk !== 1 ? 'are' : 'is') +
        ' at stockout risk and should be reviewed for expediting.'
      );
    }

    // Excess / dead-stock detail
    var overstock = excess + dead;
    if (overstock > 0) {
      var overstockNote = overstock + ' part' + (overstock !== 1 ? 's carry' : ' carries') +
        ' excess or potential dead stock';
      if (dead > 0) {
        overstockNote += ' (' + dead + ' flagged for disposition review)';
      }
      overstockNote += ', presenting an opportunity to reduce working capital exposure.';
      sentences.push(overstockNote);
    }

    // Data quality note
    if (invalid > 0 || noUsage > 0) {
      var dqParts = [];
      if (invalid > 0) dqParts.push(invalid + ' invalid');
      if (noUsage > 0) dqParts.push(noUsage + ' with no usage data');
      sentences.push(
        dqParts.join(' and ') + ' row' +
        ((invalid + noUsage) !== 1 ? 's require' : ' requires') +
        ' data cleanup before reliable triage.'
      );
    }

    return sentences.join(' ');
  }

  // ── Public API ────────────────────────────────────────────────────────

  return function buildExecutiveSummary(data) {
    var summary = data.summary;
    var results = data.results || [];

    var score      = computeHealthScore(summary);
    var label      = scoreLabel(score);
    var colorClass = scoreColorClass(score);
    var topRisk    = findTopRisk(results);
    var topOpp     = findTopOpportunity(results);
    var narrative  = buildNarrative(summary, score, topRisk, topOpp);

    return {
      score:      score,
      label:      label,
      colorClass: colorClass,
      topRisk:    topRisk,
      topOpp:     topOpp,
      narrative:  narrative,
      urgent:     summary.urgent_stockout || 0,
      excess:     (summary.excess || 0) + (summary.dead_stock || 0)
    };
  };
})();
