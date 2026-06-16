// Single helper every background worker calls once per tick. Writes one row
// per worker into worker_heartbeats (upsert keyed on `name`) so the System
// Health panel can show last-run-ago + status without each worker needing
// its own persistence path.
//
// Usage at the top of a worker tick:
//   const { heartbeat } = require('./heartbeat');
//   await heartbeat('slaWorker', { intervalSeconds: 60 });
//   try { ... } catch (e) {
//     await heartbeat('slaWorker', { status: 'error', error: e.message });
//   }
//
// `intervalSeconds` is the expected gap between ticks — used by the dashboard
// to decide when "last_run_at" is overdue (showing the worker as dead).
// Always defaulted on first insert; subsequent calls don't need to repeat it
// unless the cadence changed.

const { pool } = require('../config/database');

async function heartbeat(name, opts = {}) {
  const {
    status = 'ok',
    error = null,
    intervalSeconds,
  } = opts;
  if (!name) return;
  try {
    await pool.query(
      `INSERT INTO worker_heartbeats (name, last_run_at, last_status, last_error, expected_interval_seconds, run_count)
       VALUES (?, NOW(), ?, ?, ?, 1)
       ON DUPLICATE KEY UPDATE
         last_run_at = NOW(),
         last_status = VALUES(last_status),
         last_error  = VALUES(last_error),
         expected_interval_seconds = COALESCE(VALUES(expected_interval_seconds), expected_interval_seconds),
         run_count = run_count + 1`,
      [
        name,
        status,
        error ? String(error).slice(0, 1000) : null,
        intervalSeconds != null ? intervalSeconds : null,
      ]
    );
  } catch (e) {
    // Heartbeat itself must never crash a worker — log + swallow.
    console.error('[heartbeat]', name, e.message);
  }
}

module.exports = { heartbeat };
