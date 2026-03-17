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

  // script-src: always allow jsdelivr (Supabase browser SDK loaded from CDN)
  const scriptSrc = "'self' https://cdn.jsdelivr.net";

  // style-src: always allow inline (used throughout) + Google Fonts stylesheet
  const styleSrc = "'self' 'unsafe-inline' https://fonts.googleapis.com";

  // font-src: Google Fonts delivers font files from fonts.gstatic.com
  const fontSrc = "'self' https://fonts.gstatic.com";

  // connect-src: include the Supabase project URL (https) and websocket (wss)
  // for realtime subscriptions, plus the CDN itself for auth config fetches.
  let connectSrc = "'self'";
  if (SUPABASE_URL) {
    // Derive the wss:// form from the https:// URL
    const wsUrl = SUPABASE_URL.replace(/^https:\/\//, 'wss://');
    connectSrc = `'self' ${SUPABASE_URL} ${wsUrl}`;
  }

  res.setHeader(
    'Content-Security-Policy',
    `default-src 'self'; script-src ${scriptSrc}; style-src ${styleSrc}; font-src ${fontSrc}; connect-src ${connectSrc}; object-src 'none'; frame-ancestors 'none'`
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

if (!SUPABASE_URL) {
  console.warn('[startup] SUPABASE_URL is not set — auth and database features will be unavailable.');
}
const { stripeConfigured } = require('./plans');
if (!stripeConfigured) {
  console.warn('[startup] STRIPE_SECRET_KEY or STRIPE_PRO_PRICE_ID not set — billing features will be unavailable.');
}

app.listen(PORT, () => {
  console.log(`OpsCopilot-Lite running at http://localhost:${PORT}`);
});

