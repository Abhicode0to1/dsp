// Admin-side controller for editing the 5 customisable email templates.
// Backed by the `email_templates` table; the helpers in utils/emailUtils.js
// load a row by key, render its {{placeholders}} with real data, and fall
// back to the hardcoded HTML if no row exists.

const { pool } = require('../config/database');
const { TEMPLATE_REGISTRY, clearTemplateCache } = require('../utils/emailUtils');

// Editable defaults shown to admins when they first open an unsaved template.
// These are intentionally simpler than the production fallback HTML — they're
// a starting point an admin can extend, not the full ornate version. The
// production fallback (when the DB row is absent) still uses the rich HTML
// inside emailUtils.js.
const DEFAULTS = {
  ticket_created: {
    subject: '[Ticket #{{ticketId}}] {{subject}} — Received',
    body_html:
`<p>Hi <strong>{{customerName}}</strong>,</p>
<p>Your support ticket has been created and our team will respond shortly.</p>
<ul>
  <li><strong>Ticket ID:</strong> #{{ticketId}}</li>
  <li><strong>Subject:</strong> {{subject}}</li>
  <li><strong>Description:</strong> {{description}}</li>
</ul>
<p><a href="{{ticketLink}}">View your ticket</a></p>`,
  },
  agent_reply: {
    subject: '[Ticket #{{ticketId}}] {{subject}} — Agent Reply',
    body_html:
`<p>Hi <strong>{{customerName}}</strong>,</p>
<p><strong>{{agentName}}</strong> from our support team has replied to your ticket:</p>
<blockquote style="border-left:4px solid #4f46e5;padding:8px 14px;color:#374151">
  {{message}}
</blockquote>
<p>To reply, please use the support panel — replies via email aren't accepted.</p>
<p><a href="{{ticketLink}}">Reply on Panel</a></p>`,
  },
  otp_login: {
    subject: 'Your Anu Tech Digital login OTP: {{otp}}',
    body_html:
`<p>Hi <strong>{{name}}</strong>,</p>
<p>Your one-time password for the support panel is:</p>
<p style="font-size:28px;font-weight:700;letter-spacing:8px;color:#4f46e5;text-align:center">{{otp}}</p>
<p style="color:#6b7280;font-size:13px">This code expires in 10 minutes. Do not share it with anyone.</p>`,
  },
  welcome_setup_link: {
    subject: 'Welcome to Anu Tech Digital — set up your account',
    body_html:
`<p>Hi <strong>{{name}}</strong>,</p>
<p>Your support portal account has been created. Click the link below to choose your password — the link works for 24 hours.</p>
<p><a href="{{setupUrl}}">Set my password</a></p>
<p style="font-size:12px;color:#9ca3af">Login email: <strong>{{loginEmail}}</strong></p>`,
  },
  account_ready: {
    subject: 'Your Anu Tech Digital support account is ready',
    body_html:
`<p>Hi <strong>{{name}}</strong>,</p>
<p>Your support portal account has been created. Here are your login details:</p>
<ul>
  <li><strong>Email:</strong> {{loginEmail}}</li>
  <li><strong>Password:</strong> {{password}}</li>
</ul>
<p><a href="{{loginUrl}}">Sign in</a></p>
<p style="font-size:12px;color:#6b7280">Change your password after first login from My Profile.</p>`,
  },
  usage_reset: {
    subject: 'Your monthly support usage has been reset',
    body_html:
`<p>Hi <strong>{{customerName}}</strong>,</p>
<p>Our team has just reset your monthly support usage. Your quota starts fresh from now:</p>
<ul>
  <li><strong>Calls:</strong> 0 / {{callLimit}}</li>
  <li><strong>Live chats:</strong> 0 / {{chatLimit}}</li>
</ul>
<p style="font-size:13px;color:#555">Earlier calls and chats from this month remain visible in your history — they're marked as "pre-reset" so it's clear they no longer count toward your current quota.</p>
<p><a href="{{panelLink}}">Open the support panel</a></p>`,
  },
  rating_request: {
    subject: 'How did we do? Rate ticket #{{ticketId}}',
    body_html:
`<p>Hi <strong>{{customerName}}</strong>,</p>
<p>Your ticket <strong>#{{ticketId}} — {{subject}}</strong> has been resolved.</p>
<p>We'd love your feedback. Please take a moment to rate your experience:</p>
<p><a href="{{ticketLink}}">Rate this ticket</a></p>`,
  },
  cc_added_to_ticket: {
    subject: '[Ticket #{{ticketId}}] You\'ve been added as CC',
    body_html:
`<p>Hi,</p>
<p><strong>{{customerName}}</strong> has added you as a CC recipient on a Anu Tech Digital support ticket. You'll receive email updates whenever this ticket is replied to.</p>
<ul>
  <li><strong>Ticket ID:</strong> #{{ticketId}}</li>
  <li><strong>Subject:</strong> {{subject}}</li>
</ul>
<p style="font-size:12px;color:#6b7280">As a CC, you'll receive copies of all replies but cannot reply through the portal — only the ticket owner ({{customerName}}) can post replies.</p>`,
  },
  chat_transcript: {
    subject: 'Your chat transcript — #{{chatId}}',
    body_html:
`<p>Hi <strong>{{customerName}}</strong>,</p>
<p>Here is a copy of your chat session{{agentName}}.</p>
{{transcriptHtml}}
<p style="font-size:12px;color:#9ca3af">Chat #{{chatId}}</p>`,
  },
  call_missed: {
    subject: 'We missed your call',
    body_html:
`<p>Hi <strong>{{customerName}}</strong>,</p>
<p>We're sorry we missed your call. All our agents were busy at that moment.</p>
<p>Please try calling again or raise a support ticket and we'll get back to you shortly.</p>
<p><a href="{{callLink}}">Try calling again</a></p>`,
  },
  agent_welcome: {
    subject: 'Welcome to the Anu Tech Digital support team',
    body_html:
`<p>Hi <strong>{{name}}</strong>,</p>
<p>An admin has created {{accountKind}} account for you on the Anu Tech Digital support panel. Here's how to sign in:</p>
<ul>
  <li><strong>Email:</strong> {{loginEmail}}</li>
  <li><strong>Password:</strong> {{password}}</li>
  <li><strong>Role:</strong> {{roleLabel}}</li>
</ul>
<p><a href="{{loginUrl}}">Sign in to the panel</a></p>
<p style="font-size:13px;color:#374151">{{onboardingNote}}</p>
<p style="font-size:12px;color:#9ca3af">Please change this password after your first login from your profile.</p>`,
  },
  customer_reply_to_agent: {
    subject: '[Ticket #{{ticketId}}] {{subject}} — Customer reply',
    body_html:
`<p>Hi <strong>{{agentName}}</strong>,</p>
<p><strong>{{customerName}}</strong> has replied to ticket <strong>#{{ticketId}}</strong>:</p>
<blockquote style="border-left:4px solid #10b981;padding:8px 14px;color:#374151;white-space:pre-wrap">{{message}}</blockquote>
<p><a href="{{agentLink}}">Open agent console</a></p>`,
  },
  sla_breach_admin: {
    subject: '[SLA Breach] Ticket #{{ticketId}} — {{breachType}} SLA exceeded',
    body_html:
`<p>Hi <strong>Admin</strong>,</p>
<p>Ticket <strong>#{{ticketId}}</strong> has breached its {{breachType}} SLA.</p>
<ul>
  <li><strong>Customer:</strong> {{customerName}}</li>
  <li><strong>Subject:</strong> {{subject}}</li>
  <li><strong>Priority:</strong> {{priority}}</li>
  <li><strong>Breach type:</strong> <span style="color:#dc2626">{{breachType}}</span></li>
</ul>
<p><a href="{{ticketsLink}}">View tickets</a></p>`,
  },
  plan_upgraded_customer: {
    subject: 'Your Anu Tech Digital plan is now {{planLabel}} — payment confirmed',
    body_html:
`<p>Hi <strong>{{customerName}}</strong>,</p>
<p>Thanks for upgrading — your payment has been received and your support plan is now active.</p>
<ul>
  <li><strong>New plan:</strong> {{planLabel}}</li>
  <li><strong>Amount paid:</strong> {{amount}}</li>
  <li><strong>Active until:</strong> {{expiryDate}}</li>
  <li><strong>Payment reference:</strong> {{paymentRef}}</li>
</ul>
<p><a href="{{panelLink}}">View Plan & Invoices</a></p>
<p style="font-size:12px;color:#6b7280">A tax invoice will be emailed separately from our billing system within 24 hours. Quote the payment reference above for any billing query.</p>`,
  },
  plan_upgraded_admin: {
    subject: 'New {{planLabel}} upgrade — {{customerName}} ({{amount}})',
    body_html:
`<p>Hi <strong>Admin</strong>,</p>
<p>A customer has just upgraded their support plan via the Billing page.</p>
<ul>
  <li><strong>Customer:</strong> {{customerName}}</li>
  <li><strong>Email:</strong> {{customerEmail}}</li>
  <li><strong>New plan:</strong> <span style="color:#059669;font-weight:600">{{planLabel}}</span></li>
  <li><strong>Amount:</strong> {{amount}}</li>
  <li><strong>Payment ref:</strong> {{paymentRef}}</li>
</ul>
<p><a href="{{reportsLink}}">Open Revenue Reports</a></p>
<p style="font-size:11px;color:#9ca3af">A Zoho invoice for this upgrade is being created by the billing app in the background.</p>`,
  },
  billing_sync_failed_admin: {
    subject: 'Billing sync failed — {{customerName}} ({{planLabel}} · {{amount}})',
    body_html:
`<p>Hi <strong>Admin</strong>,</p>
<p style="background:#fef2f2;border-left:4px solid #dc2626;padding:10px 14px;border-radius:4px;color:#991b1b;font-size:13px">
  <strong>The customer's plan was upgraded in the support panel, but the billing app (Zoho) was NOT notified.</strong> Their invoice will be missing until you reconcile manually.
</p>
<ul>
  <li><strong>Customer:</strong> {{customerName}}</li>
  <li><strong>Email:</strong> {{customerEmail}}</li>
  <li><strong>Plan:</strong> {{planLabel}}</li>
  <li><strong>Amount:</strong> {{amount}}</li>
  <li><strong>Payment ref:</strong> {{paymentRef}}</li>
  <li><strong>Error:</strong> <span style="color:#991b1b;font-family:monospace;font-size:12px">{{lastError}}</span></li>
</ul>
<p><a href="{{syncsLink}}">Open Pending Syncs</a></p>
<p style="font-size:11px;color:#9ca3af">The system will automatically retry 5 times over 25 minutes. This email fires on the first failure and again if retries are exhausted.</p>`,
  },
  plan_expired_lapsed_to_free: {
    subject: 'Your {{planLabel}} plan has expired — moved to Free',
    body_html:
`<p>Hi <strong>{{customerName}}</strong>,</p>
<p>Your <strong>{{planLabel}}</strong> support plan expired today and has been moved to the <strong>Free</strong> plan.</p>
<p>Your account is still active and your past tickets, chats, and call history are all preserved — only the paid entitlements (priority SLA, live chat, voice calls) have been paused.</p>
<p><a href="{{panelLink}}">Restore your plan</a></p>
<p style="font-size:12px;color:#6b7280">Re-activating is one click — pick a plan, complete payment, and full features are back instantly. If you'd like an invoice or quote first, reply to this email.</p>`,
  },
  plan_lapsed_admin: {
    subject: '[Daily Digest] Customers lapsed to Free today',
    body_html:
`<p>Hi <strong>Admin</strong>,</p>
<p>The following customer(s) reached their plan expiry today and have been auto-moved to Free:</p>
{{lapsedListHtml}}
<p><a href="{{reportsLink}}">Open Revenue Reports</a></p>
<p style="font-size:11px;color:#9ca3af">This digest only fires when at least one customer lapsed. If you want any of these customers reactivated, use the Renew Plan button on their Customer Detail page.</p>`,
  },
};

// Sample data used to render the preview pane. Picked to be obviously fake.
const PREVIEW_VARS = {
  ticket_created:     { customerName: 'Asha Verma', ticketId: 1234, subject: 'Cannot send email from Outlook', description: 'Started this morning. Tried recreating profile, no luck.', ticketLink: 'https://example.com/tickets/1234' },
  agent_reply:        { customerName: 'Asha Verma', ticketId: 1234, subject: 'Cannot send email from Outlook', agentName: 'Priya Sharma', message: 'Hi Asha, please follow these steps...', ticketLink: 'https://example.com/tickets/1234' },
  otp_login:          { name: 'Asha Verma', otp: '472916' },
  welcome_setup_link: { name: 'Asha Verma', setupUrl: 'https://example.com/setup-password/abc123', loginEmail: 'asha@acme.com', onboardingTicketId: 42 },
  account_ready:      { name: 'Asha Verma', loginEmail: 'asha@acme.com', password: 'TempPass#2026', loginUrl: 'https://example.com/login', onboardingTicketId: 42 },
  usage_reset:        { customerName: 'Asha Verma', callLimit: 10, chatLimit: 15, panelLink: 'https://example.com/customer' },
  rating_request:     { customerName: 'Asha Verma', ticketId: 1234, subject: 'Cannot send email from Outlook', ticketLink: 'https://example.com/tickets/1234' },
  cc_added_to_ticket: { customerName: 'Asha Verma', ticketId: 1234, subject: 'Cannot send email from Outlook' },
  chat_transcript:    { customerName: 'Asha Verma', agentName: ' with Priya Sharma', chatId: 87, transcriptHtml: '<p style="background:#f3f4f6;padding:8px 12px;border-radius:4px"><em>[Full chat transcript rendered here at send time]</em></p>' },
  call_missed:        { customerName: 'Asha Verma', callLink: 'https://example.com/customer/call' },
  agent_welcome:      { name: 'Priya Sharma', loginEmail: 'priya@anutech.in', password: 'TempPass#2026', roleLabel: 'Agent', accountKind: 'an agent', onboardingNote: 'Once signed in, set your status to <strong>Online</strong> from the sidebar to start receiving chats, calls, and tickets.', loginUrl: 'https://example.com/login' },
  customer_reply_to_agent: { agentName: 'Priya Sharma', customerName: 'Asha Verma', ticketId: 1234, subject: 'Cannot send email from Outlook', message: 'Thanks Priya — your steps worked. Closing this out.', agentLink: 'https://example.com/agent' },
  sla_breach_admin:   { ticketId: 1234, subject: 'Cannot send email from Outlook', customerName: 'Asha Verma', priority: 'high', breachType: 'Response', ticketsLink: 'https://example.com/admin/tickets' },
  plan_upgraded_customer:     { customerName: 'Asha Verma', planLabel: 'Premium', amount: '₹4,999.00', expiryDate: '11 Jun 2027', paymentRef: 'pay_sample_DO_NOT_USE_test_id', panelLink: 'https://example.com/customer/billing' },
  plan_upgraded_admin:        { customerName: 'Asha Verma', customerEmail: 'asha@acme.com', planLabel: 'Premium', amount: '₹4,999.00', paymentRef: 'pay_sample_DO_NOT_USE_test_id', reportsLink: 'https://example.com/admin/reports' },
  billing_sync_failed_admin:  { customerName: 'Asha Verma', customerEmail: 'asha@acme.com', planLabel: 'Premium', amount: '₹4,999.00', paymentRef: 'pay_sample_DO_NOT_USE_test_id', lastError: 'ECONNREFUSED — billing app did not respond on port 5050', syncsLink: 'https://example.com/admin/billing-syncs' },
  plan_expired_lapsed_to_free:{ customerName: 'Asha Verma', planLabel: 'Premium', panelLink: 'https://example.com/customer/billing' },
  plan_lapsed_admin:          { lapsedListHtml: '<ul style="font-size:13px;color:#374151;padding-left:18px;margin:12px 0"><li style="margin-bottom:6px"><strong>Asha Verma</strong> (asha@acme.com) — was on <strong>Premium</strong> until 10 Jun 2026</li></ul>', reportsLink: 'https://example.com/admin/reports' },
};

function renderTemplate(str, vars) {
  return String(str).replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name) => {
    const v = vars[name];
    return v == null ? '' : String(v);
  });
}

// GET /api/admin/email-templates
// Returns the registry + which keys have a custom row in the DB.
exports.listEmailTemplates = async (req, res) => {
  try {
    const keys = TEMPLATE_REGISTRY.map(t => t.key);
    const [rows] = await pool.query(
      `SELECT template_key, updated_at, updated_by FROM email_templates
       WHERE template_key IN (${keys.map(() => '?').join(',')})`,
      keys
    );
    const customized = new Map(rows.map(r => [r.template_key, r]));
    const items = TEMPLATE_REGISTRY.map(t => ({
      ...t,
      customized: customized.has(t.key),
      updated_at: customized.get(t.key)?.updated_at || null,
    }));
    res.json({ items });
  } catch (err) {
    console.error('[listEmailTemplates]', err);
    res.status(500).json({ error: 'Server error' });
  }
};

// GET /api/admin/email-templates/:key
// Returns the current saved subject+body OR the editable defaults if no row.
exports.getEmailTemplate = async (req, res) => {
  try {
    const { key } = req.params;
    const meta = TEMPLATE_REGISTRY.find(t => t.key === key);
    if (!meta) return res.status(404).json({ error: 'Unknown template key' });

    const [[row]] = await pool.query(
      'SELECT subject, body_html, updated_at FROM email_templates WHERE template_key = ?',
      [key]
    );
    // Fall back to a blank starter when DEFAULTS doesn't define this key
    // (the hardcoded production HTML inside emailUtils.js is still used at
    // send time; the empty editor just means "no admin override yet").
    const defaults = DEFAULTS[key] || { subject: '', body_html: '' };
    res.json({
      key,
      label: meta.label,
      audience: meta.audience,
      description: meta.description,
      variables: meta.variables,
      customized: !!row,
      subject: row?.subject ?? defaults.subject,
      body_html: row?.body_html ?? defaults.body_html,
      defaults,                  // always returned so the UI can offer "Reset" client-side too
      updated_at: row?.updated_at || null,
    });
  } catch (err) {
    console.error('[getEmailTemplate]', err);
    res.status(500).json({ error: 'Server error' });
  }
};

// PUT /api/admin/email-templates/:key
// Upsert the saved version. Both subject + body_html required.
exports.saveEmailTemplate = async (req, res) => {
  try {
    const { key } = req.params;
    const { subject, body_html } = req.body;
    const meta = TEMPLATE_REGISTRY.find(t => t.key === key);
    if (!meta) return res.status(404).json({ error: 'Unknown template key' });
    if (!subject?.trim() || !body_html?.trim()) {
      return res.status(400).json({ error: 'Subject and body are both required' });
    }
    if (subject.length > 500) {
      return res.status(400).json({ error: 'Subject is too long (max 500 chars)' });
    }
    await pool.query(
      `INSERT INTO email_templates (template_key, subject, body_html, updated_by)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE subject = VALUES(subject), body_html = VALUES(body_html), updated_by = VALUES(updated_by)`,
      [key, subject.trim(), body_html, req.user.id]
    );
    clearTemplateCache(key);
    res.json({ ok: true, key });
  } catch (err) {
    console.error('[saveEmailTemplate]', err);
    res.status(500).json({ error: 'Server error' });
  }
};

// DELETE /api/admin/email-templates/:key
// Removes the customisation; the production fallback HTML takes over.
exports.resetEmailTemplate = async (req, res) => {
  try {
    const { key } = req.params;
    const meta = TEMPLATE_REGISTRY.find(t => t.key === key);
    if (!meta) return res.status(404).json({ error: 'Unknown template key' });
    await pool.query('DELETE FROM email_templates WHERE template_key = ?', [key]);
    clearTemplateCache(key);
    res.json({ ok: true, key });
  } catch (err) {
    console.error('[resetEmailTemplate]', err);
    res.status(500).json({ error: 'Server error' });
  }
};

// POST /api/admin/email-templates/:key/preview
// Renders the given subject+body with realistic-looking fake data so the admin
// can see what their changes look like before saving.
exports.previewEmailTemplate = async (req, res) => {
  try {
    const { key } = req.params;
    const { subject, body_html } = req.body;
    const meta = TEMPLATE_REGISTRY.find(t => t.key === key);
    if (!meta) return res.status(404).json({ error: 'Unknown template key' });
    const vars = PREVIEW_VARS[key];
    res.json({
      subject: renderTemplate(subject || '', vars),
      body_html: renderTemplate(body_html || '', vars),
      vars,
    });
  } catch (err) {
    console.error('[previewEmailTemplate]', err);
    res.status(500).json({ error: 'Server error' });
  }
};
