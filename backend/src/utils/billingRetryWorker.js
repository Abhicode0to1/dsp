// Billing-app sync retry worker.
// Picks up rows from pending_billing_syncs where the initial POST to the
// billing app failed (verifyUpgrade caught the error and queued the row).
// Re-tries every 5 minutes, max 5 attempts. After attempt 5 fails, fires a
// second admin alert ("retries exhausted") and leaves the row in place so an
// admin can use the "Resync" button or "Mark manually invoiced" on the
// /admin/billing-syncs page.

const { pool } = require('../config/database');
const { getSetting, postJson } = require('../controllers/syncController');
const { sendBillingSyncFailedEmail } = require('./emailUtils');
const { heartbeat } = require('./heartbeat');

const MAX_ATTEMPTS = 5;
const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
let timer = null;
let running = false;

async function tickOnce() {
  if (running) return;
  running = true;
  let tickError = null;
  try {
    const [rows] = await pool.query(
      `SELECT s.*, u.email AS customer_email, u.name AS customer_name
       FROM pending_billing_syncs s
       JOIN customers c ON c.id = s.customer_id
       JOIN users u ON u.id = c.user_id
       WHERE s.synced_at IS NULL
         AND s.dismissed_at IS NULL
         AND s.attempts < ?
       ORDER BY s.created_at ASC
       LIMIT 50`,
      [MAX_ATTEMPTS]
    );
    if (!rows.length) return;

    const billingUrl = await getSetting('billing_api_url');
    const apiKey = await getSetting('billing_api_key');
    if (!billingUrl) {
      // No billing app configured — pause silently; admin will see the rows
      // on the queue page and can dismiss them manually.
      return;
    }

    for (const r of rows) {
      try {
        const [[cust]] = await pool.query(
          'SELECT billing_customer_id FROM customers WHERE id = ?',
          [r.customer_id]
        );
        await postJson(`${billingUrl.replace(/\/$/, '')}/api/support-upgrade`, apiKey, {
          billing_customer_id: cust?.billing_customer_id || null,
          email: r.customer_email,
          plan: r.plan,
          plan_expiry: r.plan_expiry,
          payment_ref: r.payment_ref,
          payment_mode: 'Razorpay',
          amount: Number(r.amount) || 0,
        });
        await pool.query(
          `UPDATE pending_billing_syncs
           SET synced_at = NOW(), attempts = attempts + 1, last_attempt_at = NOW(), last_error = NULL
           WHERE id = ?`,
          [r.id]
        );
        console.log(`[billingRetry] row #${r.id} synced after ${r.attempts + 1} attempt(s)`);
      } catch (err) {
        const newAttempts = (r.attempts || 0) + 1;
        const errMsg = (err.message || String(err)).slice(0, 1000);
        await pool.query(
          `UPDATE pending_billing_syncs
           SET attempts = ?, last_attempt_at = NOW(), last_error = ?
           WHERE id = ?`,
          [newAttempts, errMsg, r.id]
        );
        console.error(`[billingRetry] row #${r.id} attempt ${newAttempts}/${MAX_ATTEMPTS} failed:`, errMsg);

        // Second admin email when we just used up the final retry
        if (newAttempts >= MAX_ATTEMPTS) {
          try {
            const [admins] = await pool.query(
              "SELECT email FROM users WHERE role = 'admin' AND is_active = TRUE"
            );
            const adminEmails = admins.map(a => a.email).filter(Boolean);
            if (adminEmails.length) {
              const planLabel = String(r.plan || '').charAt(0).toUpperCase() + String(r.plan || '').slice(1);
              const amountDisplay = r.amount
                ? `₹${Number(r.amount).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                : `₹0.00`;
              sendBillingSyncFailedEmail({
                to: adminEmails.join(', '),
                customerName: r.customer_name || r.customer_email,
                customerEmail: r.customer_email,
                planLabel,
                amount: amountDisplay,
                paymentRef: r.payment_ref,
                lastError: `Retries exhausted (${MAX_ATTEMPTS}/${MAX_ATTEMPTS}). Last error: ${errMsg}`,
              }).catch(e => console.error('[billingRetry] exhaustion email', e.message));
            }
          } catch (e) {
            console.error('[billingRetry] exhaustion admin lookup', e.message);
          }
        }
      }
    }
  } catch (err) {
    tickError = err.message || String(err);
    console.error('[billingRetry] worker error:', tickError);
  } finally {
    running = false;
    await heartbeat('billingRetryWorker', {
      status: tickError ? 'error' : 'ok',
      error: tickError,
      intervalSeconds: POLL_INTERVAL_MS / 1000,
    });
  }
}

function start() {
  if (timer) return;
  // Run once after a short startup delay, then on the regular interval.
  setTimeout(() => tickOnce().catch(() => {}), 30 * 1000);
  timer = setInterval(() => tickOnce().catch(() => {}), POLL_INTERVAL_MS);
  console.log(`[billingRetry] worker started — polling every ${POLL_INTERVAL_MS / 60000} min, max ${MAX_ATTEMPTS} attempts`);
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { start, stop, tickOnce };
