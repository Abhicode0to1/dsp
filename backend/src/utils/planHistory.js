// Shared logger for the plan_change_history table.
// Used by:
//   • customerController.verifyUpgrade        → 'upgrade' / 'renewal' / 'downgrade'
//   • adminController.updateCustomer          → 'manual_admin'
//   • adminController.createManualCustomer    → 'signup'
//   • expiryWorker (Phase 4)                  → 'expiry_lapse'
//   • Admin manual renew endpoint (Phase 4)   → 'renewal' or 'manual_admin'
//
// Best-effort: errors are swallowed and logged. A failed audit log entry
// MUST NOT roll back the actual plan change — losing history is preferable
// to losing the customer's paid plan upgrade.

const { pool } = require('../config/database');

async function logPlanChange({
  customerId,
  fromPlanId = null,
  toPlanId,
  changeKind,
  changedBy = null,
  amountPaid = null,
  paymentRef = null,
  expiryBefore = null,
  expiryAfter = null,
  note = null,
}) {
  try {
    if (!customerId || !toPlanId || !changeKind) {
      console.warn('[planHistory] missing required field, skipping', { customerId, toPlanId, changeKind });
      return;
    }
    // Resolve plan names so the history row is readable even after a plan rename.
    const ids = [fromPlanId, toPlanId].filter(Boolean);
    const [planRows] = ids.length
      ? await pool.query(
          `SELECT id, name FROM plans WHERE id IN (${ids.map(() => '?').join(',')})`,
          ids
        )
      : [[]];
    const planMap = new Map(planRows.map(p => [p.id, p.name]));
    await pool.query(
      `INSERT INTO plan_change_history
        (customer_id, from_plan_id, to_plan_id, from_plan_name, to_plan_name,
         change_kind, changed_by, amount_paid, payment_ref,
         expiry_before, expiry_after, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        customerId,
        fromPlanId || null,
        toPlanId,
        fromPlanId ? (planMap.get(fromPlanId) || null) : null,
        planMap.get(toPlanId) || null,
        changeKind,
        changedBy,
        amountPaid,
        paymentRef,
        expiryBefore,
        expiryAfter,
        note,
      ]
    );
  } catch (err) {
    console.error('[planHistory] insert failed:', err.message);
  }
}

// Compute the kind from from/to plan tiers. Useful for callers that just
// know "this is a plan change" but not whether it's an upgrade or downgrade.
const PLAN_TIER = { free: 0, basic: 1, moderate: 2, premium: 3 };
function inferKind(fromPlanName, toPlanName) {
  const f = PLAN_TIER[String(fromPlanName || '').toLowerCase()] ?? 0;
  const t = PLAN_TIER[String(toPlanName || '').toLowerCase()] ?? 0;
  if (t > f) return 'upgrade';
  if (t < f) return 'downgrade';
  return 'renewal';
}

module.exports = { logPlanChange, inferKind };
