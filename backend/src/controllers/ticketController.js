const { pool } = require('../config/database');
const { buildReplyEmailAttachments } = require('../utils/replyAttachmentUtils');
const {
  getCustomerWithPlan,
  isPlanActive,
  getTicketUsage,
  incrementTicketUsage,
} = require('../utils/planUtils');
const { detectBotResponse } = require('../utils/botUtils');
const { searchKbWithAI } = require('../utils/aiKbUtils');
const {
  sendTicketCreatedEmail,
  sendAgentReplyEmail,
  sendCustomerReplyEmail,
  sendTicketAssignedEmail,
  sendCcAddedToTicketEmail,
} = require('../utils/emailUtils');
const { pickAgent } = require('../utils/assignment');

const REQUEST_TYPES = ['User Management','Domain & Setup','Plan Change','Billing','Email & Migration','Access Issue','Feature Help','Escalation to Google'];
const GW_EDITIONS   = ['Business Starter','Business Standard','Business Plus','Enterprise','Frontline','Nonprofits'];

exports.createTicket = async (req, res) => {
  try {
    const { subject, description, cc_emails, request_type, gw_edition, affected_users } = req.body;
    if (!subject || !description)
      return res.status(400).json({ error: 'Subject and description are required' });

    if (request_type && !REQUEST_TYPES.includes(request_type))
      return res.status(400).json({ error: 'Invalid request_type' });
    if (gw_edition && !GW_EDITIONS.includes(gw_edition))
      return res.status(400).json({ error: 'Invalid gw_edition' });

    // Validate and normalise CC emails (comma-separated string)
    let ccStr = null;
    if (cc_emails) {
      const emails = cc_emails.split(',').map(e => e.trim()).filter(Boolean);
      const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      const invalid = emails.filter(e => !emailRe.test(e));
      if (invalid.length)
        return res.status(400).json({ error: `Invalid CC email(s): ${invalid.join(', ')}` });
      ccStr = emails.join(', ');
    }

    const customer = await getCustomerWithPlan(req.user.id);
    if (!customer) return res.status(404).json({ error: 'Customer profile not found' });

    // Plan must be active
    if (!isPlanActive(customer)) {
      return res.status(403).json({
        error: 'Your support plan has expired or is not active',
        upgrade_required: true,
      });
    }

    // Check monthly ticket limit (free plan => no hard limit but no chat/call)
    const ticketsUsed = await getTicketUsage(customer.id);
    if (customer.tickets_limit !== null && ticketsUsed >= customer.tickets_limit) {
      return res.status(403).json({
        error: `Monthly ticket limit of ${customer.tickets_limit} reached`,
        limit_exceeded: true,
        used: ticketsUsed,
        limit: customer.tickets_limit,
        upgrade_required: true,
      });
    }

    // Auto-boost priority based on affected user count
    let priority = customer.priority || 'normal';
    const numAffected = parseInt(affected_users) || 0;
    if (numAffected >= 25) priority = 'urgent';
    else if (numAffected >= 10) priority = 'high';

    // Bot suggestions (before ticket creation)
    const botHints = detectBotResponse(`${subject} ${description}`);

    // Create ticket
    const [result] = await pool.query(
      `INSERT INTO tickets (customer_id, subject, description, status, priority, cc_emails, request_type, gw_edition, affected_users)
       VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?)`,
      [customer.id, subject, description, priority, ccStr,
       request_type || null, gw_edition || null, numAffected || null]
    );

    await incrementTicketUsage(customer.id);

    const ticketId = result.insertId;

    // Tiered SLA: use plan-level hours if configured, else fall back to sla_configs
    try {
      const [[planSla]] = await pool.query(
        'SELECT sla_response_hours, sla_resolve_hours FROM plans WHERE id = ?',
        [customer.plan_id]
      );
      if (planSla?.sla_response_hours || planSla?.sla_resolve_hours) {
        await pool.query(
          `UPDATE tickets SET
             sla_response_due = IF(? IS NOT NULL, DATE_ADD(NOW(), INTERVAL ? HOUR), NULL),
             sla_resolve_due  = IF(? IS NOT NULL, DATE_ADD(NOW(), INTERVAL ? HOUR), NULL)
           WHERE id = ?`,
          [planSla.sla_response_hours, planSla.sla_response_hours,
           planSla.sla_resolve_hours,  planSla.sla_resolve_hours, ticketId]
        );
      }
    } catch { /* SLA config missing — slaWorker will fill in later */ }

    // ── Auto-assign via centralized helper ──────────────────────────────
    // Tries online agents under heavy-load threshold first, falls back to admins
    // for emergency/overflow situations. Honors work-hours block, round-robin
    // mode, skill tags (by request_type), VIP favorite agent, and break mode.
    const skillTagsRequired = request_type ? [request_type] : [];
    const { agentId, reason } = await pickAgent({
      io: req.io,
      channel: 'ticket',
      customerId: customer.id,
      priority,
      skillTagsRequired,
      requireOnline: false, // tickets are async — allow assignment even if no one is online
    });

    if (agentId) {
      const [[assignedAgent]] = await pool.query(
        'SELECT id, name, email FROM users WHERE id = ?', [agentId]
      );
      await pool.query('UPDATE tickets SET assigned_agent_id = ? WHERE id = ?', [agentId, ticketId]);
      console.log(`[Ticket] #${ticketId} assigned to ${assignedAgent.name} via ${reason}`);
      if (req.io) {
        req.io.to(`user_${agentId}`).emit('ticket_assigned', {
          ticketId, subject, customerName: req.user.name, reason,
        });
      }
      sendTicketAssignedEmail({
        to: assignedAgent.email,
        agentName: assignedAgent.name,
        customerName: req.user.name,
        ticketId, subject, description,
      });
    } else {
      console.warn(`[Ticket] #${ticketId} could not be auto-assigned: ${reason}`);
    }

    const [ticket] = await pool.query(
      `SELECT t.*, u.name AS customer_name
       FROM tickets t
       JOIN customers c ON c.id = t.customer_id
       JOIN users u ON u.id = c.user_id
       WHERE t.id = ?`,
      [ticketId]
    );

    // Email confirmation to customer + CC aliases (fire-and-forget). Skipped
    // entirely when admin has disabled ticket-created emails to reduce inbox
    // noise — the ticket still appears in the customer's portal, just no email.
    try {
      const { getBoolSetting } = require('../utils/settings');
      if (await getBoolSetting('ticket_created_email_enabled', true)) {
        sendTicketCreatedEmail({
          to: req.user.email,
          cc: ccStr || undefined,
          customerName: req.user.name,
          ticketId,
          subject,
          description,
        });
      }
    } catch {}

    res.status(201).json({
      ticket: ticket[0],
      botSuggestions: botHints,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.getMyTickets = async (req, res) => {
  try {
    const [cRows] = await pool.query(
      'SELECT id FROM customers WHERE user_id = ?',
      [req.user.id]
    );
    if (!cRows.length) return res.status(404).json({ error: 'Customer not found' });
    const customerId = cRows[0].id;

    const { status, search, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let where = 'WHERE t.customer_id = ?';
    const params = [customerId];
    if (status) { where += ' AND t.status = ?'; params.push(status); }
    if (search) { where += ' AND t.subject LIKE ?'; params.push(`%${search}%`); }

    const [tickets] = await pool.query(
      `SELECT t.*, u.name AS agent_name
       FROM tickets t
       LEFT JOIN users u ON u.id = t.assigned_agent_id
       ${where}
       ORDER BY t.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM tickets t ${where}`,
      params
    );

    res.json({ tickets, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.getTicketById = async (req, res) => {
  try {
    const [cRows] = await pool.query(
      'SELECT id FROM customers WHERE user_id = ?',
      [req.user.id]
    );
    const customerId = cRows[0]?.id;

    const [tickets] = await pool.query(
      `SELECT t.*, u.name AS agent_name, cu.user_name AS customer_name
       FROM tickets t
       LEFT JOIN users u ON u.id = t.assigned_agent_id
       LEFT JOIN (
         SELECT c.id, usr.name AS user_name FROM customers c JOIN users usr ON usr.id = c.user_id
       ) cu ON cu.id = t.customer_id
       WHERE t.id = ?`,
      [req.params.id]
    );

    if (!tickets.length) return res.status(404).json({ error: 'Ticket not found' });
    const ticket = tickets[0];

    // Customers can only see their own tickets
    if (req.user.role === 'customer' && ticket.customer_id !== customerId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const [messages] = await pool.query(
      `SELECT tm.*, u.name AS sender_name, u.role AS sender_role
       FROM ticket_messages tm
       JOIN users u ON u.id = tm.sender_id
       WHERE tm.ticket_id = ?
       ORDER BY tm.created_at ASC`,
      [ticket.id]
    );

    res.json({ ticket, messages });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.addMessage = async (req, res) => {
  try {
    const { message, attachmentIds } = req.body;
    if (!message) return res.status(400).json({ error: 'Message is required' });

    const [tickets] = await pool.query(
      'SELECT * FROM tickets WHERE id = ?',
      [req.params.id]
    );
    if (!tickets.length) return res.status(404).json({ error: 'Ticket not found' });

    if (tickets[0].status === 'closed')
      return res.status(400).json({ error: 'Cannot reply to a closed ticket' });

    // Verify customer owns this ticket
    if (req.user.role === 'customer') {
      const [cRows] = await pool.query(
        'SELECT id FROM customers WHERE user_id = ?',
        [req.user.id]
      );
      if (!cRows.length || cRows[0].id !== tickets[0].customer_id)
        return res.status(403).json({ error: 'Forbidden' });
    }

    const [result] = await pool.query(
      'INSERT INTO ticket_messages (ticket_id, sender_id, message) VALUES (?, ?, ?)',
      [req.params.id, req.user.id, message]
    );

    await pool.query(
      "UPDATE tickets SET status = 'pending', updated_at = NOW() WHERE id = ?",
      [req.params.id]
    );

    const [newMsg] = await pool.query(
      `SELECT tm.*, u.name AS sender_name, u.role AS sender_role
       FROM ticket_messages tm
       JOIN users u ON u.id = tm.sender_id
       WHERE tm.id = ?`,
      [result.insertId]
    );

    // Email notifications (fire-and-forget)
    const ticket = tickets[0];
    // Attach any files the sender uploaded with this reply so CC recipients
    // (no portal login) receive the image, not just the text.
    const emailAttachments = await buildReplyEmailAttachments(attachmentIds, ticket.id);
    if (req.user.role === 'agent' || req.user.role === 'admin') {
      // Agent replied → notify customer + CC aliases
      const [[custUser]] = await pool.query(
        `SELECT u.id, u.email, u.name FROM users u
         JOIN customers c ON c.user_id = u.id
         WHERE c.id = ?`,
        [ticket.customer_id]
      );
      if (custUser) {
        sendAgentReplyEmail({
          to: custUser.email,
          cc: ticket.cc_emails || undefined,
          customerName: custUser.name,
          ticketId: ticket.id,
          subject: ticket.subject,
          agentName: req.user.name,
          message,
          attachments: emailAttachments,
        });
        if (req.io) {
          req.io.to(`user_${custUser.id}`).emit('ticket_agent_reply', {
            ticketId: ticket.id,
            subject: ticket.subject,
            agentName: req.user.name,
            message: newMsg[0].message,
          });
        }
      }
    } else {
      // Customer replied → notify CC aliases ONLY. Agents used to also receive
      // this email but they already get a real-time bell notification +
      // ticket_customer_reply socket event (see the io.to(user_<agentId>)
      // emit a few lines down) — the extra email was duplicate noise.
      if (ticket.cc_emails) {
        const ccList = ticket.cc_emails.split(',').map(e => e.trim()).filter(Boolean);
        if (ccList.length) {
          sendCustomerReplyEmail({
            to: ccList[0],
            cc: ccList.slice(1).join(', ') || undefined,
            agentName: 'Support Team',
            customerName: req.user.name,
            ticketId: ticket.id,
            subject: ticket.subject,
            message,
            attachments: emailAttachments,
          });
        }
      }
    }

    // Socket — real-time notification to assigned agent when customer replies
    if (req.io && req.user.role === 'customer' && ticket.assigned_agent_id) {
      req.io.to(`user_${ticket.assigned_agent_id}`).emit('ticket_customer_reply', {
        ticketId: ticket.id,
        subject: ticket.subject,
        customerName: req.user.name,
        message: newMsg[0].message,
        newMessage: newMsg[0],
      });
    }

    res.status(201).json({ message: newMsg[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.updateCcEmails = async (req, res) => {
  try {
    const { cc_emails } = req.body;

    // Load ticket + customer name — needed for the diff and for the notification email
    const [tickets] = await pool.query(
      `SELECT t.id, t.customer_id, t.cc_emails, t.subject, cu.user_name AS customer_name
       FROM tickets t
       LEFT JOIN (
         SELECT c.id, usr.name AS user_name
         FROM customers c JOIN users usr ON usr.id = c.user_id
       ) cu ON cu.id = t.customer_id
       WHERE t.id = ?`,
      [req.params.id]
    );
    if (!tickets.length) return res.status(404).json({ error: 'Ticket not found' });
    const ticket = tickets[0];

    if (req.user.role === 'customer') {
      const [cRows] = await pool.query(
        'SELECT id FROM customers WHERE user_id = ?',
        [req.user.id]
      );
      if (!cRows.length || cRows[0].id !== ticket.customer_id)
        return res.status(403).json({ error: 'Forbidden' });
    }

    // Normalise the incoming list
    let normalised = [];
    if (cc_emails) {
      const raw = Array.isArray(cc_emails) ? cc_emails : String(cc_emails).split(',');
      const trimmed = raw.map(e => String(e).trim()).filter(Boolean);
      const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      const invalid = trimmed.filter(e => !re.test(e));
      if (invalid.length)
        return res.status(400).json({ error: `Invalid CC email(s): ${invalid.join(', ')}` });
      if (trimmed.length > 10)
        return res.status(400).json({ error: 'Maximum 10 CC recipients' });
      normalised = [...new Set(trimmed.map(e => e.toLowerCase()))];
    }
    const ccStr = normalised.length ? normalised.join(', ') : null;

    // Diff: only newly-added recipients get the one-time "you've been added" email
    const oldList = ticket.cc_emails
      ? ticket.cc_emails.split(',').map(e => e.trim().toLowerCase()).filter(Boolean)
      : [];
    const newlyAdded = normalised.filter(e => !oldList.includes(e));

    await pool.query(
      'UPDATE tickets SET cc_emails = ?, updated_at = NOW() WHERE id = ?',
      [ccStr, req.params.id]
    );

    // Await notifications so we can report SMTP failures back to the UI (Gmail rate limits,
    // bad creds, blocked sender, etc.) instead of silently swallowing them.
    const notified = [];
    const failed = [];
    for (const email of newlyAdded) {
      const r = await sendCcAddedToTicketEmail({
        to: email,
        ticketId: ticket.id,
        subject: ticket.subject,
        customerName: ticket.customer_name || 'An Anu Tech Digital customer',
      }).catch(err => ({ ok: false, error: err.message }));
      if (r?.ok) notified.push(email);
      else failed.push({ email, error: r?.error || 'Unknown error' });
    }

    res.json({ cc_emails: ccStr, notified, failed });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.botSuggest = async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ suggestions: [] });
    // Try local KB first for fast response
    const local = detectBotResponse(message) || [];
    res.json({ suggestions: local });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};

exports.closeTicket = async (req, res) => {
  try {
    const [cRows] = await pool.query('SELECT id FROM customers WHERE user_id = ?', [req.user.id]);
    if (!cRows.length) return res.status(404).json({ error: 'Customer not found' });
    const customerId = cRows[0].id;

    const [tickets] = await pool.query('SELECT * FROM tickets WHERE id = ?', [req.params.id]);
    if (!tickets.length) return res.status(404).json({ error: 'Ticket not found' });

    const ticket = tickets[0];
    if (ticket.customer_id !== customerId) return res.status(403).json({ error: 'Forbidden' });
    if (ticket.status === 'closed') return res.status(400).json({ error: 'Ticket is already closed' });

    await pool.query(
      "UPDATE tickets SET status = 'closed', closed_at = NOW(), updated_at = NOW() WHERE id = ?",
      [req.params.id]
    );
    res.json({ message: 'Ticket closed' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.reopenTicket = async (req, res) => {
  try {
    const [cRows] = await pool.query('SELECT id FROM customers WHERE user_id = ?', [req.user.id]);
    if (!cRows.length) return res.status(404).json({ error: 'Customer not found' });
    const customerId = cRows[0].id;

    const [tickets] = await pool.query('SELECT * FROM tickets WHERE id = ?', [req.params.id]);
    if (!tickets.length) return res.status(404).json({ error: 'Ticket not found' });

    const ticket = tickets[0];
    if (ticket.customer_id !== customerId) return res.status(403).json({ error: 'Forbidden' });
    if (ticket.status !== 'closed') return res.status(400).json({ error: 'Only closed tickets can be reopened' });

    // 24-hour reopen window: use closed_at if set, fall back to updated_at for legacy tickets
    const closedAt = ticket.closed_at || ticket.updated_at;
    const hoursElapsed = (Date.now() - new Date(closedAt).getTime()) / 3600000;
    if (hoursElapsed > 24) {
      return res.status(400).json({ error: 'Reopen window has expired (24 hours). Please open a new ticket.' });
    }

    await pool.query(
      "UPDATE tickets SET status = 'open', closed_at = NULL, updated_at = NOW() WHERE id = ?",
      [req.params.id]
    );
    res.json({ message: 'Ticket reopened' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.aiKbSearch = async (req, res) => {
  try {
    const { query } = req.body;
    if (!query || query.trim().length < 3) return res.status(400).json({ error: 'Query too short' });
    const result = await searchKbWithAI(query.trim());
    if (result.error) return res.status(503).json({ error: result.error });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};
