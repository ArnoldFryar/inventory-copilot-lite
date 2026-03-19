'use strict';

// ---------------------------------------------------------------------------
// support route — Contact Support form submission.
//
// POST /api/support
//   Body: { name, email, subject, message, metadata? }
//   Auth: optional — metadata.userEmail is passed from the client if signed in.
//
// Sends a formatted support email via SendGrid HTTP Web API (HTTPS/443).
// Falls back to console.log in development when API key is not configured.
//
// Required env vars:
//   SUPPORT_SMTP_PASS   — SendGrid API key (starts with SG.)
//   SUPPORT_EMAIL_FROM  — verified sender address, e.g. noreply@myopscopilot.com
//   SUPPORT_EMAIL_TO    — inbox that receives support requests (optional,
//                         defaults to support@myopscopilot.com)
//
// NOTE: nodemailer SMTP was removed because Railway blocks outbound TCP 587.
//       @sendgrid/mail uses HTTPS (port 443) which is always available.
// ---------------------------------------------------------------------------

const express   = require('express');
const rateLimit = require('express-rate-limit');
const sgMail    = require('@sendgrid/mail');
const router    = express.Router();

const DEST_EMAIL = (process.env.SUPPORT_EMAIL_TO || 'support@myopscopilot.com').trim();

const sgConfigured = Boolean(process.env.SUPPORT_SMTP_PASS);

if (!sgConfigured) {
  console.warn('[startup] SUPPORT_SMTP_PASS (SendGrid API key) not set — support emails will be logged only.');
} else {
  sgMail.setApiKey(process.env.SUPPORT_SMTP_PASS);
  console.log('[startup] SendGrid HTTP API configured — key prefix:', process.env.SUPPORT_SMTP_PASS.slice(0, 6));
}

// ---------------------------------------------------------------------------
// Rate limit — 5 submissions per IP per 15 minutes.
// ---------------------------------------------------------------------------
const supportRateLimit = rateLimit({
  windowMs:        15 * 60 * 1000,
  max:             5,
  standardHeaders: true,
  legacyHeaders:   false,
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

    // ── Payload presence log ────────────────────────────────────────────
    console.log('[support] payload:', {
      name:    name    ? 'present' : 'MISSING',
      email:   email   ? 'present' : 'MISSING',
      subject: subject ? 'present' : 'MISSING',
      message: message ? 'present' : 'MISSING',
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

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      return res.status(400).json({ error: 'Invalid email address.' });
    }

    if (name.length    > 120)  return res.status(400).json({ error: 'Name is too long (max 120 characters).' });
    if (email.length   > 254)  return res.status(400).json({ error: 'Email address is too long.' });
    if (subject.length > 200)  return res.status(400).json({ error: 'Subject is too long (max 200 characters).' });
    if (message.length > 4000) return res.status(400).json({ error: 'Message is too long (max 4000 characters).' });

    console.log('[support] payload validated');

    // ── Sanitise inputs ─────────────────────────────────────────────────
    const fromName    = name.trim();
    const fromEmail   = email.trim().toLowerCase();
    const subjectText = subject.trim();
    const bodyText    = message.trim();
    const timestamp   = new Date().toISOString();

    const meta      = (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) ? metadata : {};
    const pageUrl   = typeof meta.pageUrl   === 'string' ? meta.pageUrl.slice(0, 200)   : '';
    const userEmail = typeof meta.userEmail === 'string' ? meta.userEmail.slice(0, 254) : '';

    // ── Build email content ─────────────────────────────────────────────
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

    // ── Send or log ─────────────────────────────────────────────────────
    console.log('[support] sgConfigured:', sgConfigured);

    if (!sgConfigured) {
      console.log('[support] SendGrid not configured — logging message (dev mode)');
      console.log(textBody);
      console.log('[support] response sent — 200 ok:true (dev)');
      return res.json({ ok: true });
    }

    const fromAddress = (process.env.SUPPORT_EMAIL_FROM || '').trim() || `noreply@myopscopilot.com`;

    const msg = {
      to:      DEST_EMAIL,
      from:    { name: 'OpsCopilot Support', email: fromAddress },
      replyTo: { name: fromName, email: fromEmail },
      subject: subjectLine,
      text:    textBody,
      html:    htmlBody,
    };

    console.log('[support] sendMail starting → SendGrid HTTP API →', DEST_EMAIL);
    await sgMail.send(msg);

    console.log('[support] sendMail success — from:', fromEmail, 'subject:', subjectText);
    console.log('[support] response sent — 200 ok:true');
    return res.json({ ok: true });

  } catch (err) {
    const code    = err.code || (err.response && err.response.status) || '';
    const sgBody  = err.response && err.response.body ? JSON.stringify(err.response.body) : '';
    console.error('[support] sendMail failure — code:', code, 'message:', err.message, sgBody ? 'body:' + sgBody : '');
    console.log('[support] response sent — 502 ok:false');
    if (!res.headersSent) {
      res.status(502).json({ ok: false, error: 'Support email failed to send' });
    }
  }
});

module.exports = router;
