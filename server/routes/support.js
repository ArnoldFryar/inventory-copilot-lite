'use strict';

// ---------------------------------------------------------------------------
// support route — Contact Support form submission.
//
// POST /api/support
//   Body: { name, email, subject, message, metadata? }
//   Auth: optional — metadata.userEmail is passed from the client if signed in.
//
// Sends a formatted support email to support@myopscopilot.com via SMTP.
// Falls back to console.log in development when SMTP is not configured.
//
// Required env vars (SMTP):
//   SUPPORT_SMTP_HOST   — e.g. smtp.sendgrid.net
//   SUPPORT_SMTP_PORT   — default 587
//   SUPPORT_SMTP_USER   — SMTP auth username
//   SUPPORT_SMTP_PASS   — SMTP auth password / API key
//   SUPPORT_EMAIL_FROM  — sender address, e.g. noreply@myopscopilot.com
//                         defaults to SUPPORT_SMTP_USER
// ---------------------------------------------------------------------------

const express    = require('express');
const rateLimit  = require('express-rate-limit');
const nodemailer = require('nodemailer');
const router     = express.Router();

const SMTP_TIMEOUT_MS = 15_000;   // 15-second hard cap on SMTP send
const DEST_EMAIL = (process.env.SUPPORT_EMAIL_TO || 'support@myopscopilot.com').trim();

const smtpConfigured = Boolean(
  process.env.SUPPORT_SMTP_HOST &&
  process.env.SUPPORT_SMTP_USER &&
  process.env.SUPPORT_SMTP_PASS
);

if (!smtpConfigured) {
  console.warn('[startup] SUPPORT_SMTP_HOST/USER/PASS not set — support emails will be logged only.');
} else {
  // Verify SMTP credentials at startup so misconfiguration surfaces immediately.
  const t = nodemailer.createTransport({
    host:   process.env.SUPPORT_SMTP_HOST,
    port:   Number(process.env.SUPPORT_SMTP_PORT || 587),
    secure: Number(process.env.SUPPORT_SMTP_PORT || 587) === 465,
    auth: { user: process.env.SUPPORT_SMTP_USER, pass: process.env.SUPPORT_SMTP_PASS },
    connectionTimeout: 10_000,
    greetingTimeout:   10_000,
  });
  t.verify()
    .then(() => console.log('[startup] SMTP transport verified OK'))
    .catch(err => console.error('[startup] SMTP transport verification FAILED:', err.message));
}

// Lazy singleton transporter — created only when SMTP is configured.
let _transporter = null;
function getTransporter() {
  if (_transporter) return _transporter;
  _transporter = nodemailer.createTransport({
    host:   process.env.SUPPORT_SMTP_HOST,
    port:   Number(process.env.SUPPORT_SMTP_PORT || 587),
    secure: Number(process.env.SUPPORT_SMTP_PORT || 587) === 465,
    auth: {
      user: process.env.SUPPORT_SMTP_USER,
      pass: process.env.SUPPORT_SMTP_PASS,
    },
    connectionTimeout: 10_000,
    greetingTimeout:   10_000,
    socketTimeout:     15_000,
  });
  return _transporter;
}

// ---------------------------------------------------------------------------
// Rate limit — 5 submissions per IP per 15 minutes.
// Tighter than the default AI route limit to discourage spam.
// ---------------------------------------------------------------------------
const supportRateLimit = rateLimit({
  windowMs:       15 * 60 * 1000,
  max:            5,
  standardHeaders: true,
  legacyHeaders:  false,
  message: { error: 'Too many requests. Please wait before trying again.' },
  validate: { xForwardedForHeader: false },
});

// ---------------------------------------------------------------------------
// HTML escaping — prevent XSS in outbound email body.
// ---------------------------------------------------------------------------
function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// POST /api/support
// ---------------------------------------------------------------------------
router.post('/api/support', supportRateLimit, async (req, res) => {
  console.log('[support] POST /api/support hit — method:', req.method);

  try {
    const { name, email, subject, message, metadata } = req.body || {};

    // ── Debug: payload presence ─────────────────────────────────────────
    console.log('[support] payload:', {
      name:    name    ? 'present' : 'MISSING',
      email:   email   ? 'present' : 'MISSING',
      subject: subject ? 'present' : 'MISSING',
      message: message ? 'present' : 'MISSING',
    });

    // ── Debug: SMTP env var presence ────────────────────────────────────
    console.log('[support] SMTP config:', {
      SUPPORT_SMTP_HOST:  process.env.SUPPORT_SMTP_HOST  ? 'set' : 'MISSING',
      SUPPORT_SMTP_PORT:  process.env.SUPPORT_SMTP_PORT  ? 'set' : 'MISSING',
      SUPPORT_SMTP_USER:  process.env.SUPPORT_SMTP_USER  ? 'set' : 'MISSING',
      SUPPORT_SMTP_PASS:  process.env.SUPPORT_SMTP_PASS  ? 'set' : 'MISSING',
      SUPPORT_EMAIL_FROM: process.env.SUPPORT_EMAIL_FROM ? 'set' : 'MISSING',
      smtpConfigured:     smtpConfigured,
    });

    // ── Required field validation ──────────────────────────────────────
    const missing = [];
    if (!name    || typeof name    !== 'string' || !name.trim())    missing.push('name');
    if (!email   || typeof email   !== 'string' || !email.trim())   missing.push('email');
    if (!subject || typeof subject !== 'string' || !subject.trim()) missing.push('subject');
    if (!message || typeof message !== 'string' || !message.trim()) missing.push('message');

    if (missing.length) {
      console.log('[support] validation failed — missing:', missing);
      return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}.` });
    }

    // ── Email format ───────────────────────────────────────────────────
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      return res.status(400).json({ error: 'Invalid email address.' });
    }

    // ── Length limits ──────────────────────────────────────────────────
    if (name.length    > 120)  return res.status(400).json({ error: 'Name is too long (max 120 characters).' });
    if (email.length   > 254)  return res.status(400).json({ error: 'Email address is too long.' });
    if (subject.length > 200)  return res.status(400).json({ error: 'Subject is too long (max 200 characters).' });
    if (message.length > 4000) return res.status(400).json({ error: 'Message is too long (max 4000 characters).' });

    console.log('[support] payload validated');

  // ── Sanitise inputs ───────────────────────────────────────────────────
  const fromName    = name.trim();
  const fromEmail   = email.trim().toLowerCase();
  const subjectText = subject.trim();
  const bodyText    = message.trim();
  const timestamp   = new Date().toISOString();

  // Optional metadata — never trusted for routing, display-only
  const meta      = (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) ? metadata : {};
  const pageUrl   = typeof meta.pageUrl   === 'string' ? meta.pageUrl.slice(0, 200)   : '';
  const userEmail = typeof meta.userEmail === 'string' ? meta.userEmail.slice(0, 254) : '';

  // ── Build email content ───────────────────────────────────────────────
  const subjectLine = `[Support] ${subjectText}`;

  const metaRows = [
    `<tr><td style="padding:4px 0;font-size:12px;color:#475569;width:130px;vertical-align:top;">Timestamp</td><td style="padding:4px 0;font-size:12px;color:#94a3b8;">${esc(timestamp)}</td></tr>`,
    pageUrl   ? `<tr><td style="padding:4px 0;font-size:12px;color:#475569;vertical-align:top;">Page URL</td><td style="padding:4px 0;font-size:12px;color:#94a3b8;">${esc(pageUrl)}</td></tr>` : '',
    userEmail ? `<tr><td style="padding:4px 0;font-size:12px;color:#475569;vertical-align:top;">User Account</td><td style="padding:4px 0;font-size:12px;color:#94a3b8;">${esc(userEmail)}</td></tr>` : '',
  ].filter(Boolean).join('\n');

  const htmlBody = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8" /></head>
<body style="margin:0;padding:24px;background:#080c18;font-family:Inter,Helvetica,Arial,sans-serif;">
<div style="max-width:580px;margin:0 auto;background:#111827;border-radius:12px;overflow:hidden;border:1px solid rgba(255,255,255,0.10);">

  <div style="background:linear-gradient(135deg,#0f766e 0%,#115e59 100%);padding:24px 28px;">
    <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:rgba(255,255,255,0.65);">OpsCopilot</p>
    <h1 style="margin:0;font-size:20px;font-weight:700;color:#fff;">Support Request</h1>
  </div>

  <div style="padding:28px;">
    <table style="width:100%;border-collapse:collapse;margin-bottom:24px;border-radius:8px;overflow:hidden;">
      <tr style="border-bottom:1px solid rgba(255,255,255,0.07);">
        <td style="padding:10px 0;font-size:12px;color:#64748b;font-weight:600;width:90px;">Name</td>
        <td style="padding:10px 0;font-size:14px;color:#e2e8f0;">${esc(fromName)}</td>
      </tr>
      <tr style="border-bottom:1px solid rgba(255,255,255,0.07);">
        <td style="padding:10px 0;font-size:12px;color:#64748b;font-weight:600;">Email</td>
        <td style="padding:10px 0;font-size:14px;color:#e2e8f0;">${esc(fromEmail)}</td>
      </tr>
      <tr>
        <td style="padding:10px 0;font-size:12px;color:#64748b;font-weight:600;">Subject</td>
        <td style="padding:10px 0;font-size:14px;color:#e2e8f0;">${esc(subjectText)}</td>
      </tr>
    </table>

    <p style="margin:0 0 10px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;color:#64748b;">Message</p>
    <div style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:16px;font-size:14px;line-height:1.65;color:#cbd5e1;white-space:pre-wrap;">${esc(bodyText)}</div>

    <div style="margin-top:24px;padding-top:20px;border-top:1px solid rgba(255,255,255,0.07);">
      <p style="margin:0 0 10px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;color:#64748b;">Metadata</p>
      <table style="width:100%;border-collapse:collapse;">
        ${metaRows}
      </table>
    </div>
  </div>
</div>
</body>
</html>`;

  const textBody = [
    'SUPPORT REQUEST — OpsCopilot',
    '',
    `From:    ${fromName}`,
    `Email:   ${fromEmail}`,
    `Subject: ${subjectText}`,
    '',
    '--- Message ---',
    bodyText,
    '',
    '--- Metadata ---',
    `Timestamp:    ${timestamp}`,
    pageUrl   ? `Page URL:     ${pageUrl}`   : null,
    userEmail ? `User Account: ${userEmail}` : null,
  ].filter(line => line !== null).join('\n');

  // ── Send or log ─────────────────────────────────────────────────────────
  console.log('[support] smtp config validated — smtpConfigured:', smtpConfigured);

  if (!smtpConfigured) {
    console.log('[support] SMTP not configured — logging message (dev mode)');
    console.log(textBody);
    console.log('[support] response sent — 200 ok:true (dev)');
    return res.json({ ok: true });
  }

  try {
    console.log('[support] sendMail starting →', DEST_EMAIL);
    const fromAddress = (process.env.SUPPORT_EMAIL_FROM || process.env.SUPPORT_SMTP_USER).trim();
    const mailOpts = {
      from:    `"${fromName.replace(/"/g, '')}" <${fromAddress}>`,
      replyTo: `"${fromName.replace(/"/g, '')}" <${fromEmail}>`,
      to:      DEST_EMAIL,
      subject: subjectLine,
      text:    textBody,
      html:    htmlBody,
    };

    const smtpTimeout = new Promise(function (_, reject) {
      setTimeout(function () { reject(new Error('SMTP_TIMEOUT')); }, SMTP_TIMEOUT_MS);
    });

    await Promise.race([getTransporter().sendMail(mailOpts), smtpTimeout]);

    console.log('[support] sendMail success — from:', fromEmail, 'subject:', subjectText);
    console.log('[support] response sent — 200 ok:true');
    return res.json({ ok: true });
  } catch (err) {
    if (err.message === 'SMTP_TIMEOUT') {
      console.error('[support] sendMail timeout after ' + SMTP_TIMEOUT_MS + 'ms');
    } else {
      console.error('[support] sendMail failure:', err.message);
    }
    console.log('[support] response sent — 502 ok:false');
    return res.status(502).json({ ok: false, error: 'Support email failed to send' });
  }

  } catch (outerErr) {
    // Top-level catch — prevents Express 4 async handler from hanging
    console.error('[support] unhandled route error:', outerErr);
    if (!res.headersSent) {
      res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
    }
  }
});

module.exports = router;
