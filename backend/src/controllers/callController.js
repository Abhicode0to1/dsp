const { pool } = require('../config/database');
const {
  getCustomerWithPlan,
  isPlanActive,
  getCallUsage,
  incrementCallUsage,
} = require('../utils/planUtils');

const MAX_CALL_DURATION = 60 * 60; // 60 minutes in seconds (logged-duration cap, not an auto-disconnect)

function generateVirtualNumber() {
  const suffix = Math.floor(1000 + Math.random() * 9000);
  return `+1-800-DSP-${suffix}`;
}

exports.initiateCall = async (req, res) => {
  try {
    // System-wide kill switch — admin can disable voice calls entirely (e.g.,
    // during a WebRTC outage). Separate from per-plan allow_calls — this is
    // operational, not policy. Plan rules still apply when calls are enabled.
    try {
      const { getBoolSetting } = require('../utils/settings');
      const callsEnabled = await getBoolSetting('calls_system_enabled', true);
      if (!callsEnabled) {
        return res.status(503).json({
          error: 'Voice calls are temporarily unavailable. Please raise a ticket or use live chat.',
          system_disabled: true,
        });
      }
    } catch {}

    const customer = await getCustomerWithPlan(req.user.id);
    if (!customer) return res.status(404).json({ error: 'Customer profile not found' });

    if (!isPlanActive(customer)) {
      return res.status(403).json({ error: 'Your plan has expired', upgrade_required: true });
    }

    if (!customer.allow_calls) {
      return res.status(403).json({
        error: 'Call support is not available on your current plan',
        upgrade_required: true,
        current_plan: customer.plan_name,
      });
    }

    // Block call initiation if the customer is on the call blacklist (admin
    // explicitly disabled calls for them). Tickets and chat remain open.
    const [[callBlocked]] = await pool.query(
      'SELECT id FROM call_blacklist WHERE customer_user_id = ?',
      [req.user.id]
    );
    if (callBlocked) return res.status(403).json({
      error: 'Call access has been restricted for your account.',
      reason: 'blacklisted',
    });

    const callsUsed = await getCallUsage(customer.id);
    if (customer.calls_limit !== null && callsUsed >= customer.calls_limit) {
      return res.status(403).json({
        error: `Monthly call limit of ${customer.calls_limit} reached`,
        limit_exceeded: true,
        used: callsUsed,
        limit: customer.calls_limit,
        extra_charge_message: 'Additional calls are available at ₹500 per call. Contact your account manager.',
        upgrade_required: true,
      });
    }

    // Clean up stale waiting chats (customer closed browser without cancelling, older than 30 min)
    await pool.query(
      "UPDATE chats SET status = 'closed', closed_at = NOW() WHERE customer_id = ? AND status = 'waiting' AND created_at < DATE_SUB(NOW(), INTERVAL 30 MINUTE)",
      [customer.id]
    );

    // Block if active chat exists — unless this is a deliberate escalation from that same chat
    const [[activeChat]] = await pool.query(
      "SELECT id FROM chats WHERE customer_id = ? AND status IN ('waiting', 'active')",
      [customer.id]
    );
    if (activeChat) {
      const escalatingFromChatId = req.body.chat_id ? Number(req.body.chat_id) : null;
      if (escalatingFromChatId !== activeChat.id) {
        return res.status(409).json({ error: 'You have an active live chat session. Please end your chat before starting a call.' });
      }
    }

    const virtualNumber = generateVirtualNumber();

    // Pre-call category (technical / billing / others) drives skill-tag routing
    // in pickAgent — same vocabulary as the live-chat picker. Anything outside
    // the allowlist is stored as null (no routing preference).
    const allowedCategories = ['technical', 'billing', 'others'];
    const rawCategory = String(req.body?.category || '').toLowerCase();
    const category = allowedCategories.includes(rawCategory) ? rawCategory : null;

    const [result] = await pool.query(
      "INSERT INTO calls (customer_id, virtual_number, status, category) VALUES (?, ?, 'initiated', ?)",
      [customer.id, virtualNumber, category]
    );

    // Usage is incremented only when an agent actually answers (in chatSocket call_accept handler)

    res.status(201).json({
      call: { id: result.insertId, virtual_number: virtualNumber, status: 'initiated' },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.endCall = async (req, res) => {
  try {
    const [calls] = await pool.query(
      'SELECT * FROM calls WHERE id = ?',
      [req.params.id]
    );
    if (!calls.length) return res.status(404).json({ error: 'Call not found' });
    const call = calls[0];

    if (call.status === 'ended') {
      return res.status(400).json({ error: 'Call already ended' });
    }

    // Verify customer owns this call
    if (req.user.role === 'customer') {
      const [cRows] = await pool.query(
        'SELECT id FROM customers WHERE user_id = ?',
        [req.user.id]
      );
      if (!cRows.length || cRows[0].id !== call.customer_id)
        return res.status(403).json({ error: 'Forbidden' });
    }

    const startTime = call.call_start_time ? new Date(call.call_start_time) : null;
    let duration = startTime ? Math.floor((new Date() - startTime) / 1000) : 0;
    if (duration > MAX_CALL_DURATION) duration = MAX_CALL_DURATION;

    // ended_by reflects who initiated the hang-up — admin / agent / customer
    // pulled straight from the JWT role on the end-call endpoint.
    const endedBy = req.user.role === 'admin' ? 'admin'
                  : req.user.role === 'agent' ? 'agent'
                  : 'customer';
    await pool.query(
      "UPDATE calls SET status = 'ended', call_end_time = NOW(), duration = ?, ended_by = ? WHERE id = ?",
      [duration, endedBy, call.id]
    );

    res.json({
      message: 'Call ended',
      duration,
      duration_formatted: `${Math.floor(duration / 60)}m ${duration % 60}s`,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.getCallHistory = async (req, res) => {
  try {
    const [cRows] = await pool.query(
      'SELECT id FROM customers WHERE user_id = ?',
      [req.user.id]
    );
    if (!cRows.length) return res.status(404).json({ error: 'Customer not found' });

    // Show all calls from the current calendar month. Pre-reset rows stay visible
    // (so the customer doesn't lose their record of past attempts), but they're
    // flagged `pre_reset: true` and their `counted` flag is forced false so the UI
    // can grey them out and the customer sees clearly which calls hit their quota.
    // We also return `usage_reset_at` so the UI can render a divider banner where
    // the reset happened.
    // A call's `counted` flag matches the getCallUsage rule exactly: customer-
    // initiated, connected (call_start_time set), post-reset, AND NOT a short-cut
    // (ended with duration below the billable threshold — default 30s).
    const [[meta]] = await pool.query(
      'SELECT usage_reset_at FROM customers WHERE id = ?',
      [cRows[0].id]
    );
    const resetAt = meta?.usage_reset_at;

    let threshold = 30;
    let cap = 3;
    try {
      const settings = await require('../utils/assignment').getRoutingSettings();
      threshold = Number(settings.minBillableCallSeconds ?? 30);
      cap = Math.max(0, Number(settings.maxShortCutForgivalsPerMonth ?? 3));
    } catch {}

    const [calls] = await pool.query(
      `SELECT ca.id, ca.virtual_number, ca.status, ca.call_start_time,
              ca.call_end_time, ca.duration, ca.created_at, ca.initiated_by,
              u.name AS agent_name,
              (ca.call_start_time IS NOT NULL
                AND (ca.initiated_by IS NULL OR ca.initiated_by != 'agent')
                AND NOT (ca.status = 'ended' AND ca.duration IS NOT NULL AND ca.duration < ?)
                AND (? IS NULL OR ca.created_at > ?)) AS counted,
              (? IS NOT NULL AND ca.created_at <= ?) AS pre_reset
       FROM calls ca
       LEFT JOIN users u ON u.id = ca.agent_id
       WHERE ca.customer_id = ?
         AND DATE_FORMAT(ca.created_at, '%Y-%m') = DATE_FORMAT(NOW(), '%Y-%m')
       ORDER BY ca.created_at DESC
       LIMIT 200`,
      [threshold, resetAt, resetAt, resetAt, resetAt, cRows[0].id]
    );

    // Step 1: initial annotation — for each row that the SQL marked as NOT
    // counted, derive a specific reason.
    const annotated = calls.map(c => {
      const counted = !!c.counted;
      let not_counted_reason = null;
      if (!counted) {
        if (c.pre_reset) {
          not_counted_reason = 'pre_reset';
        } else if (c.initiated_by === 'agent') {
          not_counted_reason = 'agent_initiated';
        } else if (c.status === 'ended' && c.duration != null && c.duration < threshold && c.duration > 0) {
          not_counted_reason = 'short_call';
        } else if (['missed', 'no_answer', 'no_agents'].includes(c.status)) {
          not_counted_reason = c.status;
        } else if (c.status === 'rejected' || c.status === 'failed') {
          not_counted_reason = 'not_connected';
        } else if (!c.call_start_time) {
          not_counted_reason = 'not_connected';
        } else {
          not_counted_reason = 'other';
        }
      }
      return { ...c, not_counted_reason, short_call_forgiven: false, short_call_past_cap: false };
    });

    // Step 2: apply the per-month short-cut cap. Only the FIRST `cap` short-cut
    // calls (chronologically — oldest first) get forgiven. Subsequent short
    // calls flip back to `counted=true` and carry a `short_call_past_cap` flag
    // so the customer-side tooltip can explain why a short call counted this time.
    //
    // We iterate the calls in chronological order (rows come back DESC by
    // created_at, so reverse for ASC). Pre-reset short-cuts and agent-initiated
    // short calls don't consume forgivals.
    const shortCutsAsc = [];
    for (let i = annotated.length - 1; i >= 0; i--) {
      const c = annotated[i];
      if (c.not_counted_reason === 'short_call') shortCutsAsc.push(c.id);
    }
    const forgivenIds = new Set(shortCutsAsc.slice(0, cap));
    const pastCapIds  = new Set(shortCutsAsc.slice(cap));

    annotated.forEach(c => {
      if (forgivenIds.has(c.id)) {
        c.short_call_forgiven = true;
      } else if (pastCapIds.has(c.id)) {
        // Past the monthly cap — this short call COUNTS toward quota.
        c.counted = 1;
        c.not_counted_reason = null;
        c.short_call_past_cap = true;
      }
    });

    res.json({
      calls: annotated,
      usage_reset_at: resetAt,
      min_billable_call_seconds: threshold,
      max_short_cut_forgivals_per_month: cap,
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};

// ── Admin: Call blacklist ─────────────────────────────────────────────────────
// Parallel to chatController.getBlacklist/blockCustomer/unblockCustomer. Lives
// here so all call-related admin actions are co-located with the call domain.

exports.getCallBlacklist = async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT bl.*, u.name AS customer_name, u.email AS customer_email,
             ab.name AS blocked_by_name
      FROM call_blacklist bl
      JOIN users u ON u.id = bl.customer_user_id
      JOIN users ab ON ab.id = bl.blocked_by
      ORDER BY bl.created_at DESC
    `);
    res.json({ blacklist: rows });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};

exports.blockCustomerCalls = async (req, res) => {
  try {
    const { customer_user_id, identifier, reason } = req.body;

    // Resolve the target user — accept either explicit user_id (legacy) or a
    // human-friendly identifier (email or company domain). Mirrors the chat
    // blacklist resolver so admins have a consistent UX between the two tabs.
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
      'INSERT INTO call_blacklist (customer_user_id, blocked_by, reason) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE reason = VALUES(reason)',
      [user.id, req.user.id, reason || null]
    );

    // End any in-flight calls for this customer so the block takes immediate
    // effect — they shouldn't be able to stay on a call after being blocked.
    // Mark these admin-ended so the audit trail is honest.
    await pool.query(
      `UPDATE calls ca JOIN customers cu ON cu.id = ca.customer_id
       SET ca.status = 'ended', ca.call_end_time = COALESCE(ca.call_end_time, NOW()), ca.ended_by = 'admin'
       WHERE cu.user_id = ? AND ca.status IN ('initiated','ringing','active')`,
      [user.id]
    );

    res.json({ message: `${user.name} blocked from calls`, blocked_user: { id: user.id, name: user.name } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.unblockCustomerCalls = async (req, res) => {
  try {
    await pool.query('DELETE FROM call_blacklist WHERE id = ?', [req.params.id]);
    res.json({ message: 'Customer unblocked from calls' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};
