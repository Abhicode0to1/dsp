const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { pool } = require('../config/database');
const { sendOtpEmail } = require('../utils/emailUtils');

const signToken = (user, jti) =>
  jwt.sign(
    { id: user.id, email: user.email, role: user.role, jti },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );

// Exposed so other auth paths (OTP login, future SSO, etc.) issue tokens that
// pass the single-device-session check in middleware/auth.js. Without these,
// a JWT minted directly will fail the active_session_jti comparison on the
// very next request — surfacing as a confusing "Your session has ended" 401.
exports._signToken = signToken;

// Single-device login enforcement. Generates a fresh session id and persists
// it against the user. We deliberately do NOT kick existing sockets here —
// the login handler checks isCurrentlyLoggedIn() first and rejects the request
// when an active session exists, so by the time we get here we know the slot
// is free.
async function rotateSession(userId) {
  const jti = crypto.randomBytes(16).toString('hex');
  await pool.query('UPDATE users SET active_session_jti = ?, session_last_seen = NOW() WHERE id = ?', [jti, userId]);
  return jti;
}
exports._rotateSession = rotateSession;

// "Is this user actively signed in right now?" — answered by checking the
// socket.io room they'd be in if their browser is open. Socket disconnects on
// browser close / tab close / network drop, so this is the truest "live"
// signal we have without polling timestamps. Conservative fallback when io
// isn't available (e.g. tests): assume yes, since blocking a duplicate login
// is the safer default than allowing it.
async function isCurrentlyLoggedIn(io, userId, jtiInDb) {
  if (!jtiInDb) return false;
  if (!io) return true;
  try {
    const sockets = await io.in(`user_${userId}`).fetchSockets();
    return sockets.length > 0;
  } catch {
    return true;
  }
}
exports._isCurrentlyLoggedIn = isCurrentlyLoggedIn;

exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: 'Email and password are required' });

    const [rows] = await pool.query(
      'SELECT * FROM users WHERE email = ? AND is_active = TRUE',
      [email.toLowerCase().trim()]
    );
    if (!rows.length)
      return res.status(401).json({ error: 'Invalid credentials' });

    const user = rows[0];
    const valid = await bcrypt.compare(password, user.password);
    if (!valid)
      return res.status(401).json({ error: 'Invalid credentials' });

    // Single-device enforcement (block-new). Refuse a new login while this
    // account already has an active session used within the idle window.
    // RELIABLE — it does NOT depend on a live socket (a backgrounded mobile
    // PWA drops its socket but the session is still "held"). The slot frees on
    // explicit logout (jti cleared) or after SESSION_IDLE_MS of inactivity
    // (safety net against permanent lockout if the first device just closes).
    const SESSION_IDLE_MS = 30 * 60 * 1000; // 30 minutes
    const lastSeenMs = user.session_last_seen ? new Date(user.session_last_seen).getTime() : 0;
    if (user.active_session_jti && lastSeenMs && (Date.now() - lastSeenMs) < SESSION_IDLE_MS) {
      return res.status(409).json({
        error: 'This account is already signed in on another device. Please log out there first.',
        code: 'session_conflict',
      });
    }

    // If customer, fetch customer_id
    let customerId = null;
    if (user.role === 'customer') {
      const [cRows] = await pool.query(
        'SELECT id FROM customers WHERE user_id = ?',
        [user.id]
      );
      customerId = cRows[0]?.id || null;
    }

    // 2FA gate. Two cases:
    //   (a) User has 2FA enabled on their own account → MUST submit a code.
    //   (b) `require_admin_2fa` is on globally AND this is an admin who hasn't
    //       set it up yet → return a `mustSetup2FA` flag so the frontend can
    //       walk them through enrollment before issuing a session.
    // In both cases we return a short-lived partial token that proves the
    // password was correct; the /2fa/verify-login endpoint exchanges it +
    // a code for the real session JWT.
    let requireGlobal = false;
    try {
      const { getBoolSetting } = require('../utils/settings');
      requireGlobal = await getBoolSetting('require_admin_2fa', false);
    } catch {}

    const needs2FA = user.totp_enabled === 1;
    const mustSetup = !needs2FA && requireGlobal && user.role === 'admin';

    if (needs2FA || mustSetup) {
      // Partial token: 5-minute TTL, marked `step: '2fa'` so authenticate()
      // middleware rejects it on normal API endpoints — only /2fa/verify-login
      // accepts it.
      const partial = jwt.sign(
        { id: user.id, email: user.email, role: user.role, step: '2fa' },
        process.env.JWT_SECRET,
        { expiresIn: '5m' }
      );
      return res.json({
        requires_2fa: true,
        must_setup_2fa: mustSetup,
        partial_token: partial,
      });
    }

    // Record first-login timestamp so the customer tour wizard knows whether to fire.
    // Done as a fire-and-forget UPDATE so a slow write doesn't delay the login response.
    if (!user.first_login_at) {
      pool.query('UPDATE users SET first_login_at = NOW() WHERE id = ? AND first_login_at IS NULL', [user.id])
        .catch(() => {});
    }

    const jti = await rotateSession(user.id);
    const token = signToken(user, jti);
    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        customerId,
        // Front-end consumes this to decide whether the customer-tour wizard should run.
        // True on the FIRST login (first_login_at was still null when we read the row).
        is_first_login: !user.first_login_at,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// GET /api/auth/setup-password/:token — validate a setup token (no body, no auth)
// Returns the customer's name/email so the setup page can greet them. 404 if the
// token is unknown or expired.
exports.checkSetupToken = async (req, res) => {
  try {
    const { token } = req.params;
    const [[user]] = await pool.query(
      `SELECT id, name, email FROM users
       WHERE password_setup_token = ? AND password_setup_expires_at > NOW() AND is_active = TRUE`,
      [token]
    );
    if (!user) return res.status(404).json({ error: 'This setup link is invalid or has expired. Ask your account manager to send a new one.' });
    res.json({ user: { name: user.name, email: user.email } });
  } catch (err) {
    console.error('checkSetupToken', err);
    res.status(500).json({ error: 'Server error' });
  }
};

// POST /api/auth/setup-password — { token, new_password }
// Validates the token, sets the password, marks token as used, and logs the user in.
exports.setupPassword = async (req, res) => {
  try {
    const { token, new_password } = req.body;
    if (!token || !new_password) return res.status(400).json({ error: 'Token and new password are required' });
    if (new_password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    const [[user]] = await pool.query(
      `SELECT * FROM users
       WHERE password_setup_token = ? AND password_setup_expires_at > NOW() AND is_active = TRUE`,
      [token]
    );
    if (!user) return res.status(404).json({ error: 'This setup link is invalid or has expired' });

    const hashed = await bcrypt.hash(new_password, 10);
    await pool.query(
      `UPDATE users SET password = ?, password_setup_token = NULL, password_setup_expires_at = NULL
       WHERE id = ?`,
      [hashed, user.id]
    );

    // Auto-login — same shape as /login response so the front-end can treat it identically.
    let customerId = null;
    if (user.role === 'customer') {
      const [cRows] = await pool.query('SELECT id FROM customers WHERE user_id = ?', [user.id]);
      customerId = cRows[0]?.id || null;
    }
    if (!user.first_login_at) {
      pool.query('UPDATE users SET first_login_at = NOW() WHERE id = ? AND first_login_at IS NULL', [user.id])
        .catch(() => {});
    }
    const jti = await rotateSession(user.id);
    const jwtToken = signToken(user, jti);
    res.json({
      token: jwtToken,
      user: { id: user.id, name: user.name, email: user.email, role: user.role, customerId, is_first_login: !user.first_login_at },
    });
  } catch (err) {
    console.error('setupPassword', err);
    res.status(500).json({ error: 'Server error' });
  }
};

// POST /api/auth/logout — clears the active session id so the JWT can no
// longer be used, and disconnects any other tabs/devices the user has open
// under this account. This is what frees up the "single-device login" slot
// so another login attempt can succeed.
exports.logout = async (req, res) => {
  try {
    await pool.query('UPDATE users SET active_session_jti = NULL, session_last_seen = NULL WHERE id = ?', [req.user.id]);
    // Boot any other tabs the same user has open — otherwise their lingering
    // sockets would keep `isCurrentlyLoggedIn` returning true, and a fresh
    // login attempt would still get rejected even though the user "logged
    // out". `session_revoked` triggers the frontend's automatic redirect to
    // /login.
    const io = req.app.get('io');
    if (io) {
      try {
        const sockets = await io.in(`user_${req.user.id}`).fetchSockets();
        for (const s of sockets) {
          s.emit('session_revoked', { reason: 'logged_out' });
          s.disconnect(true);
        }
      } catch {}
    }
    res.json({ message: 'Logged out' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};

// Accepts EITHER `current_password` OR `otp_code` as proof. The OTP path lets
// customers who only ever log in via email OTP change their password without
// knowing the placeholder hash on their record. Both proofs are equally strong:
// password = "you know the secret", OTP = "you control the registered inbox".
exports.changePassword = async (req, res) => {
  try {
    const { current_password, new_password, otp_code } = req.body;
    if (!new_password)
      return res.status(400).json({ error: 'New password is required' });
    if (!current_password && !otp_code)
      return res.status(400).json({ error: 'Provide your current password or verify via email OTP' });
    if (new_password.length < 8)
      return res.status(400).json({ error: 'New password must be at least 8 characters' });

    const [[user]] = await pool.query('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (otp_code) {
      // OTP path — same single-use + 10-min-TTL semantics as the login OTP.
      const [[otpRow]] = await pool.query(
        `SELECT id FROM otp_codes
         WHERE user_id = ? AND code = ? AND used = FALSE AND expires_at > NOW()
         ORDER BY created_at DESC LIMIT 1`,
        [req.user.id, String(otp_code).trim()]
      );
      if (!otpRow) return res.status(400).json({ error: 'Invalid or expired OTP' });
      await pool.query('UPDATE otp_codes SET used = TRUE WHERE id = ?', [otpRow.id]);
    } else {
      const valid = await bcrypt.compare(current_password, user.password || '');
      if (!valid) return res.status(400).json({ error: 'Current password is incorrect' });
    }

    const hashed = await bcrypt.hash(new_password, 12);
    await pool.query('UPDATE users SET password = ? WHERE id = ?', [hashed, req.user.id]);

    // Audit log — only meaningful for customers (admins/agents have their own
    // password-change paths we may want to log later). Recording against the
    // CUSTOMER id keeps the entry visible in that customer's Activity tab.
    // Fire-and-forget; never blocks the response.
    if (req.user.role === 'customer') {
      pool.query('SELECT id FROM customers WHERE user_id = ?', [req.user.id])
        .then(([rows]) => {
          const customerId = rows[0]?.id;
          if (!customerId) return;
          return pool.query(
            `INSERT INTO audit_log (actor_id, actor_name, actor_role, action, entity_type, entity_id, new_value, ip_address)
             VALUES (?, ?, ?, ?, 'customer', ?, ?, ?)`,
            [req.user.id, req.user.name, 'customer',
             otp_code ? 'password_changed_self_otp' : 'password_changed_self',
             customerId,
             JSON.stringify({ via: otp_code ? 'email_otp' : 'current_password' }),
             req.ip || null]
          );
        })
        .catch(err => console.error('[audit] customer self-password change', err.message));
    }

    res.json({ message: 'Password updated successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// Send a 6-digit OTP to the logged-in user's registered email. Used by the
// Change Password form when the customer doesn't know their current password
// (typically OTP-only accounts). Reuses the otp_codes table + sendOtpEmail so
// there's a single OTP pipeline to monitor.
exports.requestChangePasswordOtp = async (req, res) => {
  try {
    const [[user]] = await pool.query(
      'SELECT id, name, email, is_active FROM users WHERE id = ?',
      [req.user.id]
    );
    if (!user || !user.is_active) return res.status(404).json({ error: 'Account not found' });

    const otp = String(Math.floor(100000 + crypto.randomInt(900000)));
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    // Invalidate any prior unused OTPs for this user — same single-use guard as
    // the login flow. A user who just requested a login OTP and then switches
    // to change-password will get a fresh code; the prior one is consumed.
    await pool.query('UPDATE otp_codes SET used = TRUE WHERE user_id = ? AND used = FALSE', [user.id]);
    await pool.query(
      'INSERT INTO otp_codes (user_id, code, expires_at) VALUES (?, ?, ?)',
      [user.id, otp, expiresAt]
    );

    const r = await sendOtpEmail({ to: user.email, name: user.name, otp });
    if (r && r.ok === false) {
      // SMTP failed — tell the user so they're not stuck waiting on a
      // mail that will never arrive. The OTP row stays in the DB; if SMTP
      // recovers, the user can retry and a new code replaces this one.
      return res.status(502).json({ error: `Could not send OTP email: ${r.error || 'mail server unavailable'}` });
    }
    res.json({ message: 'OTP sent to your registered email' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.getMe = async (req, res) => {
  try {
    let customerId = null;
    if (req.user.role === 'customer') {
      const [cRows] = await pool.query(
        'SELECT id FROM customers WHERE user_id = ?',
        [req.user.id]
      );
      customerId = cRows[0]?.id || null;
    }
    res.json({ ...req.user, customerId });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};
