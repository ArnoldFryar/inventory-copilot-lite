'use strict';

// ---------------------------------------------------------------------------
// logger — thin wrapper around console so all log calls go through one place.
// Keeps callers decoupled from the underlying output mechanism.
// ---------------------------------------------------------------------------

const log   = (...args) => console.log(...args);
const error = (...args) => console.error(...args);

module.exports = { log, error };
