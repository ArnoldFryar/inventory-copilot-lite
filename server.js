'use strict';

// ---------------------------------------------------------------------------
// server.js â€” bootstrap only.
//
// Initialises Express, applies global middleware (security headers, static
// files, body parsers), mounts route modules, and starts the HTTP server.
// All route and business logic lives under server/routes/ and server/controllers/.
// ---------------------------------------------------------------------------

const express = require('express');
const fs      = require('fs');
const path    = require('path');

const { SUPABASE_URL }       = require('./supabaseClient');
const { stripeWebhookHandler } = require('./server/controllers/billingController');

const app  = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Security headers â€” applied to every response, including static files.
// Must be registered BEFORE express.static so headers run for all requests.
// ---------------------------------------------------------------------------
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  const connectSrc = SUPABASE_URL ? `'self' ${SUPABASE_URL}` : "'self'";
  const scriptSrc  = SUPABASE_URL ? "'self' https://cdn.jsdelivr.net" : "'self'";
  res.setHeader(
    'Content-Security-Policy',
    `default-src 'self'; script-src ${scriptSrc}; style-src 'self' 'unsafe-inline'; connect-src ${connectSrc}; object-src 'none'; frame-ancestors 'none'`
  );
  next();
});

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Stripe webhook â€” MUST be registered BEFORE express.json() because Stripe
// signature verification requires the raw request body.
// ---------------------------------------------------------------------------
app.post('/api/billing/webhook',
  express.raw({ type: 'application/json' }),
  stripeWebhookHandler
);

// ---------------------------------------------------------------------------
// JSON body parser â€” used by all JSON endpoints after this point.
// ---------------------------------------------------------------------------
app.use(express.json({ limit: '10mb' }));

// ---------------------------------------------------------------------------
// Route modules
// ---------------------------------------------------------------------------
app.use(require('./server/routes/system'));
app.use(require('./server/routes/billing'));
app.use(require('./server/routes/history'));
app.use(require('./server/routes/ai'));
app.use(require('./server/routes/upload'));

// ---------------------------------------------------------------------------
// Global error handler â€” catches unhandled throws in async routes.
// ---------------------------------------------------------------------------
app.use((err, _req, res, _next) => {
  console.error('[Unhandled route error]', err.message || err);
  if (!res.headersSent) {
    res.status(500).json({ error: 'An unexpected server error occurred.' });
  }
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

app.listen(PORT, () => {
  console.log(`OpsCopilot-Lite running at http://localhost:${PORT}`);
});

