const nodemailer = require('nodemailer');
const crypto = require('crypto');
const { pool } = require('../config/database');

// ── Inbound-email plumbing ───────────────────────────────────────────────────
// Each outgoing email carries a Message-ID encoded with enough context for
// the inbound parser to figure out which template + which ticket/customer
// the customer is replying to. The format is intentionally non-PII (no
// names or emails) and short enough to fit RFC 5322's 998-char Message-ID
// line.
//
// Format examples:
//   <ticket.1234.a8f3.1717abcdef@anutech.in>         (template tied to a ticket)
//   <notify.welcome_setup_link.c0.5e92.1717a@anutech.in>  (notification email,
//                                                          c0 = customer id)
//
// The 4-char hex hash protects against malicious "change the ticket number"
// attempts: the inbound parser recomputes it from the secret + ticket id and
// rejects mismatches.

function getMessageDomain() {
  const fromAddr = (process.env.EMAIL_FROM || '').match(/<([^>]+)>/)?.[1]
                || process.env.EMAIL_FROM || 'anutech.in';
  return fromAddr.split('@')[1] || 'anutech.in';
}

// Process-level memo so every hash call in the same process sees the same
// secret. Without this, the settings cache TTL races with the first-use
// generate-and-insert: two calls in quick succession would both miss the
// cache, both generate, and end up with different secrets → ticket hashes
// produced by makeOutgoingMessageId don't verify in verifyTicketHash.
let _inboundSecretCached = null;
async function inboundSecret() {
  if (_inboundSecretCached) return _inboundSecretCached;
  try {
    const { getSetting, invalidateAllSettingsCache } = require('./settings');
    let s = (await getSetting('inbound_secret', '')).toString();
    if (!s) {
      s = crypto.randomBytes(16).toString('hex');
      await pool.query(
        'INSERT INTO admin_settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = value',
        ['inbound_secret', s]
      );
      // Re-read to pick up whatever was actually persisted (handles concurrent
      // inserts from a parallel process — both end up using the winner).
      invalidateAllSettingsCache();
      s = (await getSetting('inbound_secret', s)).toString();
    }
    _inboundSecretCached = s;
    return s;
  } catch {
    return 'dev-secret';
  }
}

async function ticketHash(ticketId) {
  const secret = await inboundSecret();
  return crypto.createHash('sha256')
    .update(`${ticketId}:${secret}`).digest('hex').slice(0, 4);
}

exports.makeTicketSubjectPrefix = async (ticketId) => {
  if (!ticketId) return '';
  const h = await ticketHash(ticketId);
  return `[Ticket #${ticketId}-${h}] `;
};

exports.makeOutgoingMessageId = async ({ templateKey, ticketId, customerId, customerUserId }) => {
  const domain = getMessageDomain();
  const ts = Date.now().toString(36); // compact timestamp helps with uniqueness
  const rand = crypto.randomBytes(2).toString('hex');
  if (ticketId) {
    const h = await ticketHash(ticketId);
    return `<ticket.${ticketId}.${h}.${ts}${rand}@${domain}>`;
  }
  const cid = customerId || customerUserId || 0;
  return `<notify.${templateKey}.c${cid}.${ts}${rand}@${domain}>`;
};

// Parsed back by the inbound worker. Returns { kind, ticketId?, hash?, templateKey?, customerId? }
exports.parseMessageId = (messageId) => {
  if (!messageId) return null;
  const inner = messageId.replace(/^<|>$/g, '').split('@')[0];
  const parts = inner.split('.');
  if (parts[0] === 'ticket' && parts.length >= 3) {
    const ticketId = Number(parts[1]);
    const hash = parts[2];
    if (!ticketId || !hash) return null;
    return { kind: 'ticket', ticketId, hash };
  }
  if (parts[0] === 'notify' && parts.length >= 3) {
    const templateKey = parts[1];
    const cidStr = parts[2].startsWith('c') ? parts[2].slice(1) : '';
    const customerId = Number(cidStr) || null;
    return { kind: 'notify', templateKey, customerId };
  }
  return null;
};

exports.verifyTicketHash = async (ticketId, hash) => {
  if (!ticketId || !hash) return false;
  return (await ticketHash(ticketId)) === hash;
};


const enabled = process.env.SMTP_ENABLED !== 'false';

// ── Admin-editable template machinery ────────────────────────────────────────
// Templates live in the email_templates DB table. Each function below first
// tries to load its template by key and render it; if no row exists, it falls
// back to the original hardcoded HTML. That means: shipping this code with an
// empty table is a no-op (same emails as before), and admin "Reset to default"
// = DELETE the row.
//
// In-memory cache to avoid one round-trip per email. 60s TTL; the admin
// controller calls clearTemplateCache(key) after a save so changes are
// immediate from the admin's perspective.
const _templateCache = new Map(); // key → { row, expiresAt }
const TEMPLATE_TTL_MS = 60_000;

async function loadTemplate(key) {
  const cached = _templateCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.row;
  try {
    const [[row]] = await pool.query(
      'SELECT subject, body_html FROM email_templates WHERE template_key = ?',
      [key]
    );
    _templateCache.set(key, { row: row || null, expiresAt: Date.now() + TEMPLATE_TTL_MS });
    return row || null;
  } catch {
    return null;
  }
}

function renderTemplate(str, vars) {
  // {{var}} substitution. Missing vars render as empty string so a partially-
  // filled admin template doesn't leave literal "{{foo}}" in the email body.
  return String(str).replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name) => {
    const v = vars[name];
    return v == null ? '' : String(v);
  });
}

exports.clearTemplateCache = (key) => {
  if (key) _templateCache.delete(key);
  else _templateCache.clear();
};

// Single source of truth for what's editable + what {{vars}} each template
// supports. The admin UI reads this via GET /api/admin/email-templates to
// render its variable-picker sidebar and the per-template label.
// Shared variable hints — every template's `variables` field references these
// by name so descriptions stay consistent across templates that share a var
// (e.g. ticketId means the same thing everywhere).
const VAR_HINTS = {
  name:               'Recipient\'s name',
  customerName:       'Customer\'s display name',
  agentName:          'Agent\'s name',
  loginEmail:         'Recipient\'s login email',
  ticketId:           'Ticket id (e.g. 1234)',
  subject:            'Ticket subject line',
  description:        'Ticket description body',
  message:            'Reply message body',
  ticketLink:         'URL — view this ticket in the customer portal',
  ticketsLink:        'URL — admin tickets list',
  agentLink:          'URL — agent console',
  panelLink:          'URL — customer portal home',
  callLink:           'URL — customer Call page',
  setupUrl:           'One-time link for the customer to set their password (24h expiry)',
  loginUrl:           'URL — login page',
  password:           'Generated or admin-typed password',
  otp:                '6-digit one-time login code',
  onboardingTicketId: 'Onboarding ticket id (if one was created)',
  callLimit:          'Plan\'s monthly call limit',
  chatLimit:          'Plan\'s monthly chat limit',
  chatId:             'Chat id (e.g. 87)',
  transcriptHtml:     'Pre-rendered transcript HTML (insert as-is, don\'t wrap)',
  priority:           'Ticket priority (low / normal / medium / high)',
  breachType:         '"Response" or "Resolution"',
  roleLabel:          '"Agent" or "Admin"',
  accountKind:        '"an agent" or "an admin" (grammar helper)',
  onboardingNote:     'Pre-rendered onboarding instructions paragraph',
  planLabel:          'Plan display name (e.g. "Premium")',
  amount:             'Amount paid, formatted with currency (e.g. "₹4,999")',
  expiryDate:         'New plan expiry date (e.g. "11 Jun 2027")',
  paymentRef:         'Razorpay payment ID — customer can quote this if there\'s a dispute',
  customerEmail:      'Customer\'s login / billing email address',
  reportsLink:        'URL — admin Reports → Revenue tab',
  lastError:          'Last error message from the billing-app sync attempt',
  syncsLink:          'URL — admin Pending Billing Syncs page',
  lapsedListHtml:     'Pre-rendered HTML list of lapsed customers (insert as-is)',
};
// Tiny helper so each entry below stays readable.
const v = (...names) => names.map(n => ({ name: n, hint: VAR_HINTS[n] || '' }));

exports.TEMPLATE_REGISTRY = [
  // ── Customer (account lifecycle) ──────────────────────────────────────────
  {
    key: 'welcome_setup_link',
    label: 'Welcome — set-up link',
    audience: 'Customer',
    category: 'Account',
    description: 'Sent when a new customer is created and needs to set their own password via a one-time link.',
    variables: v('name', 'setupUrl', 'loginEmail', 'onboardingTicketId'),
  },
  {
    key: 'account_ready',
    label: 'Account Ready — with password',
    audience: 'Customer',
    category: 'Account',
    description: 'Sent when admin creates a customer with a chosen password.',
    variables: v('name', 'loginEmail', 'password', 'loginUrl', 'onboardingTicketId'),
  },
  {
    key: 'otp_login',
    label: 'Login OTP',
    audience: 'Customer',
    category: 'Account',
    description: 'Sent when a customer requests an email OTP to log in.',
    variables: v('name', 'otp'),
  },
  {
    key: 'usage_reset',
    label: 'Monthly Usage Reset',
    audience: 'Customer',
    category: 'Account',
    description: 'Sent when admin manually resets a customer\'s monthly call/chat quota.',
    variables: v('customerName', 'callLimit', 'chatLimit', 'panelLink'),
  },

  // ── Customer (ticket lifecycle) ───────────────────────────────────────────
  {
    key: 'ticket_created',
    label: 'Ticket Created',
    audience: 'Customer',
    category: 'Ticket',
    description: 'Sent when a customer raises a new ticket.',
    variables: v('customerName', 'ticketId', 'subject', 'description', 'ticketLink'),
  },
  {
    key: 'agent_reply',
    label: 'Agent Replied on Ticket',
    audience: 'Customer',
    category: 'Ticket',
    description: 'Sent when an agent posts a reply on a ticket.',
    variables: v('customerName', 'ticketId', 'subject', 'agentName', 'message', 'ticketLink'),
  },
  {
    key: 'rating_request',
    label: 'CSAT Rating Request',
    audience: 'Customer',
    category: 'Ticket',
    description: 'Sent after a ticket is closed asking the customer to rate the experience.',
    variables: v('customerName', 'ticketId', 'subject', 'ticketLink'),
  },
  {
    key: 'cc_added_to_ticket',
    label: 'You\'ve been added as CC',
    audience: 'CC Recipient',
    category: 'Ticket',
    description: 'Sent to an external email address when added as a CC on a ticket.',
    variables: v('customerName', 'ticketId', 'subject'),
  },

  // ── Customer (chat / call) ────────────────────────────────────────────────
  {
    key: 'chat_transcript',
    label: 'Chat Transcript',
    audience: 'Customer',
    category: 'Chat & Call',
    description: 'Emailed to the customer (and optionally agent) after a live chat ends, with the full transcript.',
    variables: v('customerName', 'agentName', 'chatId', 'transcriptHtml'),
  },
  {
    key: 'call_missed',
    label: 'Missed Call Notification',
    audience: 'Customer',
    category: 'Chat & Call',
    description: 'Sent when a customer\'s incoming call rang out without being answered.',
    variables: v('customerName', 'callLink'),
  },

  // ── Agent ─────────────────────────────────────────────────────────────────
  {
    key: 'agent_welcome',
    label: 'Agent Account Created',
    audience: 'Agent',
    category: 'Team',
    description: 'Sent when admin creates a new agent or admin account.',
    variables: v('name', 'loginEmail', 'password', 'roleLabel', 'accountKind', 'onboardingNote', 'loginUrl'),
  },
  {
    key: 'customer_reply_to_agent',
    label: 'Customer Replied to Ticket',
    audience: 'Agent',
    category: 'Ticket',
    description: 'Sent to the assigned agent (and CC aliases) when the customer adds a reply.',
    variables: v('agentName', 'customerName', 'ticketId', 'subject', 'message', 'agentLink'),
  },

  // ── Billing ───────────────────────────────────────────────────────────────
  {
    key: 'plan_upgraded_customer',
    label: 'Plan Upgraded — receipt',
    audience: 'Customer',
    category: 'Billing',
    description: 'Sent to the customer after a successful Razorpay plan upgrade. Acts as the email receipt they can forward to their accounting team.',
    variables: v('customerName', 'planLabel', 'amount', 'expiryDate', 'paymentRef', 'panelLink'),
  },

  // ── Admin ─────────────────────────────────────────────────────────────────
  {
    key: 'sla_breach_admin',
    label: 'SLA Breach Alert',
    audience: 'Admin',
    category: 'Operations',
    description: 'Sent to admins when a ticket misses its response or resolution SLA.',
    variables: v('ticketId', 'subject', 'customerName', 'priority', 'breachType', 'ticketsLink'),
  },
  {
    key: 'plan_upgraded_admin',
    label: 'New Plan Upgrade (revenue alert)',
    audience: 'Admin',
    category: 'Billing',
    description: 'Sent to every active admin when a customer completes a paid upgrade. Useful for sales tracking without having to refresh the Revenue tab.',
    variables: v('customerName', 'customerEmail', 'planLabel', 'amount', 'paymentRef', 'reportsLink'),
  },
  {
    key: 'billing_sync_failed_admin',
    label: 'Billing Sync Failed (manual reconciliation)',
    audience: 'Admin',
    category: 'Billing',
    description: 'Sent to every active admin when DSP cannot notify the billing app of a paid upgrade. Customer plan is already active in DSP — Zoho invoice is missing.',
    variables: v('customerName', 'customerEmail', 'planLabel', 'amount', 'paymentRef', 'lastError', 'syncsLink'),
  },
  {
    key: 'plan_expired_lapsed_to_free',
    label: 'Plan Expired — moved to Free',
    audience: 'Customer',
    category: 'Billing',
    description: 'Sent to the customer on the day their plan expired without renewal. Auto-moves them to the Free plan; lists what they lost + how to restore.',
    variables: v('customerName', 'planLabel', 'panelLink'),
  },
  {
    key: 'plan_lapsed_admin',
    label: 'Daily Lapsed-to-Free Digest',
    audience: 'Admin',
    category: 'Billing',
    description: 'Daily digest sent to every active admin listing customers who lapsed to Free that day. Sent only when at least one customer lapsed.',
    variables: v('lapsedListHtml', 'reportsLink'),
  },
];

// Cached nodemailer transport. Built lazily on first send, rebuilt on demand
// when admin changes any SMTP setting (invalidateTransport called from
// adminController.updateSettings).
let transporter = null;
let transportSignature = ''; // identity of the current cached transporter

// Pick a value from admin_settings if non-empty, otherwise fall back to env.
// Lets admin override SMTP via the Settings UI without touching .env, while
// keeping existing installs working with their current env-based setup.
async function pickSetting(dbKey, envKey, fallback = '') {
  try {
    const { getSetting } = require('./settings');
    const v = (await getSetting(dbKey, '')).toString();
    if (v && v.trim()) return v.trim();
  } catch {}
  return process.env[envKey] || fallback;
}

async function pickBoolSetting(dbKey, envKey, fallback) {
  try {
    const { getAllSettings } = require('./settings');
    const all = await getAllSettings();
    if (all[dbKey] !== undefined && all[dbKey] !== '') {
      return all[dbKey] === '1' || all[dbKey] === 'true';
    }
  } catch {}
  if (process.env[envKey] !== undefined) {
    return process.env[envKey] === 'true' || process.env[envKey] === '1';
  }
  return fallback;
}

async function getTransporter() {
  const host = await pickSetting('smtp_host', 'SMTP_HOST', 'smtp.gmail.com');
  const portStr = await pickSetting('smtp_port', 'SMTP_PORT', '587');
  const port = parseInt(portStr, 10) || 587;
  const user = await pickSetting('smtp_user', 'SMTP_USER', '');
  const pass = await pickSetting('smtp_password', 'SMTP_PASS', '');
  // `secure: true` = implicit TLS (port 465). `false` = STARTTLS (port 587).
  // Admin can override via the smtp_secure setting; default infers from port.
  const secure = await pickBoolSetting('smtp_secure', 'SMTP_SECURE', port === 465);
  // Rebuild the transport if any input changed since last cache.
  const sig = `${host}|${port}|${secure}|${user}|${pass}`;
  if (!transporter || sig !== transportSignature) {
    transporter = nodemailer.createTransport({
      host, port, secure,
      auth: user && pass ? { user, pass } : undefined,
    });
    transportSignature = sig;
  }
  return transporter;
}

// Called from adminController.updateSettings so SMTP edits take effect on
// the very next email send without restarting the backend.
exports.invalidateTransport = () => {
  transporter = null;
  transportSignature = '';
};

async function sendMail({ to, cc, subject, html, messageId, headers, attachments }) {
  // Read admin-controlled email settings. Cached read — minimal overhead.
  let emailsDisabled = false;
  let replyTo = '';
  let bcc = '';
  let senderName = '';
  try {
    const { getBoolSetting, getSetting } = require('./settings');
    emailsDisabled = await getBoolSetting('emails_disabled', false);
    replyTo    = (await getSetting('reply_to_email', '')).toString().trim();
    bcc        = (await getSetting('bcc_email', '')).toString().trim();
    senderName = (await getSetting('brand_sender_name', '')).toString().trim();
  } catch {}

  // Admin kill-switch: when enabled, no email leaves the system. Useful for
  // maintenance windows, staging environments, and (most importantly) the
  // "did I just blast 500 customers by accident?" panic moment.
  if (emailsDisabled) {
    console.log(`[Email suppressed — emails_disabled=1] To: ${to} | Subject: ${subject}`);
    return { ok: true, skipped: true, reason: 'emails_disabled' };
  }

  if (!enabled) {
    const ccStr = cc ? ` | CC: ${cc}` : '';
    console.log(`[Email skipped — SMTP_ENABLED=false] To: ${to}${ccStr} | Subject: ${subject}`);
    return { ok: true, skipped: true };
  }
  try {
    // Compose From: prefer the admin-set smtp_from (from the Settings UI),
    // fall back to env EMAIL_FROM, then a built-in default. The
    // brand_sender_name override below can still rename the display portion.
    let smtpFrom = '';
    try {
      const { getSetting } = require('./settings');
      smtpFrom = (await getSetting('smtp_from', '')).toString().trim();
    } catch {}
    let from = smtpFrom || process.env.EMAIL_FROM || 'Anu Tech Digital <noreply@anutechdigital.com>';
    if (senderName) {
      const addrMatch = from.match(/<([^>]+)>/);
      const addr = addrMatch ? addrMatch[1] : from;
      from = `${senderName} <${addr}>`;
    }
    const mail = { from, to, subject, html };
    if (cc) mail.cc = cc;
    if (replyTo) mail.replyTo = replyTo;
    if (bcc) mail.bcc = bcc;
    // Custom Message-ID embeds template/ticket context so the inbound parser
    // can match the customer's reply back to the right ticket via In-Reply-To.
    if (messageId) mail.messageId = messageId;
    if (headers) mail.headers = headers;
    // Reply attachments (e.g. an image the customer/agent attached). Each entry
    // is { filename, path } pointing at a file in uploads/ — nodemailer streams
    // it. CC recipients have no portal login, so attaching the file is the only
    // way they get it. Caller is responsible for any size cap.
    if (attachments && attachments.length) mail.attachments = attachments;
    const tx = await getTransporter();
    await tx.sendMail(mail);
    return { ok: true };
  } catch (err) {
    // Never crash the request if email fails — surface the cause so callers can report it
    const msg = err.message || String(err);
    console.error('[Email error]', msg);
    return { ok: false, error: msg };
  }
}

const baseStyle = `
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  background: #f4f6fb; padding: 32px 0;
`;
const cardStyle = `
  max-width: 560px; margin: 0 auto; background: #fff;
  border-radius: 12px; overflow: hidden;
  box-shadow: 0 2px 8px rgba(0,0,0,0.08);
`;
const headerStyle = `
  background: #4f46e5; padding: 24px 32px;
  color: #fff; font-size: 20px; font-weight: 700;
`;
const bodyStyle  = `padding: 28px 32px; color: #374151; font-size: 14px; line-height: 1.6;`;
const btnStyle   = `
  display: inline-block; margin-top: 20px;
  background: #4f46e5; color: #fff; text-decoration: none;
  padding: 10px 24px; border-radius: 8px; font-size: 14px; font-weight: 600;
`;
const footerStyle = `
  padding: 16px 32px; background: #f9fafb;
  font-size: 12px; color: #9ca3af; text-align: center;
`;

function wrap(headerText, body) {
  return `
    <div style="${baseStyle}">
      <div style="${cardStyle}">
        <div style="${headerStyle}">🛡️ Anu Tech Digital Pvt Ltd</div>
        <div style="${bodyStyle}">${body}</div>
        <div style="${footerStyle}">
          You received this because you have an account on the Anu Tech Digital support panel.<br>
          To reply, log in and visit your ticket page.
        </div>
      </div>
    </div>`;
}

// ── Ticket created ────────────────────────────────────────────────────────────
exports.sendTicketCreatedEmail = async ({ to, cc, customerName, ticketId, subject, description }) => {
  const ticketLink = `${process.env.FRONTEND_URL}/customer/tickets/${ticketId}`;
  const vars = { customerName, ticketId, subject, description, ticketLink };
  const messageId = await exports.makeOutgoingMessageId({ templateKey: 'ticket_created', ticketId });
  const tpl = await loadTemplate('ticket_created');
  if (tpl) {
    return sendMail({
      to, cc, messageId,
      subject: renderTemplate(tpl.subject, vars),
      html: renderTemplate(tpl.body_html, vars),
    });
  }
  // Fallback: original hardcoded template
  return sendMail({
    to, cc, messageId,
    subject: `[Ticket #${ticketId}] ${subject} — Received`,
    html: wrap('New Ticket Created', `
      <p>Hi <strong>${customerName}</strong>,</p>
      <p>Your support ticket has been created and our team will respond shortly.</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:13px;">
        <tr><td style="padding:6px 0;color:#6b7280;width:110px">Ticket ID</td><td><strong>#${ticketId}</strong></td></tr>
        <tr><td style="padding:6px 0;color:#6b7280">Subject</td><td>${subject}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280;vertical-align:top">Description</td>
            <td style="white-space:pre-wrap">${description}</td></tr>
      </table>
      <a href="${ticketLink}" style="${btnStyle}">View Ticket →</a>
    `),
  });
};

// ── Chat transcript ───────────────────────────────────────────────────────────
exports.sendChatTranscriptEmail = async ({ to, customerName, agentName, messages, chatId }) => {
  const rows = messages.map(m => {
    const time = new Date(m.created_at).toLocaleString('en-IN', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' });
    const bg = m.sender_role === 'customer' ? '#f9fafb' : '#eef2ff';
    return `<tr><td style="padding:6px 10px;font-size:12px;color:#6b7280;white-space:nowrap;vertical-align:top">${time}</td><td style="padding:6px 10px;font-size:12px;font-weight:600;color:#374151;vertical-align:top">${m.sender_name}</td><td style="padding:6px 10px;font-size:13px;background:${bg};border-radius:4px">${m.message || ''}</td></tr>`;
  }).join('');
  const transcriptHtml = `<table style="width:100%;border-collapse:collapse;margin:16px 0">${rows}</table>`;
  const vars = { customerName, agentName: agentName || '', chatId, transcriptHtml };
  const messageId = await exports.makeOutgoingMessageId({ templateKey: 'chat_transcript' });
  const tpl = await loadTemplate('chat_transcript');
  if (tpl) {
    return sendMail({
      to, messageId,
      subject: renderTemplate(tpl.subject, vars),
      html: renderTemplate(tpl.body_html, vars),
    });
  }
  await sendMail({
    to,
    subject: `Chat Transcript #${chatId}`,
    html: wrap('Your Chat Transcript', `
      <p>Hi <strong>${customerName}</strong>,</p>
      <p>Here is a copy of your chat session${agentName ? ` with <strong>${agentName}</strong>` : ''}.</p>
      ${transcriptHtml}
      <p style="font-size:12px;color:#9ca3af">Chat #${chatId}</p>
    `),
  });
};

// ── Agent replied to ticket ───────────────────────────────────────────────────
exports.sendAgentReplyEmail = async ({ to, cc, customerName, ticketId, subject, agentName, message, attachments }) => {
  const ticketLink = `${process.env.FRONTEND_URL}/customer/tickets/${ticketId}`;
  const vars = { customerName, ticketId, subject, agentName, message, ticketLink };
  const messageId = await exports.makeOutgoingMessageId({ templateKey: 'agent_reply', ticketId });
  const tpl = await loadTemplate('agent_reply');
  if (tpl) {
    return sendMail({
      to, cc, messageId, attachments,
      subject: renderTemplate(tpl.subject, vars),
      html: renderTemplate(tpl.body_html, vars),
    });
  }
  return sendMail({
    to, cc, messageId, attachments,
    subject: `[Ticket #${ticketId}] ${subject} — Agent Reply`,
    html: wrap('Agent Replied to Your Ticket', `
      <p>Hi <strong>${customerName}</strong>,</p>
      <p><strong>${agentName}</strong> from our support team has replied to your ticket.</p>
      <div style="background:#f3f4f6;border-left:4px solid #4f46e5;padding:12px 16px;
                  border-radius:4px;margin:16px 0;font-size:13px;white-space:pre-wrap">${message}</div>
      <p>To reply, click the button below — <strong>replies must be made through the support panel</strong>.</p>
      <a href="${ticketLink}" style="${btnStyle}">Reply on Panel →</a>
    `),
  });
};

// ── Ticket auto-assigned — notify agent ──────────────────────────────────────
// SUPPRESSED — agents already receive an in-app socket notification + bell
// entry + queue update the moment a ticket is assigned. Sending an email on
// top of that was duplicate noise and could push 50+ messages/day to a busy
// agent. Keeping the function signature so callers compile; the body is a
// no-op log so the suppression is visible in the backend log.
exports.sendTicketAssignedEmail = async ({ to, ticketId }) => {
  console.log(`[noise-suppressed] sendTicketAssignedEmail → to=${to} ticket=#${ticketId} (in-app notification covers this)`);
  return { ok: true, skipped: true };
};

// SUPPRESSED — if the customer is on the chat page they see the "Agent
// joined" state instantly via socket; if they closed the tab they're not
// coming back via an email link anyway. Sending was just inbox clutter.
exports.sendChatAcceptedEmail = async ({ to, chatId }) => {
  console.log(`[noise-suppressed] sendChatAcceptedEmail → to=${to} chat=#${chatId} (in-app notification covers this)`);
  return { ok: true, skipped: true };
};

// ── Call missed — notify customer ─────────────────────────────────────────────
exports.sendCallMissedEmail = async ({ to, customerName }) => {
  const callLink = `${process.env.FRONTEND_URL}/customer/call`;
  const vars = { customerName, callLink };
  const messageId = await exports.makeOutgoingMessageId({ templateKey: 'call_missed' });
  const tpl = await loadTemplate('call_missed');
  if (tpl) {
    return sendMail({ to, messageId, subject: renderTemplate(tpl.subject, vars), html: renderTemplate(tpl.body_html, vars) });
  }
  await sendMail({
    to,
    subject: `We missed your call`,
    html: wrap('Missed Call Notification', `
      <p>Hi <strong>${customerName}</strong>,</p>
      <p>We're sorry we missed your call. All our agents were busy at that moment.</p>
      <p>Please try calling again or raise a support ticket and we'll get back to you shortly.</p>
      <a href="${callLink}" style="${btnStyle}">Try Again →</a>
    `),
  });
};

// ── Usage reset — notify customer ─────────────────────────────────────────────
// Sent when an admin clicks "Reset Usage" on a customer. The customer otherwise
// has no way to know their quota was reset mid-cycle, and they get confused when
// the dashboard suddenly says 0/10 even though they made calls earlier the same
// month. Pre-emptive notification sets expectations before they look at history.
exports.sendUsageResetEmail = async ({ to, customerName, callLimit, chatLimit }) => {
  const panelLink = `${process.env.FRONTEND_URL}/customer`;
  const vars = { customerName, callLimit: callLimit ?? '', chatLimit: chatLimit ?? '', panelLink };
  const messageId = await exports.makeOutgoingMessageId({ templateKey: 'usage_reset' });
  const tpl = await loadTemplate('usage_reset');
  if (tpl) {
    return sendMail({ to, messageId, subject: renderTemplate(tpl.subject, vars), html: renderTemplate(tpl.body_html, vars) });
  }
  const limitLines = [
    callLimit != null ? `<li><strong>Calls:</strong> 0 / ${callLimit}</li>` : '',
    chatLimit != null ? `<li><strong>Live chats:</strong> 0 / ${chatLimit}</li>` : '',
  ].filter(Boolean).join('');
  await sendMail({
    to,
    subject: `Your support usage has been reset`,
    html: wrap('Support Usage Reset', `
      <p>Hi <strong>${customerName}</strong>,</p>
      <p>Our team has just reset your monthly support usage. Your quota now starts fresh for the remainder of this billing month:</p>
      <ul style="line-height:1.8;">${limitLines}</ul>
      <p style="font-size:13px;color:#555;">Earlier calls and chats from this month remain visible in your history for your reference — they are marked as "pre-reset" so it's clear they no longer count toward your current quota.</p>
      <a href="${panelLink}" style="${btnStyle}">Open Support Panel →</a>
      <p style="font-size:12px;color:#888;margin-top:18px;">If you weren't expecting this reset, please reply to this email and we'll look into it.</p>
    `),
  });
};

// ── SLA breach — notify admin ─────────────────────────────────────────────────
exports.sendSlaBreachEmail = async ({ to, ticketId, subject, customerName, priority, breachType }) => {
  const ticketsLink = `${process.env.FRONTEND_URL}/admin/tickets`;
  const vars = { ticketId, subject, customerName, priority, breachType, ticketsLink };
  const tpl = await loadTemplate('sla_breach_admin');
  if (tpl) {
    return sendMail({ to, subject: renderTemplate(tpl.subject, vars), html: renderTemplate(tpl.body_html, vars) });
  }
  await sendMail({
    to,
    subject: `[SLA Breach] Ticket #${ticketId} — ${breachType} SLA exceeded`,
    html: wrap('SLA Breach Alert', `
      <p>Hi <strong>Admin</strong>,</p>
      <p>Ticket <strong>#${ticketId}</strong> has breached its ${breachType} SLA.</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:13px;">
        <tr><td style="padding:6px 0;color:#6b7280;width:110px">Ticket ID</td><td><strong>#${ticketId}</strong></td></tr>
        <tr><td style="padding:6px 0;color:#6b7280">Customer</td><td>${customerName}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280">Subject</td><td>${subject}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280">Priority</td><td style="text-transform:capitalize">${priority}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280">Breach Type</td><td style="color:#dc2626;font-weight:600">${breachType} SLA Exceeded</td></tr>
      </table>
      <a href="${ticketsLink}" style="${btnStyle}">View Tickets →</a>
    `),
  });
};

// ── OTP email ─────────────────────────────────────────────────────────────────
exports.sendOtpEmail = async ({ to, name, otp }) => {
  const vars = { name, otp };
  const messageId = await exports.makeOutgoingMessageId({ templateKey: 'otp_login' });
  const tpl = await loadTemplate('otp_login');
  if (tpl) {
    return sendMail({
      to, messageId,
      subject: renderTemplate(tpl.subject, vars),
      html: renderTemplate(tpl.body_html, vars),
    });
  }
  return sendMail({
    to,
    subject: `Your Anu Tech Digital login OTP: ${otp}`,
    html: wrap('Login Verification Code', `
      <p>Hi <strong>${name}</strong>,</p>
      <p>Your one-time password for the Anu Tech Digital support panel is:</p>
      <div style="font-size:36px;font-weight:800;letter-spacing:12px;color:#4f46e5;text-align:center;padding:24px 0">${otp}</div>
      <p style="color:#6b7280;font-size:13px">This code expires in <strong>10 minutes</strong>. Do not share it with anyone.</p>
    `),
  });
};

// ── CSAT rating request ───────────────────────────────────────────────────────
exports.sendRatingRequestEmail = async ({ to, customerName, ticketId, subject }) => {
  const ticketLink = `${process.env.FRONTEND_URL}/customer/tickets/${ticketId}`;
  const vars = { customerName, ticketId, subject, ticketLink };
  const messageId = await exports.makeOutgoingMessageId({ templateKey: 'rating_request', ticketId });
  const tpl = await loadTemplate('rating_request');
  if (tpl) {
    return sendMail({ to, messageId, subject: renderTemplate(tpl.subject, vars), html: renderTemplate(tpl.body_html, vars) });
  }
  await sendMail({
    to,
    subject: `How did we do? Rate your support experience`,
    html: wrap('Rate Your Experience', `
      <p>Hi <strong>${customerName}</strong>,</p>
      <p>Your ticket <strong>#${ticketId} — ${subject}</strong> has been resolved.</p>
      <p>We'd love to hear your feedback! Please take a moment to rate your experience.</p>
      <a href="${ticketLink}" style="${btnStyle}">Rate Now →</a>
    `),
  });
};

// ── Welcome email — new customer account created via billing sync ─────────────
// Sends a one-time setup link instead of a plaintext password. The link is bound to
// a single-use token with a 24h expiry; clicking it lets the customer pick their
// own password and lands them logged in.
exports.sendWelcomeEmail = async ({ to, name, setupToken, onboardingTicketId }) => {
  const setupUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/setup-password/${setupToken}`;
  const vars = { name, setupUrl, loginEmail: to, onboardingTicketId };
  const messageId = await exports.makeOutgoingMessageId({ templateKey: 'welcome_setup_link' });
  const tpl = await loadTemplate('welcome_setup_link');
  if (tpl) {
    return sendMail({
      to, messageId,
      subject: renderTemplate(tpl.subject, vars),
      html: renderTemplate(tpl.body_html, vars),
    });
  }
  return sendMail({
    to,
    subject: `Welcome to Anu Tech Digital – Set up your support account`,
    html: wrap('Welcome to Anu Tech Digital', `
      <p>Hi <strong>${name}</strong>,</p>
      <p>Your support portal account has been created. Click the button below to set your password and get started — the link is valid for 24 hours.</p>
      <p style="text-align:center;margin:28px 0;">
        <a href="${setupUrl}" style="${btnStyle}">Set My Password →</a>
      </p>
      ${onboardingTicketId ? `
      <div style="background:#eef2ff;border-left:4px solid #4f46e5;padding:12px 16px;margin:20px 0;border-radius:6px;font-size:13px;color:#3730a3">
        <strong>What's next?</strong> Our team has already opened
        <strong>onboarding ticket #${onboardingTicketId}</strong> for you and an agent
        will reach out shortly to help configure your email service. You'll see it as
        soon as you log in.
      </div>` : ''}
      <p style="font-size:12px;color:#9ca3af">Login email: <strong>${to}</strong></p>
      <p style="font-size:12px;color:#9ca3af">If the button doesn't work, paste this URL into your browser:</p>
      <p style="font-size:11px;color:#6b7280;word-break:break-all;font-family:monospace">${setupUrl}</p>
    `),
  });
};

// ── Account ready — sent when admin manually creates a customer with a password ──
// Different path from sendWelcomeEmail. There's no setup link to share — the
// admin already chose a password and we hand it over in the body so the customer
// can sign in immediately. They should change it themselves on first login.
exports.sendAccountReadyEmail = async ({ to, name, password, onboardingTicketId }) => {
  const loginUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/login`;
  const vars = { name, loginEmail: to, password, loginUrl, onboardingTicketId };
  const messageId = await exports.makeOutgoingMessageId({ templateKey: 'account_ready' });
  const tpl = await loadTemplate('account_ready');
  if (tpl) {
    return sendMail({
      to, messageId,
      subject: renderTemplate(tpl.subject, vars),
      html: renderTemplate(tpl.body_html, vars),
    });
  }
  return sendMail({
    to,
    subject: `Your Anu Tech Digital support account is ready`,
    html: wrap('Your Account is Ready', `
      <p>Hi <strong>${name}</strong>,</p>
      <p>Your support portal account has been created by our team. Here are your login details:</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:13px;background:#f8fafc;border-radius:8px;">
        <tr><td style="padding:10px 14px;color:#6b7280;width:120px">Email</td><td style="padding:10px 14px;"><strong>${to}</strong></td></tr>
        <tr><td style="padding:10px 14px;color:#6b7280;border-top:1px solid #e5e7eb;">Password</td><td style="padding:10px 14px;border-top:1px solid #e5e7eb;font-family:monospace;"><strong>${password}</strong></td></tr>
      </table>
      <p style="text-align:center;margin:24px 0;">
        <a href="${loginUrl}" style="${btnStyle}">Sign in →</a>
      </p>
      ${onboardingTicketId ? `
      <div style="background:#eef2ff;border-left:4px solid #4f46e5;padding:12px 16px;margin:20px 0;border-radius:6px;font-size:13px;color:#3730a3">
        <strong>What's next?</strong> Our team has already opened
        <strong>onboarding ticket #${onboardingTicketId}</strong> for you and an agent
        will reach out shortly. You'll see it as soon as you log in.
      </div>` : ''}
      <p style="font-size:12px;color:#9ca3af;border-top:1px solid #e5e7eb;padding-top:12px;margin-top:20px">
        <strong>Tip:</strong> Change this password after your first login from <em>My Profile → Change Password</em>.
      </p>
    `),
  });
};

// ── Agent welcome — sent when admin creates a new agent in the panel ─────────
// Agents always get a password chosen by the admin (the New Agent form has a
// required password field), so this is always the credential-in-body flavor.
exports.sendAgentWelcomeEmail = async ({ to, name, password, role = 'agent' }) => {
  const loginUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/login`;
  const roleLabel = role === 'admin' ? 'Admin' : 'Agent';
  const accountKind = role === 'admin' ? 'an admin' : 'an agent';
  const onboardingNote = role === 'admin'
    ? `Once signed in you'll land on the admin dashboard where you can manage customers, agents, plans, templates, and the rest of the panel.`
    : `Once signed in, set your status to <strong>Online</strong> from the sidebar to start receiving chats, calls, and ticket assignments.`;
  const vars = { name, loginEmail: to, password, roleLabel, accountKind, onboardingNote, loginUrl };
  const tpl = await loadTemplate('agent_welcome');
  if (tpl) {
    return sendMail({ to, subject: renderTemplate(tpl.subject, vars), html: renderTemplate(tpl.body_html, vars) });
  }
  await sendMail({
    to,
    subject: `Welcome to the Anu Tech Digital support team`,
    html: wrap('Welcome to the team', `
      <p>Hi <strong>${name}</strong>,</p>
      <p>An admin has created ${accountKind} account for you on the Anu Tech Digital support panel. Here's how to sign in:</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:13px;background:#f8fafc;border-radius:8px;">
        <tr><td style="padding:10px 14px;color:#6b7280;width:120px">Email</td><td style="padding:10px 14px;"><strong>${to}</strong></td></tr>
        <tr><td style="padding:10px 14px;color:#6b7280;border-top:1px solid #e5e7eb;">Password</td><td style="padding:10px 14px;border-top:1px solid #e5e7eb;font-family:monospace;"><strong>${password}</strong></td></tr>
        <tr><td style="padding:10px 14px;color:#6b7280;border-top:1px solid #e5e7eb;">Role</td><td style="padding:10px 14px;border-top:1px solid #e5e7eb;">${roleLabel}</td></tr>
      </table>
      <p style="text-align:center;margin:24px 0;">
        <a href="${loginUrl}" style="${btnStyle}">Sign in to the panel →</a>
      </p>
      <p style="font-size:13px;color:#374151">${onboardingNote}</p>
      <p style="font-size:12px;color:#9ca3af;border-top:1px solid #e5e7eb;padding-top:12px;margin-top:20px">
        <strong>Security:</strong> Please change this password from <em>your profile</em> after your first login. If you weren't expecting this account, reply to this email so we can remove it.
      </p>
    `),
  });
};

// ── Newly added CC — notify them once when they're added to a ticket ─────────
exports.sendCcAddedToTicketEmail = async ({ to, ticketId, subject, customerName }) => {
  const vars = { ticketId, subject, customerName };
  const messageId = await exports.makeOutgoingMessageId({ templateKey: 'cc_added_to_ticket', ticketId });
  const tpl = await loadTemplate('cc_added_to_ticket');
  if (tpl) {
    return sendMail({ to, messageId, subject: renderTemplate(tpl.subject, vars), html: renderTemplate(tpl.body_html, vars) });
  }
  return sendMail({
    to,
    subject: `[Ticket #${ticketId}] You've been added as a CC on a support ticket`,
    html: wrap(`You're Now Following a Support Ticket`, `
      <p>Hi,</p>
      <p><strong>${customerName}</strong> has added you as a CC recipient on an Anu Tech Digital support ticket.
      You'll receive email updates whenever this ticket is replied to by either the customer or our support team.</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:13px;">
        <tr><td style="padding:6px 0;color:#6b7280;width:110px">Ticket ID</td><td><strong>#${ticketId}</strong></td></tr>
        <tr><td style="padding:6px 0;color:#6b7280">Subject</td><td>${subject}</td></tr>
      </table>
      <p style="font-size:12px;color:#6b7280;border-top:1px solid #e5e7eb;padding-top:12px;margin-top:16px">
        <strong>Note:</strong> As a CC recipient, you'll receive copies of all replies but cannot reply through the portal —
        only the ticket owner (<strong>${customerName}</strong>) can post replies via the Anu Tech Digital support panel.
        To opt out of these emails, ask the ticket owner to remove your address from the CC list.
      </p>
    `),
  });
};

// ── Customer replied — notify assigned agent + CC aliases ─────────────────────
exports.sendCustomerReplyEmail = async ({ to, cc, agentName, customerName, ticketId, subject, message, attachments }) => {
  const agentLink = `${process.env.FRONTEND_URL}/agent`;
  const vars = { agentName, customerName, ticketId, subject, message, agentLink };
  const messageId = await exports.makeOutgoingMessageId({ templateKey: 'customer_reply_to_agent', ticketId });
  const tpl = await loadTemplate('customer_reply_to_agent');
  if (tpl) {
    return sendMail({ to, cc, messageId, attachments, subject: renderTemplate(tpl.subject, vars), html: renderTemplate(tpl.body_html, vars) });
  }
  await sendMail({
    to,
    cc,
    attachments,
    subject: `[Ticket #${ticketId}] ${subject} — Customer Reply`,
    html: wrap('Customer Replied to a Ticket', `
      <p>Hi <strong>${agentName}</strong>,</p>
      <p><strong>${customerName}</strong> has replied to ticket <strong>#${ticketId}</strong>.</p>
      <div style="background:#f3f4f6;border-left:4px solid #10b981;padding:12px 16px;
                  border-radius:4px;margin:16px 0;font-size:13px;white-space:pre-wrap">${message}</div>
      <a href="${agentLink}" style="${btnStyle}">Open Agent Console →</a>
    `),
  });
};

// ── Plan upgraded — receipt for customer ─────────────────────────────────────
// Fire-and-forget from customerController.verifyUpgrade once payment + DB write
// succeed. Doubles as the customer's email receipt — they can forward this to
// their accounting team. paymentRef is the Razorpay payment ID, useful if the
// customer ever needs to quote it for a refund / dispute.
exports.sendPlanUpgradedCustomerEmail = async ({ to, customerName, planLabel, amount, expiryDate, paymentRef }) => {
  const panelLink = `${process.env.FRONTEND_URL}/customer/billing`;
  const vars = { customerName, planLabel, amount, expiryDate, paymentRef, panelLink };
  const messageId = await exports.makeOutgoingMessageId({ templateKey: 'plan_upgraded_customer' });
  const tpl = await loadTemplate('plan_upgraded_customer');
  if (tpl) {
    return sendMail({ to, messageId, subject: renderTemplate(tpl.subject, vars), html: renderTemplate(tpl.body_html, vars) });
  }
  await sendMail({
    to, messageId,
    subject: `Your Anu Tech Digital plan is now ${planLabel} — payment confirmed`,
    html: wrap('Plan Upgrade Confirmed', `
      <p>Hi <strong>${customerName}</strong>,</p>
      <p>Thanks for upgrading — your payment has been received and your support plan is now active.</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:13px;background:#f8fafc;border-radius:8px;">
        <tr><td style="padding:10px 14px;color:#6b7280;width:140px">New plan</td><td style="padding:10px 14px;"><strong>${planLabel}</strong></td></tr>
        <tr><td style="padding:10px 14px;color:#6b7280;border-top:1px solid #e5e7eb;">Amount paid</td><td style="padding:10px 14px;border-top:1px solid #e5e7eb;"><strong>${amount}</strong></td></tr>
        <tr><td style="padding:10px 14px;color:#6b7280;border-top:1px solid #e5e7eb;">Active until</td><td style="padding:10px 14px;border-top:1px solid #e5e7eb;">${expiryDate}</td></tr>
        <tr><td style="padding:10px 14px;color:#6b7280;border-top:1px solid #e5e7eb;">Payment reference</td><td style="padding:10px 14px;border-top:1px solid #e5e7eb;font-family:monospace;font-size:12px;">${paymentRef}</td></tr>
      </table>
      <p style="text-align:center;margin:24px 0;">
        <a href="${panelLink}" style="${btnStyle}">View Plan & Invoices →</a>
      </p>
      <p style="font-size:12px;color:#6b7280;border-top:1px solid #e5e7eb;padding-top:12px;margin-top:16px">
        <strong>Tip:</strong> A tax invoice will be emailed separately from our billing system within 24 hours. You can also download it any time from the Billing → Paid Invoices tab once available.
      </p>
      <p style="font-size:12px;color:#9ca3af;margin-top:8px">
        Keep this email — it serves as your immediate proof of payment. Quote the payment reference above if you ever need to raise a billing query with us.
      </p>
    `),
  });
};

// ── Plan upgraded — revenue alert to all admins ──────────────────────────────
// Sent to every active admin so the team has real-time visibility into new
// revenue without having to refresh the Reports → Revenue tab.
exports.sendPlanUpgradedAdminEmail = async ({ to, customerName, customerEmail, planLabel, amount, paymentRef }) => {
  const reportsLink = `${process.env.FRONTEND_URL}/admin/reports`;
  const vars = { customerName, customerEmail, planLabel, amount, paymentRef, reportsLink };
  const tpl = await loadTemplate('plan_upgraded_admin');
  if (tpl) {
    return sendMail({ to, subject: renderTemplate(tpl.subject, vars), html: renderTemplate(tpl.body_html, vars) });
  }
  await sendMail({
    to,
    subject: `💰 New ${planLabel} upgrade — ${customerName} (${amount})`,
    html: wrap('New Plan Upgrade', `
      <p>Hi <strong>Admin</strong>,</p>
      <p>A customer has just upgraded their support plan via the Billing page.</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:13px;background:#f8fafc;border-radius:8px;">
        <tr><td style="padding:10px 14px;color:#6b7280;width:140px">Customer</td><td style="padding:10px 14px;"><strong>${customerName}</strong></td></tr>
        <tr><td style="padding:10px 14px;color:#6b7280;border-top:1px solid #e5e7eb;">Email</td><td style="padding:10px 14px;border-top:1px solid #e5e7eb;">${customerEmail}</td></tr>
        <tr><td style="padding:10px 14px;color:#6b7280;border-top:1px solid #e5e7eb;">New plan</td><td style="padding:10px 14px;border-top:1px solid #e5e7eb;color:#059669;font-weight:600">${planLabel}</td></tr>
        <tr><td style="padding:10px 14px;color:#6b7280;border-top:1px solid #e5e7eb;">Amount</td><td style="padding:10px 14px;border-top:1px solid #e5e7eb;"><strong>${amount}</strong></td></tr>
        <tr><td style="padding:10px 14px;color:#6b7280;border-top:1px solid #e5e7eb;">Payment ref</td><td style="padding:10px 14px;border-top:1px solid #e5e7eb;font-family:monospace;font-size:12px;">${paymentRef}</td></tr>
      </table>
      <p style="text-align:center;margin:24px 0;">
        <a href="${reportsLink}" style="${btnStyle}">Open Revenue Reports →</a>
      </p>
      <p style="font-size:12px;color:#9ca3af;margin-top:8px">
        This is an automated revenue alert. A Zoho invoice for this upgrade is being created by the billing app in the background.
      </p>
    `),
  });
};

// ── Billing sync failed — admin alert ────────────────────────────────────────
// Fired from verifyUpgrade's Zoho-notify catch block (one-shot) AND from the
// retry worker after attempts exhausted. Customer's plan IS already active in
// DSP — this email is purely to flag the missing Zoho invoice for manual fix.
exports.sendBillingSyncFailedEmail = async ({ to, customerName, customerEmail, planLabel, amount, paymentRef, lastError }) => {
  const syncsLink = `${process.env.FRONTEND_URL}/admin/health?tab=billing-syncs`;
  const vars = { customerName, customerEmail, planLabel, amount, paymentRef, lastError, syncsLink };
  const tpl = await loadTemplate('billing_sync_failed_admin');
  if (tpl) {
    return sendMail({ to, subject: renderTemplate(tpl.subject, vars), html: renderTemplate(tpl.body_html, vars) });
  }
  await sendMail({
    to,
    subject: `⚠ Billing sync failed — ${customerName} (${planLabel} · ${amount})`,
    html: wrap('Billing Sync Failure — Manual Reconciliation Required', `
      <p>Hi <strong>Admin</strong>,</p>
      <p style="background:#fef2f2;border-left:4px solid #dc2626;padding:10px 14px;border-radius:4px;color:#991b1b;font-size:13px;">
        <strong>The customer's plan has been upgraded in the support panel, but the billing app (Zoho) was NOT notified.</strong>
        Their invoice will be missing until you reconcile manually.
      </p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:13px;background:#f8fafc;border-radius:8px;">
        <tr><td style="padding:10px 14px;color:#6b7280;width:140px">Customer</td><td style="padding:10px 14px;"><strong>${customerName}</strong></td></tr>
        <tr><td style="padding:10px 14px;color:#6b7280;border-top:1px solid #e5e7eb;">Email</td><td style="padding:10px 14px;border-top:1px solid #e5e7eb;">${customerEmail}</td></tr>
        <tr><td style="padding:10px 14px;color:#6b7280;border-top:1px solid #e5e7eb;">Plan</td><td style="padding:10px 14px;border-top:1px solid #e5e7eb;">${planLabel}</td></tr>
        <tr><td style="padding:10px 14px;color:#6b7280;border-top:1px solid #e5e7eb;">Amount</td><td style="padding:10px 14px;border-top:1px solid #e5e7eb;"><strong>${amount}</strong></td></tr>
        <tr><td style="padding:10px 14px;color:#6b7280;border-top:1px solid #e5e7eb;">Payment ref</td><td style="padding:10px 14px;border-top:1px solid #e5e7eb;font-family:monospace;font-size:12px;">${paymentRef}</td></tr>
        <tr><td style="padding:10px 14px;color:#6b7280;border-top:1px solid #e5e7eb;vertical-align:top">Error</td><td style="padding:10px 14px;border-top:1px solid #e5e7eb;font-family:monospace;font-size:12px;color:#991b1b;">${lastError || '(no error message)'}</td></tr>
      </table>
      <p style="text-align:center;margin:24px 0;">
        <a href="${syncsLink}" style="${btnStyle}">Open Pending Syncs →</a>
      </p>
      <p style="font-size:12px;color:#6b7280">
        From the Pending Syncs page you can <strong>retry the sync</strong> (one-click POST to the billing app) or <strong>mark the row as manually invoiced</strong> after you handle the invoice externally.
      </p>
      <p style="font-size:11px;color:#9ca3af;margin-top:8px">
        The system will automatically retry 5 times over the next 25 minutes. This email fires on the first failure and again if all retries are exhausted.
      </p>
    `),
  });
};

// ── Plan expired — customer auto-moved to Free ───────────────────────────────
// Sent from expiryWorker on the day the customer's plan expired without
// renewal. Tone is informative, not punitive — they can re-upgrade any time.
exports.sendPlanLapsedToFreeEmail = async ({ to, customerName, planLabel }) => {
  const panelLink = `${process.env.FRONTEND_URL}/customer/billing`;
  const vars = { customerName, planLabel, panelLink };
  const tpl = await loadTemplate('plan_expired_lapsed_to_free');
  if (tpl) {
    return sendMail({ to, subject: renderTemplate(tpl.subject, vars), html: renderTemplate(tpl.body_html, vars) });
  }
  await sendMail({
    to,
    subject: `Your ${planLabel} plan has expired — moved to Free`,
    html: wrap('Your support plan has expired', `
      <p>Hi <strong>${customerName}</strong>,</p>
      <p>Your <strong>${planLabel}</strong> support plan expired today and has been moved to the <strong>Free</strong> plan.</p>
      <p>Your account is still active and your past tickets, chats, and call history are all preserved — only the paid entitlements (priority SLA, live chat, voice calls) have been paused.</p>
      <p style="text-align:center;margin:24px 0;">
        <a href="${panelLink}" style="${btnStyle}">Restore Your Plan →</a>
      </p>
      <p style="font-size:12px;color:#6b7280">
        Re-activating is one click — pick a plan, complete payment, and full features are back instantly.
        If you'd like an invoice or quote first, reply to this email and we'll send one over.
      </p>
    `),
  });
};

// ── Daily lapse digest for admins ────────────────────────────────────────────
// Sent only when at least one customer lapsed today. lapsedListHtml is the
// pre-rendered <ul> of customers (built by expiryWorker).
exports.sendPlanLapsedAdminDigestEmail = async ({ to, lapsedListHtml, count }) => {
  const reportsLink = `${process.env.FRONTEND_URL}/admin/reports`;
  const vars = { lapsedListHtml, reportsLink };
  const tpl = await loadTemplate('plan_lapsed_admin');
  if (tpl) {
    return sendMail({ to, subject: renderTemplate(tpl.subject, vars), html: renderTemplate(tpl.body_html, vars) });
  }
  await sendMail({
    to,
    subject: `[Daily Digest] ${count} customer${count === 1 ? '' : 's'} lapsed to Free today`,
    html: wrap('Daily Lapse Digest', `
      <p>Hi <strong>Admin</strong>,</p>
      <p>The following customer${count === 1 ? '' : 's'} reached their plan expiry today and ${count === 1 ? 'has' : 'have'} been auto-moved to Free:</p>
      ${lapsedListHtml}
      <p style="text-align:center;margin:24px 0;">
        <a href="${reportsLink}" style="${btnStyle}">Open Revenue Reports →</a>
      </p>
      <p style="font-size:11px;color:#9ca3af">
        This digest only fires when at least one customer lapsed. If you want any of these customers reactivated, use the Renew Plan button on their Customer Detail page.
      </p>
    `),
  });
};

// Exposed so the SLA digest worker (and any future callers) can send custom
// HTML through the same transport / SMTP-disabled guard as the canned templates.
exports.sendMail = sendMail;
