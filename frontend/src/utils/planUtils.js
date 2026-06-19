// Date-only string (YYYY-MM-DD) for a date/string, in local time. Mirrors the
// backend's planUtils.toDateStr so the admin panel computes plan status exactly
// the way the server (and customer panel) does — no more admin/customer
// disagreement on the expiry day (bug #34).
function toDateStr(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Canonical plan view for the admin panel — the SAME rule the backend uses.
//   active      – free plan, OR paid plan still within its expiry day, OR a
//                 paid plan with no expiry set (legacy: don't lock anyone out)
//   noExpirySet – paid plan with NO expiry date (legacy limbo → show a flag so
//                 the admin sets one; new paid customers always require a date)
//   isFree      – free / lifetime plan
export function planView(customer) {
  const isFree = customer?.plan_name === 'free';
  const hasExpiry = !!customer?.plan_expiry;
  const noExpirySet = !isFree && !hasExpiry && !!customer?.plan_name;
  const withinDate = hasExpiry && toDateStr(customer.plan_expiry) >= toDateStr(new Date());
  const active = isFree || noExpirySet || withinDate;
  return { active, noExpirySet, isFree };
}

export function calculateFinalPriceFE(planName, invoiceSubtotal) {
  const config = {
    basic:    { percentage: 0.05, minimum: 3000 },
    moderate: { percentage: 0.10, minimum: 8000 },
    premium:  { percentage: 0.15, minimum: 20000 },
  };
  const c = config[planName];
  if (!c) return 0;
  return Math.max(invoiceSubtotal * c.percentage, c.minimum);
}
