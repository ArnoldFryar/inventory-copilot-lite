'use strict';

const express    = require('express');
const rateLimit  = require('express-rate-limit');
const multer     = require('multer');
const fs         = require('fs');
const path       = require('path');
const { analyzeRows }              = require('./analyzer');
const cfg                          = require('./config');
const { resolveHeaders, acceptedNames } = require('./columnMap');
const { ingestCSV }                = require('./csvIngest');
const { getPlan, getPlanForUser, applyPlanLimits, STRIPE_CONFIG, stripeConfigured, getStripe } = require('./plans');
const { supabaseAdmin, verifyToken, isConfigured: supabaseConfigured, SUPABASE_URL, SUPABASE_ANON_KEY } = require('./supabaseClient');
const { compareRuns }              = require('./comparator');
const { generateHelper, aiConfigured, VALID_HELPER_TYPES, HELPER_TYPES } = require('./aiHelpers');

const app  = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Multer configuration
// - diskStorage keeps files in /uploads so we can stream-parse them
// - limits.fileSize caps uploads at 5 MB to prevent abuse
// - fileFilter rejects anything that is not a CSV before it lands on disk
// ---------------------------------------------------------------------------
const UPLOAD_DIR  = path.join(__dirname, 'uploads');
const MAX_BYTES   = 5 * 1024 * 1024; // 5 MB

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename:    (_req, file,  cb) => {
    // Prefix with timestamp to avoid collisions in concurrent requests
    const safe = Date.now() + '-' + path.basename(file.originalname);
    cb(null, safe);
  }
});

function csvFileFilter(_req, file, cb) {
  const ext  = path.extname(file.originalname).toLowerCase();
  const mime = file.mimetype;

  // Accept .csv files; also tolerate text/plain which some OS send for CSV
  const extOk  = ext === '.csv';
  const mimeOk = mime === 'text/csv' || mime === 'text/plain' ||
                 mime === 'application/vnd.ms-excel' ||
                 mime === 'application/octet-stream';

  if (extOk && mimeOk) {
    cb(null, true);
  } else {
    // Passing an Error as the first argument rejects the upload gracefully
    cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE',
      'Only .csv files are accepted.'));
  }
}

const upload = multer({
  storage,
  limits:     { fileSize: MAX_BYTES },
  fileFilter: csvFileFilter
});

// ---------------------------------------------------------------------------
// Security headers — applied to every response, including static files.
// Must be registered BEFORE express.static so the middleware runs for all
// requests; express.static short-circuits without calling next().
// X-Content-Type-Options: prevents MIME-sniffing of scripts from uploaded CSVs.
// X-Frame-Options: prevents clickjacking in iframe embeds.
// ---------------------------------------------------------------------------
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  // Narrow CSP: this app serves no external scripts, fonts, or frames.
  // 'unsafe-inline' is required for the inline styles used by the print
  // stylesheet; remove if those are ever moved to a separate file.
  // CSP must allow connect-src to Supabase so the frontend auth SDK can
  // reach the auth API directly.  Falls back to 'self'-only when unconfigured.
  const connectSrc = SUPABASE_URL
    ? `'self' ${SUPABASE_URL}`
    : "'self'";
  const scriptSrc = SUPABASE_URL
    ? "'self' https://cdn.jsdelivr.net"
    : "'self'";
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

// Stripe subscription event types we care about (module-level constant)
const SUBSCRIPTION_EVENTS = new Set([
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted'
]);

// ---------------------------------------------------------------------------
// Stripe webhook — MUST be registered BEFORE express.json() because Stripe
// signature verification requires the raw request body.  Only this single
// route uses express.raw(); all other routes use JSON as before.
// ---------------------------------------------------------------------------
app.post('/api/billing/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    if (!stripeConfigured || !supabaseAdmin) {
      return res.status(503).end();
    }

    const stripe = getStripe();
    const sig    = req.headers['stripe-signature'];

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body, sig, STRIPE_CONFIG.webhookSecret
      );
    } catch (err) {
      console.error('[Stripe webhook] Signature verification failed:', err.message);
      return res.status(400).json({ error: 'Webhook signature verification failed.' });
    }

    // Process subscription lifecycle events
    if (SUBSCRIPTION_EVENTS.has(event.type)) {
      try {
        const sub        = event.data.object;
        const customerId = sub.customer;
        const status     = sub.status;            // active, canceled, past_due, etc.
        const priceId    = sub.items?.data?.[0]?.price?.id || '';

        // Map price to plan key
        const planKey = (priceId === STRIPE_CONFIG.proPriceId) ? 'pro' : 'free';

        // Resolve Supabase user_id from stripe_customer_id
        const { data: subRow } = await supabaseAdmin
          .from('user_subscriptions')
          .select('user_id')
          .eq('stripe_customer_id', customerId)
          .single();

        if (subRow) {
          const { error } = await supabaseAdmin
            .from('user_subscriptions')
            .update({
              plan_key:            planKey,
              stripe_status:       status,
              stripe_subscription_id: sub.id,
              stripe_price_id:     priceId,
              updated_at:          new Date().toISOString()
            })
            .eq('user_id', subRow.user_id);

          if (error) console.error('[Stripe webhook] update error:', error.message);
          else       console.log(`[Stripe webhook] ${event.type}: user ${subRow.user_id} → ${planKey}/${status}`);
        } else {
          console.warn(`[Stripe webhook] No user found for customer ${customerId}`);
        }
      } catch (dbErr) {
        console.error('[Stripe webhook] DB error:', dbErr.message);
        // Still return 200 so Stripe won't retry endlessly
      }
    }

    // Acknowledge receipt (Stripe retries on non-2xx)
    res.json({ received: true });
  }
);

// ---------------------------------------------------------------------------
// JSON body parser — used by POST /api/event, POST /api/runs, and other
// JSON endpoints.  10 MB accommodates the results_json payload for the
// largest uploads (~50 k rows).  Individual route-level guards can further
// restrict if needed.
// ---------------------------------------------------------------------------
app.use(express.json({ limit: '10mb' }));

// ---------------------------------------------------------------------------
// GET /api/config — exposes active business thresholds to the frontend.
// Used by the leadership summary and PDF auditability note so the report
// always reflects the thresholds actually applied to the data.
// These keys mirror the thresholds object returned by analyzeRows so the
// frontend has a consistent shape regardless of how it retrieves them.
// ---------------------------------------------------------------------------
app.get('/api/config', (_req, res) => {
  res.json({
    critical_ratio:   cfg.CRITICAL_RATIO,
    urgent_ratio:     cfg.URGENT_RATIO,
    excess_ratio:     cfg.EXCESS_RATIO,
    dead_stock_ratio: cfg.DEAD_STOCK_RATIO,
    top_priority_max: cfg.TOP_PRIORITY_MAX
  });
});

// ---------------------------------------------------------------------------
// GET /api/auth-config — exposes the Supabase URL and anon key so the
// frontend can initialise the auth SDK without hard-coding credentials.
// These are PUBLIC values — the anon key is designed for client-side usage.
// ---------------------------------------------------------------------------
app.get('/api/auth-config', (_req, res) => {
  if (!supabaseConfigured) {
    return res.json({ configured: false });
  }
  res.json({
    configured: true,
    supabaseUrl: SUPABASE_URL,
    supabaseAnonKey: SUPABASE_ANON_KEY
  });
});

// ---------------------------------------------------------------------------
// Auth middleware — verifies the Supabase JWT from the Authorization header.
// Attaches req.user on success.  Returns 401 on invalid/missing tokens.
// Only used on protected routes — public routes skip this entirely.
// ---------------------------------------------------------------------------
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  const { user, error } = await verifyToken(token);
  if (!user) {
    return res.status(401).json({ error: error || 'Invalid session.' });
  }
  req.user = user;
  next();
}

// ---------------------------------------------------------------------------
// POST /api/billing/checkout — creates a Stripe Checkout Session for the
// Pro monthly subscription.  Returns { url } which the frontend redirects to.
// ---------------------------------------------------------------------------
app.post('/api/billing/checkout', requireAuth, async (req, res) => {
  if (!stripeConfigured) {
    return res.status(503).json({ error: 'Billing is not configured.' });
  }

  try {
    const stripe   = getStripe();
    const userId   = req.user.id;
    const email    = req.user.email;
    const returnUrl = STRIPE_CONFIG.portalReturnUrl || `${req.protocol}://${req.get('host')}`;

    // Look up or create a subscription row so we have a Stripe customer ID
    let { data: subRow } = await supabaseAdmin
      .from('user_subscriptions')
      .select('stripe_customer_id')
      .eq('user_id', userId)
      .single();

    let customerId = subRow?.stripe_customer_id;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email,
        metadata: { supabase_user_id: userId }
      });
      customerId = customer.id;

      await supabaseAdmin
        .from('user_subscriptions')
        .upsert({
          user_id:            userId,
          stripe_customer_id: customerId,
          plan_key:           'free',
          stripe_status:      'none',
          updated_at:         new Date().toISOString()
        }, { onConflict: 'user_id' });
    }

    const session = await stripe.checkout.sessions.create({
      mode:                 'subscription',
      customer:             customerId,
      line_items:           [{ price: STRIPE_CONFIG.proPriceId, quantity: 1 }],
      success_url:          `${returnUrl}?billing=success`,
      cancel_url:           `${returnUrl}?billing=cancelled`,
      subscription_data:    { metadata: { supabase_user_id: userId } }
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('[POST /api/billing/checkout]', err.message);
    res.status(500).json({ error: 'Could not create checkout session. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/billing/portal — creates a Stripe Customer Portal session.
// Lets subscribers manage payment method, cancel, view invoices, etc.
// ---------------------------------------------------------------------------
app.post('/api/billing/portal', requireAuth, async (req, res) => {
  if (!stripeConfigured) {
    return res.status(503).json({ error: 'Billing is not configured.' });
  }

  try {
    const stripe  = getStripe();
    const userId  = req.user.id;
    const returnUrl = STRIPE_CONFIG.portalReturnUrl || `${req.protocol}://${req.get('host')}`;

    const { data: subRow } = await supabaseAdmin
      .from('user_subscriptions')
      .select('stripe_customer_id')
      .eq('user_id', userId)
      .single();

    if (!subRow?.stripe_customer_id) {
      return res.status(404).json({ error: 'No billing account found. Subscribe to Pro first.' });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer:   subRow.stripe_customer_id,
      return_url: returnUrl
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('[POST /api/billing/portal]', err.message);
    res.status(500).json({ error: 'Could not open billing portal. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/plan — returns the active plan and feature entitlements.
// When the user is authenticated, resolves their per-user subscription
// from the database.  Falls back to the env-var / default for anonymous.
// ---------------------------------------------------------------------------
app.get('/api/plan', async (req, res) => {
  try {
    // Try to resolve per-user plan if an auth header is present
    const header = req.headers.authorization || '';
    const token  = header.startsWith('Bearer ') ? header.slice(7) : '';

    let plan;
    if (token && supabaseAdmin) {
      const { user } = await verifyToken(token);
      if (user) {
        plan = await getPlanForUser(user.id, supabaseAdmin);
      }
    }
    if (!plan) plan = getPlan();

    const { planEntitlements } = require('./plans');
    res.json({
      plan:         plan.key,
      name:         plan.name,
      entitlements: planEntitlements(plan),
      billingConfigured: stripeConfigured
    });
  } catch (err) {
    console.error('[GET /api/plan]', err.message);
    res.status(500).json({ error: 'Could not resolve plan.' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/event — receives client-side telemetry events.
// Privacy: only enumerated event names and aggregate numeric props are logged.
// No user identifiers, file contents, or IP addresses are stored.
// ---------------------------------------------------------------------------
app.post('/api/event', (req, res) => {
  const { event, props } = req.body || {};
  if (typeof event !== 'string' || event.length < 1 || event.length > 64) {
    return res.status(400).json({ error: 'Invalid event.' });
  }
  const safe = {
    ts:    new Date().toISOString(),
    event: event.replace(/[^\w._-]/g, ''),
    props: (props && typeof props === 'object' && !Array.isArray(props)) ? props : {}
  };
  console.log('EVENT', JSON.stringify(safe));
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// GET /sample-data — serves the bundled demo CSV as a file download.
// Lets demoes run without needing a real ERP export on hand.
// ---------------------------------------------------------------------------
app.get('/sample-data', (_req, res) => {
  const filePath = path.join(__dirname, 'public', 'sample.csv');
  res.download(filePath, 'sample_inventory.csv', (err) => {
    if (err && !res.headersSent) {
      res.status(500).json({ error: 'Sample file not available.' });
    }
  });
});

// ---------------------------------------------------------------------------
// Protected routes — /api/runs (saved analysis history)
// ---------------------------------------------------------------------------

// POST /api/runs — save an analysis run
app.post('/api/runs', requireAuth, async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(503).json({ error: 'Database is not configured.' });
  }

  const plan = await getPlanForUser(req.user.id, supabaseAdmin);
  if (!plan.savedHistory) {
    return res.status(403).json({ error: 'Saved history is a Pro plan feature.' });
  }

  const { file_name, part_count, summary_json, results_json, plan_at_upload, source_type } = req.body || {};

  if (!summary_json || !results_json) {
    return res.status(400).json({ error: 'summary_json and results_json are required.' });
  }

  const sourceValid = source_type === 'sample' || source_type === 'manual';

  const { data, error } = await supabaseAdmin
    .from('analysis_runs')
    .insert({
      user_id:        req.user.id,
      file_name:      typeof file_name === 'string' ? file_name.slice(0, 255) : 'unknown',
      part_count:     Number.isFinite(part_count) ? part_count : 0,
      summary_json:   summary_json,
      results_json:   results_json,
      plan_at_upload: typeof plan_at_upload === 'string' ? plan_at_upload.slice(0, 16) : 'free',
      source_type:    sourceValid ? source_type : 'manual'
    })
    .select('id, uploaded_at')
    .single();

  if (error) {
    console.error('[POST /api/runs]', error.message);
    return res.status(500).json({ error: 'Failed to save analysis run.' });
  }

  res.status(201).json(data);
});

// GET /api/runs — list the authenticated user's saved runs (most recent first)
app.get('/api/runs', requireAuth, async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(503).json({ error: 'Database is not configured.' });
  }

  const plan = await getPlanForUser(req.user.id, supabaseAdmin);
  if (!plan.savedHistory) {
    return res.status(403).json({ error: 'Saved history is a Pro plan feature.' });
  }

  const { data, error } = await supabaseAdmin
    .from('analysis_runs')
    .select('id, file_name, uploaded_at, part_count, summary_json, plan_at_upload, source_type')
    .eq('user_id', req.user.id)
    .order('uploaded_at', { ascending: false })
    .limit(50);

  if (error) {
    console.error('[GET /api/runs]', error.message);
    return res.status(500).json({ error: 'Failed to load history.' });
  }

  res.json(data);
});

// GET /api/runs/:id/compare — compare a run against its immediate predecessor
// Returns the diff: new urgent, resolved urgent, worsened, improved, added, removed.
// MUST be registered BEFORE the generic GET /api/runs/:id route so Express
// matches the explicit /compare segment instead of treating "compare" as an :id.
app.get('/api/runs/:id/compare', requireAuth, async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(503).json({ error: 'Database is not configured.' });
  }

  const plan = await getPlanForUser(req.user.id, supabaseAdmin);
  if (!plan.savedHistory) {
    return res.status(403).json({ error: 'Saved history is a Pro plan feature.' });
  }

  // Load the target run
  const { data: targetRun, error: e1 } = await supabaseAdmin
    .from('analysis_runs')
    .select('id, uploaded_at, results_json')
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
    .single();

  if (e1 || !targetRun) {
    return res.status(404).json({ error: 'Run not found.' });
  }

  // Find the most recent run BEFORE this one for the same user
  const { data: priorRuns, error: e2 } = await supabaseAdmin
    .from('analysis_runs')
    .select('id, uploaded_at, results_json, file_name')
    .eq('user_id', req.user.id)
    .lt('uploaded_at', targetRun.uploaded_at)
    .order('uploaded_at', { ascending: false })
    .limit(1);

  if (e2) {
    console.error('[GET /api/runs/:id/compare]', e2.message);
    return res.status(500).json({ error: 'Failed to load comparison data.' });
  }

  if (!priorRuns || priorRuns.length === 0) {
    return res.json({ hasPrior: false });
  }

  const priorRun = priorRuns[0];
  const comparison = compareRuns(
    targetRun.results_json || [],
    priorRun.results_json || []
  );
  comparison.priorRunId      = priorRun.id;
  comparison.priorUploadedAt = priorRun.uploaded_at;
  comparison.priorFileName   = priorRun.file_name;

  return res.json(comparison);
});

// GET /api/runs/:id — retrieve a single saved run (with full results)
app.get('/api/runs/:id', requireAuth, async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(503).json({ error: 'Database is not configured.' });
  }

  const plan = await getPlanForUser(req.user.id, supabaseAdmin);
  if (!plan.savedHistory) {
    return res.status(403).json({ error: 'Saved history is a Pro plan feature.' });
  }

  const { data, error } = await supabaseAdmin
    .from('analysis_runs')
    .select('*')
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
    .single();

  if (error || !data) {
    return res.status(404).json({ error: 'Run not found.' });
  }

  res.json(data);
});

// DELETE /api/runs/:id — delete a saved run
app.delete('/api/runs/:id', requireAuth, async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(503).json({ error: 'Database is not configured.' });
  }

  const plan = await getPlanForUser(req.user.id, supabaseAdmin);
  if (!plan.savedHistory) {
    return res.status(403).json({ error: 'Saved history is a Pro plan feature.' });
  }

  const { error } = await supabaseAdmin
    .from('analysis_runs')
    .delete()
    .eq('id', req.params.id)
    .eq('user_id', req.user.id);

  if (error) {
    console.error('[DELETE /api/runs/:id]', error.message);
    return res.status(500).json({ error: 'Failed to delete run.' });
  }

  res.status(204).end();
});

// ---------------------------------------------------------------------------
// POST /api/ai-helper — generate a premium AI helper draft.
// Requires Pro plan.  Takes the current run data as structured input.
// AI output is downstream of the deterministic engine — it never reclassifies.
// ---------------------------------------------------------------------------
app.post('/api/ai-helper', requireAuth, async (req, res) => {
  // Plan gating — AI helpers are a Pro feature
  const plan = await getPlanForUser(req.user.id, supabaseAdmin);
  if (plan.key !== 'pro') {
    return res.status(403).json({ error: 'AI helpers are a Pro plan feature.' });
  }

  if (!aiConfigured) {
    return res.status(503).json({ error: 'AI provider is not configured.' });
  }

  const { helperType, runData } = req.body || {};

  if (!helperType || !VALID_HELPER_TYPES.has(helperType)) {
    return res.status(400).json({
      error: `Invalid helper type. Valid types: ${[...VALID_HELPER_TYPES].join(', ')}`,
    });
  }

  if (!runData || !runData.summary || !Array.isArray(runData.results)) {
    return res.status(400).json({ error: 'runData with summary and results is required.' });
  }

  try {
    const result = await generateHelper(helperType, runData);

    // Telemetry — log which helper was used (no PII, no content)
    const safe = {
      ts:    new Date().toISOString(),
      event: 'ai_helper_generated',
      props: {
        helper_type: helperType,
        model:       result.model,
        tokens:      result.usage?.total_tokens || 0,
        part_count:  runData.summary?.total || 0,
      }
    };
    console.log('EVENT', JSON.stringify(safe));

    res.json({
      text:       result.text,
      model:      result.model,
      helperType: helperType,
      label:      HELPER_TYPES[helperType].label,
      disclaimer: 'This is an AI-generated draft for human review. Verify all details before sending or acting on this content.',
    });
  } catch (err) {
    console.error('[POST /api/ai-helper]', err.message);
    res.status(502).json({
      error: 'AI generation failed. The provider may be temporarily unavailable. Please try again.',
    });
  }
});

// GET /api/ai-helper/types — returns available helper types and whether AI is configured.
app.get('/api/ai-helper/types', (_req, res) => {
  res.json({
    configured: aiConfigured,
    types: Object.entries(HELPER_TYPES).map(([key, val]) => ({
      key,
      label:       val.label,
      description: val.description,
    })),
  });
});

// ---------------------------------------------------------------------------
// Rate limiter — /upload only
// Applied as route-level middleware so /api/config, /api/event, and static
// files are not affected.  In-memory store is correct for a single-instance
// beta deployment; swap to a Redis store if you ever run multiple processes.
// ---------------------------------------------------------------------------
const uploadLimiter = rateLimit({
  windowMs:         cfg.UPLOAD_RATE_WINDOW * 60 * 1000,
  max:              cfg.UPLOAD_RATE_MAX,
  standardHeaders:  true,   // sends RateLimit-* headers (RFC 6585-draft)
  legacyHeaders:    false,  // suppresses deprecated X-RateLimit-* headers
  handler: (_req, res) => {
    res.status(429).json({
      error:
        `Upload limit reached. You can upload up to ${cfg.UPLOAD_RATE_MAX} files ` +
        `every ${cfg.UPLOAD_RATE_WINDOW} minutes. Please wait a moment and try again.`
    });
  }
});

// ---------------------------------------------------------------------------
// POST /upload  — main endpoint
// ---------------------------------------------------------------------------
app.post('/upload', uploadLimiter, (req, res) => {
  // Enforce a hard timeout on this endpoint so a stall in csv-parser or
  // analyzeRows (e.g. a very large file on a slow pilot machine) cannot
  // hold the connection open indefinitely.  30 seconds is generous for any
  // file that would realistically be uploaded via a browser form.
  res.setTimeout(30_000, () => {
    if (req.file) fs.unlink(req.file.path, () => {});
    if (!res.headersSent)
      res.status(503).json({ error: 'Analysis timed out. The 5 MB limit supports roughly 50,000 rows. Try splitting the file into smaller batches (e.g. one product family or site at a time) and re-uploading.' });
  });

  // Run multer as a middleware manually so we can return structured JSON on
  // multer-level errors (file-type rejection, size limit, missing file).
  const singleUpload = upload.single('csvfile');

  singleUpload(req, res, (err) => {
    // --- multer / pre-parse errors -------------------------------------------
    if (err) {
      if (err instanceof multer.MulterError) {
        // Clean up any partial file multer may have written before the limit fired.
        // diskStorage writes the file to disk as it streams; LIMIT_FILE_SIZE can
        // trigger mid-write, leaving an orphaned partial file if not removed.
        if (req.file) fs.unlink(req.file.path, () => {});
        const msg = err.code === 'LIMIT_FILE_SIZE'
          ? `File is too large. Maximum allowed size is ${MAX_BYTES / (1024 * 1024)} MB.`
          : err.message || 'File upload error.';
        return res.status(400).json({ error: msg });
      }
      if (req.file) fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: err.message || 'File upload error.' });
    }

    // --- empty / missing upload ----------------------------------------------
    if (!req.file) {
      return res.status(400).json({ error: 'No file was uploaded. Please select a CSV file.' });
    }

    const filePath = req.file.path;

    // --- parse & analyze -----------------------------------------------------
    ingestCSV(filePath, async (parseErr, rows, ingestMeta) => {
      // Always clean up the temp file regardless of outcome
      fs.unlink(filePath, () => {});

      if (parseErr) {
        return res.status(422).json({ error: parseErr });
      }

      if (rows.length === 0) {
        return res.status(422).json({ error: 'The uploaded CSV contains no data rows.' });
      }

      // Drop structurally blank rows before analysis.
      // Some ERP exports include trailing blank lines, separator rows, or
      // page-break rows that csv-parser emits as rows with every field = ''.
      // Counting them as Invalid would mislead the summary metrics.
      const dataRows = rows.filter(row =>
        Object.values(row).some(v => v !== null && String(v).trim() !== '')
      );

      if (dataRows.length === 0) {
        return res.status(422).json({ error: 'The uploaded CSV contains no data rows.' });
      }

      // Delimiter detection: if the file parsed into exactly one column per row
      // AND that column key contains a semicolon, tab, or pipe, the user almost
      // certainly has a European/tab-delimited export saved with a .csv extension.
      // Give a specific, actionable error instead of the generic 'missing columns'.
      const parsedKeys = Object.keys(dataRows[0]);
      if (parsedKeys.length === 1) {
        const singleKey = parsedKeys[0];
        if (/;/.test(singleKey)) {
          return res.status(422).json({
            error:
              'This file appears to use semicolons (;) as the column delimiter. ' +
              'OpsCopilot-Lite expects standard comma-separated CSV. ' +
              'In Excel: File → Save As → “CSV (Comma delimited) (*.csv)”. ' +
              'In SAP: set the field delimiter to comma before exporting.'
          });
        }
        if (/\t/.test(singleKey)) {
          return res.status(422).json({
            error:
              'This file appears to use tabs as the column delimiter. ' +
              'OpsCopilot-Lite expects comma-separated CSV. ' +
              'Open the file in Excel and save as “CSV (Comma delimited) (*.csv)”.'
          });
        }
        if (/\|/.test(singleKey)) {
          return res.status(422).json({
            error:
              'This file appears to use pipes (|) as the column delimiter. ' +
              'OpsCopilot-Lite expects comma-separated CSV. ' +
              'Open the file in Excel or a text editor and save as comma-delimited CSV.'
          });
        }
      }

      // Schema validation — check required columns exist, honouring aliases.
      // resolveHeaders maps raw CSV headers to canonical names using the alias
      // table in columnMap.js.  If any required field is absent even after
      // alias resolution, return a 422 with the full list of accepted names
      // so the user knows exactly what to rename.
      // The resolved mapping is passed directly into analyzeRows, avoiding a
      // second resolveHeaders call inside the analyzer for the same batch.
      const { mapping, aliases, missing } = resolveHeaders(Object.keys(dataRows[0]));
      if (missing.length > 0) {
        const FRIENDLY_FIELD = {
          part_number: 'Part Number',
          on_hand:     'Quantity on Hand',
          daily_usage: 'Daily Usage',
          lead_time:   'Lead Time (calendar days)'
        };
        const FIELD_EXAMPLES = {
          part_number: 'Part No, Item, SKU, Material',
          on_hand:     'QTY ON HAND, On Hand, Stock, Balance',
          daily_usage: 'Avg Daily Usage, ADU, Consumption',
          lead_time:   'Lead Time, LT, LT Days'
        };
        const hints = missing
          .map(f => `${FRIENDLY_FIELD[f] || f} (e.g. ${FIELD_EXAMPLES[f] || acceptedNames(f)})`)
          .join('; ');
        return res.status(422).json({
          error:
            `This file is missing required column${missing.length > 1 ? 's' : ''}: ${hints}. ` +
            `Download the sample CSV for the full list of accepted column names.`
        });
      }

      // All checks passed — run the analyzer
      let result;
      try {
        result = analyzeRows(dataRows, { mapping, aliases });
      } catch (analyzeErr) {
        console.error('[/upload] analyzeRows threw:', analyzeErr);
        return res.status(500).json({ error: 'Analysis failed due to an internal error. Please try again.' });
      }

      // Apply plan limits: truncate results for free plan and annotate the
      // response with plan/entitlement metadata for the frontend.
      // Resolve per-user plan if authenticated, else fall back to env-var default
      const authHeader = req.headers.authorization || '';
      const authToken  = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
      let uploadPlan = getPlan();
      try {
        if (authToken && supabaseAdmin) {
          const { user: authUser } = await verifyToken(authToken);
          if (authUser) uploadPlan = await getPlanForUser(authUser.id, supabaseAdmin);
        }
      } catch (planErr) {
        console.error('[/upload] plan resolution error:', planErr.message);
        // Fall through with default plan — don't block the analysis
      }
      applyPlanLimits(uploadPlan, result);

      // Include ingest metadata in the response so the frontend can surface
      // preamble-skip notices and encoding information to the user.
      result.preambleRowsSkipped = ingestMeta.preambleRowsSkipped;
      result.encodingDetected    = ingestMeta.encoding;

      return res.json(result);
    });
  });
});

// ---------------------------------------------------------------------------
// Global error handler — catches unhandled throws in async routes so they
// return structured JSON instead of the default Express HTML error page.
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
// Ensure uploads directory exists at startup
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

app.listen(PORT, () => {
  console.log(`OpsCopilot-Lite running at http://localhost:${PORT}`);
});
