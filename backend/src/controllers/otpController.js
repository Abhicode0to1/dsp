const { pool } = require('../config/database');
const { sendOtpEmail } = require('../utils/emailUtils');
const crypto = require('crypto');
const {
  _signToken: signToken,
  _rotateSession: rotateSession,
  _isCurrentlyLoggedIn: isCurrentlyLoggedIn,
} = require('./authController');

exports.requestOtp = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const [[user]] = await pool.query(
      'SELECT id, name, email, role, is_active FROM users WHERE email = ?', [email]
    );
    if (!user || !user.is_active) return res.status(400).json({ error: 'Account not found' });

    // Generate 6-digit OTP
    const otp = String(Math.floor(100000 + crypto.randomInt(900000)));
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 min

    // Invalidate old OTPs for this user
    await pool.query('UPDATE otp_codes SET used = TRUE WHERE user_id = ? AND used = FALSE', [user.id]);

    await pool.query(
      'INSERT INTO otp_codes (user_id, code, expires_at) VALUES (?, ?, ?)',
      [user.id, otp, expiresAt]
    );

    await sendOtpEmail({ to: user.email, name: user.name, otp });
    res.json({ message: 'OTP sent to your email', userId: user.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.verifyOtp = async (req, res) => {
  try {
    const { userId, code } = req.body;
    if (!userId || !code) return res.status(400).json({ error: 'userId and code required' });

    const [[otpRow]] = await pool.query(
      `SELECT * FROM otp_codes WHERE user_id = ? AND code = ? AND used = FALSE AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 1`,
      [userId, code]
    );

    if (!otpRow) return res.status(400).json({ error: 'Invalid or expired OTP' });

    await pool.query('UPDATE otp_codes SET used = TRUE WHERE id = ?', [otpRow.id]);

    const [[user]] = await pool.query(
      'SELECT id, name, email, role, active_session_jti, first_login_at FROM users WHERE id = ?', [userId]
    );

    if (!user) return res.status(400).json({ error: 'Account not found. Please contact support.' });

    // Same single-device check the password login uses — if this user has a
    // live socket connection elsewhere right now, refuse the new login so the
    // existing tab keeps its session. Without this, OTP would silently kick
    // the active tab on every login (different jti = old token rejected).
    const io = req.app.get('io');
    if (await isCurrentlyLoggedIn(io, user.id, user.active_session_jti)) {
      return res.status(409).json({
        error: 'This account is already signed in on another device. Please sign out there first.',
        code: 'session_conflict',
      });
    }

    // If customer, attach customer_id to the response so the frontend doesn't
    // need a second round-trip.
    let customerId = null;
    if (user.role === 'customer') {
      const [cRows] = await pool.query('SELECT id FROM customers WHERE user_id = ?', [user.id]);
      customerId = cRows[0]?.id || null;
    }

    // Rotate the session jti + sign the JWT with the same shape the password
    // path uses (id + email + role + jti). Without this, the auth middleware's
    // active_session_jti comparison fails on the very next request — that was
    // the "Your session has ended" loop the admin reported.
    const jti = await rotateSession(user.id);
    const token = signToken(user, jti);

    // Fire-and-forget first_login_at marker so the customer tour wizard knows
    // whether to fire — mirrors the password login.
    if (!user.first_login_at) {
      pool.query('UPDATE users SET first_login_at = NOW() WHERE id = ? AND first_login_at IS NULL', [user.id])
        .catch(() => {});
    }

    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        customerId,
        is_first_login: !user.first_login_at,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};
