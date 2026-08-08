// Daily expiry worker. Runs once a day at 1am IST.
//
// For each customer whose plan_expiry has passed and who is NOT already on
// the Free plan:
//   1. UPDATE customers SET plan_id = <free>, plan_expiry = NULL
//   2. INSERT row into plan_change_history (kind = 'expiry_lapse')
//   3. Email the customer ("you're now on Free")
//
// At the end of the run, if any customers lapsed, email every active admin
// a single daily digest listing them — NOT one email per customer.
//
// Per user policy: no grace period (same-day drop). No reminder emails — the
// billing app handles renewal reminders.
//
// Toggle: admin_settings.auto_lapse_to_free = '0' skips the entire job.

const { pool } = require('../config/database');
const { getSetting } = require('./settings');
const { logPlanChange } = require('./planHistory');
const { sendPlanLapsedToFreeEmail, sendPlanLapsedAdminDigestEmail } = require('./emailUtils');
const { heartbeat } = require('./heartbeat');
const billing = require('../billing');

// Best-effort notify Billing that this customer lapsed to Free, so its
// subscriptions table doesn't keep a stale paid plan/renewal_date around
// forever. Mirrors the notify call in customerController.js's verifyUpgrade,
// but for the no-payment Free case. Never throws — a failure here must not
// stop the local lapse (DSP's own plan change already succeeded).
async function notifyBillingOfLapse({ billingCustomerId, email }) {
  try {
    const cfg = await billing.getConfig();
    if (!cfg.baseUrl) return;
    const origin = cfg.baseUrl.replace(/\/api\/v1\/?$/, '');
    await billing._requestJson(
      'POST',
      billing._joinUrl(origin, '/api/support-upgrade'),
      { ...billing._authHeaders(cfg), 'Content-Type': 'application/json' },
      { billing_customer_id: billingCustomerId || null, email, plan: 'free' }
    );
  } catch (e) {
    console.error('[expiryWorker] billing lapse-notify failed for', email, ':', e.message);
  }
}

// 24h between scheduled ticks; admin Run-Now would be more frequent but the
// dashboard "is the worker alive" check uses this as the overdue threshold.
const EXPECTED_INTERVAL_S = 24 * 3600;

let timer = null;
let running = false;

// Returns the next 01:00 local time as a JS Date.
function nextOneAm() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(1, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next;
}

async function tickOnce() {
  if (running) return;
  running = true;
  let tickError = null;
  let skipReason = null;
  try {
    const enabled = (await getSetting('auto_lapse_to_free', '1')).toString();
    if (enabled !== '1') {
      console.log('[expiryWorker] auto_lapse_to_free=0 — skipping run');
      skipReason = 'auto_lapse_to_free=0';
      return;
    }

    // Resolve the Free plan id once — bail if missing (corrupt install)
    const [[freePlan]] = await pool.query("SELECT id, name FROM plans WHERE name = 'free' LIMIT 1");
    if (!freePlan) {
      console.error('[expiryWorker] free plan missing from plans table — aborting');
      return;
    }
    const freePlanId = freePlan.id;

    // All customers with a past expiry on a non-Free plan
    const [expired] = await pool.query(
      `SELECT c.id, c.plan_id, c.plan_expiry, c.billing_customer_id, u.email, u.name AS user_name, p.name AS plan_name
       FROM customers c
       JOIN users u ON u.id = c.user_id
       LEFT JOIN plans p ON p.id = c.plan_id
       WHERE c.plan_id != ?
         AND c.plan_expiry IS NOT NULL
         AND c.plan_expiry < CURDATE()`,
      [freePlanId]
    );
    if (!expired.length) {
      console.log('[expiryWorker] no customers to lapse today');
      return;
    }

    console.log(`[expiryWorker] lapsing ${expired.length} customer(s) to Free`);

    const lapsedRows = [];
    for (const cust of expired) {
      try {
        await pool.query(
          'UPDATE customers SET plan_id = ?, plan_expiry = NULL WHERE id = ?',
          [freePlanId, cust.id]
        );
        await logPlanChange({
          customerId: cust.id,
          fromPlanId: cust.plan_id,
          toPlanId: freePlanId,
          changeKind: 'expiry_lapse',
          expiryBefore: cust.plan_expiry,
          expiryAfter: null,
          note: `Auto-lapse: plan expired on ${new Date(cust.plan_expiry).toISOString().split('T')[0]}`,
        });
        const planLabel = (cust.plan_name || 'paid').charAt(0).toUpperCase() + (cust.plan_name || 'paid').slice(1);
        // Customer email — fire and forget so SMTP errors don't fail the loop
        sendPlanLapsedToFreeEmail({
          to: cust.email,
          customerName: cust.user_name || 'there',
          planLabel,
        }).catch(err => console.error('[expiryWorker] customer email', cust.email, err.message));
        // This is a background job, not an HTTP handler — safe to await
        // rather than fire-and-forget. notifyBillingOfLapse never throws.
        await notifyBillingOfLapse({ billingCustomerId: cust.billing_customer_id, email: cust.email });
        lapsedRows.push({ ...cust, planLabel });
      } catch (e) {
        console.error(`[expiryWorker] failed to lapse customer ${cust.id}:`, e.message);
      }
    }

    // Single daily admin digest with all lapsed customers
    if (lapsedRows.length) {
      try {
        const [admins] = await pool.query(
          "SELECT email FROM users WHERE role = 'admin' AND is_active = TRUE"
        );
        const adminEmails = admins.map(a => a.email).filter(Boolean);
        if (adminEmails.length) {
          const escape = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          const listItems = lapsedRows.map(r =>
            `<li style="margin-bottom:6px"><strong>${escape(r.user_name || r.email)}</strong> (${escape(r.email)}) — was on <strong>${escape(r.planLabel)}</strong> until ${new Date(r.plan_expiry).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</li>`
          ).join('');
          const lapsedListHtml = `<ul style="font-size:13px;color:#374151;padding-left:18px;margin:12px 0">${listItems}</ul>`;
          await sendPlanLapsedAdminDigestEmail({
            to: adminEmails.join(', '),
            lapsedListHtml,
            count: lapsedRows.length,
          }).catch(err => console.error('[expiryWorker] admin digest', err.message));
        }
      } catch (e) {
        console.error('[expiryWorker] admin lookup', e.message);
      }
    }
  } catch (err) {
    tickError = err.message || String(err);
    console.error('[expiryWorker] tick error:', tickError);
  } finally {
    running = false;
    await heartbeat('expiryWorker', {
      status: tickError ? 'error' : (skipReason ? 'skipped' : 'ok'),
      error: tickError || skipReason,
      intervalSeconds: EXPECTED_INTERVAL_S,
    });
  }
}

function scheduleNext() {
  const ms = nextOneAm().getTime() - Date.now();
  timer = setTimeout(async () => {
    await tickOnce();
    scheduleNext();
  }, Math.max(60_000, ms));
}

function start() {
  if (timer) return;
  scheduleNext();
  console.log('[expiryWorker] scheduled — next run at', nextOneAm().toLocaleString('en-IN'));
}

function stop() {
  if (timer) { clearTimeout(timer); timer = null; }
}

// Manually-triggerable (used by an admin "Run lapse worker now" button in
// future, or for unit tests). Always runs synchronously regardless of cron.
module.exports = { start, stop, tickOnce };
