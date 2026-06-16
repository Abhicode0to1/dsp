const router = require('express').Router();
const {
  getDashboard,
  getCustomers,
  getCustomerById,
  updateCustomer,
  getPlans,
  updatePlan,
  updateAgentSkills,
  getAdminCalls,
  getTicketReport,
  getRevenueReport,
  getUsageReport,
  getAgents,
  createAgent,
  toggleAgent,
  changeAgentRole,
  getAllTickets,
  updateAnyTicket,
  getAllChats,
  assignChat,
  getAdminTicketDetail,
  bulkUpdateTickets,
  exportReportCsv,
  getReportTickets,
  getReportInvoices,
  getReportCalls,
  getReportChats,
  getReportCustomers,
  getReportAgents,
  listCustomReports,
  createCustomReport,
  updateCustomReport,
  deleteCustomReport,
  getCustomReportCount,
  getSettings,
  updateSettings,
  lookupBillingCustomer,
  importBillingCustomer,
  createManualCustomer,
  changeAgentPassword,
  changeCustomerPassword,
  resetCustomerUsage,
  deleteAgent,
  deleteCustomer,
  bulkImportCustomers,
  bulkCustomerAction,
} = require('../controllers/adminController');
const {
  getChatAnalytics,
  getChatArchive,
  getArchivedChatMessages,
  getBlacklist,
  blockCustomer,
  unblockCustomer,
  getAgentChatStatuses,
} = require('../controllers/chatController');
const {
  getCallBlacklist,
  blockCustomerCalls,
  unblockCustomerCalls,
} = require('../controllers/callController');
const { getAgentPerformance, getAgentReviews } = require('../controllers/csatController');
const { getTemplates, createTemplate, updateTemplate, deleteTemplate,
        getCannedResponses, createCannedResponse, updateCannedResponse, deleteCannedResponse } = require('../controllers/templateController');
const {
  listEmailTemplates,
  getEmailTemplate,
  saveEmailTemplate,
  resetEmailTemplate,
  previewEmailTemplate,
} = require('../controllers/emailTemplateController');
const { triggerPullSync, getCustomerOverrides, upsertCustomerOverrides, deleteCustomerOverrides } = require('../controllers/syncController');
const { authenticate, requireRole } = require('../middleware/auth');

router.use(authenticate);
router.use(requireRole('admin'));

// ── Usage-drift audit ─────────────────────────────────────────────────────────
// Returns customers whose live usage exceeds their plan's cap (chat / call).
// A non-empty list is a red flag: either the gate isn't holding or somebody got
// a plan downgrade without their usage being reset. Ops should review weekly.
// Admin "Run Tests" action — spawns the routing-limits test suite as a child process
// and returns its stdout + exit code. Same as `npm run test:routing`. Capped at 60s.
// Single-flight: the test suite seeds + cleans real chats/calls in shared DB tables,
// so two concurrent runs would step on each other. Subsequent requests during a run
// get 429 with a helpful message instead.
let _testRunInFlight = false;
router.post('/audit/run-tests', async (req, res) => {
  if (_testRunInFlight) {
    return res.status(429).json({
      error: 'A test run is already in progress',
      hint: 'Wait for the current run to finish (typically < 5s) and try again.',
    });
  }
  _testRunInFlight = true;
  const { spawn } = require('child_process');
  const path = require('path');
  const scriptPath = path.join(__dirname, '..', '..', 'tests', 'routing-limits.test.js');
  const started = Date.now();
  let responded = false;
  const respond = (status, payload) => {
    if (responded) return;
    responded = true;
    _testRunInFlight = false;
    res.status(status).json(payload);
  };

  try {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: path.join(__dirname, '..', '..'),
      env: { ...process.env, FORCE_COLOR: '0' },
      windowsHide: true,
    });
    let stdout = '', stderr = '';
    const killTimer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
    }, 60_000);

    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('close', code => {
      clearTimeout(killTimer);
      const summary = (stdout.match(/Total (\d+) · PASS (\d+) · FAIL (\d+)/) || []);
      const passLines  = (stdout.match(/✅[^\n]+/g) || []);
      const failLines  = (stdout.match(/❌[^\n]+/g) || []);
      respond(200, {
        exit_code: code,
        passed: code === 0,
        duration_ms: Date.now() - started,
        total: summary[1] ? Number(summary[1]) : passLines.length + failLines.length,
        pass_count: summary[2] ? Number(summary[2]) : passLines.length,
        fail_count: summary[3] ? Number(summary[3]) : failLines.length,
        pass_lines: passLines,
        fail_lines: failLines,
        stdout, stderr,
      });
    });
    child.on('error', err => {
      clearTimeout(killTimer);
      console.error('[run-tests] spawn error', err);
      respond(500, { error: 'Failed to spawn test process', detail: err.message });
    });
  } catch (err) {
    console.error('[run-tests]', err);
    respond(500, { error: 'Server error', detail: err.message });
  }
});

// Admin "Reset Usage" action — sets customers.usage_reset_at to NOW(). All chats/calls
// before that timestamp stop counting against the limit. Non-destructive: rows stay in
// history (so the customer can still see them), they just no longer hit the cap.
// Clears the in-process drift-warned cache too so the warning fires again if drift
// somehow recurs.
router.post('/audit/reset-usage/:customerId', async (req, res) => {
  try {
    const { pool } = require('../config/database');
    const id = Number(req.params.customerId);
    // Pull customer + plan limits in one query — we need them for the notification email.
    const [[c]] = await pool.query(
      `SELECT c.id, c.user_id, u.email, u.name, p.calls_limit, p.chat_limit
         FROM customers c
         JOIN users u   ON u.id = c.user_id
         LEFT JOIN plans p ON p.id = c.plan_id
        WHERE c.id = ?`, [id]);
    if (!c) return res.status(404).json({ error: 'Customer not found' });
    await pool.query(`UPDATE customers SET usage_reset_at = NOW() WHERE id = ?`, [id]);
    console.log(`[audit] usage reset for ${c.email} by admin ${req.user?.email}`);

    // Notify the customer — email + in-app socket nudge. Fire-and-forget; an SMTP
    // failure mustn't fail the admin's reset action.
    const { sendUsageResetEmail } = require('../utils/emailUtils');
    sendUsageResetEmail({
      to: c.email,
      customerName: c.name,
      callLimit: c.calls_limit,
      chatLimit: c.chat_limit,
    }).catch(err => console.error('[reset-usage email]', err.message));

    const io = req.app.get('io');
    if (io) {
      io.to(`user_${c.user_id}`).emit('usage_reset', {
        reset_at: new Date().toISOString(),
        callLimit: c.calls_limit,
        chatLimit: c.chat_limit,
      });
    }

    res.json({ ok: true, email: c.email, reset_at: new Date().toISOString() });
  } catch (err) {
    console.error('[audit] reset-usage', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/audit/usage-drift', async (req, res) => {
  try {
    const { pool } = require('../config/database');
    const { getChatUsage, getCallUsage } = require('../utils/planUtils');
    const [custs] = await pool.query(
      `SELECT c.id AS customer_id, u.email, p.name AS plan, p.chat_limit, p.calls_limit
       FROM customers c JOIN users u ON u.id = c.user_id LEFT JOIN plans p ON p.id = c.plan_id
       WHERE u.is_active = 1`
    );
    const drifts = [];
    for (const c of custs) {
      const chatUsed = await getChatUsage(c.customer_id);
      const callUsed = await getCallUsage(c.customer_id);
      if (c.chat_limit != null && chatUsed > c.chat_limit) {
        drifts.push({ customer_id: c.customer_id, email: c.email, plan: c.plan, channel: 'chat', used: chatUsed, limit: c.chat_limit, over_by: chatUsed - c.chat_limit });
      }
      if (c.calls_limit != null && callUsed > c.calls_limit) {
        drifts.push({ customer_id: c.customer_id, email: c.email, plan: c.plan, channel: 'call', used: callUsed, limit: c.calls_limit, over_by: callUsed - c.calls_limit });
      }
    }
    res.json({
      checked: custs.length,
      drift_count: drifts.length,
      drifts,
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[audit] usage-drift', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Spam-cut watchlist — surfaces customers who already have at least `cap` short
// calls this month (each short call is one under the billable threshold). Once a
// customer reaches the cap, their NEXT short call starts counting against quota,
// but high counts here can flag potential abuse or a misbehaving agent. Admin
// drills in via the Calls page "Short-cut only" filter to see the actual calls.
router.get('/audit/short-cut-watchlist', async (req, res) => {
  try {
    const { pool } = require('../config/database');
    const { getRoutingSettings } = require('../utils/assignment');
    const settings = await getRoutingSettings();
    const threshold = Number(settings.minBillableCallSeconds ?? 30);
    const cap = Math.max(0, Number(settings.maxShortCutForgivalsPerMonth ?? 3));

    // Break the short-cut count down by who hung up so admin can immediately
    // tell whether the customer is abusing OR an agent is spam-cutting them.
    // SUM(CASE…) trick: aggregate counts per ended_by within the same GROUP BY.
    const [rows] = await pool.query(
      `SELECT c.id AS customer_id, u.email, u.name AS customer_name,
              p.name AS plan, p.calls_limit,
              COUNT(*) AS short_cuts_this_month,
              SUM(CASE WHEN ca.ended_by = 'customer' THEN 1 ELSE 0 END) AS short_cuts_by_customer,
              SUM(CASE WHEN ca.ended_by = 'agent'    THEN 1 ELSE 0 END) AS short_cuts_by_agent,
              SUM(CASE WHEN ca.ended_by = 'system'   THEN 1 ELSE 0 END) AS short_cuts_by_system,
              SUM(CASE WHEN ca.ended_by IS NULL      THEN 1 ELSE 0 END) AS short_cuts_unknown,
              MAX(ca.created_at) AS last_short_cut_at
       FROM calls ca
       JOIN customers c ON c.id = ca.customer_id
       JOIN users u ON u.id = c.user_id
       LEFT JOIN plans p ON p.id = c.plan_id
       WHERE ca.status = 'ended'
         AND ca.duration IS NOT NULL
         AND ca.duration > 0
         AND ca.duration < ?
         AND (ca.initiated_by IS NULL OR ca.initiated_by != 'agent')
         AND DATE_FORMAT(ca.created_at, '%Y-%m') = DATE_FORMAT(NOW(), '%Y-%m')
         AND (c.usage_reset_at IS NULL OR ca.created_at > c.usage_reset_at)
       GROUP BY c.id, u.email, u.name, p.name, p.calls_limit
       HAVING short_cuts_this_month >= ?
       ORDER BY short_cuts_this_month DESC, last_short_cut_at DESC`,
      [threshold, cap]
    );

    res.json({
      threshold,
      cap,
      watchlist: rows,
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[audit] short-cut-watchlist', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Diagnostic — dumps the current state of all sockets + agents room + status map
// so admin can debug "why does the customer see no agents available?". Read-only.
router.get('/debug/agent-presence', (req, res) => {
  const io = req.app.get('io');
  const allSockets = [];
  const agentSocketsList = [];
  if (io?.sockets?.sockets) {
    for (const [sid, sock] of io.sockets.sockets) {
      if (!sock?.user) continue;
      const inAgents = io.sockets.adapter.rooms.get('agents')?.has(sid) || false;
      allSockets.push({
        socketId: sid.slice(0, 6),
        userId: sock.user.id,
        name: sock.user.name,
        role: sock.user.role,
        inAgentsRoom: inAgents,
        rooms: [...(sock.rooms || [])].filter(r => r !== sid).slice(0, 5),
      });
      if (inAgents) agentSocketsList.push({ userId: sock.user.id, name: sock.user.name, role: sock.user.role });
    }
  }
  const { getOnlineAgentIds } = require('../socket/chatSocket');
  res.json({
    total_connected_sockets: allSockets.length,
    all_sockets: allSockets,
    sockets_in_agents_room: agentSocketsList,
    online_per_getOnlineAgentIds: getOnlineAgentIds(io),
    io_available: !!io,
  });
});

// Feedback / bug reports submitted by customers and agents — admin reviews here.
router.get('/feedback',             require('../controllers/feedbackController').adminList);
router.get('/feedback/reporters',   require('../controllers/feedbackController').getReporters);
router.post('/feedback/bulk',       require('../controllers/feedbackController').adminBulkUpdate);
router.put('/feedback/:id',         require('../controllers/feedbackController').adminUpdate);

router.get('/dashboard',          getDashboard);
router.get('/customers',               getCustomers);
router.get('/customers/:id',           getCustomerById);
router.put('/customers/:id',           updateCustomer);
router.delete('/customers/:id',        deleteCustomer);
router.put('/customers/:id/password',  changeCustomerPassword);
router.post('/customers/:id/reset-usage', resetCustomerUsage);
router.post('/customers/:id/start-onboarding', require('../controllers/adminController').startCustomerOnboarding);
router.get('/customers/:id/overrides', getCustomerOverrides);
router.put('/customers/:id/overrides', upsertCustomerOverrides);
router.delete('/customers/:id/overrides', deleteCustomerOverrides);

// Plan change history — chronological list of all plan transitions for a
// customer (signup, upgrade, downgrade, renewal, manual_admin, expiry_lapse).
// Drives the "Plan History" tab on the Customer Detail page.
router.get('/customers/:id/plan-history', async (req, res) => {
  try {
    const { pool } = require('../config/database');
    const [rows] = await pool.query(
      `SELECT h.*, u.name AS changed_by_name
       FROM plan_change_history h
       LEFT JOIN users u ON u.id = h.changed_by
       WHERE h.customer_id = ?
       ORDER BY h.created_at DESC
       LIMIT 200`,
      [req.params.id]
    );
    res.json({ items: rows });
  } catch (err) {
    console.error('[plan-history]', err.message);
    res.status(500).json({ error: 'Failed to load plan history' });
  }
});

// ── Admin manual renew (Phase 4) ─────────────────────────────────────────────
// One-click renewal/extension from the admin Customer Detail page. Admin
// picks a target plan + expiry + optional note. Logs to plan_change_history
// (kind = 'renewal' or 'manual_admin' depending on tier movement) and pushes
// the customer's plan_id + plan_expiry. NO Razorpay involvement — admin is
// recording a payment that happened outside the panel (bank transfer, cheque,
// etc.) or granting goodwill.
router.post('/customers/:id/renew-plan', async (req, res) => {
  try {
    const { pool } = require('../config/database');
    const { logPlanChange, inferKind } = require('../utils/planHistory');
    const { target_plan_id, new_expiry, amount_paid, payment_ref, note } = req.body || {};

    if (!target_plan_id) return res.status(400).json({ error: 'target_plan_id is required' });
    if (!new_expiry || !/^\d{4}-\d{2}-\d{2}$/.test(String(new_expiry))) {
      return res.status(400).json({ error: 'new_expiry must be YYYY-MM-DD' });
    }
    if (new Date(new_expiry) < new Date()) {
      return res.status(400).json({ error: 'new_expiry must be in the future' });
    }

    const [[plan]] = await pool.query('SELECT id, name, is_active FROM plans WHERE id = ?', [target_plan_id]);
    if (!plan) return res.status(400).json({ error: 'Invalid target_plan_id' });
    if (!plan.is_active) {
      return res.status(400).json({ error: 'Target plan has been disabled — pick an active plan.' });
    }
    if (plan.name === 'free') {
      return res.status(400).json({ error: 'Use the regular Edit Customer dialog to move someone to Free — the renewal endpoint is for paid plans.' });
    }

    // Every paid-plan event must carry a verifiable payment trail. Razorpay
    // upgrades meet this via the signature-verified razorpay_payment_id; the
    // manual-renewal flow used to allow blank fields, which left the Revenue
    // tile traceable to "trust me" entries. Now both are required.
    const cleanRef = (payment_ref || '').toString().trim();
    if (!cleanRef) {
      return res.status(400).json({ error: 'payment_ref is required — enter the bank ref / cheque no / UPI ID / other transaction ID that proves payment was received.' });
    }
    if (cleanRef.length > 120) {
      return res.status(400).json({ error: 'payment_ref must be 120 characters or fewer.' });
    }
    const amountNum = Number(amount_paid);
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      return res.status(400).json({ error: 'amount_paid must be a positive number.' });
    }

    const [[snap]] = await pool.query(
      'SELECT plan_id, plan_expiry FROM customers WHERE id = ?',
      [req.params.id]
    );
    if (!snap) return res.status(404).json({ error: 'Customer not found' });

    await pool.query(
      'UPDATE customers SET plan_id = ?, plan_expiry = ?, updated_at = NOW() WHERE id = ?',
      [target_plan_id, new_expiry, req.params.id]
    );

    // Get the from-plan name for inferKind
    const [[fromPlan]] = snap.plan_id
      ? await pool.query('SELECT name FROM plans WHERE id = ?', [snap.plan_id])
      : [[]];
    const changeKind = inferKind(fromPlan?.name, plan.name);

    logPlanChange({
      customerId: Number(req.params.id),
      fromPlanId: snap.plan_id,
      toPlanId: target_plan_id,
      changeKind,
      changedBy: req.user.id,
      amountPaid: amountNum,
      paymentRef: cleanRef,
      expiryBefore: snap.plan_expiry,
      expiryAfter: new_expiry,
      note: note?.toString().slice(0, 1000) || 'Manual renewal by admin',
    });

    res.json({ ok: true, message: `Renewed to ${plan.name} until ${new_expiry}` });
  } catch (err) {
    console.error('[renew-plan]', err.message);
    res.status(500).json({ error: 'Renewal failed' });
  }
});

// ── Backfill: record payment proof against an existing customer ─────────────
// For paying customers whose plan_change_history rows have NULL payment_ref
// (initial-signup backfills + pre-enforcement manual renewals). Updates the
// MOST RECENT NULL-ref row in-place — preferred path, no fake "renewal" event
// gets created. If every row already has a ref but the customer is somehow
// still flagged as missing, falls back to inserting a kind='backfill_proof'
// row so the proof still lands somewhere queryable.
router.post('/customers/:id/record-payment-proof', async (req, res) => {
  try {
    const { pool } = require('../config/database');
    const { logPlanChange } = require('../utils/planHistory');
    const { payment_ref, amount_paid, note } = req.body || {};

    const cleanRef = (payment_ref || '').toString().trim();
    if (!cleanRef) {
      return res.status(400).json({ error: 'payment_ref is required.' });
    }
    if (cleanRef.length > 120) {
      return res.status(400).json({ error: 'payment_ref must be 120 characters or fewer.' });
    }
    const amountNum = Number(amount_paid);
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      return res.status(400).json({ error: 'amount_paid must be a positive number.' });
    }

    const customerId = Number(req.params.id);
    const [[customer]] = await pool.query(
      `SELECT c.id, c.plan_id, p.name AS plan_name
       FROM customers c LEFT JOIN plans p ON p.id = c.plan_id
       WHERE c.id = ?`,
      [customerId]
    );
    if (!customer) return res.status(404).json({ error: 'Customer not found' });
    if (!customer.plan_id || customer.plan_name === 'free') {
      return res.status(400).json({ error: 'Customer is on the Free plan — no payment proof needed.' });
    }

    const cleanNote = (note?.toString().slice(0, 1000)) || `Payment proof backfilled by admin`;

    // Prefer UPDATE on the most recent NULL-ref row
    const [[targetRow]] = await pool.query(
      `SELECT id FROM plan_change_history
       WHERE customer_id = ? AND payment_ref IS NULL
       ORDER BY created_at DESC LIMIT 1`,
      [customerId]
    );

    if (targetRow) {
      await pool.query(
        `UPDATE plan_change_history
         SET payment_ref = ?, amount_paid = ?,
             note = CONCAT(COALESCE(note, ''), CASE WHEN note IS NULL OR note = '' THEN '' ELSE ' | ' END, ?)
         WHERE id = ?`,
        [cleanRef, amountNum, `[proof backfill] ${cleanNote}`, targetRow.id]
      );
      return res.json({ ok: true, updated_row_id: targetRow.id, mode: 'update' });
    }

    // Fallback — insert a manual_admin row tagged as a proof backfill in the
    // note. (change_kind is a fixed ENUM in the schema, so we reuse the
    // closest existing value rather than ship a migration just for this rare
    // path. The "[proof backfill]" prefix in the note keeps it filterable.)
    logPlanChange({
      customerId,
      fromPlanId: customer.plan_id,
      toPlanId: customer.plan_id,
      changeKind: 'manual_admin',
      changedBy: req.user.id,
      amountPaid: amountNum,
      paymentRef: cleanRef,
      expiryBefore: null,
      expiryAfter: null,
      note: `[proof backfill] ${cleanNote}`,
    });
    res.json({ ok: true, mode: 'insert' });
  } catch (err) {
    console.error('[record-payment-proof]', err.message);
    res.status(500).json({ error: 'Could not record payment proof' });
  }
});

// ── Background worker liveness (System Health → workers card) ───────────────
// Reads the worker_heartbeats table populated by every worker on each tick.
// A worker is considered overdue if last_run_at is more than 2× its expected
// interval ago (gives some slack for cron skew + slow ticks).
router.get('/health/workers', async (req, res) => {
  try {
    const { pool } = require('../config/database');
    const [rows] = await pool.query(
      `SELECT name, last_run_at, last_status, last_error, expected_interval_seconds, run_count,
              TIMESTAMPDIFF(SECOND, last_run_at, NOW()) AS seconds_since_last_run
       FROM worker_heartbeats
       ORDER BY name`
    );
    const items = rows.map(r => ({
      name: r.name,
      last_run_at: r.last_run_at,
      last_status: r.last_status,
      last_error: r.last_error,
      run_count: Number(r.run_count) || 0,
      expected_interval_seconds: Number(r.expected_interval_seconds) || 0,
      seconds_since_last_run: Number(r.seconds_since_last_run) || 0,
      is_overdue: Number(r.seconds_since_last_run) > 2 * Number(r.expected_interval_seconds),
    }));
    res.json({ items });
  } catch (err) {
    console.error('[health/workers]', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── SLA breach forecast — tickets approaching response/resolve breach ───────
// Returns the next N tickets that will breach SLA in the window so admin can
// intervene BEFORE the breach. Default window: 4 hours, max 50 rows.
router.get('/health/sla-forecast', async (req, res) => {
  try {
    const { pool } = require('../config/database');
    const hours = Math.max(1, Math.min(72, parseInt(req.query.hours, 10) || 4));
    const [rows] = await pool.query(
      `SELECT t.id, t.subject, t.priority, t.status, t.sla_response_due, t.sla_resolve_due,
              t.first_response_at, t.assigned_agent_id,
              cu.name AS customer_name, cu.email AS customer_email,
              ag.name AS agent_name,
              LEAST(
                IFNULL(CASE WHEN t.first_response_at IS NULL THEN t.sla_response_due END, t.sla_resolve_due),
                IFNULL(t.sla_resolve_due, t.sla_response_due)
              ) AS next_breach_at
       FROM tickets t
       JOIN customers c ON c.id = t.customer_id
       JOIN users cu ON cu.id = c.user_id
       LEFT JOIN users ag ON ag.id = t.assigned_agent_id
       WHERE t.status != 'closed'
         AND t.sla_breached = FALSE
         AND (
           (t.first_response_at IS NULL AND t.sla_response_due IS NOT NULL
            AND t.sla_response_due BETWEEN NOW() AND NOW() + INTERVAL ? HOUR)
           OR
           (t.sla_resolve_due IS NOT NULL
            AND t.sla_resolve_due BETWEEN NOW() AND NOW() + INTERVAL ? HOUR)
         )
       ORDER BY next_breach_at ASC
       LIMIT 50`,
      [hours, hours]
    );
    res.json({ items: rows, window_hours: hours, count: rows.length });
  } catch (err) {
    console.error('[health/sla-forecast]', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Sidebar badge counts (admin nav) ─────────────────────────────────────────
// One unified GET so the admin sidebar makes a single round-trip per poll
// instead of N. Returns the small set of counters that drive sidebar badges:
//   - new bug reports (numeric badge on "Bug Reports")
//   - open billing syncs (contributes to "System Health" red dot)
//   - payment failures last 24h (contributes to "System Health" red dot)
//   - usage drift count (contributes to "System Health" red dot)
// Frontend computes the SYSTEM-group dot as "any of these > 0".
router.get('/sidebar-badges', async (req, res) => {
  try {
    const { pool } = require('../config/database');
    const [[counts]] = await pool.query(
      `SELECT
        (SELECT COUNT(*) FROM feedback_reports WHERE status = 'new') AS new_bug_reports,
        (SELECT COUNT(*) FROM pending_billing_syncs WHERE synced_at IS NULL AND dismissed_at IS NULL) AS open_billing_syncs,
        (SELECT COUNT(*) FROM payment_attempts WHERE status = 'failed' AND created_at >= NOW() - INTERVAL 24 HOUR) AS payment_failures_24h`
    );
    res.json({
      new_bug_reports:     Number(counts.new_bug_reports)     || 0,
      open_billing_syncs:  Number(counts.open_billing_syncs)  || 0,
      payment_failures_24h:Number(counts.payment_failures_24h)|| 0,
    });
  } catch (err) {
    console.error('[sidebar-badges]', err.message);
    // Soft-fail with zeroes — a broken badge call must never crash the nav
    res.json({ new_bug_reports: 0, open_billing_syncs: 0, payment_failures_24h: 0 });
  }
});

// ── Payment failures (Phase 1) — System Health card ─────────────────────────
// Returns failure count for the last 7 days + the most recent 20 rows.
router.get('/payment-failures', async (req, res) => {
  try {
    const { pool } = require('../config/database');
    const [[total]] = await pool.query(
      `SELECT
         SUM(CASE WHEN status = 'failed'    THEN 1 ELSE 0 END) AS failed_7d,
         SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled_7d,
         SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) AS succeeded_7d,
         COUNT(*) AS total_7d
       FROM payment_attempts
       WHERE created_at >= NOW() - INTERVAL 7 DAY`
    );
    const [recent] = await pool.query(
      `SELECT pa.id, pa.target_plan, pa.razorpay_order_id, pa.status,
              pa.error_code, pa.error_description, pa.amount, pa.created_at,
              u.email AS customer_email, u.name AS customer_name, c.id AS customer_id
       FROM payment_attempts pa
       JOIN customers c ON c.id = pa.customer_id
       JOIN users u ON u.id = c.user_id
       WHERE pa.created_at >= NOW() - INTERVAL 7 DAY
         AND pa.status IN ('failed', 'cancelled')
       ORDER BY pa.created_at DESC
       LIMIT 20`
    );
    res.json({
      stats: {
        failed: Number(total?.failed_7d) || 0,
        cancelled: Number(total?.cancelled_7d) || 0,
        succeeded: Number(total?.succeeded_7d) || 0,
        total: Number(total?.total_7d) || 0,
      },
      recent,
    });
  } catch (err) {
    console.error('[payment-failures]', err.message);
    res.status(500).json({ error: 'Failed to load payment failures' });
  }
});

// ── Pending billing syncs (Phase 2) ──────────────────────────────────────────
// Lists rows queued by verifyUpgrade when its Zoho-notify call failed, plus
// rows the retry worker hasn't completed. Three admin actions per row:
//   POST /admin/billing-syncs/:id/retry   — manual one-click retry
//   POST /admin/billing-syncs/:id/dismiss — mark as manually invoiced
//   GET  /admin/billing-syncs/stats       — for System Health card
router.get('/billing-syncs', async (req, res) => {
  try {
    const { pool } = require('../config/database');
    const filter = String(req.query.filter || 'open'); // 'open' | 'all' | 'dismissed' | 'synced'
    let where = '1=1';
    if (filter === 'open')       where = 's.synced_at IS NULL AND s.dismissed_at IS NULL';
    else if (filter === 'synced')    where = 's.synced_at IS NOT NULL';
    else if (filter === 'dismissed') where = 's.dismissed_at IS NOT NULL';
    const [rows] = await pool.query(
      `SELECT s.*, u.email AS customer_email, u.name AS customer_name,
              du.name AS dismissed_by_name
       FROM pending_billing_syncs s
       JOIN customers c ON c.id = s.customer_id
       JOIN users u ON u.id = c.user_id
       LEFT JOIN users du ON du.id = s.dismissed_by
       WHERE ${where}
       ORDER BY s.created_at DESC
       LIMIT 200`
    );
    res.json({ items: rows });
  } catch (err) {
    console.error('[billing-syncs list]', err.message);
    res.status(500).json({ error: 'Failed to load pending syncs' });
  }
});

router.get('/billing-syncs/stats', async (req, res) => {
  try {
    const { pool } = require('../config/database');
    const [[row]] = await pool.query(
      `SELECT
         SUM(CASE WHEN synced_at IS NULL AND dismissed_at IS NULL THEN 1 ELSE 0 END) AS open_count,
         SUM(CASE WHEN synced_at IS NULL AND dismissed_at IS NULL AND attempts >= 5 THEN 1 ELSE 0 END) AS exhausted_count,
         SUM(CASE WHEN synced_at IS NOT NULL THEN 1 ELSE 0 END) AS synced_count,
         SUM(CASE WHEN dismissed_at IS NOT NULL THEN 1 ELSE 0 END) AS dismissed_count
       FROM pending_billing_syncs`
    );
    res.json({
      open: Number(row.open_count) || 0,
      exhausted: Number(row.exhausted_count) || 0,
      synced: Number(row.synced_count) || 0,
      dismissed: Number(row.dismissed_count) || 0,
    });
  } catch (err) {
    console.error('[billing-syncs stats]', err.message);
    res.status(500).json({ error: 'Failed to load stats' });
  }
});

router.post('/billing-syncs/:id/retry', async (req, res) => {
  try {
    const { pool } = require('../config/database');
    const { getSetting, postJson } = require('../controllers/syncController');
    const [[row]] = await pool.query(
      `SELECT s.*, u.email AS customer_email, c.billing_customer_id
       FROM pending_billing_syncs s
       JOIN customers c ON c.id = s.customer_id
       JOIN users u ON u.id = c.user_id
       WHERE s.id = ?`,
      [req.params.id]
    );
    if (!row) return res.status(404).json({ error: 'Row not found' });
    if (row.synced_at)    return res.status(400).json({ error: 'Already synced' });
    if (row.dismissed_at) return res.status(400).json({ error: 'Row already dismissed' });

    const billingUrl = await getSetting('billing_api_url');
    const apiKey = await getSetting('billing_api_key');
    if (!billingUrl) return res.status(503).json({ error: 'Billing app URL not configured in Settings.' });

    try {
      await postJson(`${billingUrl.replace(/\/$/, '')}/api/support-upgrade`, apiKey, {
        billing_customer_id: row.billing_customer_id || null,
        email: row.customer_email,
        plan: row.plan,
        plan_expiry: row.plan_expiry,
        payment_ref: row.payment_ref,
        payment_mode: 'Razorpay',
        amount: Number(row.amount) || 0,
      });
      await pool.query(
        `UPDATE pending_billing_syncs
         SET synced_at = NOW(), attempts = attempts + 1, last_attempt_at = NOW(), last_error = NULL
         WHERE id = ?`,
        [req.params.id]
      );
      return res.json({ ok: true, message: 'Synced successfully' });
    } catch (err) {
      const errMsg = (err.message || String(err)).slice(0, 1000);
      await pool.query(
        `UPDATE pending_billing_syncs
         SET attempts = attempts + 1, last_attempt_at = NOW(), last_error = ?
         WHERE id = ?`,
        [errMsg, req.params.id]
      );
      return res.status(502).json({ error: `Billing app rejected the retry: ${errMsg}` });
    }
  } catch (err) {
    console.error('[billing-syncs retry]', err.message);
    res.status(500).json({ error: err.message || 'Retry failed' });
  }
});

router.post('/billing-syncs/:id/dismiss', async (req, res) => {
  try {
    const { pool } = require('../config/database');
    const note = (req.body?.note || '').toString().slice(0, 500);
    const [result] = await pool.query(
      `UPDATE pending_billing_syncs
       SET dismissed_at = NOW(), dismissed_by = ?, dismiss_note = ?
       WHERE id = ? AND synced_at IS NULL AND dismissed_at IS NULL`,
      [req.user.id, note || null, req.params.id]
    );
    if (!result.affectedRows) {
      return res.status(404).json({ error: 'Row not found or already closed' });
    }
    res.json({ ok: true, message: 'Marked as manually invoiced' });
  } catch (err) {
    console.error('[billing-syncs dismiss]', err.message);
    res.status(500).json({ error: 'Dismiss failed' });
  }
});

// Aggregate plan-change counts by kind in a date range — drives the "Plan
// Changes" KPI card on the Reports → Revenue tab.
router.get('/reports/plan-changes', async (req, res) => {
  try {
    const { pool } = require('../config/database');
    const from = req.query.from || null;
    const to = req.query.to || null;
    const params = [];
    let where = '1=1';
    if (from) { where += ' AND created_at >= ?'; params.push(from); }
    if (to)   { where += ' AND created_at <= ?'; params.push(to + ' 23:59:59'); }
    const [rows] = await pool.query(
      `SELECT change_kind, COUNT(*) AS count
       FROM plan_change_history
       WHERE ${where}
       GROUP BY change_kind`,
      params
    );
    // Normalize so the frontend always sees every kind even when zero
    const KINDS = ['signup', 'upgrade', 'downgrade', 'renewal', 'manual_admin', 'expiry_lapse'];
    const counts = Object.fromEntries(KINDS.map(k => [k, 0]));
    for (const r of rows) counts[r.change_kind] = Number(r.count);
    res.json({ counts });
  } catch (err) {
    console.error('[reports plan-changes]', err.message);
    res.status(500).json({ error: 'Failed to load plan-change stats' });
  }
});
router.post('/sync/pull',              triggerPullSync);
router.get('/plans',              getPlans);
router.put('/plans/:id',          updatePlan);
router.get('/calls',              getAdminCalls);
router.get('/reports/tickets',    getTicketReport);
router.get('/reports/revenue',    getRevenueReport);
router.get('/reports/usage',      getUsageReport);
router.get('/agents',             getAgents);
router.post('/agents',            createAgent);
router.put('/agents/:id/toggle',   toggleAgent);
router.delete('/agents/:id',       deleteAgent);
router.put('/agents/:id/password', changeAgentPassword);
router.put('/agents/:id/skills',   updateAgentSkills);
router.patch('/agents/:id/role',   changeAgentRole);
router.get('/tickets',            getAllTickets);
router.get('/tickets/:id',        getAdminTicketDetail);
router.put('/tickets/:id',        updateAnyTicket);
router.get('/chats',                  getAllChats);
router.get('/chats/analytics',        getChatAnalytics);
router.get('/chats/archive',          getChatArchive);
router.get('/chats/agent-statuses',   getAgentChatStatuses);
router.get('/chats/blacklist',        getBlacklist);
router.post('/chats/blacklist',       blockCustomer);
router.delete('/chats/blacklist/:id', unblockCustomer);

router.get('/calls/blacklist',        getCallBlacklist);
router.post('/calls/blacklist',       blockCustomerCalls);
router.delete('/calls/blacklist/:id', unblockCustomerCalls);

// Admin-only: send a test email to verify SMTP wiring + reply-to + BCC
// settings without having to trigger a real ticket flow. Uses the same
// sendMail path real emails go through so we exercise everything (sender
// name override, BCC, emails_disabled gate, etc.).
//
// Optional `templateKey` in the body — when supplied, dispatches to the
// real send function for that template with clearly-fake sample data
// (Sarah Chen / ticket #1247 / fake setup token / etc.) so admin can audit
// formatting and rendering of any of the 13 production templates without
// spinning up a real customer flow.
router.post('/settings/test-email', async (req, res) => {
  try {
    const { to, templateKey } = req.body || {};
    if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(to).trim())) {
      return res.status(400).json({ error: 'Provide a valid recipient email address' });
    }
    const recipient = to.trim();
    const emailUtils = require('../utils/emailUtils');

    let result;
    let humanLabel = 'Generic SMTP test';

    if (templateKey && String(templateKey).trim() && String(templateKey) !== 'generic') {
      const key = String(templateKey).trim();
      const entry = (emailUtils.TEMPLATE_REGISTRY || []).find(t => t.key === key);
      if (!entry) {
        return res.status(400).json({ error: `Unknown template: ${key}` });
      }
      humanLabel = entry.label;
      // Sample/dummy payloads for every template. Names + values are
      // deliberately fake so a real customer sees this and thinks "test."
      const sampleMessages = [
        { sender_role: 'customer', sender_name: 'Sarah Chen', message: 'Hi, my DNS verification keeps failing for acme-corp.com.', created_at: new Date(Date.now() - 600000) },
        { sender_role: 'agent',    sender_name: 'Priya Sharma', message: 'Hi Sarah! Could you share the exact error you see in the Workspace admin console?', created_at: new Date(Date.now() - 540000) },
        { sender_role: 'customer', sender_name: 'Sarah Chen', message: 'It says "TXT record not found at the root domain."', created_at: new Date(Date.now() - 480000) },
      ];
      const sampleArgs = {
        welcome_setup_link:    { to: recipient, name: 'Sarah Chen',    setupToken: 'test-token-sample-do-not-use', onboardingTicketId: 1247 },
        account_ready:         { to: recipient, name: 'Sarah Chen',    password: 'Sample-Pass-2025!',              onboardingTicketId: 1247 },
        otp_login:             { to: recipient, name: 'Sarah Chen',    otp: '482917' },
        usage_reset:           { to: recipient, customerName: 'Sarah Chen', callLimit: 60, chatLimit: 200 },
        ticket_created:        { to: recipient, customerName: 'Sarah Chen', ticketId: 1247, subject: 'DNS verification failing for acme-corp.com', description: 'Hi team,\n\nI added the TXT record Google gave me but the admin console still says "not found." It\'s been 6 hours. Help!' },
        agent_reply:           { to: recipient, customerName: 'Sarah Chen', ticketId: 1247, subject: 'DNS verification failing for acme-corp.com', agentName: 'Priya Sharma', message: 'Hi Sarah,\n\nThe record looks correct on our side. DNS propagation can take up to 24 hours — let\'s give it a few more hours and check again.\n\nIf it\'s still failing tomorrow, please paste the exact error from the admin console.\n\nBest,\nPriya' },
        rating_request:        { to: recipient, customerName: 'Sarah Chen', ticketId: 1247, subject: 'DNS verification failing for acme-corp.com' },
        cc_added_to_ticket:    { to: recipient, ticketId: 1247, subject: 'DNS verification failing for acme-corp.com', customerName: 'Sarah Chen' },
        chat_transcript:       { to: recipient, customerName: 'Sarah Chen', agentName: 'Priya Sharma', chatId: 8842, messages: sampleMessages },
        call_missed:           { to: recipient, customerName: 'Sarah Chen' },
        agent_welcome:         { to: recipient, name: 'Priya Sharma', password: 'Sample-Pass-2025!', role: 'agent' },
        customer_reply_to_agent:{to: recipient, agentName: 'Priya Sharma', customerName: 'Sarah Chen', ticketId: 1247, subject: 'DNS verification failing for acme-corp.com', message: 'Thanks Priya — I waited overnight, still the same error. Pasting the exact text:\n\n"TXT record not found at the root domain (anutech.in)."' },
        sla_breach_admin:      { to: recipient, ticketId: 1247, subject: 'DNS verification failing for acme-corp.com', customerName: 'Sarah Chen', priority: 'High', breachType: 'Response' },
        plan_upgraded_customer:{ to: recipient, customerName: 'Sarah Chen', planLabel: 'Premium', amount: '₹4,999.00', expiryDate: '11 Jun 2027', paymentRef: 'pay_sample_DO_NOT_USE_test_id' },
        plan_upgraded_admin:   { to: recipient, customerName: 'Sarah Chen', customerEmail: 'sarah@acme-corp.com', planLabel: 'Premium', amount: '₹4,999.00', paymentRef: 'pay_sample_DO_NOT_USE_test_id' },
        billing_sync_failed_admin: { to: recipient, customerName: 'Sarah Chen', customerEmail: 'sarah@acme-corp.com', planLabel: 'Premium', amount: '₹4,999.00', paymentRef: 'pay_sample_DO_NOT_USE_test_id', lastError: 'ECONNREFUSED — billing app did not respond on port 5050' },
        plan_expired_lapsed_to_free: { to: recipient, customerName: 'Sarah Chen', planLabel: 'Premium' },
        plan_lapsed_admin:           { to: recipient, lapsedListHtml: '<ul style="font-size:13px;color:#374151;padding-left:18px;margin:12px 0"><li style="margin-bottom:6px"><strong>Sarah Chen</strong> (sarah@acme-corp.com) — was on <strong>Premium</strong> until 10 Jun 2026</li><li style="margin-bottom:6px"><strong>John Lee</strong> (john@beta-inc.com) — was on <strong>Moderate</strong> until 10 Jun 2026</li></ul>', count: 2 },
      };
      const fnMap = {
        welcome_setup_link:     emailUtils.sendWelcomeEmail,
        account_ready:          emailUtils.sendAccountReadyEmail,
        otp_login:              emailUtils.sendOtpEmail,
        usage_reset:            emailUtils.sendUsageResetEmail,
        ticket_created:         emailUtils.sendTicketCreatedEmail,
        agent_reply:            emailUtils.sendAgentReplyEmail,
        rating_request:         emailUtils.sendRatingRequestEmail,
        cc_added_to_ticket:     emailUtils.sendCcAddedToTicketEmail,
        chat_transcript:        emailUtils.sendChatTranscriptEmail,
        call_missed:            emailUtils.sendCallMissedEmail,
        agent_welcome:          emailUtils.sendAgentWelcomeEmail,
        customer_reply_to_agent:emailUtils.sendCustomerReplyEmail,
        sla_breach_admin:       emailUtils.sendSlaBreachEmail,
        plan_upgraded_customer: emailUtils.sendPlanUpgradedCustomerEmail,
        plan_upgraded_admin:    emailUtils.sendPlanUpgradedAdminEmail,
        billing_sync_failed_admin: emailUtils.sendBillingSyncFailedEmail,
        plan_expired_lapsed_to_free: emailUtils.sendPlanLapsedToFreeEmail,
        plan_lapsed_admin:           emailUtils.sendPlanLapsedAdminDigestEmail,
      };
      const fn = fnMap[key];
      const args = sampleArgs[key];
      if (!fn || !args) {
        return res.status(400).json({ error: `No test handler wired for template: ${key}` });
      }
      result = await fn(args);
      // Some send functions return undefined on success — normalise
      if (!result) result = { ok: true };
    } else {
      result = await emailUtils.sendMail({
        to: recipient,
        subject: 'DSP — test email',
        html: `
          <p>This is a test email from your DSP support panel.</p>
          <p>If you got this, the outgoing-email pipeline (SMTP wiring, reply-to header, BCC archiving, sender name) is configured correctly.</p>
          <p>Triggered by: <strong>${req.user.email}</strong></p>
          <p>If you didn't expect this, your admin is verifying the email setup. You can safely ignore.</p>
        `,
      });
    }

    if (result && result.ok === false) {
      return res.status(500).json({ error: result.error || 'SMTP failed', detail: result });
    }
    if (result && result.skipped) {
      return res.json({
        ok: true,
        skipped: true,
        reason: result.reason || 'SMTP disabled',
        message: `Email was suppressed (${result.reason || 'SMTP disabled'}). Toggle "Disable all outgoing emails" off and set SMTP_ENABLED=true to send for real.`,
      });
    }
    res.json({ ok: true, message: `Test email sent to ${recipient} · ${humanLabel}` });
  } catch (err) {
    console.error('[test-email]', err);
    res.status(500).json({ error: err.message || 'Server error' });
  }
});

// Admin-only: paginated read of the inbound_email audit log so admin can
// see what the IMAP poller did with each incoming email (appended /
// quarantined / rejected / etc) and force-attach quarantined items to a
// specific ticket via the actions on the page.
router.get('/inbound-email', async (req, res) => {
  try {
    const { pool } = require('../config/database');
    const status = req.query.status || '';
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = parseInt(req.query.offset, 10) || 0;
    let where = '1=1';
    const params = [];
    if (status) { where += ' AND status = ?'; params.push(status); }
    const [rows] = await pool.query(
      `SELECT id, message_id, in_reply_to, from_email, from_name, subject, snippet,
              status, ticket_id, parent_ticket_id, note, raw_size, received_at
       FROM inbound_email
       WHERE ${where}
       ORDER BY received_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    const [[counts]] = await pool.query(`
      SELECT
        SUM(CASE WHEN status = 'appended' THEN 1 ELSE 0 END) AS appended,
        SUM(CASE WHEN status = 'reopened' THEN 1 ELSE 0 END) AS reopened,
        SUM(CASE WHEN status = 'new_ticket' THEN 1 ELSE 0 END) AS new_ticket,
        SUM(CASE WHEN status = 'quarantined' THEN 1 ELSE 0 END) AS quarantined,
        SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
        SUM(CASE WHEN status = 'autoreply_loop' THEN 1 ELSE 0 END) AS autoreply_loop,
        SUM(CASE WHEN status = 'dmarc_fail' THEN 1 ELSE 0 END) AS dmarc_fail,
        SUM(CASE WHEN status = 'ignored' THEN 1 ELSE 0 END) AS ignored,
        SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error,
        COUNT(*) AS total
      FROM inbound_email
      WHERE received_at > DATE_SUB(NOW(), INTERVAL 30 DAY)
    `);
    res.json({ items: rows, counts, limit, offset });
  } catch (err) {
    console.error('[admin inbound-email]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Force-attach a quarantined inbound email to a specific ticket (admin override).
router.post('/inbound-email/:id/attach', async (req, res) => {
  try {
    const { pool } = require('../config/database');
    const { ticket_id } = req.body || {};
    if (!ticket_id) return res.status(400).json({ error: 'ticket_id required' });
    const [[row]] = await pool.query('SELECT * FROM inbound_email WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Inbound email not found' });
    const [[ticket]] = await pool.query('SELECT id, customer_id FROM tickets WHERE id = ?', [ticket_id]);
    if (!ticket) return res.status(404).json({ error: 'Target ticket not found' });
    const [[userRow]] = await pool.query('SELECT user_id FROM customers WHERE id = ?', [ticket.customer_id]);
    // Use the full body if we have it (everything captured from 12 Jun 2026
    // onwards), fall back to the collapsed snippet for legacy rows.
    const rawBody = (row.body_text && row.body_text.trim())
      || (row.snippet && row.snippet.trim())
      || '(empty body)';
    const receivedAt = row.received_at
      ? new Date(row.received_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })
      : 'unknown time';
    // Structured header block so the body sits cleanly below — was previously
    // a single jammed paragraph that made HTML emails unreadable in the ticket.
    const body = [
      `[Inbound email attached by admin]`,
      `From:     ${row.from_name ? `${row.from_name} <${row.from_email}>` : row.from_email}`,
      `Subject:  ${row.subject || '(no subject)'}`,
      `Received: ${receivedAt}`,
      ``,
      rawBody,
    ].join('\n');
    await pool.query(
      `INSERT INTO ticket_messages (ticket_id, sender_id, message, via_email, created_at) VALUES (?, ?, ?, 1, NOW())`,
      [ticket_id, userRow?.user_id || null, body]
    );
    await pool.query('UPDATE tickets SET updated_at = NOW() WHERE id = ?', [ticket_id]);
    await pool.query("UPDATE inbound_email SET status = 'appended', ticket_id = ?, note = CONCAT(COALESCE(note,''), ' [force-attached by admin]') WHERE id = ?", [ticket_id, req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[admin inbound-email attach]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin-only manual redirect of a ringing call to a different agent. The
// in-memory call state lives in chatSocket — we delegate there via the
// exported `redirectRingingCall` helper.
router.post('/calls/:id/redirect', async (req, res) => {
  try {
    const { agent_id } = req.body || {};
    if (!agent_id) return res.status(400).json({ error: 'agent_id is required' });
    const { redirectRingingCall } = require('../socket/chatSocket');
    const io = req.app.get('io');
    if (!io) return res.status(500).json({ error: 'Socket layer unavailable' });
    const result = await redirectRingingCall(io, req.params.id, agent_id);
    res.json({ message: 'Call redirected', ...result });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('[admin redirect-call]', err);
    res.status(500).json({ error: 'Server error' });
  }
});
router.put('/chats/:id/assign',       assignChat);
router.get('/chats/:id/messages',     getArchivedChatMessages);
router.post('/tickets/bulk',      bulkUpdateTickets);
router.get('/reports/export',         exportReportCsv);
// Drill-down endpoints for the click-into-details modal on Reports. The
// `/drill/` prefix avoids collision with the chart-aggregate routes above
// (`/reports/tickets` already serves the chart, can't be reused for records).
router.get('/reports/drill/tickets',   getReportTickets);
router.get('/reports/drill/invoices',  getReportInvoices);
router.get('/reports/drill/calls',     getReportCalls);
router.get('/reports/drill/chats',     getReportChats);
router.get('/reports/drill/customers', getReportCustomers);
router.get('/reports/drill/agents',    getReportAgents);

// Custom Reports — saved admin queries that show on the Custom Reports tab.
router.get('/custom-reports',           listCustomReports);
router.post('/custom-reports',          createCustomReport);
router.put('/custom-reports/:id',       updateCustomReport);
router.delete('/custom-reports/:id',    deleteCustomReport);
router.get('/custom-reports/:id/count', getCustomReportCount);
router.get('/performance',                  getAgentPerformance);
router.get('/performance/agent/:id/ratings', getAgentReviews);

// Ticket templates (admin manages)
router.get('/templates',          getTemplates);
router.post('/templates',         createTemplate);
router.put('/templates/:id',      updateTemplate);
router.delete('/templates/:id',   deleteTemplate);

// Chat canned responses — internal-only snippets agents insert into live chats.
router.get('/canned-responses',          getCannedResponses);
router.post('/canned-responses',         createCannedResponse);
router.put('/canned-responses/:id',      updateCannedResponse);
router.delete('/canned-responses/:id',   deleteCannedResponse);

// Email templates (admin-editable copies of the 5 most-customised system emails)
router.get('/email-templates',                listEmailTemplates);
router.get('/email-templates/:key',           getEmailTemplate);
router.put('/email-templates/:key',           saveEmailTemplate);
router.delete('/email-templates/:key',        resetEmailTemplate);
router.post('/email-templates/:key/preview',  previewEmailTemplate);
router.get('/settings',                    getSettings);
router.put('/settings',                    updateSettings);
router.post('/customers/lookup-billing',   lookupBillingCustomer);
router.post('/customers/import',           importBillingCustomer);
router.post('/customers/manual',           createManualCustomer);
router.post('/customers/bulk-import',      bulkImportCustomers);
router.post('/customers/bulk-action',      bulkCustomerAction);

module.exports = router;
