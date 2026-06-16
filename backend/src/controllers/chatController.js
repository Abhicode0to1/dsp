const { pool } = require('../config/database');
const { getCustomerWithPlan, isPlanActive, getChatUsage, incrementChatUsage, getTicketUsage, incrementTicketUsage } = require('../utils/planUtils');
const { sendChatTranscriptEmail } = require('../utils/emailUtils');

exports.initiateChat = async (req, res) => {
  try {
    const customer = await getCustomerWithPlan(req.user.id);
    if (!customer) return res.status(404).json({ error: 'Customer profile not found' });

    if (!isPlanActive(customer)) {
      return res.status(403).json({ error: 'Your plan has expired', upgrade_required: true });
    }

    if (!customer.allow_chat) {
      return res.status(403).json({
        error: 'Live chat is not available on the Free plan',
        upgrade_required: true,
        current_plan: customer.plan_name,
      });
    }

    // Enforce monthly chat limit
    if (customer.chat_limit !== null) {
      const chatUsed = await getChatUsage(customer.id);
      if (chatUsed >= customer.chat_limit) {
        return res.status(403).json({
          error: `Monthly chat limit of ${customer.chat_limit} reached. Please upgrade your plan or contact your account manager.`,
          limit_exceeded: true,
          used: chatUsed,
          limit: customer.chat_limit,
        });
      }
    }

    // Check blacklist
    const [[blocked]] = await pool.query(
      'SELECT id FROM chat_blacklist WHERE customer_user_id = ?',
      [req.user.id]
    );
    if (blocked) return res.status(403).json({
      error: 'Chat access has been restricted for your account.',
      reason: 'blacklisted',
    });

    // Fast-path: customer already has an open chat. Returning the existing
    // row keeps the customer's experience idempotent (page refresh, retry,
    // or accidental double-click all land back on the same chat).
    const [existing] = await pool.query(
      "SELECT * FROM chats WHERE customer_id = ? AND status IN ('waiting', 'active')",
      [customer.id]
    );
    if (existing.length) return res.json({ chat: existing[0], already_exists: true });

    // Optional category from the pre-chat picker. Three buckets that map to the
    // admin's agent tagging vocabulary for skill-based routing — see pickAgent's
    // categoryToTags() logic. Anything else is ignored (stored as null).
    const allowedCategories = ['technical', 'billing', 'others'];
    const rawCategory = String(req.body?.category || '').toLowerCase();
    const category = allowedCategories.includes(rawCategory) ? rawCategory : null;

    // The fast-path SELECT above is *not* sufficient on its own — two
    // concurrent requests can both see "no existing chat" before either
    // INSERT commits, producing two parallel waiting chats and ringing
    // agents twice (edge-cases.test.js #3 caught this). Migration 003
    // added a unique key on `active_customer_marker` (a generated column
    // = customer_id when status IN ('waiting','active'), NULL otherwise).
    // The second concurrent INSERT therefore fails atomically with
    // ER_DUP_ENTRY; we catch that and return the row the winning request
    // committed instead.
    let chat;
    try {
      const [result] = await pool.query(
        "INSERT INTO chats (customer_id, status, category) VALUES (?, 'waiting', ?)",
        [customer.id, category]
      );
      const [[row]] = await pool.query('SELECT * FROM chats WHERE id = ?', [result.insertId]);
      chat = row;
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        const [[winner]] = await pool.query(
          "SELECT * FROM chats WHERE customer_id = ? AND status IN ('waiting','active') LIMIT 1",
          [customer.id]
        );
        if (!winner) throw err; // shouldn't happen — bubble for visibility
        return res.json({ chat: winner, already_exists: true });
      }
      throw err;
    }

    // Usage is computed from chats.accepted_at in getChatUsage — see planUtils.js.
    // Don't burn the customer's quota on a chat that may never reach an agent.

    // Queue info
    const [[qInfo]] = await pool.query(
      "SELECT COUNT(*) AS pos FROM chats WHERE status = 'waiting' AND created_at <= ?",
      [chat.created_at]
    );
    res.status(201).json({ chat, queue_position: qInfo.pos });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.getActiveChat = async (req, res) => {
  try {
    const [[cRow]] = await pool.query('SELECT id FROM customers WHERE user_id = ?', [req.user.id]);
    if (!cRow) return res.status(404).json({ error: 'Customer not found' });

    const [[chat]] = await pool.query(
      `SELECT ch.*, u.name AS agent_name, u.role AS agent_role
       FROM chats ch
       LEFT JOIN users u ON u.id = ch.agent_id
       WHERE ch.customer_id = ? AND ch.status IN ('waiting','active')
       ORDER BY ch.created_at DESC LIMIT 1`,
      [cRow.id]
    );

    if (!chat) return res.json({ chat: null });

    // Customer-facing endpoint — neutralize "Admin User" → "Support Agent" so a
    // page reload doesn't expose the admin's role through the REST path. Keeps
    // the rest of the chat row intact for the agent panel which doesn't hit
    // this endpoint.
    if (chat.agent_role === 'admin' || /^admin\b/i.test(chat.agent_name || '')) {
      chat.agent_name = 'Support Agent';
    }
    delete chat.agent_role;

    const [messages] = await pool.query(
      `SELECT cm.*, u.name AS sender_name, u.role AS sender_role
       FROM chat_messages cm
       JOIN users u ON u.id = cm.sender_id
       WHERE cm.chat_id = ?
       ORDER BY cm.created_at ASC`,
      [chat.id]
    );

    // Queue position
    let queue_position = null;
    if (chat.status === 'waiting') {
      const [[qInfo]] = await pool.query(
        "SELECT COUNT(*) AS pos FROM chats WHERE status = 'waiting' AND created_at <= ?",
        [chat.created_at]
      );
      queue_position = qInfo.pos;
    }

    res.json({ chat, messages, queue_position });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.closeChat = async (req, res) => {
  try {
    const chatId = parseInt(req.params.id);
    const [[chat]] = await pool.query('SELECT * FROM chats WHERE id = ?', [chatId]);
    if (!chat) return res.status(404).json({ error: 'Chat not found' });

    if (req.user.role === 'customer') {
      const [[cRow]] = await pool.query('SELECT id FROM customers WHERE user_id = ?', [req.user.id]);
      if (!cRow || cRow.id !== chat.customer_id) return res.status(403).json({ error: 'Forbidden' });
    }

    await pool.query("UPDATE chats SET status = 'closed', closed_at = NOW() WHERE id = ?", [chatId]);

    // Notify any agent UI that has this chat in its queue/active list so it disappears
    // without a manual refresh. Safe to fire even if no agent has it loaded.
    if (req.io) {
      // Cancel any in-flight sequential ring — the customer cancelled while their
      // chat was being rung to an agent. Without this the rung agent's queue still
      // shows the chat until the 15s timeout fires.
      try {
        const { clearChatRing } = require('../socket/chatSocket');
        // Chat ENDED (customer/agent closed it) — not escalated. Use
        // 'chat_cancelled' so the rung agent's ring just stops quietly instead
        // of showing the misleading "missed chat, now with another agent" alert.
        if (clearChatRing) clearChatRing(req.io, chatId, true, 'chat_cancelled');
      } catch {}
      req.io.to('agents').to('chat_monitors').emit('chat_removed', { chatId });
      req.io.to(`chat_${chatId}`).emit('chat_closed', { chatId });
      console.log(`[Chat ${chatId}] Closed by ${req.user.role} ${req.user.name} — broadcast chat_removed to agents + monitors`);
    } else {
      console.warn(`[Chat ${chatId}] Closed but req.io missing — agents won't be notified live`);
    }

    res.json({ message: 'Chat closed successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.getChatHistory = async (req, res) => {
  try {
    const [[cRow]] = await pool.query('SELECT id FROM customers WHERE user_id = ?', [req.user.id]);
    if (!cRow) return res.status(404).json({ error: 'Customer not found' });

    // Show all chats from the current calendar month. Pre-reset rows stay visible
    // (so the customer doesn't lose their record of past sessions), but they're
    // flagged `pre_reset: true` and a `counted` flag tells the UI which ones count
    // toward the current quota (customer-engaged AND after the reset).
    const [[meta]] = await pool.query(
      'SELECT usage_reset_at FROM customers WHERE id = ?',
      [cRow.id]
    );
    const resetAt = meta?.usage_reset_at;
    const [chats] = await pool.query(
      `SELECT ch.*, u.name AS agent_name,
              (SELECT rating FROM chat_ratings WHERE chat_id = ch.id) AS rating,
              EXISTS(
                SELECT 1 FROM chat_messages cm
                JOIN users uu ON uu.id = cm.sender_id
                WHERE cm.chat_id = ch.id AND uu.role = 'customer'
              ) AS has_customer_message,
              (EXISTS(
                SELECT 1 FROM chat_messages cm
                JOIN users uu ON uu.id = cm.sender_id
                WHERE cm.chat_id = ch.id AND uu.role = 'customer'
              ) AND (? IS NULL OR ch.created_at > ?)) AS counted,
              (? IS NOT NULL AND ch.created_at <= ?) AS pre_reset
       FROM chats ch
       LEFT JOIN users u ON u.id = ch.agent_id
       WHERE ch.customer_id = ?
         AND DATE_FORMAT(ch.created_at, '%Y-%m') = DATE_FORMAT(NOW(), '%Y-%m')
       ORDER BY ch.created_at DESC
       LIMIT 200`,
      [resetAt, resetAt, resetAt, resetAt, cRow.id]
    );

    res.json({ chats, usage_reset_at: resetAt });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};

// ── CSAT rating (customer) ────────────────────────────────────────────────────
exports.rateChat = async (req, res) => {
  try {
    const { rating, comment } = req.body;
    if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: 'Rating must be 1–5' });

    const [[chat]] = await pool.query('SELECT * FROM chats WHERE id = ?', [req.params.id]);
    if (!chat) return res.status(404).json({ error: 'Chat not found' });

    const [[cRow]] = await pool.query('SELECT id FROM customers WHERE user_id = ?', [req.user.id]);
    if (!cRow || cRow.id !== chat.customer_id) return res.status(403).json({ error: 'Forbidden' });

    await pool.query(
      'INSERT INTO chat_ratings (chat_id, rating, comment, agent_id) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE rating = VALUES(rating), comment = VALUES(comment), agent_id = VALUES(agent_id)',
      [chat.id, rating, comment || null, chat.agent_id || null]
    );

    res.json({ message: 'Rating submitted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ── Email transcript (agent sends to customer) ────────────────────────────────
exports.emailTranscript = async (req, res) => {
  try {
    const [[chat]] = await pool.query(
      `SELECT ch.*, u.name AS agent_name FROM chats ch LEFT JOIN users u ON u.id = ch.agent_id WHERE ch.id = ?`,
      [req.params.id]
    );
    if (!chat) return res.status(404).json({ error: 'Chat not found' });

    // Agent must be assigned to this chat (or be admin)
    if (req.user.role !== 'admin' && chat.agent_id !== req.user.id) {
      return res.status(403).json({ error: 'You are not assigned to this chat' });
    }

    const [messages] = await pool.query(
      `SELECT cm.*, u.name AS sender_name, u.role AS sender_role
       FROM chat_messages cm JOIN users u ON u.id = cm.sender_id
       WHERE cm.chat_id = ? ORDER BY cm.created_at ASC`,
      [chat.id]
    );

    // Send to the customer, not the agent
    const [[custUser]] = await pool.query(
      `SELECT u.email, u.name FROM customers c JOIN users u ON u.id = c.user_id WHERE c.id = ?`,
      [chat.customer_id]
    );
    if (!custUser) return res.status(404).json({ error: 'Customer not found' });

    await sendChatTranscriptEmail({
      to: custUser.email,
      customerName: custUser.name,
      agentName: chat.agent_name || req.user.name,
      messages,
      chatId: chat.id,
    });

    res.json({ message: `Transcript sent to ${custUser.email}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ── Offline message → ticket (customer, called when no agents available) ──────
exports.leaveOfflineMessage = async (req, res) => {
  try {
    const { message, subject } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: 'Message is required' });

    const customer = await getCustomerWithPlan(req.user.id);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    if (!isPlanActive(customer)) {
      return res.status(403).json({ error: 'Your support plan has expired. Please renew to contact support.' });
    }

    const ticketsUsed = await getTicketUsage(customer.id);
    if (customer.tickets_limit !== null && ticketsUsed >= customer.tickets_limit) {
      return res.status(403).json({ error: 'Monthly ticket limit reached. Please upgrade your plan.' });
    }

    const [result] = await pool.query(
      `INSERT INTO tickets (customer_id, subject, description, status, priority)
       VALUES (?, ?, ?, 'open', 'normal')`,
      [customer.id, subject?.trim() || 'Offline support request', message.trim()]
    );

    await incrementTicketUsage(customer.id);

    res.status(201).json({ ticket_id: result.insertId, message: 'Your message was received. We will get back to you via a support ticket.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ── Queue info (customer) ─────────────────────────────────────────────────────
exports.getQueueInfo = async (req, res) => {
  try {
    const [[cRow]] = await pool.query('SELECT id FROM customers WHERE user_id = ?', [req.user.id]);
    if (!cRow) return res.status(404).json({ error: 'Not found' });

    const [[chat]] = await pool.query(
      "SELECT id, created_at FROM chats WHERE customer_id = ? AND status = 'waiting' LIMIT 1",
      [cRow.id]
    );
    if (!chat) return res.json({ position: 0 });

    const [[qInfo]] = await pool.query(
      "SELECT COUNT(*) AS pos FROM chats WHERE status = 'waiting' AND created_at <= ?",
      [chat.created_at]
    );

    res.json({ position: qInfo.pos });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};

// ── Transfer chat (agent) ─────────────────────────────────────────────────────
exports.transferChat = async (req, res) => {
  try {
    const { target_agent_id, note } = req.body;
    if (!target_agent_id) return res.status(400).json({ error: 'target_agent_id required' });

    const [[chat]] = await pool.query('SELECT * FROM chats WHERE id = ?', [req.params.id]);
    if (!chat) return res.status(404).json({ error: 'Chat not found' });
    if (chat.agent_id !== req.user.id && req.user.role !== 'admin')
      return res.status(403).json({ error: 'Not your chat' });

    const [[targetAgent]] = await pool.query("SELECT id, name FROM users WHERE id = ? AND role IN ('agent', 'admin') AND is_active = TRUE", [target_agent_id]);
    if (!targetAgent) return res.status(404).json({ error: 'Target agent not found' });

    await pool.query(
      'UPDATE chats SET agent_id = ?, transfer_note = ? WHERE id = ?',
      [target_agent_id, note || null, chat.id]
    );

    res.json({ message: `Chat transferred to ${targetAgent.name}`, agent: targetAgent });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ── Admin: Chat analytics ─────────────────────────────────────────────────────
exports.getChatAnalytics = async (req, res) => {
  try {
    const { days = 7 } = req.query;

    const [[totals]] = await pool.query(`
      SELECT
        COUNT(*) AS total,
        SUM(status = 'closed') AS closed,
        SUM(status IN ('waiting','active')) AS open,
        AVG(TIMESTAMPDIFF(SECOND, created_at, COALESCE(first_response_at, NOW()))) AS avg_first_response_secs,
        AVG(TIMESTAMPDIFF(SECOND, created_at, closed_at)) AS avg_duration_secs
      FROM chats
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
    `, [days]);

    const [byAgent] = await pool.query(`
      SELECT u.name AS agent_name, u.id AS agent_id,
             COUNT(*) AS handled,
             AVG(TIMESTAMPDIFF(SECOND, ch.accepted_at, ch.closed_at)) AS avg_duration_secs,
             AVG(cr.rating) AS avg_rating
      FROM chats ch
      JOIN users u ON u.id = ch.agent_id
      LEFT JOIN chat_ratings cr ON cr.chat_id = ch.id
      WHERE ch.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY) AND ch.agent_id IS NOT NULL
      GROUP BY ch.agent_id
      ORDER BY handled DESC
    `, [days]);

    const [byHour] = await pool.query(`
      SELECT HOUR(created_at) AS hour, COUNT(*) AS count
      FROM chats
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
      GROUP BY HOUR(created_at)
      ORDER BY hour
    `, [days]);

    const [[ratings]] = await pool.query(`
      SELECT AVG(cr.rating) AS avg_rating, COUNT(*) AS total_ratings
      FROM chat_ratings cr
      JOIN chats ch ON ch.id = cr.chat_id
      WHERE ch.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
    `, [days]);

    res.json({ totals, byAgent, byHour, ratings });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ── Admin: Chat archive (search) ──────────────────────────────────────────────
exports.getChatArchive = async (req, res) => {
  try {
    const { q, agent_id, from, to, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    let where = "ch.status = 'closed'";
    const params = [];

    if (q) {
      where += ' AND (u.name LIKE ? OR cm_first.message LIKE ?)';
      params.push(`%${q}%`, `%${q}%`);
    }
    if (agent_id) { where += ' AND ch.agent_id = ?'; params.push(agent_id); }
    if (from)     { where += ' AND ch.created_at >= ?'; params.push(from); }
    if (to)       { where += ' AND ch.created_at <= ?'; params.push(to); }

    const [chats] = await pool.query(`
      SELECT ch.id, ch.created_at, ch.closed_at, ch.accepted_at,
             cu.name AS customer_name, cu.email AS customer_email,
             ag.name AS agent_name,
             cr.rating,
             (SELECT COUNT(*) FROM chat_messages WHERE chat_id = ch.id) AS message_count,
             TIMESTAMPDIFF(SECOND, ch.accepted_at, ch.closed_at) AS duration_secs
      FROM chats ch
      JOIN customers c ON c.id = ch.customer_id
      JOIN users cu ON cu.id = c.user_id
      LEFT JOIN users ag ON ag.id = ch.agent_id
      LEFT JOIN chat_ratings cr ON cr.chat_id = ch.id
      LEFT JOIN chat_messages cm_first ON cm_first.id = (SELECT MIN(id) FROM chat_messages WHERE chat_id = ch.id)
      WHERE ${where}
      ORDER BY ch.closed_at DESC
      LIMIT ? OFFSET ?
    `, [...params, parseInt(limit), offset]);

    const [[{ total }]] = await pool.query(`
      SELECT COUNT(*) AS total FROM chats ch
      JOIN customers c ON c.id = ch.customer_id
      JOIN users cu ON cu.id = c.user_id
      LEFT JOIN users ag ON ag.id = ch.agent_id
      LEFT JOIN chat_messages cm_first ON cm_first.id = (SELECT MIN(id) FROM chat_messages WHERE chat_id = ch.id)
      WHERE ${where}
    `, params);

    res.json({ chats, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ── Admin: Get archive chat messages ─────────────────────────────────────────
exports.getArchivedChatMessages = async (req, res) => {
  try {
    const [messages] = await pool.query(
      `SELECT cm.*, u.name AS sender_name, u.role AS sender_role
       FROM chat_messages cm JOIN users u ON u.id = cm.sender_id
       WHERE cm.chat_id = ? ORDER BY cm.created_at ASC`,
      [req.params.id]
    );
    res.json({ messages });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};

// ── Admin: Blacklist ──────────────────────────────────────────────────────────
exports.getBlacklist = async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT bl.*, u.name AS customer_name, u.email AS customer_email,
             ab.name AS blocked_by_name
      FROM chat_blacklist bl
      JOIN users u ON u.id = bl.customer_user_id
      JOIN users ab ON ab.id = bl.blocked_by
      ORDER BY bl.created_at DESC
    `);
    res.json({ blacklist: rows });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};

exports.blockCustomer = async (req, res) => {
  try {
    const { customer_user_id, identifier, reason } = req.body;

    // Two ways to identify the target:
    //   (1) Legacy: { customer_user_id: <number> } — kept for back-compat
    //   (2) New:    { identifier: "<email-or-domain>" } — what the UI now sends
    // Lookup precedence: explicit user_id wins; otherwise resolve identifier
    // by email (if it contains '@') or by customers.domain.
    let user;
    if (customer_user_id) {
      const [[row]] = await pool.query('SELECT id, name FROM users WHERE id = ?', [customer_user_id]);
      user = row;
    } else if (typeof identifier === 'string' && identifier.trim()) {
      const ident = identifier.trim();
      if (ident.includes('@')) {
        const [[row]] = await pool.query(
          "SELECT id, name FROM users WHERE email = ? AND role = 'customer'",
          [ident]
        );
        user = row;
        if (!user) return res.status(404).json({ error: `No customer found with email "${ident}"` });
      } else {
        // Domain lookup — join customers → users so we return the customer's user id
        const [rows] = await pool.query(
          `SELECT u.id, u.name FROM customers c
           JOIN users u ON u.id = c.user_id
           WHERE c.domain = ?`,
          [ident]
        );
        if (!rows.length) return res.status(404).json({ error: `No customer found with domain "${ident}"` });
        if (rows.length > 1) {
          return res.status(409).json({
            error: `${rows.length} customers share the domain "${ident}". Use the customer's email address instead to pick the exact account.`,
          });
        }
        user = rows[0];
      }
    } else {
      return res.status(400).json({ error: 'Email or domain is required' });
    }

    if (!user) return res.status(404).json({ error: 'Customer not found' });

    await pool.query(
      'INSERT INTO chat_blacklist (customer_user_id, blocked_by, reason) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE reason = VALUES(reason)',
      [user.id, req.user.id, reason || null]
    );

    // Close any active/waiting chats for this customer (they should hear the
    // block immediately, not on their next page reload).
    await pool.query(
      `UPDATE chats c JOIN customers cu ON cu.id = c.customer_id
       SET c.status = 'closed', c.closed_at = NOW()
       WHERE cu.user_id = ? AND c.status IN ('waiting','active')`,
      [user.id]
    );

    res.json({ message: `${user.name} blocked from chat`, blocked_user: { id: user.id, name: user.name } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.unblockCustomer = async (req, res) => {
  try {
    await pool.query('DELETE FROM chat_blacklist WHERE id = ?', [req.params.id]);
    res.json({ message: 'Customer unblocked' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};

// ── Admin: Agent statuses (from socket in-memory, pulled by admin) ────────────
exports.getAgentChatStatuses = async (req, res) => {
  // Actual statuses come from socket; we return DB-level active chats per agent
  try {
    const [rows] = await pool.query(`
      SELECT u.id, u.name, u.email,
             COUNT(ch.id) AS active_chats,
             MAX(ch.accepted_at) AS last_chat_at
      FROM users u
      LEFT JOIN chats ch ON ch.agent_id = u.id AND ch.status = 'active'
      WHERE u.role = 'agent' AND u.is_active = TRUE
      GROUP BY u.id
    `);
    res.json({ agents: rows });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};
