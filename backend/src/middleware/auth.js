const jwt = require('jsonwebtoken');
const { pool } = require('../config/database');

const authenticate = async (req, res, next) => {
  const header = req.headers['authorization'];
  // Allow token via query param as fallback (needed for <img src> and <a download> tags)
  const token = (header && header.startsWith('Bearer '))
    ? header.split(' ')[1]
    : req.query.token;

  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    // Partial 2FA-step tokens are NOT real sessions — they only carry the
    // password-was-correct proof, not a session jti. Refuse them on every
    // normal API endpoint; only /2fa/verify-login accepts them.
    if (decoded.step === '2fa') {
      return res.status(401).json({ error: 'Two-factor verification required', code: 'needs_2fa' });
    }
    const [rows] = await pool.query(
      'SELECT id, name, email, role, is_active, active_session_jti, session_last_seen FROM users WHERE id = ?',
      [decoded.id]
    );
    if (!rows.length || !rows[0].is_active) {
      return res.status(401).json({ error: 'User not found or inactive' });
    }
    // Single-device enforcement: if a newer login overwrote the active session
    // id, this token is stale and must be rejected. NULL active_session_jti
    // means no session is currently considered active (post-logout) — also
    // rejected so logged-out tokens can't be reused.
    if (decoded.jti !== rows[0].active_session_jti) {
      return res.status(401).json({
        error: rows[0].active_session_jti
          ? 'You signed in on another device. This session has ended.'
          : 'Session ended. Please log in again.',
        code: 'session_revoked',
      });
    }
    req.user = rows[0];
    // Refresh this session's last-seen (throttled to ~once/min) so block-new
    // single-device login knows the session is still active — without relying
    // on a live socket. Fire-and-forget; never blocks the request.
    const lastSeenMs = rows[0].session_last_seen ? new Date(rows[0].session_last_seen).getTime() : 0;
    if (Date.now() - lastSeenMs > 60000) {
      pool.query('UPDATE users SET session_last_seen = NOW() WHERE id = ?', [decoded.id]).catch(() => {});
    }
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};

const requireRole = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user.role)) {
    return res.status(403).json({ error: 'Forbidden: insufficient permissions' });
  }
  next();
};

module.exports = { authenticate, requireRole };
