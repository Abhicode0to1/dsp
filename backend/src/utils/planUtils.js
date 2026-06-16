const { pool } = require('../config/database');

const currentMonthYear = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

async function getCustomerWithPlan(userId) {
  const [rows] = await pool.query(
    `SELECT c.*, p.name AS plan_name, p.allow_chat, p.allow_calls,
            p.allow_email_ticket, p.tickets_limit, p.calls_limit, p.chat_limit,
            p.priority, p.percentage, p.minimum_price, p.sla_response_hours,
            u.name AS user_name, u.email,
            o.allow_chat AS ov_chat, o.allow_calls AS ov_calls,
            o.tickets_limit AS ov_tickets, o.calls_limit AS ov_calls_limit,
            o.chat_limit AS ov_chat_limit,
            o.override_reason
     FROM customers c
     JOIN users u ON u.id = c.user_id
     LEFT JOIN plans p ON p.id = c.plan_id
     LEFT JOIN customer_feature_overrides o ON o.customer_id = c.id
     WHERE c.user_id = ?`,
    [userId]
  );
  if (!rows[0]) return null;
  const r = rows[0];
  // Apply per-customer overrides (NULL means "use plan default")
  if (r.ov_chat    !== null && r.ov_chat    !== undefined) r.allow_chat    = r.ov_chat;
  if (r.ov_calls   !== null && r.ov_calls   !== undefined) r.allow_calls   = r.ov_calls;
  if (r.ov_tickets !== null && r.ov_tickets !== undefined) r.tickets_limit = r.ov_tickets;
  if (r.ov_calls_limit !== null && r.ov_calls_limit !== undefined) r.calls_limit = r.ov_calls_limit;
  if (r.ov_chat_limit  !== null && r.ov_chat_limit  !== undefined) r.chat_limit  = r.ov_chat_limit;
  return r;
}

function isPlanActive(customer) {
  if (!customer.plan_id) return false;
  if (!customer.plan_expiry) return true; // no expiry = free/lifetime plan, always active
  return new Date(customer.plan_expiry) >= new Date();
}

async function getTicketUsage(customerId) {
  const my = currentMonthYear();
  const [rows] = await pool.query(
    'SELECT count FROM ticket_usage WHERE customer_id = ? AND month_year = ?',
    [customerId, my]
  );
  return rows[0]?.count || 0;
}

async function getCallUsage(customerId) {
  // Two layered rules:
  //   1) Short calls (duration < min_billable_call_seconds, default 30s) are
  //      "forgiven" — they don't count toward the customer's monthly quota.
  //      Designed to neutralise agent spam-cuts where an agent picks up + cuts
  //      to burn the customer's quota. Symmetrically forgives customer-cut
  //      short calls too (they got no useful support either).
  //   2) Forgiveness is CAPPED at max_short_cut_forgivals_per_month per customer
  //      (default 3). After that, additional short calls START counting against
  //      the customer's quota. Closes the customer-side abuse vector where
  //      someone could spam sub-threshold calls forever.
  //
  // Computation:
  //   connected_calls = customer-initiated, post-reset, this-month, that reached
  //                     ringing/active or call_start_time was set
  //   short_cuts      = subset of connected_calls that ended with duration < threshold
  //   forgiven        = MIN(short_cuts, cap)
  //   usage           = connected_calls - forgiven
  //
  // Missed/failed/no-answer calls aren't connected so they don't show up in
  // either count — the customer isn't punished when an agent doesn't pick up.
  // Currently-active and still-ringing calls count so a customer can't dial
  // past the cap mid-flight.
  //
  // Honors `customers.usage_reset_at` — calls before that point are excluded.
  const my = currentMonthYear();
  const [[meta]] = await pool.query('SELECT usage_reset_at FROM customers WHERE id = ?', [customerId]);
  const resetAt = meta?.usage_reset_at;

  // Inline-require to avoid a top-of-file circular import between
  // planUtils ↔ assignment.
  let threshold = 30;
  let cap = 3;
  try {
    const settings = await require('./assignment').getRoutingSettings();
    threshold = Number(settings.minBillableCallSeconds ?? 30);
    cap = Math.max(0, Number(settings.maxShortCutForgivalsPerMonth ?? 3));
  } catch {}

  const [[counts]] = await pool.query(
    `SELECT
       SUM(CASE WHEN (call_start_time IS NOT NULL OR status IN ('ringing','active')) THEN 1 ELSE 0 END) AS connected,
       SUM(CASE WHEN status = 'ended' AND duration IS NOT NULL AND duration > 0 AND duration < ? THEN 1 ELSE 0 END) AS short_cuts
     FROM calls
     WHERE customer_id = ?
       AND DATE_FORMAT(created_at, '%Y-%m') = ?
       AND (initiated_by IS NULL OR initiated_by != 'agent')
       AND (? IS NULL OR created_at > ?)`,
    [threshold, customerId, my, resetAt, resetAt]
  );
  const connected = Number(counts?.connected || 0);
  const shortCuts = Number(counts?.short_cuts || 0);
  const forgiven = Math.min(shortCuts, cap);
  const usage = Math.max(0, connected - forgiven);
  _maybeWarnDrift('call', customerId, usage);
  return usage;
}

async function incrementTicketUsage(customerId) {
  const my = currentMonthYear();
  await pool.query(
    `INSERT INTO ticket_usage (customer_id, month_year, count)
     VALUES (?, ?, 1)
     ON DUPLICATE KEY UPDATE count = count + 1`,
    [customerId, my]
  );
}

// Drift detection helper — logs once when usage exceeds the customer's plan cap.
// A usage>limit reading is always a symptom of either (a) a counter bug we missed or
// (b) a plan downgrade. Either way ops should see it; the warn is rate-limited per pid
// so a single drifted customer can't spam the log.
const _driftWarned = new Set();
async function _maybeWarnDrift(channel, customerId, usage) {
  try {
    const [[row]] = await pool.query(
      `SELECT u.email, p.chat_limit, p.calls_limit FROM customers c
       JOIN users u ON u.id = c.user_id LEFT JOIN plans p ON p.id = c.plan_id
       WHERE c.id = ?`, [customerId]);
    if (!row) return;
    const cap = channel === 'chat' ? row.chat_limit : row.calls_limit;
    if (cap != null && usage > cap) {
      const key = `${channel}:${customerId}`;
      if (_driftWarned.has(key)) return;
      _driftWarned.add(key);
      console.warn(`[usage-drift] ${row.email} ${channel}: usage=${usage} > limit=${cap}. ` +
        `Investigate via GET /api/admin/audit/usage-drift.`);
    }
  } catch {}
}

async function getChatUsage(customerId) {
  // A chat counts toward usage only if the customer actually engaged — i.e. they
  // sent at least one message after the agent accepted. This prevents accidental
  // accept→instant-close cycles (UI mis-clicks, automated tests, agent declines, etc.)
  // from burning quota and ensures the counter matches what the customer sees as a
  // "real" chat session in their History tab.
  //
  // We used to also add a +1 for any waiting/active chat so the customer couldn't
  // queue past their cap, but that produced a flapping dashboard counter (5/15
  // jumps to 6/15 the moment a chat is started, then drops back to 5/15 if the
  // customer leaves without engaging). Cap enforcement is already handled at the
  // initiateChat level: the "one waiting/active chat at a time" check returns the
  // existing chat instead of creating a new row, so the +1 trick was redundant.
  // Number only goes up now, only when the customer actually consumed support.
  //
  // Honors `customers.usage_reset_at` — when admin resets a customer's usage from
  // the System Health panel, only chats accepted after that timestamp count. Rows
  // before the reset are skipped (still visible in history, just not counted).
  const my = currentMonthYear();
  const [[meta]] = await pool.query('SELECT usage_reset_at FROM customers WHERE id = ?', [customerId]);
  const resetAt = meta?.usage_reset_at;
  const [rows] = await pool.query(
    `SELECT COUNT(DISTINCT ch.id) AS cnt FROM chats ch
     JOIN chat_messages cm ON cm.chat_id = ch.id
     JOIN users u ON u.id = cm.sender_id
     WHERE ch.customer_id = ?
       AND ch.accepted_at IS NOT NULL
       AND DATE_FORMAT(ch.accepted_at, '%Y-%m') = ?
       AND u.role = 'customer'
       AND (? IS NULL OR ch.accepted_at > ?)`,
    [customerId, my, resetAt, resetAt]
  );
  const usage = Number(rows[0]?.cnt) || 0;
  _maybeWarnDrift('chat', customerId, usage);
  return usage;
}

async function incrementChatUsage(customerId) {
  const my = currentMonthYear();
  await pool.query(
    `INSERT INTO chat_usage (customer_id, month_year, count)
     VALUES (?, ?, 1)
     ON DUPLICATE KEY UPDATE count = count + 1`,
    [customerId, my]
  );
}

async function incrementCallUsage(customerId) {
  const my = currentMonthYear();
  await pool.query(
    `INSERT INTO call_usage (customer_id, month_year, count)
     VALUES (?, ?, 1)
     ON DUPLICATE KEY UPDATE count = count + 1`,
    [customerId, my]
  );
}

function calculateFinalPrice(planName, invoiceSubtotal) {
  const config = {
    basic:    { percentage: 0.05, minimum: 3000 },
    moderate: { percentage: 0.10, minimum: 8000 },
    premium:  { percentage: 0.15, minimum: 20000 },
  };
  const c = config[planName];
  if (!c) return 0;
  return Math.max(invoiceSubtotal * c.percentage, c.minimum);
}

module.exports = {
  getCustomerWithPlan,
  isPlanActive,
  getTicketUsage,
  getCallUsage,
  getChatUsage,
  incrementTicketUsage,
  incrementCallUsage,
  incrementChatUsage,
  calculateFinalPrice,
  currentMonthYear,
};
