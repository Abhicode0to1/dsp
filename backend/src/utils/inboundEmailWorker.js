// Inbound email ingestion — polls the support inbox via IMAP, parses each
// new email, and decides what to do with it according to the policy:
//
//   1. Auto-reply / vacation responder           → ignore (RFC 3834)
//   2. DMARC failure                             → quarantine (possible spoof)
//   3. Subject token [Ticket #N-hash] matches    → append to ticket, reopen
//                                                  if closed within 24h
//   4. Subject token but ticket closed > 24h     → new ticket, linked to old
//   5. In-Reply-To Message-ID matches            → per-template handler
//   6. Sender in tickets.cc_emails (open ticket) → append as CC reply
//   7. Sender is a known customer                → new ticket (category guessed
//                                                  from any matched template,
//                                                  otherwise "general")
//   8. Sender unknown                            → quarantine + polite auto-reply
//                                                  (throttled once per 7 days)
//
// Defends against:
//   • Replays / duplicates (UNIQUE message_id in inbound_email)
//   • Auto-reply loops (RFC 3834 headers)
//   • Spoofing (Authentication-Results: dmarc=fail)
//   • Attachment bloat (size cap from chat_attachment_max_mb)
//
// Runs as a long-lived poll loop started from server.js. Reconnects on
// IMAP socket errors with exponential backoff.
const Imap = require('node-imap');
const { simpleParser } = require('mailparser');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pool } = require('../config/database');
const {
  parseMessageId,
  verifyTicketHash,
  sendMail,
  makeOutgoingMessageId,
} = require('./emailUtils');
const { getSetting, getBoolSetting, getIntSetting } = require('./settings');

const UPLOAD_DIR = path.join(__dirname, '../../uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Re-open grace window — matches existing customer-facing reopen policy
// in ticketController.reopenTicket (24 hours from closed_at).
const REOPEN_WINDOW_HOURS = 24;
// Polite auto-reply throttle per sender.
const UNKNOWN_AUTOREPLY_THROTTLE_DAYS = 7;

// Map each notification template_key to (a) what category the resulting new
// ticket should land in, and (b) any extra tags / priority hints.
const TEMPLATE_TO_INTENT = {
  welcome_setup_link:     { category: 'Onboarding',     priority: 'normal',  tag: 'onboarding' },
  account_ready:          { category: 'Onboarding',     priority: 'normal',  tag: 'onboarding' },
  otp_login:              { category: 'Security',       priority: 'high',    tag: 'security',  flagSecurity: true },
  usage_reset:            { category: 'Billing',        priority: 'normal',  tag: 'billing' },
  chat_transcript:        { category: 'Chat follow-up', priority: 'normal',  tag: 'chat-followup' },
  call_missed:            { category: 'Call follow-up', priority: 'high',    tag: 'call-followup' },
};

// ── State / lifecycle ────────────────────────────────────────────────────────
let imap = null;
let pollTimer = null;
let backoffMs = 60_000;
let started = false;
const POLL_INTERVAL_MS = 60_000;  // 1 minute — well under Gmail IMAP rate limits

async function start() {
  if (started) return;
  started = true;
  console.log('[inbound-email] worker starting');
  await tick();
  pollTimer = setInterval(() => { tick().catch(err => console.error('[inbound-email tick]', err)); }, POLL_INTERVAL_MS);
}

async function stop() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  started = false;
  try { imap?.end(); } catch {}
}

// Single poll cycle — opens connection, scans for unread, processes, closes.
async function tick() {
  const { heartbeat } = require('./heartbeat');
  if (!(await getBoolSetting('inbound_enabled', false))) {
    await heartbeat('inboundEmailWorker', { status: 'skipped', error: 'inbound_enabled=0', intervalSeconds: POLL_INTERVAL_MS / 1000 });
    return;
  }
  const config = await getImapConfig();
  if (!config.host || !config.user || !config.password) {
    // Settings incomplete — skip silently until admin fills them in.
    await heartbeat('inboundEmailWorker', { status: 'skipped', error: 'IMAP credentials missing', intervalSeconds: POLL_INTERVAL_MS / 1000 });
    return;
  }

  try {
    const messages = await fetchUnreadMessages(config);
    if (!messages.length) {
      await heartbeat('inboundEmailWorker', { status: 'ok', intervalSeconds: POLL_INTERVAL_MS / 1000 });
      return;
    }
    console.log(`[inbound-email] fetched ${messages.length} unread message(s)`);
    for (const m of messages) {
      try {
        await processMessage(m);
      } catch (err) {
        console.error('[inbound-email processMessage]', err);
        await safeLog({
          message_id: m.headers?.['message-id'] || `error-${Date.now()}`,
          from_email: m.from?.address || 'unknown',
          subject: m.subject || '',
          status: 'error',
          note: (err.message || String(err)).slice(0, 480),
        });
      }
    }
    backoffMs = POLL_INTERVAL_MS;
    await heartbeat('inboundEmailWorker', { status: 'ok', intervalSeconds: POLL_INTERVAL_MS / 1000 });
  } catch (err) {
    console.error('[inbound-email IMAP]', err.message);
    backoffMs = Math.min(backoffMs * 2, 30 * 60_000);
    await heartbeat('inboundEmailWorker', { status: 'error', error: err.message, intervalSeconds: POLL_INTERVAL_MS / 1000 });
    setTimeout(() => { tick().catch(() => {}); }, backoffMs);
  }
}

async function getImapConfig() {
  return {
    host:     await getSetting('imap_host', ''),
    port:     await getIntSetting('imap_port', 993),
    user:     await getSetting('imap_user', ''),
    password: await getSetting('imap_password', ''),
    tls:      await getBoolSetting('imap_secure', true),
    mailbox:  (await getSetting('imap_mailbox', 'INBOX')) || 'INBOX',
  };
}

// Fetch unread messages, parse each one via mailparser, mark Seen.
function fetchUnreadMessages(config) {
  return new Promise((resolve, reject) => {
    const client = new Imap({
      user: config.user,
      password: config.password,
      host: config.host,
      port: config.port,
      tls: config.tls,
      authTimeout: 10000,
      connTimeout: 10000,
      tlsOptions: { rejectUnauthorized: true },
    });
    imap = client;
    const parsed = [];
    client.once('error', reject);
    client.once('end', () => resolve(parsed));
    client.once('ready', () => {
      client.openBox(config.mailbox, false, (err) => {
        if (err) return reject(err);
        client.search(['UNSEEN'], (err2, uids) => {
          if (err2) return reject(err2);
          if (!uids?.length) { client.end(); return; }
          const f = client.fetch(uids, { bodies: '', markSeen: true });
          f.on('message', (msg) => {
            const chunks = [];
            msg.on('body', (stream) => stream.on('data', (c) => chunks.push(c)));
            msg.on('end', async () => {
              try {
                const buf = Buffer.concat(chunks);
                const p = await simpleParser(buf);
                parsed.push({
                  raw_size: buf.length,
                  from: p.from?.value?.[0] || {},
                  to: (p.to?.value || []).map(x => x.address),
                  cc: (p.cc?.value || []).map(x => x.address),
                  subject: p.subject || '',
                  text: p.text || '',
                  html: p.html || '',
                  attachments: p.attachments || [],
                  headers: p.headers,
                  // Normalised header lookup (lowercased keys)
                  hdrs: (() => {
                    const out = {};
                    if (p.headers) p.headers.forEach((v, k) => { out[k.toLowerCase()] = v; });
                    return out;
                  })(),
                });
              } catch (e) {
                console.error('[inbound-email parse]', e.message);
              }
            });
          });
          f.once('error', reject);
          f.once('end', () => client.end());
        });
      });
    });
    client.connect();
  });
}

// Decision matrix entry point.
async function processMessage(msg) {
  const messageId = String(msg.hdrs['message-id'] || '').slice(0, 255);
  if (!messageId) {
    return safeLog({ message_id: `nomid-${Date.now()}`, from_email: msg.from?.address || 'unknown', subject: msg.subject, status: 'error', note: 'missing Message-ID header' });
  }
  // Idempotency — UNIQUE on inbound_email.message_id means duplicate inserts
  // fail, and we exit before doing any work.
  const [[dup]] = await pool.query('SELECT id FROM inbound_email WHERE message_id = ? LIMIT 1', [messageId]);
  if (dup) {
    console.log('[inbound-email] dup, skip:', messageId);
    return;
  }

  const fromEmail = (msg.from?.address || '').toLowerCase().trim();
  const subject = (msg.subject || '').slice(0, 500);
  const snippet = (msg.text || msg.html?.replace(/<[^>]+>/g, ' ') || '').replace(/\s+/g, ' ').trim().slice(0, 500);
  const inReplyTo = String(msg.hdrs['in-reply-to'] || '').slice(0, 255);
  // Compute the body once up-front (was previously only set after Step 2). Used
  // for ticket-message routing (where it gets passed through ctx) AND now also
  // persisted to inbound_email.body_text so admin's "Attach to ticket" action
  // has something readable to drop in — the collapsed snippet alone is useless
  // for that purpose. stripQuotedHistory removes quoted history below the new
  // reply so we don't paste 5 generations of nested >>>.
  const cleanedBody = stripQuotedHistory(msg.text || htmlToText(msg.html));

  // ── Step 1: ignore auto-replies (RFC 3834) ─────────────────────────────────
  const autoSubmitted = String(msg.hdrs['auto-submitted'] || '').toLowerCase();
  const precedence = String(msg.hdrs['precedence'] || '').toLowerCase();
  const xAutoResp = String(msg.hdrs['x-auto-response-suppress'] || '').toLowerCase();
  if (autoSubmitted && autoSubmitted !== 'no'
      || precedence === 'bulk' || precedence === 'list' || precedence === 'auto_reply'
      || xAutoResp.includes('all')) {
    return logRow(messageId, inReplyTo, fromEmail, msg.from?.name, subject, snippet, msg.raw_size, 'autoreply_loop', null, null, 'auto-reply / bulk / vacation responder header detected', cleanedBody);
  }

  // ── Step 2: DMARC fail → quarantine ────────────────────────────────────────
  const authResults = String(msg.hdrs['authentication-results'] || '').toLowerCase();
  if (/dmarc=fail/.test(authResults)) {
    return logRow(messageId, inReplyTo, fromEmail, msg.from?.name, subject, snippet, msg.raw_size, 'dmarc_fail', null, null, 'DMARC verification failed on inbound — possible spoof', cleanedBody);
  }

  // ── Step 3 & 4: subject token match ────────────────────────────────────────
  const tokenMatch = subject.match(/\[Ticket #(\d+)-([a-f0-9]{4})\]/i);
  if (tokenMatch) {
    const ticketId = parseInt(tokenMatch[1], 10);
    const hash = tokenMatch[2].toLowerCase();
    if (await verifyTicketHash(ticketId, hash)) {
      return await routeToTicketById(ticketId, msg, { messageId, inReplyTo, fromEmail, subject, snippet, cleanedBody });
    }
    // hash mismatch — possible spoof attempt; fall through to other matchers
    console.warn(`[inbound-email] subject token #${ticketId} hash mismatch (got ${hash})`);
  }

  // ── Step 5: In-Reply-To header → recover via Message-ID ────────────────────
  if (inReplyTo) {
    const parsed = parseMessageId(inReplyTo);
    if (parsed?.kind === 'ticket') {
      if (await verifyTicketHash(parsed.ticketId, parsed.hash)) {
        return await routeToTicketById(parsed.ticketId, msg, { messageId, inReplyTo, fromEmail, subject, snippet, cleanedBody });
      }
    } else if (parsed?.kind === 'notify') {
      // Customer replying to a notification email — create a new ticket with
      // the category guessed from the template they're replying to.
      return await createTicketFromNotification(parsed.templateKey, msg, { messageId, inReplyTo, fromEmail, subject, snippet, cleanedBody });
    }
  }

  // ── Step 6/7: lookup sender in customers / cc_emails ───────────────────────
  const [[customerRow]] = await pool.query(
    `SELECT c.id AS customer_id, c.user_id, u.name AS customer_name
     FROM customers c JOIN users u ON u.id = c.user_id
     WHERE LOWER(u.email) = ? AND u.is_active = 1 LIMIT 1`,
    [fromEmail]
  );

  if (customerRow) {
    // Known customer, no template context — create a generic ticket.
    return await createGenericTicket(customerRow, msg, { messageId, inReplyTo, fromEmail, subject, snippet, cleanedBody });
  }

  // Could be a CC participant on someone else's ticket
  const [ccTickets] = await pool.query(
    `SELECT id FROM tickets WHERE status != 'closed' AND cc_emails IS NOT NULL
       AND FIND_IN_SET(?, REPLACE(REPLACE(cc_emails, ', ', ','), ' ', '')) > 0
     ORDER BY id DESC LIMIT 1`,
    [fromEmail]
  );
  if (ccTickets.length) {
    return await appendAsCcReply(ccTickets[0].id, msg, { messageId, inReplyTo, fromEmail, subject, snippet, cleanedBody });
  }

  // ── Step 8: Unknown sender → polite throttled auto-reply + optional forward
  await sendPoliteAutoReply(fromEmail, msg);
  return logRow(messageId, inReplyTo, fromEmail, msg.from?.name, subject, snippet, msg.raw_size, 'rejected', null, null, 'sender not in customers or cc_emails (forwarded to support@ if configured)', cleanedBody);
}

// ── Per-decision handlers ────────────────────────────────────────────────────

async function routeToTicketById(ticketId, msg, ctx) {
  const [[ticket]] = await pool.query('SELECT id, customer_id, status, closed_at, subject FROM tickets WHERE id = ? LIMIT 1', [ticketId]);
  if (!ticket) {
    return logRow(ctx.messageId, ctx.inReplyTo, ctx.fromEmail, msg.from?.name, ctx.subject, ctx.snippet, msg.raw_size, 'rejected', null, null, `subject referenced ticket #${ticketId} but it no longer exists`, ctx.cleanedBody);
  }

  // Confirm the sender has standing to post on this ticket:
  //   - ticket owner (matches customer's email), OR
  //   - cc participant (in ticket.cc_emails)
  const [[ownerRow]] = await pool.query(
    `SELECT LOWER(u.email) AS email FROM customers c JOIN users u ON u.id = c.user_id WHERE c.id = ? LIMIT 1`,
    [ticket.customer_id]
  );
  const isOwner = ownerRow?.email === ctx.fromEmail;
  let isCc = false;
  if (!isOwner) {
    const [[c]] = await pool.query(
      `SELECT FIND_IN_SET(?, REPLACE(REPLACE(cc_emails, ', ', ','), ' ', '')) > 0 AS is_cc FROM tickets WHERE id = ?`,
      [ctx.fromEmail, ticketId]
    );
    isCc = !!c?.is_cc;
  }
  if (!isOwner && !isCc) {
    return logRow(ctx.messageId, ctx.inReplyTo, ctx.fromEmail, msg.from?.name, ctx.subject, ctx.snippet, msg.raw_size, 'quarantined', ticketId, null, 'sender is neither owner nor CC on this ticket — admin review', ctx.cleanedBody);
  }

  if (ticket.status === 'closed') {
    const closedAt = ticket.closed_at ? new Date(ticket.closed_at).getTime() : 0;
    const hoursClosed = (Date.now() - closedAt) / 3600_000;
    if (hoursClosed <= REOPEN_WINDOW_HOURS) {
      // Re-open + append (matches the panel's own reopen policy: 24h grace)
      await pool.query("UPDATE tickets SET status = 'open', closed_at = NULL, updated_at = NOW() WHERE id = ?", [ticketId]);
      await appendMessage(ticketId, ticket.customer_id, ctx, msg, isCc ? 'customer_cc_email' : 'customer_email');
      return logRow(ctx.messageId, ctx.inReplyTo, ctx.fromEmail, msg.from?.name, ctx.subject, ctx.snippet, msg.raw_size, 'reopened', ticketId, null, `closed ${hoursClosed.toFixed(1)}h ago — within ${REOPEN_WINDOW_HOURS}h window`, ctx.cleanedBody);
    } else {
      // Past reopen window — create new ticket linked to old, NOT append.
      const newId = await insertLinkedNewTicket(ticket.customer_id, ticketId, ticket.subject, ctx);
      return logRow(ctx.messageId, ctx.inReplyTo, ctx.fromEmail, msg.from?.name, ctx.subject, ctx.snippet, msg.raw_size, 'new_ticket', newId, ticketId, `original closed ${hoursClosed.toFixed(0)}h ago, past ${REOPEN_WINDOW_HOURS}h window`, ctx.cleanedBody);
    }
  }

  // Open or in-progress — just append
  await appendMessage(ticketId, ticket.customer_id, ctx, msg, isCc ? 'customer_cc_email' : 'customer_email');
  return logRow(ctx.messageId, ctx.inReplyTo, ctx.fromEmail, msg.from?.name, ctx.subject, ctx.snippet, msg.raw_size, 'appended', ticketId, null, isCc ? 'CC reply' : null, ctx.cleanedBody);
}

async function createTicketFromNotification(templateKey, msg, ctx) {
  // Sender must still be a known customer to land here (otherwise unknown-sender path).
  const [[customer]] = await pool.query(
    `SELECT c.id AS customer_id FROM customers c JOIN users u ON u.id = c.user_id
     WHERE LOWER(u.email) = ? AND u.is_active = 1 LIMIT 1`,
    [ctx.fromEmail]
  );
  if (!customer) {
    await sendPoliteAutoReply(ctx.fromEmail, msg);
    return logRow(ctx.messageId, ctx.inReplyTo, ctx.fromEmail, msg.from?.name, ctx.subject, ctx.snippet, msg.raw_size, 'rejected', null, null, `reply to ${templateKey} but sender not a customer`, ctx.cleanedBody);
  }
  const intent = TEMPLATE_TO_INTENT[templateKey] || { category: 'General', priority: 'normal' };
  const newId = await insertNewTicket({
    customerId: customer.customer_id,
    subject: ctx.subject || `Re: ${templateKey}`,
    description: ctx.cleanedBody || ctx.snippet,
    category: intent.category,
    priority: intent.priority,
    via: 'email-reply-to-notification',
  });
  await ingestAttachments(newId, msg);
  if (intent.flagSecurity) {
    await notifyAdmin('Security flag: OTP reply received', `Customer ${ctx.fromEmail} replied to a login OTP email. New ticket #${newId} created. Possible account-takeover signal — please review.`);
  }
  return logRow(ctx.messageId, ctx.inReplyTo, ctx.fromEmail, msg.from?.name, ctx.subject, ctx.snippet, msg.raw_size, 'new_ticket', newId, null, `notification reply: ${templateKey} → category ${intent.category}`, ctx.cleanedBody);
}

async function createGenericTicket(customer, msg, ctx) {
  const newId = await insertNewTicket({
    customerId: customer.customer_id,
    subject: ctx.subject || 'Email enquiry',
    description: ctx.cleanedBody || ctx.snippet,
    category: 'General',
    priority: 'normal',
    via: 'email-cold-inbound',
  });
  await ingestAttachments(newId, msg);
  return logRow(ctx.messageId, ctx.inReplyTo, ctx.fromEmail, msg.from?.name, ctx.subject, ctx.snippet, msg.raw_size, 'new_ticket', newId, null, 'known customer, no template context', ctx.cleanedBody);
}

async function appendAsCcReply(ticketId, msg, ctx) {
  const [[ticket]] = await pool.query('SELECT customer_id FROM tickets WHERE id = ?', [ticketId]);
  if (!ticket) {
    return logRow(ctx.messageId, ctx.inReplyTo, ctx.fromEmail, msg.from?.name, ctx.subject, ctx.snippet, msg.raw_size, 'error', null, null, `cc match on ticket #${ticketId} but ticket vanished`, ctx.cleanedBody);
  }
  await appendMessage(ticketId, ticket.customer_id, ctx, msg, 'customer_cc_email');
  return logRow(ctx.messageId, ctx.inReplyTo, ctx.fromEmail, msg.from?.name, ctx.subject, ctx.snippet, msg.raw_size, 'appended', ticketId, null, `CC participant ${ctx.fromEmail} → ticket #${ticketId}`, ctx.cleanedBody);
}

// ── DB helpers ───────────────────────────────────────────────────────────────

async function insertNewTicket({ customerId, subject, description, category, priority, via }) {
  const finalSubject = (subject || '').replace(/^\s*Re:\s*/i, '').slice(0, 500) || 'Email enquiry';
  const finalDescription = `${description || ''}\n\n---\nReceived via email (${via}).`;
  const [r] = await pool.query(
    `INSERT INTO tickets (customer_id, subject, description, status, priority, request_type, created_at, updated_at)
     VALUES (?, ?, ?, 'open', ?, ?, NOW(), NOW())`,
    [customerId, finalSubject, finalDescription, priority || 'normal', category || 'General']
  );
  return r.insertId;
}

async function insertLinkedNewTicket(customerId, parentTicketId, parentSubject, ctx) {
  const subject = ctx.subject || `Re: ${parentSubject || 'previous ticket'}`;
  const description = `${ctx.cleanedBody || ctx.snippet}\n\n---\nReceived via email reply to closed ticket #${parentTicketId} (past 24h reopen window — new ticket created and linked).`;
  const [r] = await pool.query(
    `INSERT INTO tickets (customer_id, subject, description, status, priority, request_type, created_at, updated_at)
     VALUES (?, ?, ?, 'open', 'normal', 'General', NOW(), NOW())`,
    [customerId, subject.slice(0, 500), description]
  );
  return r.insertId;
}

async function appendMessage(ticketId, customerId, ctx, msg, senderRole) {
  const body = ctx.cleanedBody || ctx.snippet || '(empty body)';
  // sender_id needs the customer's user_id (existing pattern). Tag the body
  // with the sender's email for CC replies so the panel can show
  // "sarah@client.com (CC) replied via email".
  const [[userRow]] = await pool.query('SELECT user_id FROM customers WHERE id = ? LIMIT 1', [customerId]);
  const senderUserId = userRow?.user_id || null;
  const prefix = senderRole === 'customer_cc_email' ? `[CC ${ctx.fromEmail}] ` : '';
  await pool.query(
    `INSERT INTO ticket_messages (ticket_id, sender_id, message, via_email, created_at)
     VALUES (?, ?, ?, 1, NOW())`,
    [ticketId, senderUserId, `${prefix}${body}`]
  );
  await pool.query(`UPDATE tickets SET updated_at = NOW() WHERE id = ?`, [ticketId]);
  await ingestAttachments(ticketId, msg);
}

async function ingestAttachments(ticketId, msg) {
  if (!msg.attachments?.length) return;
  const maxMb = await getIntSetting('chat_attachment_max_mb', 10);
  const maxBytes = maxMb * 1024 * 1024;
  for (const att of msg.attachments) {
    if (!att.content) continue;
    if (att.content.length > maxBytes) {
      console.warn(`[inbound-email] skipping oversized attachment ${att.filename} (${att.content.length} bytes)`);
      continue;
    }
    const ext = (att.filename || '').split('.').pop() || 'bin';
    const stored = `email-${ticketId}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.${ext}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, stored), att.content);
    await pool.query(
      `INSERT INTO file_attachments (original_name, stored_name, mime_type, size_bytes, ref_type, ref_id, created_at)
       VALUES (?, ?, ?, ?, 'ticket', ?, NOW())`,
      [att.filename || stored, stored, att.contentType || 'application/octet-stream', att.content.length, ticketId]
    );
  }
}

async function notifyAdmin(subject, body) {
  try {
    const [admins] = await pool.query("SELECT email FROM users WHERE role = 'admin' AND is_active = 1");
    for (const a of admins) {
      sendMail({ to: a.email, subject, html: `<p>${body}</p>` }).catch(() => {});
    }
  } catch (err) { console.error('[inbound-email notifyAdmin]', err); }
}

async function sendPoliteAutoReply(toEmail, msg) {
  if (!toEmail) return;
  // Throttle to once per 7 days per address — so we don't reply repeatedly
  // to spammers (which would just confirm our address is live + active).
  const [[row]] = await pool.query(
    'SELECT last_replied_at FROM inbound_autoreply_log WHERE from_email = ? LIMIT 1',
    [toEmail]
  );
  if (row) {
    const hoursSince = (Date.now() - new Date(row.last_replied_at).getTime()) / 3600_000;
    if (hoursSince < UNKNOWN_AUTOREPLY_THROTTLE_DAYS * 24) return;
  }
  await pool.query(
    'INSERT INTO inbound_autoreply_log (from_email, last_replied_at) VALUES (?, NOW()) ON DUPLICATE KEY UPDATE last_replied_at = NOW()',
    [toEmail]
  );

  // If admin has set up a public-facing support@ address, mention it in the
  // auto-reply AND forward the stranger's message there so a human can
  // decide. Otherwise just send the soft auto-reply and silently drop the
  // original — nothing is lost (it's logged in inbound_email).
  const supportAddr = (await getSetting('support_email_address', '')).toString().trim();

  // Forward to support@ (best-effort, fire-and-forget). Useful so the human-
  // monitored inbox catches anything the poller dropped.
  if (supportAddr && msg) {
    try {
      const fwdSubject = `[Forwarded — unknown sender] ${(msg.subject || '(no subject)').slice(0, 400)}`;
      const fwdBody = `
<p>The inbound poller received the message below from <strong>${toEmail}</strong>, who isn't in the customers table. Auto-reply was sent (throttled to 1×/7d).</p>
<p>Forwarded so you can decide if it needs a human response.</p>
<hr/>
<p><strong>From:</strong> ${msg.from?.name ? `${msg.from.name} &lt;${toEmail}&gt;` : toEmail}</p>
<p><strong>Subject:</strong> ${msg.subject || '(no subject)'}</p>
<hr/>
<pre style="white-space:pre-wrap;font-family:inherit;font-size:13px;color:#374151">${(msg.text || msg.html || '').slice(0, 4000)}</pre>`;
      sendMail({
        to: supportAddr,
        subject: fwdSubject,
        html: fwdBody,
        headers: { 'Auto-Submitted': 'auto-generated' }, // don't trip remote auto-reply loops
      }).catch(() => {});
    } catch (err) {
      console.error('[inbound-email forward to support]', err.message);
    }
  }

  const messageId = await makeOutgoingMessageId({ templateKey: 'unknown_sender_autoreply' });
  const supportLine = supportAddr
    ? `<p>Our team will be in touch via <a href="mailto:${supportAddr}">${supportAddr}</a> shortly.</p>`
    : `<p>Our team will be in touch shortly.</p>`;
  sendMail({
    to: toEmail,
    messageId,
    subject: 'Re: your message',
    html: `
<p>Thanks — we got your message.</p>
<p>If you're already a customer, please reply from the email address you have on file with us so we can find your account.</p>
${supportLine}
<p style="color:#9ca3af;font-size:12px;margin-top:18px">This is an automated acknowledgement. We won't reply again to this address for 7 days.</p>`,
    headers: { 'Auto-Submitted': 'auto-replied' },
  }).catch(() => {});
}

// ── Plain helpers ────────────────────────────────────────────────────────────

function htmlToText(html) {
  if (!html) return '';
  return html.replace(/<style[\s\S]*?<\/style>/gi, '')
             .replace(/<script[\s\S]*?<\/script>/gi, '')
             .replace(/<br\s*\/?\s*>/gi, '\n')
             .replace(/<\/(p|div|li|tr)>/gi, '\n')
             .replace(/<[^>]+>/g, ' ')
             .replace(/&nbsp;/g, ' ')
             .replace(/&amp;/g, '&')
             .replace(/&lt;/g, '<')
             .replace(/&gt;/g, '>')
             .replace(/&quot;/g, '"')
             .replace(/[ \t]+\n/g, '\n')
             .replace(/\n{3,}/g, '\n\n')
             .trim();
}

// Strip "> On <date> X wrote:" quoted history below the new reply. Best-effort
// — different mail clients format quoting differently; we catch the common ones.
function stripQuotedHistory(text) {
  if (!text) return '';
  const lines = text.split(/\r?\n/);
  const cutPatterns = [
    /^On\s.+?wrote:\s*$/i,                                 // Gmail / Apple Mail
    /^_{3,}\s*$/,                                          // Outlook divider
    /^From:\s.+/,                                          // Outlook quoted header
    /^Sent:\s/,                                            // Outlook quoted header
    /^>+\s/,                                               // Already-prefixed quote
    /^-{2,}\s*Original Message\s*-{2,}/i,
  ];
  for (let i = 0; i < lines.length; i++) {
    for (const p of cutPatterns) {
      if (p.test(lines[i].trim())) {
        // Cut here, but keep the few lines above as the actual reply.
        return lines.slice(0, i).join('\n').trim();
      }
    }
  }
  return text.trim();
}

async function logRow(message_id, in_reply_to, from_email, from_name, subject, snippet, raw_size, status, ticket_id, parent_ticket_id, note, body_text) {
  await safeLog({ message_id, in_reply_to, from_email, from_name, subject, snippet, raw_size, status, ticket_id, parent_ticket_id, note, body_text });
}

async function safeLog(row) {
  try {
    await pool.query(
      `INSERT INTO inbound_email
        (message_id, in_reply_to, from_email, from_name, subject, snippet, body_text, raw_size, status, ticket_id, parent_ticket_id, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE id = id`,
      [
        (row.message_id || '').slice(0, 255),
        (row.in_reply_to || '').slice(0, 255) || null,
        (row.from_email || '').slice(0, 320),
        (row.from_name || '').slice(0, 255) || null,
        (row.subject || '').slice(0, 500),
        (row.snippet || '').slice(0, 500),
        // MEDIUMTEXT caps at 16 MB; trim defensively to 100K to avoid
        // monster marketing emails from blowing up DB row size.
        row.body_text ? String(row.body_text).slice(0, 100_000) : null,
        row.raw_size || 0,
        row.status,
        row.ticket_id || null,
        row.parent_ticket_id || null,
        (row.note || '').slice(0, 500) || null,
      ]
    );
  } catch (err) {
    console.error('[inbound-email safeLog]', err.message);
  }
}

module.exports = { start, stop };
