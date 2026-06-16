const { pool } = require('../config/database');
const { sendAgentReplyEmail } = require('../utils/emailUtils');
const { sendPushToUser } = require('../utils/pushUtils');
const { buildReplyEmailAttachments } = require('../utils/replyAttachmentUtils');

exports.getAgentDashboard = async (req, res) => {
  try {
    const agentId = req.user.id;
    const { _getChatRingForId } = require('../socket/chatSocket');

    const [[openTickets]] = await pool.query(
      "SELECT COUNT(*) AS count FROM tickets WHERE assigned_agent_id = ? AND status != 'closed'",
      [agentId]
    );
    // pendingChats: only chats currently rung to ME (or with no active ring — broadcast
    // fallback). Same filter as getPendingChats so the sidebar badge & dashboard stay
    // in sync with the ring-ownership model.
    const [pendingRows] = await pool.query(
      "SELECT id FROM chats WHERE status = 'waiting'"
    );
    const pendingForMe = pendingRows.filter(r => {
      const ring = _getChatRingForId ? _getChatRingForId(r.id) : null;
      if (!ring) return true;
      return Number(ring.agentId) === Number(agentId);
    });
    const pendingChats = { count: pendingForMe.length };
    const [[activeChats]] = await pool.query(
      "SELECT COUNT(*) AS count FROM chats WHERE agent_id = ? AND status = 'active'",
      [agentId]
    );
    const [[resolvedToday]] = await pool.query(
      "SELECT COUNT(*) AS count FROM tickets WHERE assigned_agent_id = ? AND status = 'closed' AND DATE(updated_at) = CURDATE()",
      [agentId]
    );

    // SLA at-risk: assigned-to-me tickets, no first response yet, response SLA due within 30 min
    const [[slaAtRisk]] = await pool.query(
      `SELECT COUNT(*) AS count FROM tickets
       WHERE assigned_agent_id = ?
         AND status != 'closed'
         AND first_response_at IS NULL
         AND sla_response_due IS NOT NULL
         AND sla_response_due BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL 30 MINUTE)`,
      [agentId]
    );

    // SLA breached: assigned-to-me tickets where sla_response_due has already passed.
    // These are the "old tickets forgotten" the dashboard banner alerts on. We also
    // return the worst offenders (top 3 by how-overdue) so the banner can name them
    // directly: "Beta (12h overdue), Acme (8h overdue)".
    const [[slaBreached]] = await pool.query(
      `SELECT COUNT(*) AS count FROM tickets
       WHERE assigned_agent_id = ?
         AND status != 'closed'
         AND first_response_at IS NULL
         AND sla_response_due IS NOT NULL
         AND sla_response_due < NOW()`,
      [agentId]
    );
    const [slaBreachedTickets] = await pool.query(
      `SELECT t.id, t.subject,
              cu.user_name AS customer_name,
              TIMESTAMPDIFF(HOUR, sla_response_due, NOW()) AS hours_overdue
       FROM tickets t
       LEFT JOIN (SELECT c.id, usr.name AS user_name FROM customers c JOIN users usr ON usr.id = c.user_id) cu ON cu.id = t.customer_id
       WHERE t.assigned_agent_id = ?
         AND t.status != 'closed'
         AND t.first_response_at IS NULL
         AND t.sla_response_due IS NOT NULL
         AND t.sla_response_due < NOW()
       ORDER BY t.sla_response_due ASC LIMIT 3`,
      [agentId]
    );

    // Today's CSAT — average score across ticket + chat ratings for this agent today
    const [[csatToday]] = await pool.query(
      `SELECT ROUND(AVG(score), 2) AS avg, COUNT(*) AS total
       FROM ratings
       WHERE agent_id = ? AND DATE(created_at) = CURDATE()`,
      [agentId]
    );

    // Next action — most-urgent unresponded ticket assigned to me, else longest-waiting chat
    let nextAction = null;
    const [[urgentTicket]] = await pool.query(
      `SELECT id, subject, priority, sla_response_due,
              TIMESTAMPDIFF(MINUTE, NOW(), sla_response_due) AS mins_to_sla
       FROM tickets
       WHERE assigned_agent_id = ?
         AND status != 'closed'
         AND first_response_at IS NULL
       ORDER BY (sla_response_due IS NULL), sla_response_due ASC, created_at ASC
       LIMIT 1`,
      [agentId]
    );
    if (urgentTicket) {
      nextAction = {
        type: 'ticket',
        id: urgentTicket.id,
        subject: urgentTicket.subject,
        priority: urgentTicket.priority,
        minsToSla: urgentTicket.mins_to_sla,
      };
    } else {
      // Only surface a chat as the next action if it's currently being rung to
      // THIS agent (or has no active ring). Otherwise an escalated chat would
      // keep showing on the original agent's dashboard until the customer closes
      // it — defeating the sequential-ring contract.
      const [waitingChats] = await pool.query(
        `SELECT c.id, c.category, u.name AS customer_name,
                TIMESTAMPDIFF(MINUTE, c.created_at, NOW()) AS mins_waiting
         FROM chats c JOIN customers cu ON cu.id = c.customer_id JOIN users u ON u.id = cu.user_id
         WHERE c.status = 'waiting'
         ORDER BY c.created_at ASC`
      );
      const oldestChat = waitingChats.find(ch => {
        const ring = _getChatRingForId ? _getChatRingForId(ch.id) : null;
        if (!ring) return true;
        return Number(ring.agentId) === Number(agentId);
      });
      if (oldestChat) {
        nextAction = {
          type: 'chat',
          id: oldestChat.id,
          customerName: oldestChat.customer_name,
          category: oldestChat.category || null,
          minsWaiting: oldestChat.mins_waiting,
        };
      }
    }

    res.json({
      stats: {
        openTickets: openTickets.count,
        pendingChats: pendingChats.count,
        activeChats: activeChats.count,
        resolvedToday: resolvedToday.count,
        slaAtRisk: slaAtRisk.count,
        slaBreached: slaBreached.count,
        slaBreachedTickets,
        csatToday: {
          avg: csatToday.avg ? Number(csatToday.avg) : null,
          total: Number(csatToday.total) || 0,
        },
        nextAction,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.getAgentTickets = async (req, res) => {
  try {
    const { status, unassigned, all, view, request_type, gw_edition } = req.query;
    let where = '';
    const params = [];

    if (view === 'all') {
      where = 'WHERE t.merged_into IS NULL';
      if (status) { where += ' AND t.status = ?'; params.push(status); }
    } else if (all === 'true') {
      where = 'WHERE (t.assigned_agent_id IS NULL OR t.assigned_agent_id = ?) AND t.status != "closed"';
      params.push(req.user.id);
    } else if (unassigned === 'true') {
      where = 'WHERE t.assigned_agent_id IS NULL AND t.status != "closed"';
    } else {
      where = 'WHERE t.assigned_agent_id = ?';
      params.push(req.user.id);
      if (status) { where += ' AND t.status = ?'; params.push(status); }
    }
    if (request_type) { where += ' AND t.request_type = ?'; params.push(request_type); }
    if (gw_edition)   { where += ' AND t.gw_edition = ?';   params.push(gw_edition); }

    const agentId = req.user.id;
    const isAdmin = req.user.role === 'admin';
    const [tickets] = await pool.query(
      `SELECT t.*, u.name AS agent_name,
              cu.user_name AS customer_name, cu.domain AS customer_domain,
              p.name AS plan_name,
              (t.assigned_agent_id = ? OR ? = 1) AS is_mine
       FROM tickets t
       LEFT JOIN users u ON u.id = t.assigned_agent_id
       LEFT JOIN (
         SELECT c.id, usr.name AS user_name, c.domain, c.plan_id
         FROM customers c JOIN users usr ON usr.id = c.user_id
       ) cu ON cu.id = t.customer_id
       LEFT JOIN plans p ON p.id = cu.plan_id
       ${where}
       ORDER BY FIELD(t.priority,'urgent','high','medium','normal','low'), t.created_at ASC`,
      [agentId, isAdmin ? 1 : 0, ...params]
    );

    res.json({ tickets });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

const VALID_TICKET_STATUSES  = ['open', 'pending', 'closed', 'resolved'];
const VALID_TICKET_PRIORITIES = ['urgent', 'high', 'medium', 'normal', 'low'];

exports.updateTicket = async (req, res) => {
  try {
    // Whitelist of fields agents/admins may mutate via this endpoint.
    // Reassignment is intentionally NOT permitted here.
    const { status, priority } = req.body;

    if (status !== undefined && !VALID_TICKET_STATUSES.includes(status))
      return res.status(400).json({ error: 'Invalid status' });
    if (priority !== undefined && !VALID_TICKET_PRIORITIES.includes(priority))
      return res.status(400).json({ error: 'Invalid priority' });

    const [tickets] = await pool.query(
      'SELECT * FROM tickets WHERE id = ?',
      [req.params.id]
    );
    if (!tickets.length) return res.status(404).json({ error: 'Ticket not found' });

    // Only the assigned agent or an admin may update a ticket
    if (req.user.role !== 'admin' && tickets[0].assigned_agent_id !== req.user.id) {
      return res.status(403).json({ error: 'Only the assigned agent can update this ticket' });
    }

    const updates = [];
    const params = [];

    if (status !== undefined) {
      updates.push('status = ?'); params.push(status);
      // Keep closed_at in sync with status transitions so analytics + reopen logic work.
      // Customer reopen path (ticketController.reopenTicket) already does this; mirror here
      // for the agent/admin update path.
      if (status === 'closed') {
        updates.push('closed_at = COALESCE(closed_at, NOW())');
      } else if (tickets[0].status === 'closed' && status !== 'closed') {
        updates.push('closed_at = NULL');
      }
    }
    if (priority !== undefined)             { updates.push('priority = ?');        params.push(priority); }
    if (req.body.tags !== undefined)        { updates.push('tags = ?');            params.push(JSON.stringify(req.body.tags)); }
    if (req.body.due_date !== undefined)    { updates.push('due_date = ?');        params.push(req.body.due_date || null); }
    if (req.body.pending_reason !== undefined) { updates.push('pending_reason = ?'); params.push(req.body.pending_reason || null); }
    if (req.body.google_case_id !== undefined) { updates.push('google_case_id = ?'); params.push(req.body.google_case_id || null); }
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });

    params.push(req.params.id);
    await pool.query(
      `UPDATE tickets SET ${updates.join(', ')}, updated_at = NOW() WHERE id = ?`,
      params
    );

    const [updated] = await pool.query(
      'SELECT * FROM tickets WHERE id = ?',
      [req.params.id]
    );

    if (req.io && status !== undefined && status !== tickets[0].status) {
      const [[custUser]] = await pool.query(
        `SELECT u.id FROM users u JOIN customers c ON c.user_id = u.id WHERE c.id = ?`,
        [tickets[0].customer_id]
      );
      if (custUser) {
        req.io.to(`user_${custUser.id}`).emit('ticket_status_change', {
          ticketId: tickets[0].id,
          subject: tickets[0].subject,
          oldStatus: tickets[0].status,
          newStatus: status,
          agentName: req.user.name,
        });
      }
    }

    res.json({ ticket: updated[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// Agent self-claim: an unassigned ticket can be grabbed by any agent.
// Atomic — only succeeds if no other agent has claimed it in the meantime.
exports.claimTicket = async (req, res) => {
  try {
    const [result] = await pool.query(
      'UPDATE tickets SET assigned_agent_id = ? WHERE id = ? AND assigned_agent_id IS NULL',
      [req.user.id, req.params.id]
    );
    if (result.affectedRows === 0) {
      const [[ticket]] = await pool.query('SELECT assigned_agent_id FROM tickets WHERE id = ?', [req.params.id]);
      if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
      return res.status(409).json({ error: 'Ticket already claimed by another agent' });
    }
    const [[updated]] = await pool.query('SELECT * FROM tickets WHERE id = ?', [req.params.id]);

    if (req.io && updated) {
      const [[custUser]] = await pool.query(
        `SELECT u.id FROM users u JOIN customers c ON c.user_id = u.id WHERE c.id = ?`,
        [updated.customer_id]
      );
      if (custUser) {
        req.io.to(`user_${custUser.id}`).emit('ticket_assigned_to_customer', {
          ticketId: updated.id,
          subject: updated.subject,
          agentName: req.user.name,
        });
      }
    }

    res.json({ ticket: updated });
  } catch (err) {
    console.error('claimTicket error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.requestReassignment = async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason || !reason.trim())
      return res.status(400).json({ error: 'A reason is required' });

    const [tickets] = await pool.query('SELECT * FROM tickets WHERE id = ?', [req.params.id]);
    if (!tickets.length) return res.status(404).json({ error: 'Ticket not found' });
    if (tickets[0].assigned_agent_id !== req.user.id)
      return res.status(403).json({ error: 'You are not assigned to this ticket' });

    const note = `[Reassignment Request] Agent "${req.user.name}" cannot handle this ticket.\nReason: ${reason.trim()}`;
    await pool.query(
      'INSERT INTO ticket_messages (ticket_id, sender_id, message) VALUES (?, ?, ?)',
      [req.params.id, req.user.id, note]
    );

    if (req.io) {
      req.io.to('agents').emit('reassignment_requested', {
        ticketId: tickets[0].id,
        subject: tickets[0].subject,
        agentName: req.user.name,
        reason: reason.trim(),
      });
    }

    res.json({ message: 'Reassignment request submitted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.replyToTicket = async (req, res) => {
  try {
    const { message, attachmentIds } = req.body;
    if (!message) return res.status(400).json({ error: 'Message is required' });

    const [tickets] = await pool.query('SELECT * FROM tickets WHERE id = ?', [req.params.id]);
    if (!tickets.length) return res.status(404).json({ error: 'Ticket not found' });
    if (tickets[0].status === 'closed')
      return res.status(400).json({ error: 'Ticket is closed' });

    // Only the assigned agent or an admin may reply
    if (req.user.role !== 'admin' && tickets[0].assigned_agent_id !== req.user.id) {
      return res.status(403).json({ error: 'Only the assigned agent can reply to this ticket' });
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
       FROM ticket_messages tm JOIN users u ON u.id = tm.sender_id
       WHERE tm.id = ?`,
      [result.insertId]
    );

    // Notify customer + CC aliases by email (fire-and-forget)
    const ticket = tickets[0];
    const [[custUser]] = await pool.query(
      `SELECT u.id, u.email, u.name FROM users u
       JOIN customers c ON c.user_id = u.id
       WHERE c.id = ?`,
      [ticket.customer_id]
    );
    // Attach any files the agent uploaded with this reply so CC recipients
    // (no portal login) receive them, not just the text.
    const emailAttachments = await buildReplyEmailAttachments(attachmentIds, ticket.id);
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
      // OS push so the customer sees the reply even with the app closed.
      sendPushToUser(custUser.id, {
        title: `Reply on #${ticket.id}`,
        body: `${req.user.name}: ${String(newMsg[0].message).replace(/\s+/g, ' ').slice(0, 120)}`,
        url: `/customer/tickets/${ticket.id}`,
        tag: `ticket-${ticket.id}`,
      }).catch(() => {});
    }

    res.status(201).json({ message: newMsg[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.getPendingChats = async (req, res) => {
  try {
    const myId = req.user.id;

    // Two buckets returned together:
    //  (1) Unclaimed chats (agent_id IS NULL) — visible to all agents unless
    //      a sequential-ring is currently targeting one specific agent.
    //  (2) Chats reserved to ME but still 'waiting' (admin queued the chat
    //      while I was busy on another). Always visible to me, never to others.
    const [chats] = await pool.query(
      `SELECT ch.*, u.name AS customer_name, c.domain, p.name AS plan_name
       FROM chats ch
       JOIN customers c ON c.id = ch.customer_id
       JOIN users u ON u.id = c.user_id
       LEFT JOIN plans p ON p.id = c.plan_id
       WHERE ch.status = 'waiting' AND (ch.agent_id IS NULL OR ch.agent_id = ?)
       ORDER BY ch.created_at ASC`,
      [myId]
    );

    // Sequential-ring filter applies ONLY to unclaimed entries (agent_id IS NULL).
    // Chats already reserved to a specific agent bypass the ring since they're
    // explicitly held for that one agent.
    const { _getChatRingForId } = require('../socket/chatSocket');
    const filtered = chats.filter(ch => {
      if (ch.agent_id === myId) return true; // queued specifically to me
      const ring = _getChatRingForId ? _getChatRingForId(ch.id) : null;
      // No ring active → visible to all (broadcast fallback or auto-assign path)
      if (!ring) return true;
      // Active ring → only visible to the agent currently being rung
      return Number(ring.agentId) === Number(myId);
    });

    res.json({ chats: filtered });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};

exports.getMyChats = async (req, res) => {
  try {
    const [chats] = await pool.query(
      `SELECT ch.*, u.name AS customer_name, c.domain
       FROM chats ch
       JOIN customers c ON c.id = ch.customer_id
       JOIN users u ON u.id = c.user_id
       WHERE ch.agent_id = ? AND ch.status = 'active'
       ORDER BY ch.created_at DESC`,
      [req.user.id]
    );
    res.json({ chats });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};

exports.acceptChat = async (req, res) => {
  try {
    // Atomic claim: succeed only if the chat is still 'waiting' AND it's either
    // unclaimed OR already reserved to this same agent (e.g. an admin queued
    // it to them while they were busy). The reserved-to-me case is the new
    // path — without it, claiming a queued chat would 409.
    const [result] = await pool.query(
      `UPDATE chats SET agent_id = ?, status = 'active', accepted_at = NOW()
       WHERE id = ? AND status = 'waiting' AND (agent_id IS NULL OR agent_id = ?)`,
      [req.user.id, req.params.id, req.user.id]
    );

    if (result.affectedRows === 0) {
      const [chats] = await pool.query('SELECT id, status FROM chats WHERE id = ?', [req.params.id]);
      if (!chats.length) return res.status(404).json({ error: 'Chat not found' });
      return res.status(409).json({ error: 'Chat already accepted by another agent' });
    }

    const [[updated]] = await pool.query('SELECT * FROM chats WHERE id = ?', [req.params.id]);
    res.json({ chat: updated });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.getChatMessages = async (req, res) => {
  try {
    const [chats] = await pool.query('SELECT * FROM chats WHERE id = ?', [req.params.id]);
    if (!chats.length) return res.status(404).json({ error: 'Chat not found' });

    // Only the assigned agent or an admin may read chat history
    if (req.user.role !== 'admin' && chats[0].agent_id !== req.user.id) {
      return res.status(403).json({ error: 'You are not assigned to this chat' });
    }

    const [messages] = await pool.query(
      `SELECT cm.*, u.name AS sender_name, u.role AS sender_role
       FROM chat_messages cm
       JOIN users u ON u.id = cm.sender_id
       WHERE cm.chat_id = ?
       ORDER BY cm.created_at ASC`,
      [req.params.id]
    );
    res.json({ messages });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};

exports.getCustomerDetail = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT c.*, u.name, u.email,
              p.name AS plan_name, p.allow_chat, p.allow_calls,
              p.tickets_limit, p.calls_limit
       FROM customers c
       JOIN users u ON u.id = c.user_id
       LEFT JOIN plans p ON p.id = c.plan_id
       WHERE c.id = ?`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Customer not found' });

    let products = [];
    try { products = JSON.parse(rows[0].products || '[]'); } catch {}

    const [tickets] = await pool.query(
      `SELECT id, subject, status, priority, created_at FROM tickets
       WHERE customer_id = ? ORDER BY created_at DESC LIMIT 5`,
      [req.params.id]
    );

    res.json({ customer: { ...rows[0], products }, tickets });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};

// ── New endpoints ──────────────────────────────────────────────────────────────

exports.bulkUpdateTickets = async (req, res) => {
  try {
    const { ticket_ids, action, value } = req.body;
    if (!ticket_ids?.length || !action) return res.status(400).json({ error: 'ticket_ids and action required' });

    const ph = ticket_ids.map(() => '?').join(',');
    const base = req.user.role === 'admin'
      ? `WHERE id IN (${ph})`
      : `WHERE id IN (${ph}) AND assigned_agent_id = ?`;
    const baseParams = req.user.role === 'admin' ? ticket_ids : [...ticket_ids, req.user.id];

    if (action === 'close') {
      await pool.query(`UPDATE tickets SET status = 'closed', closed_at = COALESCE(closed_at, NOW()), updated_at = NOW() ${base}`, baseParams);
    } else if (action === 'set_priority' && value) {
      await pool.query(`UPDATE tickets SET priority = ?, updated_at = NOW() ${base}`, [value, ...baseParams]);
    } else if (action === 'set_status' && value) {
      // Mirror closed_at on bulk status flips. closed_at MUST come before status in the SET
      // list because MySQL evaluates SET expressions left-to-right using already-applied
      // values for subsequent columns — putting closed_at first lets us read the OLD status.
      if (value === 'closed') {
        await pool.query(`UPDATE tickets SET closed_at = COALESCE(closed_at, NOW()), status = ?, updated_at = NOW() ${base}`, [value, ...baseParams]);
      } else {
        await pool.query(`UPDATE tickets SET closed_at = CASE WHEN status = 'closed' THEN NULL ELSE closed_at END, status = ?, updated_at = NOW() ${base}`, [value, ...baseParams]);
      }
    } else if (action === 'add_tag' && value) {
      const [rows] = await pool.query(`SELECT id, tags FROM tickets ${base}`, baseParams);
      for (const t of rows) {
        const tags = Array.isArray(t.tags) ? t.tags : [];
        if (!tags.includes(value)) {
          await pool.query('UPDATE tickets SET tags = ?, updated_at = NOW() WHERE id = ?', [JSON.stringify([...tags, value]), t.id]);
        }
      }
    } else {
      return res.status(400).json({ error: 'Unknown action' });
    }

    res.json({ message: `Bulk ${action} applied to ${ticket_ids.length} ticket(s)` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.getAgentList = async (req, res) => {
  try {
    // Join in-memory online status from the socket layer so transfer dropdowns
    // (call + chat + ticket reassign) can show who's actually available to take
    // a hand-off right now. Falling back to an empty Set if io isn't wired up
    // (rare — only during early boot or in tests) so the response still works.
    const { getOnlineAgentIds } = require('../socket/chatSocket');
    const io = req.app.get('io');
    const onlineSet = io
      ? new Set((getOnlineAgentIds(io) || []).map(Number))
      : new Set();
    const [agents] = await pool.query(
      "SELECT id, name, email FROM users WHERE role IN ('agent','admin') AND is_active = TRUE ORDER BY name"
    );
    const enriched = agents.map(a => ({
      ...a,
      is_online: onlineSet.has(Number(a.id)),
    }));
    res.json({ agents: enriched });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};

exports.searchCustomers = async (req, res) => {
  try {
    const { q = '' } = req.query;
    const like = `%${q}%`;
    const [customers] = await pool.query(
      `SELECT c.id, u.name, u.email, c.domain, p.name AS plan_name
       FROM customers c
       JOIN users u ON u.id = c.user_id
       LEFT JOIN plans p ON p.id = c.plan_id
       WHERE u.name LIKE ? OR u.email LIKE ? OR c.domain LIKE ?
       ORDER BY u.name LIMIT 20`,
      [like, like, like]
    );
    res.json({ customers });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};

exports.createAgentTicket = async (req, res) => {
  try {
    const { customer_id, subject, description, priority = 'normal' } = req.body;
    if (!customer_id || !subject || !description)
      return res.status(400).json({ error: 'customer_id, subject and description are required' });

    const [customers] = await pool.query('SELECT id FROM customers WHERE id = ?', [customer_id]);
    if (!customers.length) return res.status(404).json({ error: 'Customer not found' });

    const [result] = await pool.query(
      `INSERT INTO tickets (customer_id, subject, description, status, priority, assigned_agent_id)
       VALUES (?, ?, ?, 'open', ?, ?)`,
      [customer_id, subject, description, priority, req.user.id]
    );

    const [ticket] = await pool.query(
      `SELECT t.*, u.name AS customer_name, a.name AS agent_name,
              cu.domain AS customer_domain, p.name AS plan_name
       FROM tickets t
       JOIN customers c ON c.id = t.customer_id
       JOIN users u ON u.id = c.user_id
       LEFT JOIN users a ON a.id = t.assigned_agent_id
       LEFT JOIN plans p ON p.id = c.plan_id
       LEFT JOIN customers cu ON cu.id = t.customer_id
       WHERE t.id = ?`,
      [result.insertId]
    );

    res.status(201).json({ ticket: ticket[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// POST /api/agent/calls/:id/notes — save the agent's quick-notes for a call.
// Called automatically when the call ends, regardless of the wrap-up choice — that
// way the notes are preserved even if the agent picks "Resolved" or "Skip" instead
// of "Create follow-up ticket". The notes are visible later from the Calls tab.
exports.saveCallNotes = async (req, res) => {
  try {
    const callId = Number(req.params.id);
    const { notes } = req.body;
    const [[call]] = await pool.query('SELECT agent_id FROM calls WHERE id = ?', [callId]);
    if (!call) return res.status(404).json({ error: 'Call not found' });
    if (call.agent_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    await pool.query('UPDATE calls SET agent_notes = ? WHERE id = ?', [notes || null, callId]);
    res.json({ ok: true });
  } catch (err) {
    console.error('saveCallNotes', err);
    res.status(500).json({ error: 'Server error' });
  }
};

// GET /api/agent/calls/mine — recent calls handled by this agent (last 30 days).
// Used by the agent's Calls tab: powers both the recent-history list and the today/total
// stats. Returns customer name + duration + status so the agent has full context.
exports.getMyCalls = async (req, res) => {
  try {
    const agentId = req.user.id;
    const [calls] = await pool.query(
      `SELECT ca.id, ca.status, ca.call_start_time, ca.call_end_time, ca.duration,
              ca.created_at, ca.initiated_by, ca.ticket_id, ca.agent_notes,
              ca.participants,
              u.name AS customer_name, cu.id AS customer_id, cu.domain AS customer_domain
       FROM calls ca
       LEFT JOIN customers cu ON cu.id = ca.customer_id
       LEFT JOIN users u ON u.id = cu.user_id
       WHERE (ca.agent_id = ?
              OR JSON_CONTAINS(ca.participants, JSON_OBJECT('agent_id', ?)) = 1)
         AND ca.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
       ORDER BY ca.created_at DESC
       LIMIT 100`,
      [agentId, agentId]
    );

    // Today/all-time stats for the header cards
    const [[today]] = await pool.query(
      `SELECT
         COUNT(*) AS calls_today,
         COALESCE(SUM(CASE WHEN call_start_time IS NOT NULL THEN duration ELSE 0 END), 0) AS seconds_today
       FROM calls
       WHERE agent_id = ? AND DATE(created_at) = CURDATE()`,
      [agentId]
    );
    const [[connectedRow]] = await pool.query(
      `SELECT COUNT(*) AS n FROM calls
       WHERE agent_id = ? AND call_start_time IS NOT NULL
         AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)`,
      [agentId]
    );

    res.json({
      calls,
      stats: {
        calls_today: Number(today?.calls_today) || 0,
        seconds_today: Number(today?.seconds_today) || 0,
        connected_30d: Number(connectedRow?.n) || 0,
      },
    });
  } catch (err) {
    console.error('getMyCalls', err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.getAgentTicketDetail = async (req, res) => {
  try {
    const agentId = req.user.id;
    const [tickets] = await pool.query(
      `SELECT t.*, a.name AS agent_name,
              cu.user_name AS customer_name, cu.domain AS customer_domain, cu.cust_id AS cust_id,
              p.name AS plan_name, cu.plan_expiry,
              (t.assigned_agent_id = ? OR ? = 'admin') AS is_mine
       FROM tickets t
       LEFT JOIN users a ON a.id = t.assigned_agent_id
       LEFT JOIN (SELECT c.id AS cust_id, usr.name AS user_name, c.domain, c.plan_id, c.plan_expiry, c.id
                  FROM customers c JOIN users usr ON usr.id = c.user_id) cu ON cu.id = t.customer_id
       LEFT JOIN plans p ON p.id = cu.plan_id
       WHERE t.id = ?`,
      [agentId, req.user.role, req.params.id]
    );
    if (!tickets.length) return res.status(404).json({ error: 'Ticket not found' });

    const ticket = tickets[0];
    // Parse tags JSON safely
    if (typeof ticket.tags === 'string') {
      try { ticket.tags = JSON.parse(ticket.tags); } catch { ticket.tags = []; }
    }

    const [messages] = await pool.query(
      `SELECT tm.*, u.name AS sender_name, u.role AS sender_role
       FROM ticket_messages tm JOIN users u ON u.id = tm.sender_id
       WHERE tm.ticket_id = ? ORDER BY tm.created_at ASC`,
      [req.params.id]
    );

    // Total time logged
    const [[timeRow]] = await pool.query(
      'SELECT COALESCE(SUM(seconds),0) AS total_seconds FROM ticket_time_logs WHERE ticket_id = ?',
      [req.params.id]
    );
    ticket.total_time_seconds = timeRow.total_seconds;

    res.json({ ticket, messages });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};

// ── Internal Notes ───────────────────────────────────────────────────────────
exports.getInternalNotes = async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      const [[ticket]] = await pool.query('SELECT assigned_agent_id FROM tickets WHERE id = ?', [req.params.id]);
      if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
      if (ticket.assigned_agent_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
    }
    const [notes] = await pool.query(
      `SELECT n.*, u.name AS agent_name
       FROM ticket_internal_notes n JOIN users u ON u.id = n.agent_id
       WHERE n.ticket_id = ? ORDER BY n.created_at ASC`,
      [req.params.id]
    );
    res.json({ notes });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
};

exports.addInternalNote = async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      const [[ticket]] = await pool.query('SELECT assigned_agent_id FROM tickets WHERE id = ?', [req.params.id]);
      if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
      if (ticket.assigned_agent_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
    }
    const { note } = req.body;
    if (!note?.trim()) return res.status(400).json({ error: 'Note is required' });
    const [result] = await pool.query(
      'INSERT INTO ticket_internal_notes (ticket_id, agent_id, note) VALUES (?, ?, ?)',
      [req.params.id, req.user.id, note.trim()]
    );
    const [[row]] = await pool.query(
      `SELECT n.*, u.name AS agent_name FROM ticket_internal_notes n JOIN users u ON u.id = n.agent_id WHERE n.id = ?`,
      [result.insertId]
    );
    res.status(201).json({ note: row });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
};

exports.deleteInternalNote = async (req, res) => {
  try {
    const [notes] = await pool.query(
      'SELECT * FROM ticket_internal_notes WHERE id = ? AND ticket_id = ?',
      [req.params.noteId, req.params.id]
    );
    if (!notes.length) return res.status(404).json({ error: 'Note not found' });
    if (notes[0].agent_id !== req.user.id && req.user.role !== 'admin')
      return res.status(403).json({ error: 'Forbidden' });
    await pool.query('DELETE FROM ticket_internal_notes WHERE id = ?', [req.params.noteId]);
    res.json({ message: 'Note deleted' });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
};

// ── Time Logs ────────────────────────────────────────────────────────────────
exports.addTimeLog = async (req, res) => {
  try {
    const { seconds } = req.body;
    if (!seconds || seconds < 1) return res.status(400).json({ error: 'Invalid seconds' });

    if (req.user.role !== 'admin') {
      const [[ticket]] = await pool.query('SELECT assigned_agent_id FROM tickets WHERE id = ?', [req.params.id]);
      if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
      if (ticket.assigned_agent_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
    }

    const [result] = await pool.query(
      'INSERT INTO ticket_time_logs (ticket_id, agent_id, seconds) VALUES (?, ?, ?)',
      [req.params.id, req.user.id, seconds]
    );
    const [[timeRow]] = await pool.query(
      'SELECT COALESCE(SUM(seconds),0) AS total_seconds FROM ticket_time_logs WHERE ticket_id = ?',
      [req.params.id]
    );
    res.status(201).json({ logId: result.insertId, total_seconds: timeRow.total_seconds });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
};

// ── Macros ───────────────────────────────────────────────────────────────────
exports.getMacros = async (req, res) => {
  try {
    const [macros] = await pool.query(
      `SELECT m.*, u.name AS created_by_name
       FROM ticket_macros m JOIN users u ON u.id = m.created_by
       WHERE m.is_global = 1 OR m.created_by = ?
       ORDER BY m.name ASC`,
      [req.user.id]
    );
    macros.forEach(m => {
      if (typeof m.actions === 'string') try { m.actions = JSON.parse(m.actions); } catch {}
    });
    res.json({ macros });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
};

exports.createMacro = async (req, res) => {
  try {
    const { name, actions } = req.body;
    if (!name?.trim() || !actions || !Array.isArray(actions))
      return res.status(400).json({ error: 'name and actions[] are required' });
    const [result] = await pool.query(
      'INSERT INTO ticket_macros (name, actions, created_by, is_global) VALUES (?, ?, ?, ?)',
      [name.trim(), JSON.stringify(actions), req.user.id, req.user.role === 'admin' ? 1 : 0]
    );
    res.status(201).json({ id: result.insertId });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
};

exports.deleteMacro = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM ticket_macros WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    if (rows[0].created_by !== req.user.id && req.user.role !== 'admin')
      return res.status(403).json({ error: 'Forbidden' });
    await pool.query('DELETE FROM ticket_macros WHERE id = ?', [req.params.id]);
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
};

// ── Merge Tickets ────────────────────────────────────────────────────────────
exports.mergeTicket = async (req, res) => {
  try {
    const { merge_into_id } = req.body;
    const ticketId = parseInt(req.params.id);
    const targetId = parseInt(merge_into_id);
    if (!targetId || targetId === ticketId)
      return res.status(400).json({ error: 'Invalid merge target' });

    const [src] = await pool.query('SELECT * FROM tickets WHERE id = ?', [ticketId]);
    const [dst] = await pool.query('SELECT * FROM tickets WHERE id = ?', [targetId]);
    if (!src.length || !dst.length) return res.status(404).json({ error: 'Ticket not found' });

    // Only assigned agent or admin may merge
    if (req.user.role !== 'admin' && src[0].assigned_agent_id !== req.user.id) {
      return res.status(403).json({ error: 'Only the assigned agent can merge this ticket' });
    }

    // Move all messages from source to target
    await pool.query('UPDATE ticket_messages SET ticket_id = ? WHERE ticket_id = ?', [targetId, ticketId]);
    await pool.query('UPDATE ticket_internal_notes SET ticket_id = ? WHERE ticket_id = ?', [targetId, ticketId]);
    await pool.query(
      "UPDATE tickets SET merged_into = ?, status = 'closed', closed_at = COALESCE(closed_at, NOW()), updated_at = NOW() WHERE id = ?",
      [targetId, ticketId]
    );

    // Add system note
    await pool.query(
      'INSERT INTO ticket_messages (ticket_id, sender_id, message) VALUES (?, ?, ?)',
      [targetId, req.user.id, `[Merged] Ticket #${ticketId} was merged into this ticket by ${req.user.name}`]
    );

    res.json({ message: `Ticket #${ticketId} merged into #${targetId}`, target_id: targetId });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
};

// ── Related Tickets ──────────────────────────────────────────────────────────
exports.getRelatedTickets = async (req, res) => {
  try {
    const [src] = await pool.query('SELECT customer_id FROM tickets WHERE id = ?', [req.params.id]);
    if (!src.length) return res.status(404).json({ error: 'Ticket not found' });
    const [tickets] = await pool.query(
      `SELECT id, subject, status, priority, created_at FROM tickets
       WHERE customer_id = ? AND id != ? AND merged_into IS NULL
       ORDER BY created_at DESC LIMIT 10`,
      [src[0].customer_id, req.params.id]
    );
    res.json({ tickets });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
};

exports.convertChatToTicket = async (req, res) => {
  try {
    const { subject, description } = req.body;
    const chatId = req.params.id;

    const [chats] = await pool.query(
      `SELECT ch.*, u.name AS customer_name
       FROM chats ch
       JOIN customers c ON c.id = ch.customer_id
       JOIN users u ON u.id = c.user_id
       WHERE ch.id = ?`,
      [chatId]
    );
    if (!chats.length) return res.status(404).json({ error: 'Chat not found' });
    const chat = chats[0];

    // Block double-conversion: if this chat was already escalated, hand back the
    // existing ticket instead of creating a duplicate. Lets the Archive view's
    // "Convert" button be safely re-clickable too.
    const [[existingTicket]] = await pool.query(
      'SELECT id FROM tickets WHERE source_chat_id = ? LIMIT 1',
      [chatId]
    );
    if (existingTicket) {
      return res.status(409).json({
        error: 'This chat has already been converted to a ticket',
        existing_ticket_id: existingTicket.id,
      });
    }

    const [messages] = await pool.query(
      `SELECT cm.message, u.name, u.role
       FROM chat_messages cm JOIN users u ON u.id = cm.sender_id
       WHERE cm.chat_id = ? ORDER BY cm.created_at ASC`,
      [chatId]
    );

    const transcript = messages.length
      ? messages.map(m => `[${m.role === 'agent' || m.role === 'admin' ? 'Agent' : 'Customer'}] ${m.name}: ${m.message}`).join('\n')
      : '(no messages yet)';

    const finalSubject = (subject || '').trim() || `Chat with ${chat.customer_name}`;
    const finalDesc = description?.trim()
      ? `${description.trim()}\n\n--- Chat Transcript ---\n${transcript}`
      : `Converted from live chat.\n\n--- Chat Transcript ---\n${transcript}`;

    const [result] = await pool.query(
      `INSERT INTO tickets (customer_id, subject, description, status, priority, assigned_agent_id, source_chat_id)
       VALUES (?, ?, ?, 'open', 'normal', ?, ?)`,
      [chat.customer_id, finalSubject, finalDesc, req.user.id, chatId]
    );

    const [ticket] = await pool.query(
      `SELECT t.*, u.name AS customer_name, a.name AS agent_name
       FROM tickets t
       JOIN customers c ON c.id = t.customer_id
       JOIN users u ON u.id = c.user_id
       LEFT JOIN users a ON a.id = t.assigned_agent_id
       WHERE t.id = ?`,
      [result.insertId]
    );

    // We deliberately do NOT close the chat here. The agent stays in control —
    // they'll inform the customer about the ticket in their own words and end
    // the chat with the regular End button when the conversation actually feels
    // done. Decoupling these two actions removes a class of "wait, why did my
    // chat just die" complaints and lets the agent answer follow-ups without
    // a fresh chat round-trip.

    res.status(201).json({ ticket: ticket[0], chat_status: chat.status });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ── Templates (read-only for agents) ─────────────────────────────────────────
exports.getAgentTemplates = async (req, res) => {
  try {
    const [templates] = await pool.query(
      'SELECT id, name, subject_template, description_template, default_priority FROM ticket_templates WHERE is_active = 1 ORDER BY name ASC'
    );
    res.json({ templates });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
};

// ── My Performance ────────────────────────────────────────────────────────────
exports.getMyPerformance = async (req, res) => {
  try {
    const id = req.user.id;

    const [chatRes, ticketRes, closedRes, openRes, commentsRes] = await Promise.all([
      pool.query(
        `SELECT ROUND(AVG(rating), 2) AS avg_chat_rating, COUNT(*) AS total_chat_ratings,
                SUM(rating = 1) AS c1, SUM(rating = 2) AS c2, SUM(rating = 3) AS c3,
                SUM(rating = 4) AS c4, SUM(rating = 5) AS c5
         FROM chat_ratings WHERE agent_id = ?`,
        [id]
      ),
      pool.query(
        `SELECT ROUND(AVG(score), 2) AS avg_ticket_rating, COUNT(*) AS total_ticket_ratings,
                SUM(score = 1) AS c1, SUM(score = 2) AS c2, SUM(score = 3) AS c3,
                SUM(score = 4) AS c4, SUM(score = 5) AS c5
         FROM ratings WHERE agent_id = ? AND ref_type = 'ticket'`,
        [id]
      ),
      pool.query(
        `SELECT COUNT(*) AS count FROM tickets
         WHERE assigned_agent_id = ? AND status = 'closed'
           AND MONTH(updated_at) = MONTH(NOW()) AND YEAR(updated_at) = YEAR(NOW())`,
        [id]
      ),
      pool.query(
        `SELECT COUNT(*) AS count FROM tickets WHERE assigned_agent_id = ? AND status != 'closed'`,
        [id]
      ),
      pool.query(
        `(SELECT 'chat' AS type, cr.rating AS score, cr.comment, cr.created_at
          FROM chat_ratings cr WHERE cr.agent_id = ? AND cr.comment IS NOT NULL AND cr.comment != '')
         UNION ALL
         (SELECT 'ticket' AS type, r.score, r.comment, r.created_at
          FROM ratings r WHERE r.agent_id = ? AND r.ref_type = 'ticket' AND r.comment IS NOT NULL AND r.comment != '')
         ORDER BY created_at DESC LIMIT 10`,
        [id, id]
      ),
    ]);
    const chatRow = chatRes[0][0];
    const ticketRow = ticketRes[0][0];
    const closedRow = closedRes[0][0];
    const openRow = openRes[0][0];
    const recentComments = commentsRes[0];

    const chatRatings   = Number(chatRow.total_chat_ratings)    || 0;
    const ticketRatings = Number(ticketRow.total_ticket_ratings) || 0;
    const total = chatRatings + ticketRatings;

    const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    [1, 2, 3, 4, 5].forEach(s => {
      dist[s] = Number(chatRow[`c${s}`] || 0) + Number(ticketRow[`c${s}`] || 0);
    });

    const weightedSum = (chatRow.avg_chat_rating || 0) * chatRatings +
                        (ticketRow.avg_ticket_rating || 0) * ticketRatings;
    const combined_avg = total > 0 ? Math.round(weightedSum / total * 100) / 100 : null;

    res.json({
      avg_chat_rating:           chatRow.avg_chat_rating,
      avg_ticket_rating:         ticketRow.avg_ticket_rating,
      combined_avg,
      total_ratings:             total,
      dist,
      tickets_closed_this_month: Number(closedRow.count),
      open_tickets:              Number(openRow.count),
      recent_comments:           recentComments,
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
};

// ── Customer History ──────────────────────────────────────────────────────────
exports.getCustomerHistory = async (req, res) => {
  try {
    const cid = req.params.id;
    const [tickets] = await pool.query(
      'SELECT id, subject, status, priority, created_at FROM tickets WHERE customer_id = ? ORDER BY created_at DESC LIMIT 10',
      [cid]
    );
    const [chats] = await pool.query(
      'SELECT id, status, created_at, closed_at FROM chats WHERE customer_id = ? ORDER BY created_at DESC LIMIT 10',
      [cid]
    );
    const [calls] = await pool.query(
      `SELECT id, status, call_start_time, call_end_time, duration, created_at
       FROM calls WHERE customer_id = ? ORDER BY created_at DESC LIMIT 10`,
      [cid]
    );

    // Totals for the "Recent history" strip at the top of a ticket — agents need to
    // know at a glance whether this customer was around recently and what they were
    // doing. Counts cover the last 90 days so it actually reflects "recent".
    const [[counts]] = await pool.query(
      `SELECT
        (SELECT COUNT(*) FROM tickets WHERE customer_id = ? AND created_at >= DATE_SUB(NOW(), INTERVAL 90 DAY)) AS tickets_90d,
        (SELECT COUNT(*) FROM chats   WHERE customer_id = ? AND created_at >= DATE_SUB(NOW(), INTERVAL 90 DAY)) AS chats_90d,
        (SELECT COUNT(*) FROM calls   WHERE customer_id = ? AND created_at >= DATE_SUB(NOW(), INTERVAL 90 DAY)) AS calls_90d,
        (SELECT COUNT(*) FROM tickets WHERE customer_id = ? AND status NOT IN ('closed','resolved')) AS open_tickets`,
      [cid, cid, cid, cid]
    );

    // The single most-recent touch (for "called yesterday" type lines)
    const [[latest]] = await pool.query(
      `SELECT 'ticket' AS kind, id, created_at FROM tickets WHERE customer_id = ?
       UNION ALL
       SELECT 'chat'   AS kind, id, created_at FROM chats   WHERE customer_id = ?
       UNION ALL
       SELECT 'call'   AS kind, id, created_at FROM calls   WHERE customer_id = ?
       ORDER BY created_at DESC LIMIT 1`,
      [cid, cid, cid]
    );

    res.json({ tickets, chats, calls, counts, latest_touch: latest || null });
  } catch (err) { console.error('getCustomerHistory', err); res.status(500).json({ error: 'Server error' }); }
};

// ── Chat Internal Notes ───────────────────────────────────────────────────────
exports.getChatNotes = async (req, res) => {
  try {
    const chatId = req.params.id;
    if (req.user.role !== 'admin') {
      const [[chat]] = await pool.query('SELECT agent_id FROM chats WHERE id = ?', [chatId]);
      if (!chat) return res.status(404).json({ error: 'Chat not found' });
      if (chat.agent_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
    }
    const [notes] = await pool.query(
      `SELECT n.*, u.name AS agent_name
       FROM chat_internal_notes n JOIN users u ON u.id = n.agent_id
       WHERE n.chat_id = ? ORDER BY n.created_at ASC`,
      [chatId]
    );
    res.json({ notes });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
};

exports.addChatNote = async (req, res) => {
  try {
    const chatId = req.params.id;
    if (req.user.role !== 'admin') {
      const [[chat]] = await pool.query('SELECT agent_id FROM chats WHERE id = ?', [chatId]);
      if (!chat) return res.status(404).json({ error: 'Chat not found' });
      if (chat.agent_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
    }
    const { note } = req.body;
    if (!note?.trim()) return res.status(400).json({ error: 'Note is required' });
    const [result] = await pool.query(
      'INSERT INTO chat_internal_notes (chat_id, agent_id, note) VALUES (?, ?, ?)',
      [chatId, req.user.id, note.trim()]
    );
    const [[row]] = await pool.query(
      `SELECT n.*, u.name AS agent_name FROM chat_internal_notes n JOIN users u ON u.id = n.agent_id WHERE n.id = ?`,
      [result.insertId]
    );
    res.status(201).json({ note: row });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
};

// ── Chat Archive (agent-scoped past chats) ────────────────────────────────────
exports.getAgentChatArchive = async (req, res) => {
  try {
    const { q, from, to, page = 1, limit = 30 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let where = "ch.status = 'closed'";
    const params = [];

    // Agents see only chats they handled; admins see all
    if (req.user.role !== 'admin') {
      where += ' AND ch.agent_id = ?';
      params.push(req.user.id);
    }
    if (q) {
      where += ' AND (cu.name LIKE ? OR cu.email LIKE ?)';
      params.push(`%${q}%`, `%${q}%`);
    }
    if (from) { where += ' AND ch.created_at >= ?'; params.push(from); }
    if (to)   { where += ' AND ch.created_at <= ?'; params.push(to); }

    const [chats] = await pool.query(`
      SELECT ch.id, ch.created_at, ch.closed_at, ch.accepted_at,
             cu.name AS customer_name, cu.email AS customer_email,
             c.domain AS customer_domain,
             ag.name AS agent_name,
             cr.rating, cr.comment AS rating_comment,
             (SELECT COUNT(*) FROM chat_messages WHERE chat_id = ch.id) AS message_count,
             TIMESTAMPDIFF(SECOND, ch.accepted_at, ch.closed_at) AS duration_secs,
             (SELECT t.id FROM tickets t WHERE t.source_chat_id = ch.id LIMIT 1) AS existing_ticket_id
      FROM chats ch
      JOIN customers c ON c.id = ch.customer_id
      JOIN users cu ON cu.id = c.user_id
      LEFT JOIN users ag ON ag.id = ch.agent_id
      LEFT JOIN chat_ratings cr ON cr.chat_id = ch.id
      WHERE ${where}
      ORDER BY ch.closed_at DESC
      LIMIT ? OFFSET ?
    `, [...params, parseInt(limit), offset]);

    const [[{ total }]] = await pool.query(`
      SELECT COUNT(*) AS total FROM chats ch
      JOIN customers c ON c.id = ch.customer_id
      JOIN users cu ON cu.id = c.user_id
      WHERE ${where}
    `, params);

    res.json({ chats, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.getAgentArchivedMessages = async (req, res) => {
  try {
    // Ownership check: only assigned agent or admin
    if (req.user.role !== 'admin') {
      const [[chat]] = await pool.query('SELECT agent_id FROM chats WHERE id = ?', [req.params.id]);
      if (!chat) return res.status(404).json({ error: 'Chat not found' });
      if (chat.agent_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
    }
    const [messages] = await pool.query(
      `SELECT cm.*, u.name AS sender_name, u.role AS sender_role
       FROM chat_messages cm JOIN users u ON u.id = cm.sender_id
       WHERE cm.chat_id = ? ORDER BY cm.created_at ASC`,
      [req.params.id]
    );
    res.json({ messages });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
};

exports.deleteChatNote = async (req, res) => {
  try {
    const [[note]] = await pool.query(
      'SELECT * FROM chat_internal_notes WHERE id = ? AND chat_id = ?',
      [req.params.noteId, req.params.id]
    );
    if (!note) return res.status(404).json({ error: 'Note not found' });
    if (note.agent_id !== req.user.id && req.user.role !== 'admin')
      return res.status(403).json({ error: 'Forbidden' });
    await pool.query('DELETE FROM chat_internal_notes WHERE id = ?', [req.params.noteId]);
    res.json({ message: 'Note deleted' });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
};
