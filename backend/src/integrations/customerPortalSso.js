/**
 * Phase 1 integration: Customer Panel (domain-management-system) -> Support
 * Panel single sign-on.
 *
 * Verifies the short-lived handoff token minted by the Customer Panel's
 * lib/integrations/support-sso.ts, finds-or-creates the matching DSP
 * customer (reusing the existing billing-sync upsert logic so we don't
 * duplicate find-or-create rules), and issues a normal DSP session via the
 * same helpers authController.login() uses.
 */

const jwt = require('jsonwebtoken');
const { pool } = require('../config/database');
const { upsertCustomer } = require('../controllers/syncController');
const { _signToken: signToken, _rotateSession: rotateSession, _bootOtherSockets: bootOtherSockets } = require('../controllers/authController');

// Single-use guard for SSO tokens (replay protection). An in-memory Map is
// safe here because DSP runs as a single PM2 fork-mode process, not
// clustered (see SETUP.md: `pm2 start src/server.js --name dsp`, no -i flag).
// If DSP is ever moved to cluster mode, this needs to move to MySQL/shared
// storage instead.
const usedJti = new Map(); // jti -> expiry (ms epoch)
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [jti, expiresAt] of usedJti) {
    if (expiresAt < now) usedJti.delete(jti);
  }
}, SWEEP_INTERVAL_MS).unref();

function verifyAndConsumeToken(token) {
  const secret = process.env.SSO_SHARED_SECRET;
  if (!secret) throw new Error('SSO_SHARED_SECRET is not configured');

  const payload = jwt.verify(token, secret, { algorithms: ['HS256'] });
  if (payload.purpose !== 'dsp-sso') throw new Error('Invalid token purpose');
  if (!payload.jti) throw new Error('Token missing jti');
  if (usedJti.has(payload.jti)) throw new Error('Token already used');

  const expiresAtMs = (payload.exp || Math.floor(Date.now() / 1000) + 60) * 1000;
  usedJti.set(payload.jti, expiresAtMs);
  return payload;
}

/**
 * @param {string} token - the signed handoff token from the Customer Panel
 * @param {import('socket.io').Server | undefined} io
 * @returns {Promise<{ ok: true, token: string, user: object } | { ok: false, reason: string }>}
 */
async function loginViaCustomerPortalSso(token, io) {
  const payload = verifyAndConsumeToken(token);
  const dmsUserId = payload.sub;
  const { email, name } = payload;
  if (!dmsUserId || !email || !name) {
    throw new Error('Token missing required fields');
  }

  // Find-or-create via the existing billing-sync upsert so this path follows
  // the same rules as the ResellerOS/billing connector (match by
  // billing_customer_id OR email, default new customers to Free plan).
  // status: 'active' — a customer arriving via SSO is, by definition,
  // currently logged into the Customer Panel, so their DSP account should be
  // active on first creation (upsertCustomer defaults unspecified status to
  // inactive, which is right for billing-driven sync but wrong here).
  const result = await upsertCustomer({
    billing_customer_id: dmsUserId,
    email,
    name,
    status: 'active',
  });

  let userId = result.user_id;
  if (!userId) {
    const [[customerRow]] = await pool.query('SELECT user_id FROM customers WHERE id = ?', [result.customer_id]);
    userId = customerRow?.user_id;
  }
  if (!userId) throw new Error('Could not resolve DSP user after upsert');

  const [[user]] = await pool.query('SELECT * FROM users WHERE id = ?', [userId]);
  if (!user) throw new Error('DSP user not found after upsert');

  // Respect an admin-deactivated account — SSO must not resurrect it.
  if (!user.is_active) {
    return { ok: false, reason: 'account_deactivated' };
  }

  // Don't let a cross-app handoff silently defeat 2FA the customer
  // specifically enabled on their DSP account — fall back to a normal login
  // so they still have to complete it.
  if (user.totp_enabled) {
    return { ok: false, reason: 'totp_required' };
  }

  // Reuse the existing session (same jti) instead of rotating when the
  // customer already has a live one — this is a same-browser handoff from
  // the Customer Panel, not a new device logging in. Rotating here would
  // invalidate any DSP tab already open (via bootOtherSockets' "last-login-
  // wins" kick), which is exactly what happens if a customer bounces back to
  // the Customer Panel and clicks Support a second time while their first
  // DSP tab is still open. Only mint a fresh jti (real rotation, with the
  // normal kick-other-sessions behavior) when there's no active session yet.
  const jti = user.active_session_jti || (await rotateSession(user.id));
  if (!user.active_session_jti) {
    await bootOtherSockets(io, user.id);
  }
  const sessionToken = signToken(user, jti);

  const [[customer]] = await pool.query('SELECT id FROM customers WHERE user_id = ?', [user.id]);

  return {
    ok: true,
    token: sessionToken,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      customerId: customer?.id || null,
    },
  };
}

module.exports = { loginViaCustomerPortalSso };
