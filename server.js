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
// Trust proxy — Railway (and most PaaS hosts) terminate TLS at a reverse
// proxy that injects X-Forwarded-For / X-Forwarded-Proto headers.
// Without this, express-rate-limit v7+ throws ERR_ERL_UNEXPECTED_X_FORWARDED_FOR
// and req.ip returns the proxy IP instead of the real client IP.
// Value 1 = trust the first (nearest) proxy hop.
// ---------------------------------------------------------------------------
app.set('trust proxy', 1);

// ---------------------------------------------------------------------------
// Security headers â€” applied to every response, including static files.
// Must be registered BEFORE express.static so headers run for all requests.
// ---------------------------------------------------------------------------
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');

  // script-src: always allow jsdelivr (Supabase browser SDK loaded from CDN)
  // and Tailwind Play CDN (used on ops.html marketing page)
  const scriptSrc = "'self' https://cdn.jsdelivr.net https://cdn.tailwindcss.com";

  // style-src: always allow inline (used throughout) + Google Fonts stylesheet
  const styleSrc = "'self' 'unsafe-inline' https://fonts.googleapis.com";

  // font-src: Google Fonts delivers font files from fonts.gstatic.com
  const fontSrc = "'self' https://fonts.gstatic.com";

  // connect-src: Supabase (https + wss for realtime) and jsdelivr (browser
  // fetches source maps from cdn.jsdelivr.net via XHR/fetch at runtime).
  let connectSrc = "'self' https://cdn.jsdelivr.net";
  if (SUPABASE_URL) {
    const wsUrl = SUPABASE_URL.replace(/^https:\/\//, 'wss://');
    connectSrc = `'self' https://cdn.jsdelivr.net ${SUPABASE_URL} ${wsUrl}`;
  }

  res.setHeader(
    'Content-Security-Policy',
    `default-src 'self'; script-src ${scriptSrc}; style-src ${styleSrc}; font-src ${fontSrc}; img-src 'self' data:; connect-src ${connectSrc}; object-src 'none'; frame-ancestors 'none'`
  );
  next();
});

// ---------------------------------------------------------------------------
// Hostname-based root routing
// Registered BEFORE express.static so this handler wins for GET /.
//
// Uses req.headers.host directly (strips port) instead of req.hostname so
// the result is consistent regardless of trust proxy depth.
//
//   myopscopilot.com         → ops.html  (marketing landing page)
//   www.myopscopilot.com     → 301 redirect → https://myopscopilot.com/
//   app.myopscopilot.com     → index.html (the app)
//   localhost / anything else → index.html (safe local dev fallback)
// ---------------------------------------------------------------------------
const PUBLIC_DIR  = path.join(__dirname, 'public');
const APP_HTML    = path.join(PUBLIC_DIR, 'index.html');
const LANDING_HTML = path.join(PUBLIC_DIR, 'ops.html');

app.get('/', (req, res) => {
  const rawHost = req.headers.host || '';
  const host = rawHost.replace(/:\d+$/, '').toLowerCase();

  if (host === 'www.myopscopilot.com') {
    console.log('[route:root] REDIRECT www ->', host);
    return res.redirect(301, 'https://myopscopilot.com/');
  }
  if (host === 'myopscopilot.com') {
    console.log('[route:root] LANDING', host);
    return res.sendFile(LANDING_HTML);
  }
  if (host === 'app.myopscopilot.com') {
    console.log('[route:root] APP', host);
    return res.sendFile(APP_HTML);
  }
  console.log('[route:root] FALLBACK', host);
  return res.sendFile(APP_HTML);
});

// ---------------------------------------------------------------------------
// Diagnostic endpoint — confirm hostname resolution in production
// Remove or gate behind an env flag once DNS is verified.
// ---------------------------------------------------------------------------
app.get('/health/host', (req, res) => {
  res.json({
    hostname:   req.hostname,
    hostHeader: req.headers.host,
  });
});

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------
app.use(express.static(PUBLIC_DIR));

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
app.use(require('./server/routes/events'));
app.use(require('./server/routes/support'));
app.use(require('./server/routes/procurement'));
app.use(require('./server/routes/pfep'));

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

// Fail fast if either root-served HTML file is missing.
[APP_HTML, LANDING_HTML].forEach((f) => {
  if (!fs.existsSync(f)) {
    console.error(`[startup] FATAL: required file not found: ${f}`);
    process.exit(1);
  }
});

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

// Prevent unhandled promise rejections from crashing the process.
// Express 4 does not automatically forward async route errors to the
// error-handling middleware — a rejected promise leaves the request hanging
// until the proxy times out (502). The try/catch wrappers in each route
// handler are the primary defence; this is the last-resort safety net.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

