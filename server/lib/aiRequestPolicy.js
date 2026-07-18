'use strict';

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const AI_LIMITS = Object.freeze({
  resultRows:      positiveInt(process.env.AI_MAX_RESULT_ROWS, 5000),
  selectedParts:   positiveInt(process.env.AI_MAX_SELECTED_PARTS, 100),
  supplierGroups:  positiveInt(process.env.AI_MAX_SUPPLIER_GROUPS, 25),
  refinementChars: positiveInt(process.env.AI_MAX_REFINEMENT_CHARS, 500),
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validate the bounded client payload before spending an AI request.
 * Returns null when valid or an HTTP-ready { status, error } object.
 */
function validateAiPayload(payload) {
  const { runData, context, refinement } = payload || {};

  if (!isPlainObject(runData) ||
      !isPlainObject(runData.summary) ||
      !Array.isArray(runData.results)) {
    return {
      status: 400,
      error: 'runData with summary and results is required.',
    };
  }

  if (runData.results.length > AI_LIMITS.resultRows) {
    return {
      status: 413,
      error: `AI helpers accept up to ${AI_LIMITS.resultRows} result rows per request. Narrow the analysis or select priority parts.`,
    };
  }

  if (runData.topPriority !== undefined && !Array.isArray(runData.topPriority)) {
    return { status: 400, error: 'runData.topPriority must be an array.' };
  }

  if (context !== undefined && context !== null && !isPlainObject(context)) {
    return { status: 400, error: 'context must be an object.' };
  }

  if (context && context.selectedParts !== undefined) {
    if (!Array.isArray(context.selectedParts)) {
      return { status: 400, error: 'context.selectedParts must be an array.' };
    }
    if (context.selectedParts.length > AI_LIMITS.selectedParts) {
      return {
        status: 413,
        error: `Select no more than ${AI_LIMITS.selectedParts} parts for one AI draft.`,
      };
    }
  }

  if (context && context.supplierGroups !== undefined) {
    if (!isPlainObject(context.supplierGroups)) {
      return { status: 400, error: 'context.supplierGroups must be an object.' };
    }
    if (Object.keys(context.supplierGroups).length > AI_LIMITS.supplierGroups) {
      return {
        status: 413,
        error: `Use no more than ${AI_LIMITS.supplierGroups} supplier groups per AI draft.`,
      };
    }
    const invalidGroup = Object.values(context.supplierGroups)
      .some(parts => !Array.isArray(parts) || parts.length > AI_LIMITS.selectedParts);
    if (invalidGroup) {
      return {
        status: 413,
        error: `Each supplier group must contain no more than ${AI_LIMITS.selectedParts} parts.`,
      };
    }
  }

  if (refinement !== undefined && refinement !== null) {
    if (!isPlainObject(refinement)) {
      return { status: 400, error: 'refinement must be an object.' };
    }
    if (String(refinement.instruction || '').length > AI_LIMITS.refinementChars) {
      return {
        status: 413,
        error: `Refinement instructions are limited to ${AI_LIMITS.refinementChars} characters.`,
      };
    }
  }

  return null;
}

module.exports = { AI_LIMITS, validateAiPayload };
