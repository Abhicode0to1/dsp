const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { login, logout, getMe, changePassword, requestChangePasswordOtp, checkSetupToken, setupPassword } = require('../controllers/authController');
const { authenticate } = require('../middleware/auth');

// Rate-limit ONLY brute-forceable endpoints (login, password change). Don't apply
// to /me — that's a token-check that fires on every page load + socket reconnect,
// which would silently exhaust the quota during normal browsing and lock the user
// out without them ever typing a password.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many attempts, try again in 15 minutes' },
});
const passwordChangeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { error: 'Too many password changes, try again later' },
});
// Separate limiter for the OTP-request endpoint — costlier (sends real mail)
// so be stricter, but still allow a few retries if SMTP hiccups.
const passwordChangeOtpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many OTP requests, try again in 15 minutes' },
});

// Setup-password endpoints are public (the token IS the auth). Light rate-limit so
// they can't be brute-forced — 30/15min is plenty for a real user even on retries.
const setupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: 'Too many setup attempts, try again later' },
});

// Staff IP allowlist gate — runs before login. Per-role, DB-backed lists of
// single IPs and/or CIDR ranges (comma-separated):
//   admin role → `admin_ip_allowlist`
//   agent role → `agent_ip_allowlist`
// Empty list for a role = allow all (no enforcement for that role). Customers
// are NEVER gated, so the customer panel stays publicly reachable. When a
// role's list is non-empty, only requests from a matching IP are let through;
// everyone else gets a 403 before their password is even validated. The lists
// are editable from admin Settings, so IPs can be changed without a redeploy.
// NOTE: behind a reverse proxy / Cloudflare, `req.ip` depends on `trust proxy`
// being set to the correct hop count (or CF-Connecting-IP being forwarded) so
// it reflects the real client, not the proxy.
async function ipAllowlistGate(req, res, next) {
  // BREAK-GLASS: if a bad allowlist ever locks you out, set
  // DISABLE_IP_ALLOWLIST=true in the backend .env and `pm2 reload` to bypass
  // this gate entirely, log in, fix the lists in admin Settings, then remove
  // the env line and reload. Logged loudly so it can't be silently left on.
  if (process.env.DISABLE_IP_ALLOWLIST === 'true') {
    console.warn('[IP allowlist] ⚠ BYPASSED — DISABLE_IP_ALLOWLIST=true is set. Remove it from .env once you have recovered access.');
    return next();
  }
  try {
    const targetEmail = (req.body?.email || '').toLowerCase().trim();
    if (!targetEmail) return next();

    const { pool } = require('../config/database');
    const [[user]] = await pool.query('SELECT role FROM users WHERE LOWER(email) = ? LIMIT 1', [targetEmail]);
    if (!user) return next();

    // Pick the list for this role; customers (and any other role) are exempt.
    const settingKey = user.role === 'admin' ? 'admin_ip_allowlist'
                      : user.role === 'agent' ? 'agent_ip_allowlist'
                      : null;
    if (!settingKey) return next();

    const { getSetting } = require('../utils/settings');
    const allowlistRaw = (await getSetting(settingKey, '')).toString().trim();
    if (!allowlistRaw) return next(); // empty = no enforcement for this role

    const { ipAllowed } = require('../utils/ipMatcher');
    const remoteIp = (req.ip || req.connection?.remoteAddress || '').replace(/^::ffff:/, '');
    if (!ipAllowed(remoteIp, allowlistRaw)) {
      console.warn(`[IP allowlist] Blocked ${user.role} login attempt for ${targetEmail} from ${remoteIp}`);
      const label = user.role === 'admin' ? 'Admin' : 'Agent';
      return res.status(403).json({ error: `${label} login is restricted from this network. Contact your administrator if you believe this is wrong.` });
    }
    next();
  } catch (err) {
    console.error('[ipAllowlistGate]', err);
    next(); // never fail-closed on a config-reading error — would lock everyone out
  }
}

router.post('/login', loginLimiter, ipAllowlistGate, login);
router.post('/logout', authenticate, logout);
router.get('/me', authenticate, getMe);
router.put('/change-password', authenticate, passwordChangeLimiter, changePassword);
router.post('/change-password/request-otp', authenticate, passwordChangeOtpLimiter, requestChangePasswordOtp);
router.get('/setup-password/:token', setupLimiter, checkSetupToken);
router.post('/setup-password',       setupLimiter, setupPassword);

// ── 2FA ───────────────────────────────────────────────────────────────────
const twoFactor = require('../controllers/twoFactorController');
// verify-login uses a partial token (not a session token) — no `authenticate`.
router.post('/2fa/verify-login', loginLimiter, twoFactor.verifyLogin);
// status + enrolment + disable all need a real session.
router.get('/2fa/status',         authenticate, twoFactor.status);
router.post('/2fa/setup-init',    authenticate, twoFactor.setupInit);
router.post('/2fa/setup-confirm', authenticate, twoFactor.setupConfirm);
router.post('/2fa/disable',       authenticate, twoFactor.disable);

module.exports = router;
