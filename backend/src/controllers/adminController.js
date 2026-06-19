const { pool } = require('../config/database');
const { calculateFinalPrice, currentMonthYear, getTicketUsage, getChatUsage, getCallUsage } = require('../utils/planUtils');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { upsertCustomer, getSetting, fetchJson, postJson } = require('./syncController');
const { sendWelcomeEmail, sendAccountReadyEmail, sendAgentWelcomeEmail } = require('../utils/emailUtils');
const { logPlanChange } = require('../utils/planHistory');

// Small helper to record an audit entry. Fire-and-forget — never blocks the
// admin action. Used by changePassword / resetUsage / updateCustomer / etc.
// so each customer's Activity tab can show what's been done to them and by whom.
function _audit(req, { action, entityType = 'customer', entityId, oldValue, newValue }) {
  if (!req?.user || !entityId) return;
  pool.query(
    `INSERT INTO audit_log (actor_id, actor_name, actor_role, action, entity_type, entity_id, old_value, new_value, ip_address)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [req.user.id, req.user.name, req.user.role, action, entityType, entityId,
     oldValue == null ? null : (typeof oldValue === 'string' ? oldValue : JSON.stringify(oldValue)),
     newValue == null ? null : (typeof newValue === 'string' ? newValue : JSON.stringify(newValue)),
     req.ip || null]
  ).catch(err => console.error('[audit]', action, err.message));
}

// Free plan never expires. Anywhere the admin can pick (or change to) Free,
// any expiry date they provide gets coerced to NULL so the plan-active check
// treats them as "always active" indefinitely. Paid plans (basic / moderate /
// premium) keep their expiry as supplied.
async function coerceExpiryForPlan(planId, requestedExpiry) {
  if (!planId) return requestedExpiry || null;
  const [[plan]] = await pool.query('SELECT name FROM plans WHERE id = ?', [planId]);
  if (plan && plan.name === 'free') return null;
  return requestedExpiry || null;
}

// Lower-cased plan name for a plan id (or null). Used to decide whether an
// expiry date is required (paid plans) vs forbidden (free plans).
async function planNameById(planId) {
  if (!planId) return null;
  const [[plan]] = await pool.query('SELECT name FROM plans WHERE id = ?', [Number(planId)]);
  return plan ? String(plan.name).toLowerCase() : null;
}

// A paid plan MUST have a valid YYYY-MM-DD expiry date (free plans never expire).
// Returns an error string if the (plan, expiry) pair is invalid, else null.
// This is what prevents the "paid plan with no expiry" limbo that made the
// admin panel show EXPIRED while the customer panel showed ACTIVE (bug #34).
function expiryRequirementError(planName, expiry) {
  if (!planName || planName === 'free') return null; // free: expiry not required
  const val = expiry ? String(expiry).slice(0, 10) : '';
  if (!val) return 'An expiry date is required for paid plans.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(val)) return 'Expiry date must be a valid date (YYYY-MM-DD).';
  return null;
}
// And the dashboard count: Free customers count as active too (their NULL
// expiry shouldn't disqualify them).
exports.getDashboard = async (req, res) => {
  try {
    const [[totalCustomers]] = await pool.query('SELECT COUNT(*) AS count FROM customers');
    // "Active Plans" = any non-expired plan including Free (which never expires).
    // Broken out by Free vs Paid so the dashboard subtitle can show the split —
    // a single combined number conflates 3 Free customers with 11 paying ones.
    const [[activeBreakdown]] = await pool.query(
      `SELECT
         COUNT(*)                                        AS total_active,
         SUM(CASE WHEN p.name = 'free' THEN 1 ELSE 0 END) AS free_active,
         SUM(CASE WHEN p.name != 'free' THEN 1 ELSE 0 END) AS paid_active
       FROM customers c
       JOIN plans p ON p.id = c.plan_id
       WHERE p.name = 'free' OR c.plan_expiry >= CURDATE()`
    );
    const activeCustomers = { count: Number(activeBreakdown.total_active) || 0 };
    const [[openTickets]] = await pool.query(
      "SELECT COUNT(*) AS count FROM tickets WHERE status != 'closed'"
    );
    // Revenue is computed as ANNUAL RECURRING REVENUE (ARR) — sum of each
    // active customer's plan price. Free counts as ₹0 (minimum_price = 0).
    // Reflects what the panel actually knows: who's on which plan now × the
    // price set in Settings → Plans. NOT pulled from the invoices table —
    // that's the Zoho billing app's job, and DSP shouldn't pretend to be one.
    // A paid customer only counts toward ARR / "paying customers" once they have
    // a RECORDED PAYMENT (a non-empty payment_ref in plan_change_history) — a
    // manually-created paid customer with no proof of payment is NOT counted as
    // revenue (bug #34). `hp.has_proof` is the per-customer payment-proof flag.
    const [[revenueStats]] = await pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN p.name != 'free' AND hp.has_proof = 1 THEN p.minimum_price ELSE 0 END), 0) AS arr,
         SUM(CASE WHEN p.name != 'free' AND hp.has_proof = 1 THEN 1 ELSE 0 END) AS paying_customers,
         SUM(CASE WHEN p.name  = 'free' THEN 1 ELSE 0 END) AS free_customers
       FROM customers c
       JOIN plans p ON p.id = c.plan_id
       LEFT JOIN (
         SELECT customer_id, 1 AS has_proof FROM plan_change_history
         WHERE payment_ref IS NOT NULL AND payment_ref <> '' GROUP BY customer_id
       ) hp ON hp.customer_id = c.id
       WHERE p.name = 'free' OR c.plan_expiry IS NULL OR c.plan_expiry >= CURDATE()`
    );
    const totalRevenue = { total: Number(revenueStats.arr) || 0 };
    const [[waitingChats]] = await pool.query(
      "SELECT COUNT(*) AS count FROM chats WHERE status = 'waiting'"
    );

    const [recentCustomers] = await pool.query(
      `SELECT c.id, u.name, u.email, c.domain, c.plan_expiry,
              p.name AS plan_name, c.created_at
       FROM customers c
       JOIN users u ON u.id = c.user_id
       LEFT JOIN plans p ON p.id = c.plan_id
       ORDER BY c.created_at DESC LIMIT 5`
    );

    const [planDistribution] = await pool.query(
      `SELECT p.name AS plan_name, COUNT(c.id) AS count
       FROM plans p
       LEFT JOIN customers c ON c.plan_id = p.id
       GROUP BY p.id, p.name`
    );

    // ── Today's snapshot — last 24h activity counts ────────────────────────
    const [[today]] = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM customers WHERE created_at >= NOW() - INTERVAL 1 DAY) AS new_customers,
        (SELECT COUNT(*) FROM tickets   WHERE created_at >= NOW() - INTERVAL 1 DAY) AS new_tickets,
        (SELECT COUNT(*) FROM tickets   WHERE closed_at  >= NOW() - INTERVAL 1 DAY AND status = 'closed') AS closed_tickets,
        (SELECT COUNT(*) FROM chats     WHERE created_at >= NOW() - INTERVAL 1 DAY) AS new_chats,
        (SELECT COUNT(*) FROM calls     WHERE created_at >= NOW() - INTERVAL 1 DAY) AS new_calls,
        (SELECT COALESCE(SUM(amount_paid), 0) FROM plan_change_history
           WHERE amount_paid > 0 AND created_at >= NOW() - INTERVAL 1 DAY) AS revenue_today
    `);

    // ── Trends — current period vs previous period (last 30d vs prior 30d) ─
    const [[trends]] = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM customers WHERE created_at >= NOW() - INTERVAL 30 DAY) AS customers_30d,
        (SELECT COUNT(*) FROM customers WHERE created_at >= NOW() - INTERVAL 60 DAY AND created_at < NOW() - INTERVAL 30 DAY) AS customers_prev_30d,
        (SELECT COUNT(*) FROM tickets   WHERE created_at >= NOW() - INTERVAL 30 DAY) AS tickets_30d,
        (SELECT COUNT(*) FROM tickets   WHERE created_at >= NOW() - INTERVAL 60 DAY AND created_at < NOW() - INTERVAL 30 DAY) AS tickets_prev_30d,
        (SELECT COALESCE(SUM(amount_paid), 0) FROM plan_change_history
           WHERE amount_paid > 0 AND created_at >= NOW() - INTERVAL 30 DAY) AS revenue_30d,
        (SELECT COALESCE(SUM(amount_paid), 0) FROM plan_change_history
           WHERE amount_paid > 0 AND created_at >= NOW() - INTERVAL 60 DAY AND created_at < NOW() - INTERVAL 30 DAY) AS revenue_prev_30d
    `);

    // ── SLA & queue health — operational signals ──────────────────────────
    const [openByPriority] = await pool.query(`
      SELECT priority, COUNT(*) AS count FROM tickets
      WHERE status != 'closed' GROUP BY priority
    `);
    const priorityMap = { urgent: 0, high: 0, medium: 0, normal: 0, low: 0 };
    for (const r of openByPriority) priorityMap[r.priority] = Number(r.count) || 0;

    const [[slaApproachingRow]] = await pool.query(`
      SELECT COUNT(*) AS count FROM tickets
      WHERE status != 'closed' AND sla_breached = FALSE
        AND (
          (first_response_at IS NULL AND sla_response_due IS NOT NULL
           AND sla_response_due BETWEEN NOW() AND NOW() + INTERVAL 4 HOUR)
          OR
          (sla_resolve_due IS NOT NULL
           AND sla_resolve_due BETWEEN NOW() AND NOW() + INTERVAL 4 HOUR)
        )
    `);

    const [[avgFirstResponse]] = await pool.query(`
      SELECT AVG(TIMESTAMPDIFF(MINUTE, created_at, first_response_at)) AS avg_minutes
      FROM tickets
      WHERE first_response_at IS NOT NULL AND created_at >= NOW() - INTERVAL 1 DAY
    `);

    // Agent presence — count from socket.io rooms when io is available; falls
    // back to "users with role=agent OR admin who are is_active" otherwise.
    let agentsOnline = 0;
    try {
      const io = req.app.get('io');
      if (io) {
        const { getOnlineAgentIds } = require('../socket/chatSocket');
        agentsOnline = getOnlineAgentIds(io).length;
      }
    } catch {}

    // ── Plans expiring soon — next 30 days, paid plans only ───────────────
    const [expiringList] = await pool.query(`
      SELECT c.id AS customer_id, u.name AS customer_name, u.email,
             p.name AS plan_name, p.minimum_price AS plan_price,
             c.plan_expiry,
             DATEDIFF(c.plan_expiry, CURDATE()) AS days_left
      FROM customers c
      JOIN users u ON u.id = c.user_id
      JOIN plans p ON p.id = c.plan_id
      WHERE p.name != 'free'
        AND c.plan_expiry IS NOT NULL
        AND c.plan_expiry >= CURDATE()
        AND c.plan_expiry < CURDATE() + INTERVAL 30 DAY
      ORDER BY c.plan_expiry ASC
      LIMIT 20
    `);
    const arrAtRisk = expiringList.reduce((s, r) => s + (Number(r.plan_price) || 0), 0);

    res.json({
      stats: {
        totalCustomers: totalCustomers.count,
        activeCustomers: activeCustomers.count,
        activeFreeCustomers: Number(activeBreakdown.free_active) || 0,
        activePaidCustomers: Number(activeBreakdown.paid_active) || 0,
        openTickets: openTickets.count,
        totalRevenue: totalRevenue.total,           // = ARR (kept name for backward compat)
        arr: totalRevenue.total,                    // explicit ARR label
        mrr: Math.round(totalRevenue.total / 12),   // monthly slice of ARR
        payingCustomers: Number(revenueStats.paying_customers) || 0,
        freeCustomers: Number(revenueStats.free_customers) || 0,
        waitingChats: waitingChats.count,
      },
      today: {
        newCustomers:   Number(today.new_customers) || 0,
        newTickets:     Number(today.new_tickets) || 0,
        closedTickets:  Number(today.closed_tickets) || 0,
        newChats:       Number(today.new_chats) || 0,
        newCalls:       Number(today.new_calls) || 0,
        revenue:        Number(today.revenue_today) || 0,
      },
      trends: {
        customersDelta: Number(trends.customers_30d) - Number(trends.customers_prev_30d),
        ticketsDelta:   Number(trends.tickets_30d)   - Number(trends.tickets_prev_30d),
        revenueDelta:   Number(trends.revenue_30d)   - Number(trends.revenue_prev_30d),
      },
      slaQueue: {
        openByPriority: priorityMap,
        approachingBreach: Number(slaApproachingRow.count) || 0,
        avgFirstResponseMinutes: avgFirstResponse.avg_minutes != null
          ? Math.round(Number(avgFirstResponse.avg_minutes))
          : null,
        waitingChats: waitingChats.count,
        agentsOnline,
      },
      expiring: {
        items: expiringList.map(r => ({
          customer_id: r.customer_id,
          customer_name: r.customer_name,
          email: r.email,
          plan_name: r.plan_name,
          plan_price: Number(r.plan_price) || 0,
          plan_expiry: r.plan_expiry,
          days_left: Number(r.days_left) || 0,
        })),
        count: expiringList.length,
        arrAtRisk,
      },
      recentCustomers,
      planDistribution,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.getCustomers = async (req, res) => {
  try {
    const { search, plan, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let where = 'WHERE 1=1';
    const params = [];

    if (search) {
      where += ' AND (u.name LIKE ? OR u.email LIKE ? OR c.domain LIKE ?)';
      const s = `%${search}%`;
      params.push(s, s, s);
    }
    if (plan) { where += ' AND p.name = ?'; params.push(plan); }

    const [customers] = await pool.query(
      `SELECT c.id, u.name, u.email, c.domain, c.products, c.plan_expiry,
              c.invoice_subtotal, c.created_at,
              p.id AS plan_id, p.name AS plan_name,
              CASE
                WHEN p.name IS NULL OR p.name = 'free' THEN 0
                WHEN EXISTS (
                  SELECT 1 FROM plan_change_history h
                  WHERE h.customer_id = c.id AND h.payment_ref IS NOT NULL AND h.payment_ref != ''
                ) THEN 0
                ELSE 1
              END AS missing_payment_proof
       FROM customers c
       JOIN users u ON u.id = c.user_id
       LEFT JOIN plans p ON p.id = c.plan_id
       ${where}
       ORDER BY c.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM customers c
       JOIN users u ON u.id = c.user_id
       LEFT JOIN plans p ON p.id = c.plan_id
       ${where}`,
      params
    );

    const formatted = customers.map(c => {
      let products = [];
      try { products = JSON.parse(c.products || '[]'); } catch {}
      return { ...c, products, missing_payment_proof: !!c.missing_payment_proof };
    });

    res.json({ customers: formatted, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.getCustomerById = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT c.*, u.name, u.email, u.is_active,
              p.name AS plan_name, p.allow_chat, p.allow_calls,
              p.tickets_limit, p.chat_limit, p.calls_limit, p.priority AS plan_priority
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
      'SELECT * FROM tickets WHERE customer_id = ? ORDER BY created_at DESC LIMIT 10',
      [req.params.id]
    );

    const [invoices] = await pool.query(
      `SELECT i.*, p.name AS plan_name FROM invoices i
       JOIN plans p ON p.id = i.plan_id
       WHERE i.customer_id = ? ORDER BY i.created_at DESC`,
      [req.params.id]
    );

    // Live month-to-date usage — same helpers the plan-gating logic uses, so
    // the numbers shown here always match what the gate would enforce on a
    // new request.
    const customerId = Number(req.params.id);
    const [ticketsUsed, chatsUsed, callsUsed] = await Promise.all([
      getTicketUsage(customerId).catch(() => 0),
      getChatUsage(customerId).catch(() => 0),
      getCallUsage(customerId).catch(() => 0),
    ]);

    // Per-customer overrides (if any). The customer info card uses this to
    // show a "has overrides" badge; the detail view shows the reason on hover.
    const [[override]] = await pool.query(
      `SELECT allow_chat, allow_calls, tickets_limit, calls_limit, override_reason, updated_at
       FROM customer_feature_overrides WHERE customer_id = ?`,
      [customerId]
    );

    // Missing-payment-proof flag — paying customer with zero non-NULL
    // payment_ref rows in their plan_change_history. Free / null plans never
    // need proof.
    const planName = rows[0].plan_name;
    let missingPaymentProof = false;
    if (planName && planName !== 'free') {
      const [[{ has_ref }]] = await pool.query(
        `SELECT COUNT(*) > 0 AS has_ref FROM plan_change_history
         WHERE customer_id = ? AND payment_ref IS NOT NULL AND payment_ref != ''`,
        [customerId]
      );
      missingPaymentProof = !has_ref;
    }

    res.json({
      customer: { ...rows[0], products, missing_payment_proof: missingPaymentProof },
      tickets,
      invoices,
      tickets_used: ticketsUsed,
      chats_used: chatsUsed,
      calls_used: callsUsed,
      override: override || null,
    });
  } catch (err) {
    console.error('[getCustomerById]', err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.updateCustomer = async (req, res) => {
  try {
    const { planId, planExpiry, invoiceSubtotal, domain, products, transactionRef, is_vip, favorite_agent_id } = req.body;
    const updates = [];
    const params = [];

    // Snapshot the pre-update plan_id + expiry so we can write a plan_change_history
    // row when the admin actually changes the plan. Only loaded when planId is in
    // the payload — most admin edits don't touch the plan.
    let preChange = null;
    if (planId !== undefined) {
      const [[snap]] = await pool.query(
        'SELECT plan_id, plan_expiry FROM customers WHERE id = ?',
        [req.params.id]
      );
      preChange = snap || null;
    }

    if (planId !== undefined) {
      // Customers must always be on a plan — reject attempts to clear it.
      // The admin UI now hides the "No Plan" option, but defend the DB anyway.
      if (planId === null || planId === '' || planId === 0) {
        return res.status(400).json({ error: 'Plan is required — pick Free if the customer should have no paid features.' });
      }
      // Block switching customers TO a deactivated plan. If the customer is
      // already on that plan we let the update through (admin might be editing
      // other fields and just sending the existing planId back).
      const [[targetPlan]] = await pool.query('SELECT id, is_active FROM plans WHERE id = ?', [Number(planId)]);
      if (!targetPlan) return res.status(400).json({ error: 'Invalid plan_id' });
      if (!targetPlan.is_active) {
        const [[curr]] = await pool.query('SELECT plan_id FROM customers WHERE id = ?', [req.params.id]);
        if (!curr || curr.plan_id !== Number(planId)) {
          return res.status(400).json({ error: 'That plan has been disabled — pick an active plan instead.' });
        }
      }
      updates.push('plan_id = ?'); params.push(planId);
    }
    if (planExpiry !== undefined) {
      // Force Free → NULL expiry (the plan being saved, if any)
      const coerced = await coerceExpiryForPlan(planId, planExpiry);
      updates.push('plan_expiry = ?'); params.push(coerced);
    } else if (planId !== undefined) {
      // Plan changed but expiry wasn't in the payload — if the new plan is
      // Free, null out the old expiry so a Premium-to-Free downgrade doesn't
      // leave a stale date hanging.
      const coerced = await coerceExpiryForPlan(planId, null);
      if (coerced === null) { updates.push('plan_expiry = ?'); params.push(null); }
    }
    // Bug #34: a paid plan must always have an expiry. Validate the EFFECTIVE
    // post-update plan + expiry so an edit can never leave a paid customer in
    // the "no expiry" limbo. Only runs when the plan or expiry is being touched
    // — unrelated edits (domain, products, …) are never blocked.
    if (planId !== undefined || planExpiry !== undefined) {
      const [[curr]] = await pool.query(
        `SELECT c.plan_expiry, p.name AS plan_name
           FROM customers c LEFT JOIN plans p ON p.id = c.plan_id WHERE c.id = ?`,
        [req.params.id]
      );
      const effPlanName = planId !== undefined
        ? await planNameById(planId)
        : (curr?.plan_name ? String(curr.plan_name).toLowerCase() : null);
      const effExpiry = planExpiry !== undefined ? (planExpiry || null) : (curr?.plan_expiry || null);
      const updErr = expiryRequirementError(effPlanName, effExpiry);
      if (updErr) return res.status(400).json({ error: updErr });
    }
    if (invoiceSubtotal !== undefined) { updates.push('invoice_subtotal = ?'); params.push(invoiceSubtotal); }
    if (domain !== undefined) { updates.push('domain = ?'); params.push(domain); }
    if (products !== undefined) { updates.push('products = ?'); params.push(JSON.stringify(products)); }
    if (is_vip !== undefined) { updates.push('is_vip = ?'); params.push(is_vip ? 1 : 0); }
    if (favorite_agent_id !== undefined) { updates.push('favorite_agent_id = ?'); params.push(favorite_agent_id || null); }

    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });

    params.push(req.params.id);
    await pool.query(
      `UPDATE customers SET ${updates.join(', ')}, updated_at = NOW() WHERE id = ?`,
      params
    );

    // Plan-change audit: only fires when admin actually changed the plan_id
    // (not when they just edited other fields on the same plan). Kind is
    // 'manual_admin' — explicitly distinct from customer-initiated upgrades so
    // we can filter the two in reports / customer history.
    if (planId !== undefined && preChange && Number(preChange.plan_id) !== Number(planId)) {
      logPlanChange({
        customerId: Number(req.params.id),
        fromPlanId: preChange.plan_id,
        toPlanId: Number(planId),
        changeKind: 'manual_admin',
        changedBy: req.user?.id || null,
        amountPaid: invoiceSubtotal != null ? Number(invoiceSubtotal) : null,
        paymentRef: transactionRef || null,
        expiryBefore: preChange.plan_expiry,
        expiryAfter: planExpiry || null,
        note: 'Changed via admin Customer Detail / Edit dialog',
      });
    }

    // Audit: capture which fields were edited (not the values — keep PII out of the log)
    _audit(req, {
      action: 'profile_updated',
      entityId: Number(req.params.id),
      newValue: { fields: Object.keys(req.body).filter(k => req.body[k] !== undefined) },
    });

    // Auto-generate invoice if plan changed
    if (planId && invoiceSubtotal !== undefined) {
      const [plans] = await pool.query('SELECT * FROM plans WHERE id = ?', [planId]);
      if (plans.length && plans[0].name !== 'free') {
        const finalPrice = calculateFinalPrice(plans[0].name, invoiceSubtotal);
        const gstAmount = finalPrice * 0.18;
        const dueDate = new Date();
        dueDate.setDate(dueDate.getDate() + 30);

        await pool.query(
          `INSERT INTO invoices (customer_id, plan_id, subtotal, gst_amount, final_price, status, due_date)
           VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
          [req.params.id, planId, invoiceSubtotal, gstAmount, finalPrice, dueDate.toISOString().split('T')[0]]
        );
      }
    }

    // Notify billing app when plan is changed
    if (planId) {
      try {
        const [[custDetail]] = await pool.query(
          `SELECT c.billing_customer_id, u.email, p.name AS plan_name
           FROM customers c
           JOIN users u ON u.id = c.user_id
           LEFT JOIN plans p ON p.id = ?
           WHERE c.id = ?`,
          [planId, req.params.id]
        );
        const billingUrl = await getSetting('billing_api_url');
        const billingKey = await getSetting('billing_api_key');
        if (billingUrl && custDetail) {
          await postJson(`${billingUrl.replace(/\/$/, '')}/api/support-upgrade`, billingKey, {
            billing_customer_id: custDetail.billing_customer_id || null,
            email: custDetail.email,
            plan: custDetail.plan_name,
            plan_expiry: planExpiry || null,
            payment_ref: transactionRef || null,
            payment_mode: 'Online',
            amount: invoiceSubtotal || 0,
          });
          console.log('[Admin Upgrade] Billing app notified for customer', req.params.id);
        }
      } catch (e) {
        console.error('[Admin Upgrade] Billing notification failed (non-fatal):', e.message);
      }
    }

    res.json({ message: 'Customer updated successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// Paginated list of calls across all agents/customers, with filter support.
// Joins file_attachments to expose recording info (if any).
exports.getAdminCalls = async (req, res) => {
  try {
    const { q, agent_id, customer_id, from, to, has_recording, short_only, page = 1, limit = 30 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    // Read the billable threshold so we can flag (and optionally filter) calls
    // that were accepted but ended under the limit — i.e. the spam-cut audit
    // lens. Cached inside getRoutingSettings; default 30.
    const { minBillableCallSeconds } = await require('../utils/assignment').getRoutingSettings();
    const threshold = Number(minBillableCallSeconds || 30);

    let where = '1=1';
    const params = [];
    if (q)            { where += ' AND (cu.name LIKE ? OR cu.email LIKE ? OR c.domain LIKE ?)'; params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    if (agent_id)     { where += ' AND ca.agent_id = ?';    params.push(agent_id); }
    if (customer_id)  { where += ' AND ca.customer_id = ?'; params.push(customer_id); }
    if (from)         { where += ' AND ca.created_at >= ?'; params.push(from); }
    if (to)           { where += ' AND ca.created_at <= ?'; params.push(to); }
    if (has_recording === '1') where += ' AND ca.recording_attachment_id IS NOT NULL';
    if (has_recording === '0') where += ' AND ca.recording_attachment_id IS NULL';
    // Short-cut audit filter: only show inbound calls that were ended with a
    // duration below the billable threshold. Helps spot agents who spam-cut.
    if (short_only === '1') {
      where += " AND ca.status = 'ended' AND ca.duration IS NOT NULL AND ca.duration < ? AND ca.initiated_by <> 'agent'";
      params.push(threshold);
    }

    const [calls] = await pool.query(`
      SELECT ca.id, ca.created_at, ca.call_start_time, ca.call_end_time, ca.duration,
             ca.status, ca.initiated_by, ca.ended_by, ca.ticket_id, ca.recording_attachment_id,
             ca.agent_id, ca.participants,
             cu.name AS customer_name, cu.email AS customer_email, c.domain AS customer_domain,
             ag.name AS agent_name,
             fa.size_bytes AS recording_size, fa.mime_type AS recording_mime,
             -- All recording legs for this call (a transferred call has one per
             -- agent), each tagged with the uploading agent's name so the admin
             -- can play "Abhishek's leg" + "Ranjeet's leg" separately.
             (SELECT JSON_ARRAYAGG(JSON_OBJECT(
                'id', fr.id, 'mime', fr.mime_type, 'size', fr.size_bytes,
                'uploaded_by', fr.uploaded_by, 'uploader', uu.name,
                'created_at', fr.created_at))
              FROM file_attachments fr LEFT JOIN users uu ON uu.id = fr.uploaded_by
              WHERE fr.ref_type = 'call_recording' AND fr.ref_id = ca.id) AS recordings
      FROM calls ca
      JOIN customers c ON c.id = ca.customer_id
      JOIN users cu ON cu.id = c.user_id
      LEFT JOIN users ag ON ag.id = ca.agent_id
      LEFT JOIN file_attachments fa ON fa.id = ca.recording_attachment_id
      WHERE ${where}
      ORDER BY ca.created_at DESC
      LIMIT ? OFFSET ?
    `, [...params, parseInt(limit), offset]);

    const [[{ total }]] = await pool.query(`
      SELECT COUNT(*) AS total FROM calls ca
      JOIN customers c ON c.id = ca.customer_id
      JOIN users cu ON cu.id = c.user_id
      WHERE ${where}
    `, params);

    res.json({ calls, total, page: parseInt(page), limit: parseInt(limit), min_billable_call_seconds: threshold });
  } catch (err) {
    console.error('getAdminCalls error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.getPlans = async (req, res) => {
  try {
    // Alias `minimum_price` -> `price` for the frontend (column name is legacy).
    const [plans] = await pool.query('SELECT *, minimum_price AS price FROM plans ORDER BY id');
    res.json({ plans });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};

// Update a plan's limits + feature flags. Changes propagate immediately to
// customer panel (Billing) and agent panel (eligibility checks for calls/chats).
exports.updatePlan = async (req, res) => {
  try {
    const planId = parseInt(req.params.id, 10);
    if (!planId) return res.status(400).json({ error: 'Invalid plan id' });

    const [[existing]] = await pool.query('SELECT * FROM plans WHERE id = ?', [planId]);
    if (!existing) return res.status(404).json({ error: 'Plan not found' });

    // Whitelist of editable fields. `name` is intentionally NOT editable to keep
    // plan identifiers stable (free/basic/moderate/premium). Frontend uses
    // friendlier names than the DB columns — map here.
    //   price -> minimum_price  (legacy column name; we use it as the annual price)
    const FIELD_TO_COLUMN = {
      price: 'minimum_price',
      allow_chat: 'allow_chat',
      allow_calls: 'allow_calls',
      allow_email_ticket: 'allow_email_ticket',
      chat_limit: 'chat_limit',
      calls_limit: 'calls_limit',
      tickets_limit: 'tickets_limit',
      sla_response_hours: 'sla_response_hours',
      sla_resolve_hours: 'sla_resolve_hours',
      agent_can_initiate_call: 'agent_can_initiate_call',
      is_active: 'is_active',
    };
    const NUMERIC = new Set(['price', 'chat_limit', 'calls_limit', 'tickets_limit', 'sla_response_hours', 'sla_resolve_hours']);
    const BOOL    = new Set(['allow_chat', 'allow_calls', 'allow_email_ticket', 'agent_can_initiate_call', 'is_active']);

    // Free is the fallback for createManualCustomer — disabling it would break
    // new-customer creation. Refuse and tell the admin why.
    if (req.body.is_active === false || req.body.is_active === 0) {
      if (existing.name === 'free') {
        return res.status(400).json({ error: 'The Free plan can\'t be disabled — it\'s the default for new customers.' });
      }
    }

    const updates = [];
    const params  = [];
    for (const key of Object.keys(FIELD_TO_COLUMN)) {
      if (req.body[key] === undefined) continue;
      let val = req.body[key];
      if (val === '' || val === null) val = null; // explicit "unlimited"/unset
      else if (BOOL.has(key)) val = val ? 1 : 0;
      else if (NUMERIC.has(key)) {
        const n = parseInt(val, 10);
        if (isNaN(n) || n < 0) return res.status(400).json({ error: `${key} must be a positive number` });
        val = n;
      }
      updates.push(`\`${FIELD_TO_COLUMN[key]}\` = ?`);
      params.push(val);
    }
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });

    params.push(planId);
    await pool.query(`UPDATE plans SET ${updates.join(', ')} WHERE id = ?`, params);

    const [[updated]] = await pool.query('SELECT *, minimum_price AS price FROM plans WHERE id = ?', [planId]);

    // Broadcast so every open customer / agent panel can refetch and re-render
    // without a manual page refresh. Payload includes the plan name so clients
    // can filter (a customer on Premium ignores changes to Basic). Affected
    // customers re-read their dashboard; agents re-read any open ticket detail
    // that belongs to a customer on this plan.
    const io = req.app.get('io');
    if (io && updated) {
      io.emit('plan_changed', { planId: updated.id, planName: updated.name });
    }

    res.json({ plan: updated });
  } catch (err) {
    console.error('updatePlan error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.getTicketReport = async (req, res) => {
  try {
    const { from, to } = req.query;
    const dr = dateRangeWhere(from, to, 't.created_at');
    // For sub-queries that don't use a `t.` alias, build a non-aliased variant.
    const drBare = dateRangeWhere(from, to, 'created_at');

    const [byStatus] = await pool.query(
      `SELECT status, COUNT(*) AS count FROM tickets WHERE 1=1${drBare.sql} GROUP BY status`,
      drBare.params
    );
    const [byPriority] = await pool.query(
      `SELECT priority, COUNT(*) AS count FROM tickets WHERE 1=1${drBare.sql} GROUP BY priority`,
      drBare.params
    );
    // LEFT JOIN so tickets whose customer has no plan_id (or whose customer row
    // is missing entirely — legacy / load-test data) still show up. NULL
    // plan_name is rendered as "(no plan)" on the frontend.
    const [byPlan] = await pool.query(
      `SELECT p.name AS plan_name, COUNT(t.id) AS ticket_count
       FROM tickets t
       LEFT JOIN customers c ON c.id = t.customer_id
       LEFT JOIN plans p ON p.id = c.plan_id
       WHERE 1=1${dr.sql}
       GROUP BY p.name`,
      dr.params
    );
    // Monthly chart used to be hard-coded to the last 6 months. When a date
    // range is provided we drop that floor and use the user's range; with no
    // range we keep the 6-month default so the chart still shows a meaningful
    // trend on a fresh page load.
    const monthlySql = from || to
      ? `SELECT DATE_FORMAT(created_at, '%Y-%m') AS month, COUNT(*) AS count
         FROM tickets WHERE 1=1${drBare.sql} GROUP BY month ORDER BY month`
      : `SELECT DATE_FORMAT(created_at, '%Y-%m') AS month, COUNT(*) AS count
         FROM tickets WHERE created_at >= DATE_SUB(NOW(), INTERVAL 6 MONTH)
         GROUP BY month ORDER BY month`;
    const [monthly] = await pool.query(monthlySql, from || to ? drBare.params : []);

    // Per-agent breakdown — closed tickets only so it reads as "how many did
    // each agent resolve" rather than open-pile depth. Includes admin-handled
    // tickets too (no role filter) so a single-admin shop sees their own work.
    // LEFT JOIN so closed tickets with NULL assigned_agent_id (closed without
    // ever being assigned — bulk-closed by admin or legacy migrations) also
    // show up. NULL agent groups into an "Unassigned" row on the frontend.
    const [byAgent] = await pool.query(
      `SELECT u.id, u.name AS agent_name, COUNT(t.id) AS ticket_count
       FROM tickets t
       LEFT JOIN users u ON u.id = t.assigned_agent_id
       WHERE t.status = 'closed'${dr.sql}
       GROUP BY u.id, u.name
       ORDER BY ticket_count DESC
       LIMIT 11`,
      dr.params
    );

    // KPIs for the top strip — derived from the same tickets table in one go.
    //   total              : every ticket ever raised
    //   avgResolutionHours : (closed_at − created_at) for closed tickets
    //   slaMetPct          : % of closed tickets resolved before sla_resolve_due
    //   topRequestType     : most common request_type (Google Workspace etc.)
    const [[totals]] = await pool.query(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) AS closed_count,
              ROUND(AVG(CASE WHEN status = 'closed' AND closed_at IS NOT NULL
                THEN TIMESTAMPDIFF(MINUTE, created_at, closed_at) / 60.0
                ELSE NULL END), 1) AS avg_resolution_hours,
              SUM(CASE WHEN status = 'closed' AND sla_resolve_due IS NOT NULL
                       AND closed_at IS NOT NULL AND closed_at <= sla_resolve_due
                       THEN 1 ELSE 0 END) AS sla_met,
              SUM(CASE WHEN status = 'closed' AND sla_resolve_due IS NOT NULL
                       THEN 1 ELSE 0 END) AS sla_eligible
       FROM tickets WHERE 1=1${drBare.sql}`,
      drBare.params
    );
    const slaMetPct = totals.sla_eligible > 0
      ? Math.round((totals.sla_met / totals.sla_eligible) * 100)
      : null;
    const [[topType]] = await pool.query(
      `SELECT request_type, COUNT(*) AS count
       FROM tickets
       WHERE request_type IS NOT NULL AND request_type != ''${drBare.sql}
       GROUP BY request_type ORDER BY count DESC LIMIT 1`,
      drBare.params
    );

    const kpis = {
      total: Number(totals.total || 0),
      closedCount: Number(totals.closed_count || 0),
      avgResolutionHours: totals.avg_resolution_hours,
      slaMetPct,
      topRequestType: topType?.request_type || null,
      topRequestTypeCount: topType ? Number(topType.count) : 0,
    };

    res.json({ byStatus, byPriority, byPlan, byAgent, monthly, kpis });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.getRevenueReport = async (req, res) => {
  try {
    const { from, to } = req.query;
    const drBare = dateRangeWhere(from, to, 'created_at');

    // Monthly trend = actual money collected per month, derived from
    // plan_change_history.amount_paid (the source of truth for Razorpay /
    // admin-manual-renewal payments). Replaces the legacy invoice.final_price
    // sum which mixed seed/manual rows with real payments.
    const monthlySql = from || to
      ? `SELECT DATE_FORMAT(created_at, '%Y-%m') AS month,
                COALESCE(SUM(amount_paid), 0) AS revenue,
                COUNT(*) AS invoice_count
         FROM plan_change_history
         WHERE amount_paid IS NOT NULL AND amount_paid > 0${drBare.sql}
         GROUP BY month ORDER BY month`
      : `SELECT DATE_FORMAT(created_at, '%Y-%m') AS month,
                COALESCE(SUM(amount_paid), 0) AS revenue,
                COUNT(*) AS invoice_count
         FROM plan_change_history
         WHERE amount_paid IS NOT NULL AND amount_paid > 0
           AND created_at >= DATE_SUB(NOW(), INTERVAL 6 MONTH)
         GROUP BY month ORDER BY month`;
    const [monthly] = await pool.query(monthlySql, from || to ? drBare.params : []);

    // byPlan = actual money collected per plan in the selected range (still
    // useful for "which plan drives the most revenue").
    const drPch = dateRangeWhere(from, to, 'h.created_at');
    const [byPlan] = await pool.query(
      `SELECT h.to_plan_name AS plan_name,
              COALESCE(SUM(h.amount_paid), 0) AS revenue,
              COUNT(*) AS count
       FROM plan_change_history h
       WHERE h.amount_paid IS NOT NULL AND h.amount_paid > 0
         AND h.to_plan_name IS NOT NULL${drPch.sql}
       GROUP BY h.to_plan_name`,
      drPch.params
    );

    // Summary still uses invoice statuses (paid/pending/overdue) because
    // plan_change_history doesn't carry that distinction — every row is
    // "money collected". Kept for the existing Reports UI legacy fields.
    const [[summary]] = await pool.query(
      `SELECT
        SUM(CASE WHEN status = 'paid' THEN final_price ELSE 0 END) AS paid_revenue,
        SUM(CASE WHEN status = 'pending' THEN final_price ELSE 0 END) AS pending_revenue,
        SUM(CASE WHEN status = 'overdue' THEN final_price ELSE 0 END) AS overdue_revenue
       FROM invoices WHERE 1=1${drBare.sql}`,
      drBare.params
    );

    // ARR + MRR — point-in-time forward-looking revenue based on current
    // active customer base × plan prices. Independent of date range filter
    // (it's always "right now", not historical). Only paid customers with a
    // recorded payment_ref count — unverified (no-proof) customers are excluded
    // from revenue (bug #34), matching the dashboard ARR query above.
    const [[arrStats]] = await pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN p.name != 'free' AND hp.has_proof = 1 THEN p.minimum_price ELSE 0 END), 0) AS arr,
         SUM(CASE WHEN p.name != 'free' AND hp.has_proof = 1 THEN 1 ELSE 0 END) AS paying_customers,
         SUM(CASE WHEN p.name  = 'free' THEN 1 ELSE 0 END) AS free_customers
       FROM customers c
       JOIN plans p ON p.id = c.plan_id
       LEFT JOIN (
         SELECT customer_id, 1 AS has_proof FROM plan_change_history
         WHERE payment_ref IS NOT NULL AND payment_ref <> '' GROUP BY customer_id
       ) hp ON hp.customer_id = c.id
       WHERE p.name = 'free' OR c.plan_expiry IS NULL OR c.plan_expiry >= CURDATE()`
    );
    const arr = Number(arrStats.arr) || 0;
    const arrBreakdown = {
      arr,
      mrr: Math.round(arr / 12),
      payingCustomers: Number(arrStats.paying_customers) || 0,
      freeCustomers: Number(arrStats.free_customers) || 0,
    };

    // ARR by plan — what each tier contributes to the forward-looking ARR.
    const [arrByPlanRaw] = await pool.query(
      `SELECT p.name AS plan_name,
              p.minimum_price AS plan_price,
              COUNT(*) AS active_customers,
              SUM(p.minimum_price) AS plan_arr
       FROM customers c
       JOIN plans p ON p.id = c.plan_id
       WHERE p.name = 'free' OR c.plan_expiry IS NULL OR c.plan_expiry >= CURDATE()
       GROUP BY p.name, p.minimum_price`
    );
    const PLAN_RANK = { free: 0, basic: 1, moderate: 2, premium: 3 };
    const arrByPlan = arrByPlanRaw
      .map(r => ({
        plan_name: r.plan_name,
        plan_price: Number(r.plan_price) || 0,
        active_customers: Number(r.active_customers) || 0,
        plan_arr: Number(r.plan_arr) || 0,
      }))
      .sort((a, b) => (PLAN_RANK[a.plan_name] ?? 99) - (PLAN_RANK[b.plan_name] ?? 99));

    // Plan distribution — point-in-time count of customers per plan. Not
    // scoped by the date range (customers are a "current state" thing, not
    // an event). Includes a "(no plan)" bucket via LEFT JOIN for customers
    // whose plan_id is null. Sorted in business order (free → paid → unknown).
    const PLAN_ORDER = { free: 0, basic: 1, moderate: 2, premium: 3 };
    const [planCountsRaw] = await pool.query(
      `SELECT p.name AS plan_name, COUNT(*) AS count
       FROM customers c
       LEFT JOIN plans p ON p.id = c.plan_id
       GROUP BY p.name`
    );
    const planCounts = planCountsRaw
      .map(r => ({ plan_name: r.plan_name, count: Number(r.count) }))
      .sort((a, b) => (PLAN_ORDER[a.plan_name] ?? 99) - (PLAN_ORDER[b.plan_name] ?? 99));

    // KPI strip: total / free / paid customer counts + new conversions in
    // range. "Conversion" = customer's first paid invoice fell inside the
    // selected date window. Best proxy we have without a plan-change history
    // table — accurately captures real money-in events.
    const [[custStats]] = await pool.query(
      `SELECT
         COUNT(*) AS total_customers,
         SUM(CASE WHEN p.name = 'free' THEN 1 ELSE 0 END) AS free_customers,
         SUM(CASE WHEN p.name IN ('basic','moderate','premium') THEN 1 ELSE 0 END) AS paid_customers,
         SUM(CASE WHEN p.name IS NULL THEN 1 ELSE 0 END) AS no_plan_customers
       FROM customers c
       LEFT JOIN plans p ON p.id = c.plan_id`
    );

    // Conversions in the selected range — customer's first PAID plan-change
    // event (upgrade/renewal/manual_admin with amount_paid > 0) fell inside
    // the selected window. Switched from invoice-based to plan_change_history
    // so this captures Razorpay payments and admin manual renewals (which is
    // every real money-in event the panel knows about), not just rows that
    // happen to exist in the invoices table.
    const conversionsParams = [];
    let conversionsRangeSql = '';
    if (from || to) {
      const re = /^\d{4}-\d{2}-\d{2}$/;
      if (re.test(from)) { conversionsRangeSql += ' AND first_paid_at >= ?'; conversionsParams.push(`${from} 00:00:00`); }
      if (re.test(to))   { conversionsRangeSql += ' AND first_paid_at <= ?'; conversionsParams.push(`${to} 23:59:59`); }
    }
    const [[conv]] = await pool.query(
      `SELECT COUNT(*) AS count FROM (
         SELECT customer_id, MIN(created_at) AS first_paid_at
         FROM plan_change_history
         WHERE amount_paid IS NOT NULL AND amount_paid > 0
         GROUP BY customer_id
       ) firsts WHERE 1=1${conversionsRangeSql}`,
      conversionsParams
    );

    const kpis = {
      totalCustomers:    Number(custStats.total_customers || 0),
      freeCustomers:     Number(custStats.free_customers || 0),
      paidCustomers:     Number(custStats.paid_customers || 0),
      noPlanCustomers:   Number(custStats.no_plan_customers || 0),
      conversionsInRange: Number(conv.count || 0),
    };

    res.json({ monthly, byPlan, summary, planCounts, kpis, arrBreakdown, arrByPlan });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.getUsageReport = async (req, res) => {
  try {
    // Read directly from the live tables (tickets / calls / chats), not from
    // the *_usage aggregate tables. Those aggregate tables are quota counters
    // — they're only incremented in specific business paths (agent answered
    // the call, chat counted against monthly limit), so they materially
    // under-count real activity. For a "how busy were we" report, the right
    // signal is every event that actually happened.
    const { from, to } = req.query;
    const drBare = dateRangeWhere(from, to, 'created_at');

    const [ticketUsage] = await pool.query(
      `SELECT DATE_FORMAT(created_at, '%Y-%m') AS month_year, COUNT(*) AS total_tickets
       FROM tickets WHERE 1=1${drBare.sql}
       GROUP BY month_year ORDER BY month_year DESC LIMIT 12`,
      drBare.params
    );
    const [callUsage] = await pool.query(
      `SELECT DATE_FORMAT(created_at, '%Y-%m') AS month_year, COUNT(*) AS total_calls
       FROM calls WHERE 1=1${drBare.sql}
       GROUP BY month_year ORDER BY month_year DESC LIMIT 12`,
      drBare.params
    );
    const [chatUsage] = await pool.query(
      `SELECT DATE_FORMAT(created_at, '%Y-%m') AS month_year, COUNT(*) AS total_chats
       FROM chats WHERE 1=1${drBare.sql}
       GROUP BY month_year ORDER BY month_year DESC LIMIT 12`,
      drBare.params
    );

    // Top-customers: prefer the current month IF it has data, otherwise fall
    // back to the most recent month with tickets. Surfacing `displayMonth` lets
    // the UI label which month is actually displayed.
    const currentMonth = new Date().toISOString().slice(0, 7);
    const displayMonth = (() => {
      const has = ticketUsage.find(t => t.month_year === currentMonth);
      if (has) return currentMonth;
      return ticketUsage.length ? ticketUsage[0].month_year : currentMonth;
    })();

    // Top customers — when the admin has a date range set, ignore displayMonth
    // and use the range. Otherwise fall back to per-month view as before.
    const trDr = dateRangeWhere(from, to, 't.created_at');
    const topCustomersSql = (from || to)
      ? `SELECT c.id AS customer_id, u.name, c.domain, p.name AS plan_name,
                COUNT(t.id) AS tickets_this_month
         FROM tickets t
         JOIN customers c ON c.id = t.customer_id
         JOIN users u     ON u.id = c.user_id
         LEFT JOIN plans p ON p.id = c.plan_id
         WHERE 1=1${trDr.sql}
         GROUP BY c.id, u.name, c.domain, p.name
         ORDER BY tickets_this_month DESC LIMIT 10`
      : `SELECT c.id AS customer_id, u.name, c.domain, p.name AS plan_name,
                COUNT(t.id) AS tickets_this_month
         FROM tickets t
         JOIN customers c ON c.id = t.customer_id
         JOIN users u     ON u.id = c.user_id
         LEFT JOIN plans p ON p.id = c.plan_id
         WHERE DATE_FORMAT(t.created_at, '%Y-%m') = ?
         GROUP BY c.id, u.name, c.domain, p.name
         ORDER BY tickets_this_month DESC LIMIT 10`;
    const [topCustomers] = await pool.query(
      topCustomersSql,
      (from || to) ? trDr.params : [displayMonth]
    );

    res.json({ ticketUsage, callUsage, chatUsage, topCustomers, displayMonth });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ── Reports drill-down ──────────────────────────────────────────────────────
// Powers the click-into-details modals on the Reports page. Each endpoint
// accepts a small whitelist of filters (status, priority, plan, agent_id,
// month, request_type, sla_met) and returns the matching rows. Keeping these
// separate from the chart-aggregation endpoints lets the chart and the drill
// modal share filter semantics without one having to re-derive the other.

function safeMonth(s) {
  // Accept YYYY-MM only — guards the LIKE pattern below.
  if (typeof s !== 'string') return null;
  return /^\d{4}-\d{2}$/.test(s) ? s : null;
}

// Validate a YYYY-MM-DD date string and turn `from`/`to` query params into a
// SQL fragment + bind values. Returns `{ sql: '', params: [] }` if neither is
// supplied (so callers can blindly concat the fragment). `column` is the
// alias-qualified date column to compare against, e.g. 't.created_at'.
function dateRangeWhere(from, to, column) {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  const f = re.test(from) ? from : null;
  const t = re.test(to)   ? to   : null;
  const parts = [];
  const params = [];
  if (f) { parts.push(`${column} >= ?`);                params.push(`${f} 00:00:00`); }
  if (t) { parts.push(`${column} <= ?`);                params.push(`${t} 23:59:59`); }
  return { sql: parts.length ? (' AND ' + parts.join(' AND ')) : '', params };
}

exports.getReportTickets = async (req, res) => {
  try {
    const { status, priority, plan, agent_id, customer_id, month, request_type,
            sla_met, no_plan, no_agent, from, to, group_by } = req.query;
    const where = ['1=1'];
    const params = [];
    if (status)       { where.push('t.status = ?');               params.push(status); }
    if (priority)     { where.push('t.priority = ?');             params.push(priority); }
    if (plan)         { where.push('p.name = ?');                 params.push(plan); }
    if (agent_id)     { where.push('t.assigned_agent_id = ?');    params.push(agent_id); }
    if (customer_id)  { where.push('t.customer_id = ?');          params.push(customer_id); }
    if (request_type) { where.push('t.request_type = ?');         params.push(request_type); }
    // "Missing-bucket" filters that line up with the chart's NULL groups —
    // no_plan = tickets whose customer has no plan link; no_agent = tickets
    // with no assigned agent (closed-without-assignment).
    if (no_plan === 'true')  { where.push('p.id IS NULL'); }
    if (no_agent === 'true') { where.push('t.assigned_agent_id IS NULL'); }
    const m = safeMonth(month);
    if (m)            { where.push("DATE_FORMAT(t.created_at, '%Y-%m') = ?"); params.push(m); }
    if (sla_met === 'true') {
      where.push("t.status = 'closed' AND t.sla_resolve_due IS NOT NULL AND t.closed_at <= t.sla_resolve_due");
    } else if (sla_met === 'false') {
      where.push("t.status = 'closed' AND t.sla_resolve_due IS NOT NULL AND t.closed_at > t.sla_resolve_due");
    }
    // Apply the page-level date range to the WHERE chain.
    const dr = dateRangeWhere(from, to, 't.created_at');
    if (dr.sql) { where.push(dr.sql.replace(/^ AND /, '')); params.push(...dr.params); }

    // group_by=customer / group_by=agent → return aggregated counts instead of
    // individual records. Same WHERE filters apply. Keeps the LEFT JOINs so
    // the "(no customer)" / "(unassigned)" buckets stay visible just like the
    // chart itself does.
    if (group_by === 'customer') {
      const [rows] = await pool.query(
        `SELECT t.customer_id, u.name AS customer_name, c.domain, p.name AS plan_name,
                COUNT(*) AS count
         FROM tickets t
         LEFT JOIN customers c ON c.id = t.customer_id
         LEFT JOIN users u     ON u.id = c.user_id
         LEFT JOIN plans p     ON p.id = c.plan_id
         LEFT JOIN users ag    ON ag.id = t.assigned_agent_id
         WHERE ${where.join(' AND ')}
         GROUP BY t.customer_id, u.name, c.domain, p.name
         ORDER BY count DESC
         LIMIT 100`,
        params
      );
      return res.json({ groups: rows, total: rows.length, group_by });
    }
    if (group_by === 'agent') {
      const [rows] = await pool.query(
        `SELECT t.assigned_agent_id AS agent_id, ag.name AS agent_name,
                COUNT(*) AS count
         FROM tickets t
         LEFT JOIN customers c ON c.id = t.customer_id
         LEFT JOIN users u     ON u.id = c.user_id
         LEFT JOIN plans p     ON p.id = c.plan_id
         LEFT JOIN users ag    ON ag.id = t.assigned_agent_id
         WHERE ${where.join(' AND ')}
         GROUP BY t.assigned_agent_id, ag.name
         ORDER BY count DESC
         LIMIT 100`,
        params
      );
      return res.json({ groups: rows, total: rows.length, group_by });
    }

    const [rows] = await pool.query(
      `SELECT t.id, t.subject, t.status, t.priority, t.request_type,
              t.created_at, t.closed_at, t.sla_resolve_due,
              u.name  AS customer_name, u.email AS customer_email,
              c.domain,
              p.name  AS plan_name,
              ag.name AS agent_name
       FROM tickets t
       LEFT JOIN customers c ON c.id = t.customer_id
       LEFT JOIN users u     ON u.id = c.user_id
       LEFT JOIN plans p     ON p.id = c.plan_id
       LEFT JOIN users ag    ON ag.id = t.assigned_agent_id
       WHERE ${where.join(' AND ')}
       ORDER BY t.created_at DESC
       LIMIT 500`,
      params
    );
    res.json({ tickets: rows, total: rows.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.getReportInvoices = async (req, res) => {
  try {
    const { status, plan, month, from, to } = req.query;
    const where = ['1=1'];
    const params = [];
    if (status) { where.push('i.status = ?'); params.push(status); }
    if (plan)   { where.push('p.name = ?');   params.push(plan); }
    const m = safeMonth(month);
    if (m)      { where.push("DATE_FORMAT(i.created_at, '%Y-%m') = ?"); params.push(m); }
    const dr = dateRangeWhere(from, to, 'i.created_at');
    if (dr.sql) { where.push(dr.sql.replace(/^ AND /, '')); params.push(...dr.params); }

    const [rows] = await pool.query(
      `SELECT i.id, i.final_price, i.subtotal, i.gst_amount, i.status,
              i.created_at, i.due_date,
              p.name AS plan_name,
              u.name AS customer_name,
              u.email AS customer_email,
              c.domain
       FROM invoices i
       LEFT JOIN plans p     ON p.id = i.plan_id
       LEFT JOIN customers c ON c.id = i.customer_id
       LEFT JOIN users u     ON u.id = c.user_id
       WHERE ${where.join(' AND ')}
       ORDER BY i.created_at DESC
       LIMIT 500`,
      params
    );
    res.json({ invoices: rows, total: rows.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.getReportAgents = async (req, res) => {
  try {
    const { role, status, skill_tag, from, to } = req.query;
    const where = ["u.role IN ('agent','admin')"];
    const params = [];
    if (role === 'agent' || role === 'admin') { where.push('u.role = ?'); params.push(role); }
    if (status === 'active')   { where.push('u.is_active = 1'); }
    if (status === 'inactive') { where.push('u.is_active = 0'); }

    // The per-agent computed counts (tickets resolved, chats handled, calls
    // answered, avg CSAT) are scoped to the page-level date range when one
    // is provided. Range is applied inside each correlated subquery so the
    // numbers reflect "what did this agent do during this window."
    const re = /^\d{4}-\d{2}-\d{2}$/;
    const f = re.test(from) ? `${from} 00:00:00` : null;
    const t = re.test(to)   ? `${to} 23:59:59`   : null;
    const dateClause = (col) => {
      if (!f && !t) return '';
      const parts = [];
      if (f) parts.push(`${col} >= ?`);
      if (t) parts.push(`${col} <= ?`);
      return ' AND ' + parts.join(' AND ');
    };
    const dateParams = () => [f, t].filter(Boolean);

    // Build the SELECT — three correlated subqueries + AVG over ratings.
    const sql = `
      SELECT u.id, u.name, u.email, u.role, u.is_active, u.skill_tags,
             (SELECT COUNT(*) FROM tickets t
                WHERE t.assigned_agent_id = u.id AND t.status = 'closed'
                ${dateClause('t.created_at')}) AS tickets_resolved,
             (SELECT COUNT(*) FROM chats ch
                WHERE ch.agent_id = u.id AND ch.status = 'closed'
                ${dateClause('ch.created_at')}) AS chats_handled,
             (SELECT COUNT(*) FROM calls ca
                WHERE ca.agent_id = u.id AND ca.status = 'ended'
                ${dateClause('ca.created_at')}) AS calls_answered,
             (SELECT ROUND(AVG(score), 2) FROM ratings r
                WHERE r.agent_id = u.id ${dateClause('r.created_at')}) AS avg_csat
      FROM users u
      WHERE ${where.join(' AND ')}
      ORDER BY tickets_resolved DESC, u.name ASC
      LIMIT 500
    `;
    // Subquery params: tickets / chats / calls / ratings — each consumes the
    // same date-range params in the same order.
    const fullParams = [
      ...dateParams(), ...dateParams(), ...dateParams(), ...dateParams(),
      ...params,
    ];
    let [rows] = await pool.query(sql, fullParams);

    // Optional skill-tag filter — applied post-query because skill_tags is
    // a JSON column. Treat empty filter as "no constraint."
    if (skill_tag && skill_tag.trim()) {
      const tag = skill_tag.trim();
      rows = rows.filter(r => {
        let tags = [];
        try { tags = typeof r.skill_tags === 'string' ? JSON.parse(r.skill_tags) : (r.skill_tags || []); } catch {}
        return Array.isArray(tags) && tags.includes(tag);
      });
    }

    // Stringify skill_tags so the CSV / table renders something readable.
    rows = rows.map(r => ({
      ...r,
      skill_tags: (() => {
        let tags = [];
        try { tags = typeof r.skill_tags === 'string' ? JSON.parse(r.skill_tags) : (r.skill_tags || []); } catch {}
        return Array.isArray(tags) && tags.length ? tags.join(', ') : '';
      })(),
      status_label: r.is_active ? 'Active' : 'Inactive',
    }));

    res.json({ agents: rows, total: rows.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.getReportCustomers = async (req, res) => {
  try {
    const { plan, plan_group, no_plan, converted_from, converted_to } = req.query;
    const where = ['1=1'];
    const params = [];
    if (plan)                  { where.push('p.name = ?'); params.push(plan); }
    if (plan_group === 'paid') { where.push("p.name IN ('basic','moderate','premium')"); }
    if (plan_group === 'free') { where.push("p.name = 'free'"); }
    if (no_plan === 'true')    { where.push('p.id IS NULL'); }

    // "Converted in range" — customer's first paid invoice fell in
    // [converted_from, converted_to]. Implemented via a join against the
    // first-paid-per-customer subquery so each customer appears once.
    const re = /^\d{4}-\d{2}-\d{2}$/;
    const cf = re.test(converted_from) ? converted_from : null;
    const ct = re.test(converted_to)   ? converted_to   : null;
    let firstPaidJoin = '';
    if (cf || ct) {
      firstPaidJoin = `JOIN (
        SELECT customer_id, MIN(created_at) AS first_paid_at
        FROM invoices WHERE status = 'paid' GROUP BY customer_id
      ) fp ON fp.customer_id = c.id`;
      if (cf) { where.push('fp.first_paid_at >= ?'); params.push(`${cf} 00:00:00`); }
      if (ct) { where.push('fp.first_paid_at <= ?'); params.push(`${ct} 23:59:59`); }
    }

    const [rows] = await pool.query(
      `SELECT c.id, c.domain, c.created_at, c.plan_expiry,
              u.name AS customer_name, u.email,
              p.name AS plan_name
       FROM customers c
       LEFT JOIN users u ON u.id = c.user_id
       LEFT JOIN plans p ON p.id = c.plan_id
       ${firstPaidJoin}
       WHERE ${where.join(' AND ')}
       ORDER BY c.created_at DESC
       LIMIT 500`,
      params
    );
    res.json({ customers: rows, total: rows.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.getReportChats = async (req, res) => {
  try {
    const { month, agent_id, customer_id, status, from, to, group_by } = req.query;
    const where = ['1=1'];
    const params = [];
    if (agent_id)    { where.push('ch.agent_id = ?');    params.push(agent_id); }
    if (customer_id) { where.push('ch.customer_id = ?'); params.push(customer_id); }
    if (status)      { where.push('ch.status = ?');      params.push(status); }
    const m = safeMonth(month);
    if (m)           { where.push("DATE_FORMAT(ch.created_at, '%Y-%m') = ?"); params.push(m); }
    const dr = dateRangeWhere(from, to, 'ch.created_at');
    if (dr.sql) { where.push(dr.sql.replace(/^ AND /, '')); params.push(...dr.params); }

    if (group_by === 'customer') {
      const [rows] = await pool.query(
        `SELECT ch.customer_id, u.name AS customer_name, c.domain, COUNT(*) AS count
         FROM chats ch
         LEFT JOIN customers c ON c.id = ch.customer_id
         LEFT JOIN users u     ON u.id = c.user_id
         LEFT JOIN users ag    ON ag.id = ch.agent_id
         WHERE ${where.join(' AND ')}
         GROUP BY ch.customer_id, u.name, c.domain
         ORDER BY count DESC LIMIT 100`,
        params
      );
      return res.json({ groups: rows, total: rows.length, group_by });
    }
    if (group_by === 'agent') {
      const [rows] = await pool.query(
        `SELECT ch.agent_id, ag.name AS agent_name, COUNT(*) AS count
         FROM chats ch
         LEFT JOIN customers c ON c.id = ch.customer_id
         LEFT JOIN users u     ON u.id = c.user_id
         LEFT JOIN users ag    ON ag.id = ch.agent_id
         WHERE ${where.join(' AND ')}
         GROUP BY ch.agent_id, ag.name
         ORDER BY count DESC LIMIT 100`,
        params
      );
      return res.json({ groups: rows, total: rows.length, group_by });
    }

    const [rows] = await pool.query(
      `SELECT ch.id, ch.status, ch.category, ch.department,
              ch.created_at, ch.accepted_at, ch.closed_at,
              u.name  AS customer_name,
              c.domain,
              ag.name AS agent_name
       FROM chats ch
       LEFT JOIN customers c ON c.id = ch.customer_id
       LEFT JOIN users u     ON u.id = c.user_id
       LEFT JOIN users ag    ON ag.id = ch.agent_id
       WHERE ${where.join(' AND ')}
       ORDER BY ch.created_at DESC
       LIMIT 500`,
      params
    );
    res.json({ chats: rows, total: rows.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.getReportCalls = async (req, res) => {
  try {
    const { month, agent_id, customer_id, status, from, to, group_by } = req.query;
    const where = ['1=1'];
    const params = [];
    if (agent_id)    { where.push('ca.agent_id = ?');    params.push(agent_id); }
    if (customer_id) { where.push('ca.customer_id = ?'); params.push(customer_id); }
    if (status)      { where.push('ca.status = ?');      params.push(status); }
    const m = safeMonth(month);
    if (m)           { where.push("DATE_FORMAT(ca.created_at, '%Y-%m') = ?"); params.push(m); }
    const dr = dateRangeWhere(from, to, 'ca.created_at');
    if (dr.sql) { where.push(dr.sql.replace(/^ AND /, '')); params.push(...dr.params); }

    if (group_by === 'customer') {
      const [rows] = await pool.query(
        `SELECT ca.customer_id, u.name AS customer_name, c.domain, COUNT(*) AS count
         FROM calls ca
         LEFT JOIN customers c ON c.id = ca.customer_id
         LEFT JOIN users u     ON u.id = c.user_id
         LEFT JOIN users ag    ON ag.id = ca.agent_id
         WHERE ${where.join(' AND ')}
         GROUP BY ca.customer_id, u.name, c.domain
         ORDER BY count DESC LIMIT 100`,
        params
      );
      return res.json({ groups: rows, total: rows.length, group_by });
    }
    if (group_by === 'agent') {
      const [rows] = await pool.query(
        `SELECT ca.agent_id, ag.name AS agent_name, COUNT(*) AS count
         FROM calls ca
         LEFT JOIN customers c ON c.id = ca.customer_id
         LEFT JOIN users u     ON u.id = c.user_id
         LEFT JOIN users ag    ON ag.id = ca.agent_id
         WHERE ${where.join(' AND ')}
         GROUP BY ca.agent_id, ag.name
         ORDER BY count DESC LIMIT 100`,
        params
      );
      return res.json({ groups: rows, total: rows.length, group_by });
    }

    const [rows] = await pool.query(
      `SELECT ca.id, ca.virtual_number, ca.status, ca.duration,
              ca.initiated_by, ca.created_at, ca.call_start_time, ca.call_end_time,
              u.name  AS customer_name,
              c.domain,
              ag.name AS agent_name
       FROM calls ca
       LEFT JOIN customers c ON c.id = ca.customer_id
       LEFT JOIN users u     ON u.id = c.user_id
       LEFT JOIN users ag    ON ag.id = ca.agent_id
       WHERE ${where.join(' AND ')}
       ORDER BY ca.created_at DESC
       LIMIT 500`,
      params
    );
    res.json({ calls: rows, total: rows.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ── Custom Reports ──────────────────────────────────────────────────────────
// CRUD for the admin-built saved reports that appear on the Reports →
// Custom Reports tab. Shared visibility (no owner filter on list/get) —
// every admin sees every saved report. `filters` and `columns` are JSON
// blobs that drive the drill-down execution.

const VALID_RESOURCES = new Set(['tickets', 'invoices', 'calls', 'chats', 'customers', 'agents']);

exports.listCustomReports = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT cr.id, cr.name, cr.resource, cr.filters, cr.columns,
              cr.created_by, cr.created_at, cr.updated_at,
              u.name AS created_by_name
       FROM custom_reports cr
       LEFT JOIN users u ON u.id = cr.created_by
       ORDER BY cr.updated_at DESC`
    );
    res.json({ reports: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.createCustomReport = async (req, res) => {
  try {
    const { name, resource, filters, columns } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
    if (!VALID_RESOURCES.has(resource)) return res.status(400).json({ error: 'Invalid resource' });
    if (!Array.isArray(columns) || columns.length === 0) return res.status(400).json({ error: 'At least one column required' });
    if (filters && typeof filters !== 'object') return res.status(400).json({ error: 'filters must be an object' });

    const [result] = await pool.query(
      `INSERT INTO custom_reports (name, resource, filters, columns, created_by)
       VALUES (?, ?, ?, ?, ?)`,
      [name.trim(), resource, JSON.stringify(filters || {}), JSON.stringify(columns), req.user.id]
    );
    const [[row]] = await pool.query(
      `SELECT cr.*, u.name AS created_by_name
       FROM custom_reports cr LEFT JOIN users u ON u.id = cr.created_by
       WHERE cr.id = ?`,
      [result.insertId]
    );
    res.status(201).json({ report: row });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.updateCustomReport = async (req, res) => {
  try {
    const { name, filters, columns } = req.body;
    const updates = [];
    const params = [];
    if (name !== undefined) {
      if (!name || !name.trim()) return res.status(400).json({ error: 'Name cannot be empty' });
      updates.push('name = ?'); params.push(name.trim());
    }
    if (filters !== undefined) {
      if (typeof filters !== 'object') return res.status(400).json({ error: 'filters must be an object' });
      updates.push('filters = ?'); params.push(JSON.stringify(filters));
    }
    if (columns !== undefined) {
      if (!Array.isArray(columns) || columns.length === 0) return res.status(400).json({ error: 'At least one column required' });
      updates.push('columns = ?'); params.push(JSON.stringify(columns));
    }
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
    params.push(req.params.id);

    await pool.query(
      `UPDATE custom_reports SET ${updates.join(', ')}, updated_at = NOW() WHERE id = ?`,
      params
    );
    const [[row]] = await pool.query(
      `SELECT cr.*, u.name AS created_by_name
       FROM custom_reports cr LEFT JOIN users u ON u.id = cr.created_by
       WHERE cr.id = ?`,
      [req.params.id]
    );
    if (!row) return res.status(404).json({ error: 'Report not found' });
    res.json({ report: row });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.deleteCustomReport = async (req, res) => {
  try {
    const [result] = await pool.query('DELETE FROM custom_reports WHERE id = ?', [req.params.id]);
    if (!result.affectedRows) return res.status(404).json({ error: 'Report not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// Convenience endpoint: fetch a saved report's count for the dashboard card.
// Reuses the existing drill controllers via a small in-process dispatch.
exports.getCustomReportCount = async (req, res) => {
  try {
    const [[row]] = await pool.query(
      'SELECT id, resource, filters FROM custom_reports WHERE id = ?',
      [req.params.id]
    );
    if (!row) return res.status(404).json({ error: 'Report not found' });
    const filters = typeof row.filters === 'string' ? JSON.parse(row.filters) : row.filters;
    // Forward to the matching drill handler — same code path, ensures
    // count + records stay consistent. The handler reads from req.query so
    // we just merge filters in via a shadow query object.
    const drillReq = Object.create(req);
    drillReq.query = { ...req.query, ...filters };
    const drillRes = {
      _data: null,
      _status: 200,
      status(c) { this._status = c; return this; },
      json(d) { this._data = d; return this; },
    };
    const fn = ({
      tickets:   exports.getReportTickets,
      invoices:  exports.getReportInvoices,
      calls:     exports.getReportCalls,
      chats:     exports.getReportChats,
      customers: exports.getReportCustomers,
      agents:    exports.getReportAgents,
    })[row.resource];
    if (!fn) return res.status(400).json({ error: 'Invalid resource on saved report' });
    await fn(drillReq, drillRes);
    if (drillRes._status >= 400) return res.status(drillRes._status).json(drillRes._data || {});
    const dataKey = row.resource; // tickets/invoices/calls/chats/customers
    const rows = drillRes._data?.[dataKey] || [];
    res.json({ count: rows.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ── Agent management ───────────────────────────────────────────────────────────

exports.getAgents = async (req, res) => {
  try {
    const [agents] = await pool.query(
      `SELECT u.id, u.name, u.email, u.role, u.is_active, u.created_at,
              u.skill_tags, u.on_break_until,
              (SELECT COUNT(*) FROM tickets WHERE assigned_agent_id = u.id AND status != 'closed') AS open_tickets,
              (SELECT COUNT(*) FROM chats WHERE agent_id = u.id AND status = 'active') AS active_chats,
              (SELECT COUNT(*) FROM tickets WHERE assigned_agent_id = u.id AND status = 'closed'
               AND DATE(updated_at) = CURDATE()) AS resolved_today,
              (SELECT COUNT(*) FROM tickets WHERE assigned_agent_id = u.id) AS total_tickets
       FROM users u WHERE u.role IN ('agent','admin') ORDER BY u.name`
    );
    // Normalize skill_tags JSON to an array
    agents.forEach(a => {
      try { a.skill_tags = typeof a.skill_tags === 'string' ? JSON.parse(a.skill_tags) : (a.skill_tags || []); } catch { a.skill_tags = []; }
    });
    res.json({ agents });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};

exports.updateAgentSkills = async (req, res) => {
  try {
    const { skill_tags } = req.body;
    if (!Array.isArray(skill_tags)) return res.status(400).json({ error: 'skill_tags must be an array' });
    const clean = skill_tags.map(t => String(t).trim()).filter(Boolean).slice(0, 20);
    await pool.query('UPDATE users SET skill_tags = ? WHERE id = ? AND role IN (?, ?)',
      [JSON.stringify(clean), req.params.id, 'agent', 'admin']);
    res.json({ skill_tags: clean });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};

exports.createAgent = async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password)
      return res.status(400).json({ error: 'Name, email and password are required' });

    // Role is optional and defaults to 'agent' for backward compatibility with
    // older callers. Only 'agent' or 'admin' are accepted here — any other value
    // is a client bug and we reject it rather than silently coercing.
    const newRole = role || 'agent';
    if (!['agent', 'admin'].includes(newRole))
      return res.status(400).json({ error: "Role must be either 'agent' or 'admin'" });

    const [existing] = await pool.query('SELECT id FROM users WHERE email = ?', [email]);
    if (existing.length) return res.status(409).json({ error: 'Email already in use' });

    const hashed = await bcrypt.hash(password, 10);
    const [result] = await pool.query(
      "INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)",
      [name, email, hashed, newRole]
    );
    const [[agent]] = await pool.query(
      'SELECT id, name, email, role, is_active, created_at FROM users WHERE id = ?',
      [result.insertId]
    );

    // Fire-and-forget welcome email with login credentials. Without this the agent
    // has no idea their account exists. Failure to send must NOT block account
    // creation — admin should still get a 201, just with an email_sent: false flag
    // so the UI can warn them to hand the creds over manually.
    let email_sent = false;
    try {
      await sendAgentWelcomeEmail({ to: email, name, password, role: newRole });
      email_sent = true;
    } catch (err) {
      console.error('[createAgent welcome email]', err.message);
    }

    res.status(201).json({ agent, email_sent });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.toggleAgent = async (req, res) => {
  try {
    const [[user]] = await pool.query(
      "SELECT id, is_active FROM users WHERE id = ? AND role IN ('agent','admin')",
      [req.params.id]
    );
    if (!user) return res.status(404).json({ error: 'Agent not found' });

    const newStatus = !user.is_active;
    await pool.query('UPDATE users SET is_active = ?, updated_at = NOW() WHERE id = ?', [newStatus, req.params.id]);
    res.json({ is_active: newStatus });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};

// PATCH /admin/agents/:id/role — promote an agent to admin or demote an admin
// back to agent. Two safety rails: an admin can't demote themselves (would lock
// them out of the panel mid-session), and the last active admin can't be
// demoted (would leave the system with no one able to manage it).
exports.changeAgentRole = async (req, res) => {
  try {
    const targetId = Number(req.params.id);
    const { role: newRole } = req.body;
    if (!['agent', 'admin'].includes(newRole))
      return res.status(400).json({ error: "Role must be either 'agent' or 'admin'" });

    const [[user]] = await pool.query(
      "SELECT id, name, email, role, is_active FROM users WHERE id = ? AND role IN ('agent','admin')",
      [targetId]
    );
    if (!user) return res.status(404).json({ error: 'Agent not found' });

    if (user.role === newRole)
      return res.status(400).json({ error: `User is already ${newRole === 'admin' ? 'an admin' : 'an agent'}` });

    // Refuse self-demotion. Promotion of self isn't possible (caller is already admin),
    // but demotion of self would kick the caller out of admin routes immediately.
    if (user.id === req.user.id && newRole === 'agent')
      return res.status(400).json({ error: "You can't demote your own admin account from here." });

    // Don't leave the system without an active admin.
    if (user.role === 'admin' && newRole === 'agent') {
      const [[{ active_admins }]] = await pool.query(
        "SELECT COUNT(*) AS active_admins FROM users WHERE role = 'admin' AND is_active = 1 AND id != ?",
        [targetId]
      );
      if (active_admins === 0)
        return res.status(400).json({ error: 'Cannot demote the last active admin.' });
    }

    await pool.query('UPDATE users SET role = ?, updated_at = NOW() WHERE id = ?', [newRole, targetId]);

    _audit(req, {
      action: newRole === 'admin' ? 'agent.promoted_to_admin' : 'agent.demoted_to_agent',
      entityType: 'user',
      entityId: targetId,
      oldValue: user.role,
      newValue: newRole,
    });

    res.json({ id: targetId, role: newRole });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// DELETE /admin/agents/:id — permanently remove an agent.
// Their assigned tickets / chats / calls are KEPT but the agent_id is nullified,
// so customer data isn't lost when an agent leaves the team. Refuses to delete
// the last admin or anyone currently mid-call/mid-chat.
exports.deleteAgent = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const agentId = Number(req.params.id);

    const [[user]] = await conn.query(
      "SELECT id, name, email, role, is_active FROM users WHERE id = ? AND role IN ('agent','admin')",
      [agentId]
    );
    if (!user) {
      conn.release();
      return res.status(404).json({ error: 'Agent not found' });
    }
    if (user.id === req.user.id) {
      conn.release();
      return res.status(400).json({ error: "You can't delete your own account from here." });
    }
    // Keep at least one active admin in the system.
    if (user.role === 'admin') {
      const [[{ active_admins }]] = await conn.query(
        "SELECT COUNT(*) AS active_admins FROM users WHERE role = 'admin' AND is_active = 1 AND id != ?",
        [agentId]
      );
      if (active_admins === 0) {
        conn.release();
        return res.status(400).json({ error: 'Cannot delete the last active admin.' });
      }
    }
    // Don't delete someone mid-call or mid-chat — their session would die mid-action.
    const [[{ active_chats }]] = await conn.query(
      "SELECT COUNT(*) AS active_chats FROM chats WHERE agent_id = ? AND status = 'active'",
      [agentId]
    );
    const [[{ active_calls }]] = await conn.query(
      "SELECT COUNT(*) AS active_calls FROM calls WHERE agent_id = ? AND status IN ('ringing','active')",
      [agentId]
    );
    if (active_chats > 0 || active_calls > 0) {
      conn.release();
      return res.status(409).json({
        error: `Agent has ${active_chats} active chat(s) and ${active_calls} live call(s). End those first, or set the agent to Offline.`,
      });
    }

    await conn.beginTransaction();
    try {
      // Preserve work — null out the agent_id on assigned rows. Customer-facing
      // history (ticket conversations, chat archive, call records) stays intact.
      const [tk] = await conn.query('UPDATE tickets SET assigned_agent_id = NULL WHERE assigned_agent_id = ?', [agentId]);
      const [ch] = await conn.query('UPDATE chats   SET agent_id = NULL WHERE agent_id = ?', [agentId]);
      const [cl] = await conn.query('UPDATE calls   SET agent_id = NULL WHERE agent_id = ?', [agentId]);
      // Some auxiliary tables also reference users; null them too so the user delete succeeds.
      // (failures here are swallowed — these are best-effort and missing tables shouldn't block deletion)
      try { await conn.query('UPDATE feedback_reports SET reviewed_by = NULL WHERE reviewed_by = ?', [agentId]); } catch {}
      try { await conn.query('UPDATE ticket_internal_notes SET author_id = NULL WHERE author_id = ?', [agentId]); } catch {}

      await conn.query('DELETE FROM users WHERE id = ?', [agentId]);
      await conn.commit();
      console.log(`[deleteAgent] ${user.email} removed by admin ${req.user.email} — reassigned ${tk.affectedRows} tickets, ${ch.affectedRows} chats, ${cl.affectedRows} calls`);
      res.json({
        ok: true,
        reassigned: {
          tickets: tk.affectedRows,
          chats: ch.affectedRows,
          calls: cl.affectedRows,
        },
      });
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  } catch (err) {
    console.error('[deleteAgent]', err);
    res.status(500).json({ error: err.message || 'Failed to delete agent' });
  } finally {
    conn.release();
  }
};

// DELETE /admin/customers/:id — permanently remove a customer + ALL their data.
// Unlike agents, customer data has no value once they leave (it's THEIR tickets,
// THEIR chats, THEIR calls). We cascade-delete in dependency order. The user row
// goes last; customers.user_id has ON DELETE CASCADE so the customer row drops
// with it.
exports.deleteCustomer = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const customerId = Number(req.params.id);
    const [[cust]] = await conn.query(
      `SELECT c.id, c.user_id, u.name, u.email
         FROM customers c JOIN users u ON u.id = c.user_id
        WHERE c.id = ?`,
      [customerId]
    );
    if (!cust) {
      conn.release();
      return res.status(404).json({ error: 'Customer not found' });
    }

    // Block deletion if they have a chat or call in progress — admin should end those first.
    const [[{ active_chats }]] = await conn.query(
      "SELECT COUNT(*) AS active_chats FROM chats WHERE customer_id = ? AND status IN ('waiting','active')",
      [customerId]
    );
    const [[{ active_calls }]] = await conn.query(
      "SELECT COUNT(*) AS active_calls FROM calls WHERE customer_id = ? AND status IN ('ringing','active')",
      [customerId]
    );
    if (active_chats > 0 || active_calls > 0) {
      conn.release();
      return res.status(409).json({
        error: `Customer has ${active_chats} active chat(s) and ${active_calls} live call(s). End those first.`,
      });
    }

    await conn.beginTransaction();
    try {
      // Gather counts for the audit reply.
      const [[{ ticket_count }]] = await conn.query('SELECT COUNT(*) AS ticket_count FROM tickets WHERE customer_id = ?', [customerId]);
      const [[{ chat_count }]]   = await conn.query('SELECT COUNT(*) AS chat_count   FROM chats   WHERE customer_id = ?', [customerId]);
      const [[{ call_count }]]   = await conn.query('SELECT COUNT(*) AS call_count   FROM calls   WHERE customer_id = ?', [customerId]);

      // Delete in dependency order. Most join tables have ON DELETE CASCADE on the
      // parent (ticket_messages → tickets, chat_messages → chats), so we only need
      // to drop the parents.
      await conn.query('DELETE FROM tickets WHERE customer_id = ?', [customerId]);
      await conn.query('DELETE FROM chats   WHERE customer_id = ?', [customerId]);
      await conn.query('DELETE FROM calls   WHERE customer_id = ?', [customerId]);
      // Auxiliary tables that don't cascade — best-effort cleanup.
      try { await conn.query('DELETE FROM ticket_usage WHERE customer_id = ?', [customerId]); } catch {}
      try { await conn.query('DELETE FROM chat_usage   WHERE customer_id = ?', [customerId]); } catch {}
      try { await conn.query('DELETE FROM call_usage   WHERE customer_id = ?', [customerId]); } catch {}
      try { await conn.query('DELETE FROM customer_tags WHERE customer_id = ?', [customerId]); } catch {}
      try { await conn.query('DELETE FROM customer_feature_overrides WHERE customer_id = ?', [customerId]); } catch {}
      try { await conn.query('UPDATE feedback_reports SET reporter_user_id = ? WHERE reporter_user_id = ?', [req.user.id, cust.user_id]); } catch {}

      // The user row delete cascades to customers via FK ON DELETE CASCADE.
      await conn.query('DELETE FROM users WHERE id = ?', [cust.user_id]);

      await conn.commit();
      console.log(`[deleteCustomer] ${cust.email} removed by admin ${req.user.email} — dropped ${ticket_count} tickets, ${chat_count} chats, ${call_count} calls`);
      res.json({
        ok: true,
        deleted: { tickets: ticket_count, chats: chat_count, calls: call_count },
      });
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  } catch (err) {
    console.error('[deleteCustomer]', err);
    res.status(500).json({ error: err.message || 'Failed to delete customer' });
  } finally {
    conn.release();
  }
};

exports.changeAgentPassword = async (req, res) => {
  try {
    const { password } = req.body;
    if (!password || password.length < 6)
      return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const [[user]] = await pool.query(
      "SELECT id FROM users WHERE id = ? AND role IN ('agent','admin')",
      [req.params.id]
    );
    if (!user) return res.status(404).json({ error: 'Agent not found' });

    const hashed = await bcrypt.hash(password, 10);
    await pool.query('UPDATE users SET password = ?, updated_at = NOW() WHERE id = ?', [hashed, req.params.id]);
    res.json({ message: 'Password updated successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};

exports.changeCustomerPassword = async (req, res) => {
  try {
    const { password } = req.body;
    if (!password || password.length < 6)
      return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const [[customer]] = await pool.query(
      'SELECT user_id FROM customers WHERE id = ?',
      [req.params.id]
    );
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const hashed = await bcrypt.hash(password, 10);
    await pool.query('UPDATE users SET password = ?, is_active = 1, updated_at = NOW() WHERE id = ?', [hashed, customer.user_id]);
    _audit(req, { action: 'password_changed', entityId: Number(req.params.id) });
    res.json({ message: 'Password updated successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};

// POST /api/admin/customers/:id/reset-usage
// Resets ticket, call, and chat usage counts for the current month.
//
// Calls + chats are computed live from the calls/chats tables and gated by
// customers.usage_reset_at — bumping that timestamp is the only thing that
// actually drops the dashboard counters. The legacy *_usage rows are kept in
// sync for any tooling still reading them, but they're not authoritative.
// Tickets still read from ticket_usage so we zero that row directly.
exports.resetCustomerUsage = async (req, res) => {
  try {
    const customerId = Number(req.params.id);
    const [[cRow]] = await pool.query('SELECT id, user_id FROM customers WHERE id = ?', [customerId]);
    if (!cRow) return res.status(404).json({ error: 'Customer not found' });

    const my = currentMonthYear();

    // Bump the cutoff — drops live call/chat counters to 0 immediately.
    await pool.query('UPDATE customers SET usage_reset_at = NOW() WHERE id = ?', [customerId]);

    // Tickets still read from the legacy counter table — zero the current month row.
    await pool.query(
      `INSERT INTO ticket_usage (customer_id, month_year, count) VALUES (?, ?, 0)
       ON DUPLICATE KEY UPDATE count = 0`,
      [customerId, my]
    );

    // Keep legacy call/chat counters in sync for any back-compat consumers.
    await pool.query(
      `INSERT INTO call_usage (customer_id, month_year, count) VALUES (?, ?, 0)
       ON DUPLICATE KEY UPDATE count = 0`,
      [customerId, my]
    );
    await pool.query(
      `INSERT INTO chat_usage (customer_id, month_year, count) VALUES (?, ?, 0)
       ON DUPLICATE KEY UPDATE count = 0`,
      [customerId, my]
    );

    // In-app nudge so the customer's dashboard refreshes without manual reload.
    const io = req.app.get('io');
    if (io) {
      io.to(`user_${cRow.user_id}`).emit('usage_reset', {
        reset_at: new Date().toISOString(),
      });
    }

    _audit(req, { action: 'usage_reset', entityId: customerId, newValue: { month: my } });
    res.json({ message: 'Usage reset successfully for current month' });
  } catch (err) {
    console.error('resetCustomerUsage error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ── Ticket management (admin full view) ───────────────────────────────────────

exports.getAllTickets = async (req, res) => {
  try {
    const { status, priority, agent_id, search, page = 1, limit = 25 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let where = 'WHERE 1=1';
    const params = [];
    if (status) { where += ' AND t.status = ?'; params.push(status); }
    if (priority) { where += ' AND t.priority = ?'; params.push(priority); }
    if (agent_id === 'unassigned') { where += ' AND t.assigned_agent_id IS NULL'; }
    else if (agent_id) { where += ' AND t.assigned_agent_id = ?'; params.push(agent_id); }
    if (search) {
      where += ' AND (t.subject LIKE ? OR cu.user_name LIKE ? OR cu.domain LIKE ?)';
      const s = `%${search}%`;
      params.push(s, s, s);
    }

    const [tickets] = await pool.query(
      `SELECT t.*,
              a.name AS agent_name,
              cu.user_name AS customer_name, cu.domain AS customer_domain, p.name AS plan_name
       FROM tickets t
       LEFT JOIN users a ON a.id = t.assigned_agent_id
       LEFT JOIN (SELECT c.id, usr.name AS user_name, c.domain, c.plan_id
                  FROM customers c JOIN users usr ON usr.id = c.user_id) cu ON cu.id = t.customer_id
       LEFT JOIN plans p ON p.id = cu.plan_id
       ${where}
       ORDER BY FIELD(t.priority,'high','medium','normal','low'), t.updated_at DESC
       LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );
    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM tickets t
       LEFT JOIN (SELECT c.id, usr.name AS user_name, c.domain
                  FROM customers c JOIN users usr ON usr.id = c.user_id) cu ON cu.id = t.customer_id
       ${where}`,
      params
    );
    res.json({ tickets, total, page: parseInt(page) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.updateAnyTicket = async (req, res) => {
  try {
    const { status, priority, assigned_agent_id } = req.body;
    const updates = [], params = [];
    if (status) { updates.push('status = ?'); params.push(status); }
    if (priority) { updates.push('priority = ?'); params.push(priority); }
    if (assigned_agent_id !== undefined) { updates.push('assigned_agent_id = ?'); params.push(assigned_agent_id || null); }
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });

    params.push(req.params.id);
    await pool.query(`UPDATE tickets SET ${updates.join(', ')}, updated_at = NOW() WHERE id = ?`, params);
    const [[ticket]] = await pool.query('SELECT * FROM tickets WHERE id = ?', [req.params.id]);
    res.json({ ticket });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};

// ── Chat management (admin full view) ─────────────────────────────────────────

exports.getAllChats = async (req, res) => {
  try {
    const { status } = req.query;
    let where = status ? 'WHERE ch.status = ?' : "WHERE ch.status IN ('waiting','active')";
    const params = status ? [status] : [];

    const [chats] = await pool.query(
      `SELECT ch.*, cu.name AS customer_name, cu.email AS customer_email,
              c.domain, p.name AS plan_name, a.name AS agent_name
       FROM chats ch
       JOIN customers c ON c.id = ch.customer_id
       JOIN users cu ON cu.id = c.user_id
       LEFT JOIN plans p ON p.id = c.plan_id
       LEFT JOIN users a ON a.id = ch.agent_id
       ${where}
       ORDER BY ch.created_at ASC`,
      params
    );
    res.json({ chats });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};

exports.assignChat = async (req, res) => {
  try {
    const { agent_id } = req.body;
    if (!agent_id) return res.status(400).json({ error: 'agent_id is required' });

    // Pull the customer name/domain in one shot so the agent's ring toast can
    // show who it's from. Without this the broadcast event has nothing useful
    // to render.
    const [[chat]] = await pool.query(
      `SELECT ch.id, ch.customer_id, ch.category, ch.status,
              cu.name AS customer_name, c.domain, p.name AS plan_name
       FROM chats ch
       JOIN customers c ON c.id = ch.customer_id
       JOIN users cu ON cu.id = c.user_id
       LEFT JOIN plans p ON p.id = c.plan_id
       WHERE ch.id = ? AND ch.status = 'waiting'`,
      [req.params.id]
    );
    if (!chat) return res.status(404).json({ error: 'Chat not found or not waiting' });

    const [[agent]] = await pool.query(
      "SELECT id, name FROM users WHERE id = ? AND role IN ('agent','admin') AND is_active = TRUE",
      [agent_id]
    );
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    // Admin only RESERVES the chat — they don't auto-activate it. Status stays
    // 'waiting', agent_id is set. The chat shows up in that one agent's
    // pending list (hidden from everyone else by getPendingChats' filter) and
    // they explicitly click Accept to start the conversation. Matches the
    // user's rule: "admin can only assign; agent will accept by herself."
    await pool.query(
      "UPDATE chats SET agent_id = ? WHERE id = ?",
      [agent_id, req.params.id]
    );

    if (req.io) {
      // Targeted emit to the assignee's user room — fires the same bell + ring
      // + toast the agent gets for any new pending chat, but only on their
      // socket. Other agents see nothing. NotificationBell and the agent
      // Chats page already listen for `new_chat_request` and update their
      // pending list, so no new frontend wiring needed.
      req.io.to(`user_${agent_id}`).emit('new_chat_request', {
        chatId: parseInt(req.params.id),
        customer: {
          customer_name: chat.customer_name,
          domain: chat.domain,
          plan_name: chat.plan_name,
          category: chat.category,
        },
      });
    }

    res.json({
      message: `Chat assigned to ${agent.name} — waiting for them to accept.`,
      agentName: agent.name,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.bulkUpdateTickets = async (req, res) => {
  try {
    const { ids, action, agent_id } = req.body;
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids array required' });
    if (!['close', 'assign'].includes(action)) return res.status(400).json({ error: 'action must be close or assign' });

    const io = req.app.get('io');
    const placeholders = ids.map(() => '?').join(',');

    if (action === 'close') {
      // Snapshot assignees BEFORE close so we can notify them
      const [prevRows] = await pool.query(
        `SELECT id, assigned_agent_id FROM tickets WHERE id IN (${placeholders})`,
        ids
      );
      await pool.query(
        `UPDATE tickets SET status = 'closed', closed_at = COALESCE(closed_at, NOW()), updated_at = NOW() WHERE id IN (${placeholders})`,
        ids
      );
      if (io) {
        for (const t of prevRows) {
          if (t.assigned_agent_id) {
            io.to(`user_${t.assigned_agent_id}`).emit('ticket_unassigned', {
              ticketId: t.id, reason: 'bulk_closed',
            });
          }
        }
      }
    } else {
      if (!agent_id) return res.status(400).json({ error: 'agent_id required for assign' });
      const [[newAgent]] = await pool.query("SELECT id, name FROM users WHERE id = ? AND role IN ('agent','admin')", [agent_id]);
      if (!newAgent) return res.status(404).json({ error: 'Agent not found' });

      // Snapshot previous owners + ticket+customer info BEFORE update. We also
      // grab the customer's user_id (to address their socket room) and the
      // outgoing agent's name (for the "transferred from X" notice).
      const [prevRows] = await pool.query(
        `SELECT t.id, t.assigned_agent_id, t.subject,
                u.id   AS customer_user_id,
                u.name AS customer_name,
                oa.name AS old_agent_name
         FROM tickets t
         LEFT JOIN customers c ON c.id = t.customer_id
         LEFT JOIN users u  ON u.id  = c.user_id
         LEFT JOIN users oa ON oa.id = t.assigned_agent_id
         WHERE t.id IN (${placeholders})`,
        ids
      );

      await pool.query(
        `UPDATE tickets SET assigned_agent_id = ?, updated_at = NOW() WHERE id IN (${placeholders})`,
        [agent_id, ...ids]
      );

      // Notify both old (unassign) and new (assign) owners so their UIs stay in sync.
      // Without this the old owner keeps seeing the ticket in their queue + receives
      // stale customer-reply notifications for a ticket they no longer own.
      if (io) {
        const newRoom = `user_${agent_id}`;
        for (const t of prevRows) {
          const oldOwnerId = t.assigned_agent_id;
          if (oldOwnerId && oldOwnerId !== agent_id) {
            io.to(`user_${oldOwnerId}`).emit('ticket_unassigned', {
              ticketId: t.id, reason: 'bulk_reassigned', newAgentId: agent_id, newAgentName: newAgent.name,
            });
          }
          if (oldOwnerId !== agent_id) {
            io.to(newRoom).emit('ticket_assigned', {
              ticketId: t.id,
              subject: t.subject,
              customerName: t.customer_name,
              reason: 'admin_bulk_reassign',
            });
          }
          // Tell the customer who they're now talking to. Only emit on a real
          // change of owner (initial assign is handled separately by the bell's
          // ticket_assigned_to_customer event for self-claim).
          if (t.customer_user_id && oldOwnerId && oldOwnerId !== agent_id) {
            io.to(`user_${t.customer_user_id}`).emit('ticket_transferred_to_customer', {
              ticketId: t.id,
              subject: t.subject,
              fromAgentName: t.old_agent_name || 'a colleague',
              newAgentName: newAgent.name,
            });
          }
        }
      }
    }
    res.json({ updated: ids.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.exportReportCsv = async (req, res) => {
  try {
    const { type = 'tickets', from, to } = req.query;
    let rows, headers;

    if (type === 'tickets') {
      const params = [];
      let where = 'WHERE 1=1';
      if (from) { where += ' AND t.created_at >= ?'; params.push(from); }
      if (to)   { where += ' AND t.created_at <= ?'; params.push(to + ' 23:59:59'); }

      [rows] = await pool.query(
        `SELECT t.id, t.subject, t.status, t.priority, t.created_at, t.updated_at,
                u.name AS customer_name, u.email AS customer_email,
                a.name AS agent_name
         FROM tickets t
         LEFT JOIN customers c ON c.id = t.customer_id
         LEFT JOIN users u ON u.id = c.user_id
         LEFT JOIN users a ON a.id = t.assigned_agent_id
         ${where} ORDER BY t.created_at DESC`,
        params
      );
      headers = ['id', 'subject', 'status', 'priority', 'created_at', 'updated_at', 'customer_name', 'customer_email', 'agent_name'];
    } else if (type === 'csat') {
      [rows] = await pool.query(
        `SELECT r.id, r.score, r.comment, r.created_at, u.name AS agent_name, c.domain
         FROM ratings r
         LEFT JOIN users u ON u.id = r.agent_id
         LEFT JOIN customers c ON c.id = r.customer_id
         ORDER BY r.created_at DESC`
      );
      headers = ['id', 'score', 'comment', 'created_at', 'agent_name', 'domain'];
    } else if (type === 'revenue') {
      [rows] = await pool.query(
        `SELECT i.id, p.name AS plan_name, i.final_price, i.subtotal, i.gst_amount,
                i.status, i.created_at, i.due_date,
                u.name AS customer_name, c.domain
         FROM invoices i
         LEFT JOIN plans p ON p.id = i.plan_id
         LEFT JOIN customers c ON c.id = i.customer_id
         LEFT JOIN users u ON u.id = c.user_id
         ORDER BY i.created_at DESC`
      );
      headers = ['id', 'plan_name', 'final_price', 'subtotal', 'gst_amount', 'status', 'created_at', 'due_date', 'customer_name', 'domain'];
    } else if (type === 'usage') {
      [rows] = await pool.query(
        `SELECT tu.month_year, u.name AS customer_name, c.domain,
                p.name AS plan_name, tu.count AS tickets_used,
                COALESCE(cu.count, 0) AS calls_used,
                COALESCE(chu.count, 0) AS chats_used
         FROM ticket_usage tu
         JOIN customers c ON c.id = tu.customer_id
         JOIN users u ON u.id = c.user_id
         LEFT JOIN plans p ON p.id = c.plan_id
         LEFT JOIN call_usage cu ON cu.customer_id = tu.customer_id AND cu.month_year = tu.month_year
         LEFT JOIN chat_usage chu ON chu.customer_id = tu.customer_id AND chu.month_year = tu.month_year
         ORDER BY tu.month_year DESC, tickets_used DESC`
      );
      headers = ['month_year', 'customer_name', 'domain', 'plan_name', 'tickets_used', 'calls_used', 'chats_used'];
    } else {
      return res.status(400).json({ error: 'type must be tickets, csat, revenue, or usage' });
    }

    const escape = v => {
      if (v == null) return '';
      const s = String(v);
      return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [headers.join(','), ...rows.map(r => headers.map(h => escape(r[h])).join(','))].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${type}_export_${Date.now()}.csv"`);
    res.send(csv);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ── Admin Settings ────────────────────────────────────────────────────────────
exports.getSettings = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT `key`, value FROM admin_settings');
    const settings = {};
    rows.forEach(r => { settings[r.key] = r.value; });

    // For SMTP fields the runtime falls back to env vars when admin_settings
    // is blank. Reflect that in the UI so admin sees what's ACTUALLY being
    // used right now (otherwise the card appears empty even though emails
    // work). When admin saves, the prefilled values get persisted to
    // admin_settings — a one-time, frictionless migration from env to DB.
    const envFallback = {
      smtp_host:     process.env.SMTP_HOST,
      smtp_port:     process.env.SMTP_PORT,
      smtp_user:     process.env.SMTP_USER,
      smtp_password: process.env.SMTP_PASS,
      smtp_from:     process.env.EMAIL_FROM,
      smtp_secure:   process.env.SMTP_SECURE,
      // Same env→DB reflection for the other runtime creds the admin can manage
      // from Settings (Cloudflare TURN for calls, Anthropic for the AI bot).
      anthropic_api_key:         process.env.ANTHROPIC_API_KEY,
      cloudflare_turn_key_id:    process.env.CLOUDFLARE_TURN_KEY_ID,
      cloudflare_turn_api_token: process.env.CLOUDFLARE_TURN_API_TOKEN,
    };
    for (const [k, v] of Object.entries(envFallback)) {
      if (!settings[k] && v !== undefined && v !== '') {
        settings[k] = v;
      }
    }
    res.json({ settings });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
};

const ALLOWED_SETTING_KEYS = new Set([
  'auto_close_days', 'queue_sla_minutes',
  'billing_api_url', 'billing_api_key', 'billing_webhook_secret',
  'razorpay_key_id', 'razorpay_key_secret',
  'work_hours_start', 'work_hours_end', 'work_hours_days',
  'assignment_mode', 'heavy_load_threshold', 'heavy_load_chat_threshold', 'heavy_load_call_threshold',
  'block_outside_work_hours',
  'auto_assign_enabled',
  'billing_extras_enabled',
  'min_billable_call_seconds',
  'max_short_cut_forgivals_per_month',
  // ── Renewal & expiry (Phase 4)
  'renewal_window_days',         // days before expiry when renewal/downgrade options open (default 30)
  'auto_lapse_to_free',          // '1' = expiryWorker auto-moves expired customers to Free (default '1')
  // ── SLA & Queue Alerts (slaWorker reads these)
  'ticket_warning_pct',          // alert agent when ticket reaches X% of SLA (default 80)
  'ticket_breach_action',        // 'escalate' | 'notify_admin' | 'both' | 'none' (default 'notify_admin')
  // ── SMTP config (overrides env vars when set — emailUtils picks the more
  // specific source: admin_settings → env → built-in default)
  'smtp_host',                   // e.g. 'smtp.gmail.com'
  'smtp_port',                   // 587 (STARTTLS) or 465 (TLS)
  'smtp_user',                   // SMTP username (usually the sender email)
  'smtp_password',               // SMTP password / app password — stored encrypted at rest if possible
  'smtp_from',                   // From: header, "Display Name <addr@domain>" form
  'smtp_secure',                 // '1' = implicit TLS (port 465); '0' = STARTTLS (port 587)
  // ── Runtime API credentials (admin_settings → env fallback; read live)
  'anthropic_api_key',           // Claude API key for the AI bot / KB search
  'cloudflare_turn_key_id',      // Cloudflare Realtime TURN key id (calls)
  'cloudflare_turn_api_token',   // Cloudflare Realtime TURN API token (calls)
  // ── Inbound email (IMAP poller picks these up via the settings cache)
  'inbound_enabled',             // '1' = poll the inbox + ingest; default '0' (must be turned on explicitly)
  'imap_host',                   // e.g. 'imap.gmail.com'
  'imap_port',                   // 993 (TLS) or 143 (STARTTLS)
  'imap_user',                   // usually support@yourdomain.com
  'imap_password',               // app password for the support inbox
  'imap_secure',                 // '1' = TLS (993); '0' = STARTTLS (143)
  'imap_mailbox',                // INBOX by default
  'support_email_address',       // the canonical support inbox address (used for outgoing Reply-To + sanity-check)
  'inbound_secret',              // secret used to compute the [Ticket #N-hash] verification hash; rotates to invalidate old tokens
  // ── Email defaults (emailUtils reads these)
  'reply_to_email',              // overrides Reply-To header on outgoing emails
  'bcc_email',                   // silent compliance BCC on every outgoing customer email
  'emails_disabled',             // '1' = swallow all outgoing email; useful during maintenance
  // ── Customer experience policy toggles
  'csat_after_chat',             // '1' = show CSAT survey after a chat ends (default '1')
  'csat_after_ticket',           // '1' = email CSAT survey after ticket close (default '1')
  'allow_chat_attachments',      // '1' = customers can attach files in chat (default '1')
  'chat_attachment_max_mb',      // max attachment size in MB (default 10)
  'chat_attachment_types',       // comma-separated extension list (default 'jpg,png,gif,pdf,doc,docx,txt,zip')
  'ticket_created_email_enabled',// '1' = send "ticket received" email on new ticket (default '1')
  // ── Security & access
  'admin_idle_timeout_minutes',  // auto-logout idle admins (default 30)
  'require_admin_2fa',           // '1' = enforce TOTP for admin role (placeholder until 2FA flow built)
  'admin_ip_allowlist',          // CSV of CIDRs / IPs gating ADMIN logins; empty = allow all
  'agent_ip_allowlist',          // CSV of CIDRs / IPs gating AGENT logins; empty = allow all
  'password_min_length',         // default 8
  'password_require_digit',      // '1' / '0'
  'password_require_symbol',     // '1' / '0'
  // ── Branding (white-labelling)
  'brand_sender_name',           // "From" name on outgoing emails — default "Anutech Support"
  'brand_footer_text',           // extra text at bottom of customer panel
  'brand_color',                 // hex color used for primary buttons / accents on customer side
  // ── Operations
  'maintenance_mode',            // '1' = customer endpoints return 503 + banner; admin still usable
  'maintenance_message',         // optional custom message shown to customers during maintenance
  'audit_retention_days',        // prune audit_log entries older than X days (default 180)
  // ── Channel kill switches
  'bot_widget_enabled',          // '1' = show in-app bot to customers (default '1')
  'calls_system_enabled',        // '1' = allow voice calls system-wide (default '1' — kill switch)
  'whatsapp_enabled',            // '1' = enable WhatsApp channel (placeholder, default '0')
]);

exports.updateSettings = async (req, res) => {
  try {
    const { settings } = req.body;
    if (!settings || typeof settings !== 'object')
      return res.status(400).json({ error: 'settings object required' });
    // Silently drop keys that aren't in the whitelist instead of rejecting the
    // whole payload. The frontend load() spreads everything the GET returns
    // into form state — including server-managed fields like
    // `billing_last_sync` — and then sends it all back on Save. Failing the
    // whole save because of a server-managed echo would block the admin from
    // updating real settings.
    const writable = {};
    const skipped = [];
    for (const [key, value] of Object.entries(settings)) {
      if (ALLOWED_SETTING_KEYS.has(key)) writable[key] = value;
      else skipped.push(key);
    }
    if (skipped.length) console.warn('[updateSettings] ignored read-only/unknown keys:', skipped.join(', '));

    for (const [key, value] of Object.entries(writable)) {
      await pool.query(
        'INSERT INTO admin_settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = ?',
        [key, String(value), String(value)]
      );
    }
    // Invalidate the routing-helper cache so changes take effect immediately
    try { require('../utils/assignment').invalidateSettingsCache(); } catch {}
    // Same for the generic settings cache used by emailUtils / maintenance
    // middleware / channel gates.
    try { require('../utils/settings').invalidateAllSettingsCache(); } catch {}
    // Force the SMTP transport to rebuild on next send so host/port/user
    // changes from the Settings UI take effect immediately.
    try { require('../utils/emailUtils').invalidateTransport?.(); } catch {}
    // TURN creds + Anthropic key can change here too — drop their caches so the
    // next call / AI request picks up the new value without a restart.
    try { require('../utils/turnUtils').invalidateTurnCache?.(); } catch {}
    try { require('../utils/aiKbUtils').invalidateAiClient?.(); } catch {}
    res.json({ message: 'Settings updated' });
  } catch (err) {
    console.error('updateSettings error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.getAdminTicketDetail = async (req, res) => {
  try {
    const [[ticket]] = await pool.query(
      `SELECT t.*, a.name AS agent_name,
              cu.user_name AS customer_name, cu.user_email AS customer_email,
              cu.domain AS customer_domain, p.name AS plan_name
       FROM tickets t
       LEFT JOIN users a ON a.id = t.assigned_agent_id
       LEFT JOIN (SELECT c.id, usr.name AS user_name, usr.email AS user_email, c.domain, c.plan_id
                  FROM customers c JOIN users usr ON usr.id = c.user_id) cu ON cu.id = t.customer_id
       LEFT JOIN plans p ON p.id = cu.plan_id
       WHERE t.id = ?`,
      [req.params.id]
    );
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

    const [messages] = await pool.query(
      `SELECT tm.*, u.name AS sender_name, u.role AS sender_role
       FROM ticket_messages tm JOIN users u ON u.id = tm.sender_id
       WHERE tm.ticket_id = ? ORDER BY tm.created_at ASC`,
      [req.params.id]
    );
    res.json({ ticket, messages });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};

// POST /admin/customers/lookup-billing — search billing app by email
exports.lookupBillingCustomer = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });

    const billingUrl = await getSetting('billing_api_url');
    const apiKey    = await getSetting('billing_api_key');
    if (!billingUrl) return res.status(400).json({ error: 'Billing app URL is not configured in Settings' });

    const url  = `${billingUrl.replace(/\/$/, '')}/api/customers?email=${encodeURIComponent(email)}&per_page=10`;
    const data = await fetchJson(url, apiKey);

    if (!data || !Array.isArray(data.customers)) {
      return res.status(502).json({ error: 'Billing app returned an unexpected response' });
    }

    const found = data.customers.find(c => c.email?.toLowerCase() === email.toLowerCase());
    if (!found) return res.status(404).json({ error: 'No customer found with that email in billing app' });

    res.json({ customer: found });
  } catch (err) {
    console.error('[Lookup Billing]', err.message);
    res.status(502).json({ error: err.message || 'Failed to search billing app' });
  }
};

// Internal helper — creates the onboarding ticket + tag + agent assignment for a
// customer. Used both at import time (when admin checks "needs onboarding") AND from
// the manual /start-onboarding endpoint (when admin decides later). Returns
// { onboarding_ticket_id, assigned_agent } so the caller can show a confirmation.
//
// Idempotent — if an open 'Onboarding —' ticket already exists for this customer, it
// returns the existing one rather than creating a duplicate.
//
// `preferredAgentId` (optional): when the admin picked a specific agent at import time
// (or in the Start Onboarding modal), use them directly instead of the pickAgent
// auto-router. We still validate the id resolves to a real agent/admin so a stale UI
// can't assign tickets to random user ids.
async function _startOnboarding({ customerId, customerName, adminId, io, preferredAgentId }) {
  const [[existing]] = await pool.query(
    `SELECT id, assigned_agent_id FROM tickets
     WHERE customer_id = ? AND subject LIKE 'Onboarding —%' AND status NOT IN ('closed','resolved')
     ORDER BY id DESC LIMIT 1`,
    [customerId]
  );
  if (existing) {
    const [[agent]] = existing.assigned_agent_id
      ? await pool.query('SELECT id, name FROM users WHERE id = ?', [existing.assigned_agent_id])
      : [[null]];
    return { onboarding_ticket_id: existing.id, assigned_agent: agent || null, reused_existing: true };
  }

  const subject = `Onboarding — set up support for ${customerName}`;
  const description =
`Welcome, ${customerName}! A few quick questions to get your support running:

1) Which email service are we setting up?
   • Google Workspace
   • Microsoft 365
   • Zoho Mail
   • Other (please specify)

2) What is your primary domain name?

3) How many user mailboxes do you need to start?

4) Are you migrating from another email provider? If yes — which one, and is there a cutover date you're targeting?

5) Any specific apps you'll use (Gmail / Drive / Meet / Outlook / Teams / etc.) or compliance needs (data residency, MFA policy, SSO)?

Reply on this ticket with the answers — or start a chat / call any time. An agent has been assigned and will reach out shortly.`;

  const [tIns] = await pool.query(
    `INSERT INTO tickets (customer_id, subject, description, status, priority)
     VALUES (?, ?, ?, 'open', 'normal')`,
    [customerId, subject, description]
  );

  let assignedAgent = null;
  try {
    let agentId = null;
    let reason = 'onboarding';

    // If admin picked a specific agent, honor it after a sanity check that the user
    // really is an agent/admin (defensive — guards against a stale select dropdown).
    if (preferredAgentId) {
      const [[picked]] = await pool.query(
        `SELECT id, name FROM users WHERE id = ? AND role IN ('agent','admin') AND is_active = TRUE`,
        [preferredAgentId]
      );
      if (picked) {
        agentId = picked.id;
        reason = 'onboarding_admin_picked';
      }
    }

    // Fall back to the auto-router when no preferred agent was given (or the id was bad).
    if (!agentId) {
      const { pickAgent } = require('../utils/assignment');
      const out = await pickAgent({ io, channel: 'ticket', customerId, requireOnline: false });
      agentId = out.agentId;
    }

    if (agentId) {
      const [[agent]] = await pool.query('SELECT id, name FROM users WHERE id = ?', [agentId]);
      await pool.query('UPDATE tickets SET assigned_agent_id = ? WHERE id = ?', [agentId, tIns.insertId]);
      assignedAgent = agent || null;
      if (io) {
        io.to(`user_${agentId}`).emit('ticket_assigned', {
          ticketId: tIns.insertId, subject, customerName, reason,
        });
      }
    }
  } catch (e) { console.error('[onboarding] agent pick failed', e); }

  // Tag the customer 'onboarding-pending' so admins can filter at-a-glance.
  await pool.query(
    `INSERT INTO customer_tags (customer_id, tag, set_by) VALUES (?, 'onboarding-pending', ?)
     ON DUPLICATE KEY UPDATE set_at = NOW()`,
    [customerId, adminId || null]
  );

  return { onboarding_ticket_id: tIns.insertId, assigned_agent: assignedAgent, reused_existing: false };
}

// POST /admin/customers/import — create or update customer from billing data.
// Always creates the account + sends a setup link. Onboarding ticket + tag are
// created ONLY when the admin explicitly requests them via `needs_onboarding: true`.
// Existing customers being migrated don't need an onboarding ticket — they just need
// a panel account, and we don't want to spam them with "we're setting up your email"
// when they're long past that phase.
exports.importBillingCustomer = async (req, res) => {
  try {
    const { needs_onboarding, onboarding_agent_id } = req.body;
    const result = await upsertCustomer(req.body);
    if (result.action === 'skipped') {
      return res.status(400).json({ error: result.reason });
    }

    const artifacts = { onboarding_ticket_id: null, assigned_agent: null, setup_email_sent: false };

    if (result.action === 'created') {
      // Optional: kick off onboarding only if the admin checked the box.
      if (needs_onboarding) {
        try {
          const out = await _startOnboarding({
            customerId: result.customer_id,
            customerName: result.name,
            adminId: req.user?.id,
            io: req.app.get('io'),
            preferredAgentId: onboarding_agent_id ? Number(onboarding_agent_id) : null,
          });
          artifacts.onboarding_ticket_id = out.onboarding_ticket_id;
          artifacts.assigned_agent = out.assigned_agent;
        } catch (e) {
          console.error('[Import Customer] onboarding side-effects failed', e);
        }
      }

      // Always send a setup link. The email references the onboarding ticket only when
      // one was actually created — otherwise it's a simple "welcome, set your password"
      // message with no support-ticket noise.
      sendWelcomeEmail({
        to: result.email, name: result.name,
        setupToken: result.setup_token,
        onboardingTicketId: artifacts.onboarding_ticket_id,
      }).then(() => { artifacts.setup_email_sent = true; }).catch(() => {});
    }

    res.json({
      action: result.action,
      customer_id: result.customer_id,
      ...artifacts,
    });
  } catch (err) {
    console.error('[Import Customer]', err.message);
    res.status(500).json({ error: err.message || 'Import failed' });
  }
};

// POST /admin/customers/manual — create a customer account without going through
// the billing-app import flow. Used when the admin wants to onboard someone whose
// records aren't in billing yet (trial/free user, manually-acquired account, etc.).
// Admin provides the basics directly; we either send a setup link OR honor the
// password the admin typed (some admins want to dictate the initial password).
exports.createManualCustomer = async (req, res) => {
  try {
    const {
      name,
      email,
      password,           // optional — if provided, account is ready to use immediately
      plan_id,            // optional — number; null = no plan assigned
      plan_expiry,        // optional — YYYY-MM-DD; ignored if no plan_id
      domain,             // optional
      needs_onboarding,
      onboarding_agent_id,
      send_setup_email,   // default true; admin can suppress if they handed out the password directly
    } = req.body;

    if (!name?.trim() || !email?.trim()) {
      return res.status(400).json({ error: 'Name and email are required' });
    }
    const cleanEmail = String(email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }
    if (password && String(password).length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    // Refuse to clobber an existing user — this isn't an upsert, it's a "create".
    const [[existing]] = await pool.query('SELECT id, role FROM users WHERE email = ?', [cleanEmail]);
    if (existing) {
      return res.status(409).json({ error: `A ${existing.role} account already exists with that email` });
    }

    // Every customer must have a plan. If the admin didn't supply one, default
    // to the Free plan so the customer lands in a valid (entitlement-defined)
    // state instead of a planless dead-end. Inactive plans are not selectable
    // for new customers (existing customers on them keep their seat).
    let resolvedPlanId;
    if (plan_id) {
      const [[plan]] = await pool.query('SELECT id, is_active FROM plans WHERE id = ?', [Number(plan_id)]);
      if (!plan) return res.status(400).json({ error: 'Invalid plan_id' });
      if (!plan.is_active) return res.status(400).json({ error: 'That plan has been disabled — pick an active plan instead.' });
      resolvedPlanId = plan.id;
    } else {
      const [[freePlan]] = await pool.query("SELECT id FROM plans WHERE name = 'free' LIMIT 1");
      if (!freePlan) return res.status(500).json({ error: 'Free plan missing from plans table' });
      resolvedPlanId = freePlan.id;
    }
    // Paid plans REQUIRE a valid expiry date (free plans never expire). Reject
    // up front so we never create a paid customer in the "no expiry" limbo.
    const resolvedPlanName = await planNameById(resolvedPlanId);
    const expiryErr = expiryRequirementError(resolvedPlanName, plan_expiry);
    if (expiryErr) return res.status(400).json({ error: expiryErr });

    // Free plan → expiry is always NULL ("never expires"). Paid plans keep the supplied expiry.
    const resolvedExpiry = await coerceExpiryForPlan(resolvedPlanId, plan_expiry);

    // Password handling: admin-supplied password = ready-to-use account.
    // No admin password = generate a setup token, account ships in "needs setup" state.
    // We still bcrypt-hash a placeholder so the row is valid either way.
    const crypto = require('crypto');
    let setupToken = null;
    let hashedPassword;
    if (password) {
      hashedPassword = await bcrypt.hash(String(password), 10);
    } else {
      setupToken = crypto.randomBytes(32).toString('hex');
      hashedPassword = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10);
    }

    const [userResult] = await pool.query(
      `INSERT INTO users (name, email, password, role, is_active, password_setup_token, password_setup_expires_at)
       VALUES (?, ?, ?, 'customer', 1, ?, ${setupToken ? 'DATE_ADD(NOW(), INTERVAL 24 HOUR)' : 'NULL'})`,
      [name.trim(), cleanEmail, hashedPassword, setupToken]
    );
    const userId = userResult.insertId;

    const [custResult] = await pool.query(
      `INSERT INTO customers (user_id, plan_id, plan_expiry, domain)
       VALUES (?, ?, ?, ?)`,
      [userId, resolvedPlanId, resolvedExpiry, domain?.trim() || null]
    );
    const customerId = custResult.insertId;

    // Audit row — this customer's first ever plan_change_history entry.
    logPlanChange({
      customerId,
      fromPlanId: null,
      toPlanId: resolvedPlanId,
      changeKind: 'signup',
      changedBy: req.user?.id || null,
      expiryAfter: resolvedExpiry,
      note: 'Manual customer creation (admin Add Customer dialog)',
    });

    // Optional onboarding ticket — same _startOnboarding helper the import flow uses,
    // so admin gets identical artifacts back and downstream behavior matches.
    const artifacts = { onboarding_ticket_id: null, assigned_agent: null, setup_email_sent: false };
    if (needs_onboarding) {
      try {
        const out = await _startOnboarding({
          customerId,
          customerName: name.trim(),
          adminId: req.user?.id,
          io: req.app.get('io'),
          preferredAgentId: onboarding_agent_id ? Number(onboarding_agent_id) : null,
        });
        artifacts.onboarding_ticket_id = out.onboarding_ticket_id;
        artifacts.assigned_agent = out.assigned_agent;
      } catch (e) {
        console.error('[Manual Customer] onboarding side-effects failed', e);
      }
    }

    // Setup email goes out by default. Two flavors:
    //   - admin-supplied password: sendAccountReadyEmail — credentials in the body, no setup link.
    //   - no password: sendWelcomeEmail — 24h setup-link flow where the customer picks their own.
    // Synchronous so the response.setup_email_sent flag accurately reflects whether
    // the customer will actually hear about their account.
    if (send_setup_email !== false) {
      try {
        if (password) {
          await sendAccountReadyEmail({
            to: cleanEmail,
            name: name.trim(),
            password: String(password),
            onboardingTicketId: artifacts.onboarding_ticket_id,
          });
        } else {
          await sendWelcomeEmail({
            to: cleanEmail,
            name: name.trim(),
            setupToken,
            onboardingTicketId: artifacts.onboarding_ticket_id,
          });
        }
        artifacts.setup_email_sent = true;
      } catch (err) {
        console.error('[Manual Customer] welcome email failed', err.message);
      }
    }

    res.status(201).json({
      action: 'created',
      customer_id: customerId,
      user_id: userId,
      ...artifacts,
    });
  } catch (err) {
    console.error('[Manual Customer]', err);
    res.status(500).json({ error: err.message || 'Failed to create customer' });
  }
};

// Bulk import customers from a parsed CSV. The frontend sends rows as JSON;
// the server validates, creates, and reports per-row outcomes. Email goes
// out as a welcome (set-up-link) email so customers pick their own password.
//
// Request body:
//   {
//     rows: [{ name, email, plan, domain? }, ...],
//     send_setup_email: true | false   (default true)
//   }
// Response:
//   { summary: { created, skipped, failed }, rows: [{ row, status, error?, customer_id? }, ...] }
exports.bulkImportCustomers = async (req, res) => {
  try {
    const { rows, send_setup_email = true } = req.body || {};
    if (!Array.isArray(rows) || !rows.length) {
      return res.status(400).json({ error: 'No rows to import' });
    }
    if (rows.length > 500) {
      return res.status(400).json({ error: 'Maximum 500 rows per import — split into smaller batches' });
    }

    // Resolve plan-name → plan-id once. We accept the plan column as either a
    // case-insensitive name ('basic', 'Premium', etc.) OR a numeric id.
    const [planRows] = await pool.query('SELECT id, name FROM plans');
    const planByName = new Map(planRows.map(p => [p.name.toLowerCase(), p.id]));
    const planById = new Map(planRows.map(p => [p.id, p.name]));

    const crypto = require('crypto');
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const outcomes = [];
    let created = 0, skipped = 0, failed = 0;

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i] || {};
      const rowNum = i + 1;
      const name = String(r.name || '').trim();
      const email = String(r.email || '').trim().toLowerCase();
      const planInput = String(r.plan || '').trim();
      const domain = r.domain ? String(r.domain).trim() : null;

      // Validation
      if (!name || !email) {
        outcomes.push({ row: rowNum, email, status: 'failed', error: 'Name and email required' });
        failed++; continue;
      }
      if (!emailRe.test(email)) {
        outcomes.push({ row: rowNum, email, status: 'failed', error: 'Invalid email format' });
        failed++; continue;
      }

      // Resolve plan (optional — empty means "no plan assigned yet")
      let planId = null;
      if (planInput) {
        const lower = planInput.toLowerCase();
        if (planByName.has(lower)) {
          planId = planByName.get(lower);
        } else if (!isNaN(Number(planInput)) && planById.has(Number(planInput))) {
          planId = Number(planInput);
        } else {
          outcomes.push({ row: rowNum, email, status: 'failed', error: `Unknown plan '${planInput}' — valid: ${[...planByName.keys()].join(', ')}` });
          failed++; continue;
        }
      }

      // Skip duplicates (any role) — preserve the existing-account guard
      const [[existing]] = await pool.query('SELECT id, role FROM users WHERE email = ?', [email]);
      if (existing) {
        outcomes.push({ row: rowNum, email, status: 'skipped', error: `${existing.role} account already exists` });
        skipped++; continue;
      }

      try {
        const setupToken = crypto.randomBytes(32).toString('hex');
        const placeholderHash = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10);
        // Free plan → never expires (NULL). Paid plans → 30 days from now (default for bulk import).
        const planNameLower = planId ? planById.get(planId) : null;
        const planExpiry = (planId && planNameLower !== 'free')
          ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
          : null;

        const [userResult] = await pool.query(
          `INSERT INTO users (name, email, password, role, is_active, password_setup_token, password_setup_expires_at)
           VALUES (?, ?, ?, 'customer', 1, ?, DATE_ADD(NOW(), INTERVAL 24 HOUR))`,
          [name, email, placeholderHash, setupToken]
        );
        const [custResult] = await pool.query(
          `INSERT INTO customers (user_id, plan_id, plan_expiry, domain) VALUES (?, ?, ?, ?)`,
          [userResult.insertId, planId, planExpiry, domain]
        );

        // Audit row for bulk import — each imported customer gets a 'signup' entry.
        if (planId) {
          logPlanChange({
            customerId: custResult.insertId,
            fromPlanId: null,
            toPlanId: planId,
            changeKind: 'signup',
            changedBy: req.user?.id || null,
            expiryAfter: planExpiry,
            note: 'Bulk import from billing app',
          });
        }

        // Welcome email — fire and forget so a slow/broken SMTP doesn't stall
        // a 500-row import. The setup token is valid for 24h regardless.
        if (send_setup_email) {
          sendWelcomeEmail({ to: email, name, setupToken })
            .catch(err => console.error('[Bulk import] welcome email failed for', email, err.message));
        }
        outcomes.push({
          row: rowNum, email, status: 'created',
          customer_id: custResult.insertId, user_id: userResult.insertId,
          plan: planId ? planById.get(planId) : null,
        });
        created++;
      } catch (rowErr) {
        outcomes.push({ row: rowNum, email, status: 'failed', error: rowErr.message?.slice(0, 200) || 'Insert failed' });
        failed++;
      }
    }

    res.json({ summary: { total: rows.length, created, skipped, failed }, rows: outcomes });
  } catch (err) {
    console.error('[Bulk Import]', err);
    res.status(500).json({ error: err.message || 'Bulk import failed' });
  }
};

// POST /admin/customers/:id/start-onboarding — manual trigger for an existing customer.
// Bulk actions on a selection of customers. One endpoint covers the four
// admin workflows (reset usage, resend welcome email, change plan, delete) so
// the frontend doesn't need four separate calls. Returns a per-customer
// outcome so the admin can see at a glance which ones succeeded / failed.
//
// Request body:
//   {
//     customer_ids: [1, 2, 3],
//     action: 'reset-usage' | 'resend-welcome' | 'change-plan' | 'delete',
//     params: { plan_id?, plan_expiry? }    // only for change-plan
//   }
// Response:
//   { summary: { total, succeeded, failed }, results: [{ customer_id, status, error? }] }
exports.bulkCustomerAction = async (req, res) => {
  try {
    const { customer_ids, action, params = {} } = req.body || {};
    if (!Array.isArray(customer_ids) || !customer_ids.length) {
      return res.status(400).json({ error: 'No customers selected' });
    }
    if (customer_ids.length > 200) {
      return res.status(400).json({ error: 'Maximum 200 customers per bulk action — split into smaller batches' });
    }
    const validActions = ['reset-usage', 'resend-welcome', 'change-plan', 'delete'];
    if (!validActions.includes(action)) {
      return res.status(400).json({ error: `Unknown action — must be one of: ${validActions.join(', ')}` });
    }

    // Resolve plan if change-plan
    let targetPlanId = null;
    let targetPlanExpiry = null;
    if (action === 'change-plan') {
      if (!params.plan_id) return res.status(400).json({ error: 'plan_id is required for change-plan' });
      const [[plan]] = await pool.query('SELECT id FROM plans WHERE id = ?', [Number(params.plan_id)]);
      if (!plan) return res.status(400).json({ error: 'Invalid plan_id' });
      targetPlanId = plan.id;
      targetPlanExpiry = params.plan_expiry || null;
    }

    const month = new Date().toISOString().slice(0, 7);
    const results = [];
    let succeeded = 0, failed = 0;

    for (const rawId of customer_ids) {
      const customerId = Number(rawId);
      if (!Number.isInteger(customerId) || customerId <= 0) {
        results.push({ customer_id: rawId, status: 'failed', error: 'Invalid customer_id' });
        failed++; continue;
      }
      try {
        const [[cust]] = await pool.query(
          `SELECT c.id, c.user_id, c.plan_id, u.name, u.email
           FROM customers c JOIN users u ON u.id = c.user_id WHERE c.id = ?`,
          [customerId]
        );
        if (!cust) {
          results.push({ customer_id: customerId, status: 'failed', error: 'Customer not found' });
          failed++; continue;
        }

        if (action === 'reset-usage') {
          // Wipe the current month's counters across all three usage tables.
          // Matches the per-customer endpoint's behaviour (resetCustomerUsage).
          await pool.query('UPDATE customers SET usage_reset_at = NOW() WHERE id = ?', [customerId]);
          await pool.query('DELETE FROM ticket_usage WHERE customer_id = ? AND month_year = ?', [customerId, month]);
          await pool.query('DELETE FROM call_usage   WHERE customer_id = ? AND month_year = ?', [customerId, month]);
          await pool.query('DELETE FROM chat_usage   WHERE customer_id = ? AND month_year = ?', [customerId, month]);
          _audit(req, { action: 'usage_reset_bulk', entityId: customerId, newValue: { month } });
          results.push({ customer_id: customerId, status: 'ok' });
        }

        else if (action === 'resend-welcome') {
          // Mint a fresh setup token + send a new welcome email. Useful when
          // a customer never received the original or let it expire.
          const setupToken = crypto.randomBytes(32).toString('hex');
          await pool.query(
            `UPDATE users SET password_setup_token = ?, password_setup_expires_at = DATE_ADD(NOW(), INTERVAL 24 HOUR) WHERE id = ?`,
            [setupToken, cust.user_id]
          );
          sendWelcomeEmail({ to: cust.email, name: cust.name, setupToken })
            .catch(err => console.error('[Bulk resend-welcome] email failed for', cust.email, err.message));
          _audit(req, { action: 'welcome_email_resent', entityId: customerId });
          results.push({ customer_id: customerId, status: 'ok' });
        }

        else if (action === 'change-plan') {
          // Free → never expires. Coerce the supplied expiry to NULL for Free targets.
          const coercedExpiry = await coerceExpiryForPlan(targetPlanId, targetPlanExpiry);
          await pool.query(
            `UPDATE customers SET plan_id = ?, plan_expiry = ? WHERE id = ?`,
            [targetPlanId, coercedExpiry, customerId]
          );
          _audit(req, { action: 'plan_changed_bulk', entityId: customerId, oldValue: { plan_id: cust.plan_id }, newValue: { plan_id: targetPlanId, plan_expiry: coercedExpiry } });
          results.push({ customer_id: customerId, status: 'ok' });
        }

        else if (action === 'delete') {
          // Cascade: messages → tickets/chats/calls → usage → customer → user.
          // Mirrors deleteCustomer (single-customer endpoint).
          await pool.query('DELETE FROM chat_messages WHERE chat_id IN (SELECT id FROM chats WHERE customer_id = ?)', [customerId]);
          await pool.query('DELETE FROM chats WHERE customer_id = ?', [customerId]);
          await pool.query('DELETE FROM ticket_messages WHERE ticket_id IN (SELECT id FROM tickets WHERE customer_id = ?)', [customerId]);
          await pool.query('DELETE FROM tickets WHERE customer_id = ?', [customerId]);
          await pool.query('DELETE FROM calls WHERE customer_id = ?', [customerId]);
          await pool.query('DELETE FROM ticket_usage WHERE customer_id = ?', [customerId]);
          await pool.query('DELETE FROM call_usage WHERE customer_id = ?', [customerId]);
          await pool.query('DELETE FROM chat_usage WHERE customer_id = ?', [customerId]);
          await pool.query('DELETE FROM customer_feature_overrides WHERE customer_id = ?', [customerId]).catch(() => {});
          await pool.query('DELETE FROM customers WHERE id = ?', [customerId]);
          await pool.query('DELETE FROM users WHERE id = ?', [cust.user_id]);
          results.push({ customer_id: customerId, status: 'ok' });
        }
        succeeded++;
      } catch (rowErr) {
        results.push({ customer_id: customerId, status: 'failed', error: rowErr.message?.slice(0, 200) || 'Action failed' });
        failed++;
      }
    }

    res.json({
      summary: { total: customer_ids.length, succeeded, failed },
      results,
    });
  } catch (err) {
    console.error('[Bulk customer action]', err);
    res.status(500).json({ error: err.message || 'Bulk action failed' });
  }
};

// Admin opens the customer's profile and clicks "Start Onboarding" when this customer
// (already imported earlier without onboarding) now needs the email-setup workflow.
// Returns the same artifact shape as the import flow so the UI can reuse the same
// confirmation toast.
exports.startCustomerOnboarding = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { agent_id } = req.body || {};
    const [[c]] = await pool.query(
      `SELECT c.id, u.name FROM customers c JOIN users u ON u.id = c.user_id WHERE c.id = ?`, [id]);
    if (!c) return res.status(404).json({ error: 'Customer not found' });
    const out = await _startOnboarding({
      customerId: c.id, customerName: c.name,
      adminId: req.user?.id, io: req.app.get('io'),
      preferredAgentId: agent_id ? Number(agent_id) : null,
    });
    res.json(out);
  } catch (err) {
    console.error('[start-onboarding]', err);
    res.status(500).json({ error: 'Failed to start onboarding' });
  }
};
