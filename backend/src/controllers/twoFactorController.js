// 2FA (TOTP) endpoints. The login controller emits a partial token + the
// `requires_2fa` flag when the user has 2FA enabled or when require_admin_2fa
// is on and they're an admin who hasn't enrolled yet. This file handles the
// rest of the lifecycle: enrolment, verification at login, and disabling.
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { pool } = require('../config/database');
const { generateSecret, verifyCode, otpauthUri, generateBackupCodes, hashBackupCode } = require('../utils/totp');

const signSessionToken = (user, jti) =>
  jwt.sign(
    { id: user.id, email: user.email, role: user.role, jti },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );

async function rotateSession(userId) {
  const jti = crypto.randomBytes(16).toString('hex');
  await pool.query('UPDATE users SET active_session_jti = ? WHERE id = ?', [jti, userId]);
  return jti;
}

// Returns the current 2FA enrolment status for the signed-in user.
exports.status = async (req, res) => {
  try {
    const [[row]] = await pool.query(
      'SELECT totp_enabled FROM users WHERE id = ?',
      [req.user.id]
    );
    const { getBoolSetting } = require('../utils/settings');
    const globalRequired = await getBoolSetting('require_admin_2fa', false);
    res.json({
      enabled: row?.totp_enabled === 1,
      globally_required: globalRequired,
      // Admin needs to set up 2FA if global setting is on AND they haven't yet.
      must_setup: globalRequired && req.user.role === 'admin' && row?.totp_enabled !== 1,
    });
  } catch (err) {
    console.error('[2fa status]', err);
    res.status(500).json({ error: 'Server error' });
  }
};

// Step 1 of enrolment: generate a fresh secret + the otpauth URI the user's
// authenticator app consumes from the QR code. The secret is held in the
// session via a short-lived signed token; nothing is persisted until they
// confirm a code in step 2 (no half-enrolled accounts).
exports.setupInit = async (req, res) => {
  try {
    const secret = generateSecret();
    const uri = otpauthUri({ secret, label: req.user.email, issuer: 'DSP Support' });
    // Setup token: holds the candidate secret + the user's id, expires in 10
    // min. The setup-confirm endpoint requires this back so we can verify
    // the user's code against the secret they're enrolling.
    const setup_token = jwt.sign(
      { id: req.user.id, candidate_secret: secret, step: '2fa-setup' },
      process.env.JWT_SECRET,
      { expiresIn: '10m' }
    );
    res.json({ secret, otpauth_uri: uri, setup_token });
  } catch (err) {
    console.error('[2fa setupInit]', err);
    res.status(500).json({ error: 'Server error' });
  }
};

// Step 2: user types the 6-digit code their authenticator showed. We verify
// against the secret embedded in the setup_token; if it matches, persist the
// secret + flip the totp_enabled flag + generate one-time backup codes.
exports.setupConfirm = async (req, res) => {
  try {
    const { setup_token, code } = req.body || {};
    if (!setup_token || !code) return res.status(400).json({ error: 'setup_token and code are required' });
    let decoded;
    try {
      decoded = jwt.verify(setup_token, process.env.JWT_SECRET);
    } catch {
      return res.status(400).json({ error: 'Setup expired — please start over.' });
    }
    if (decoded.step !== '2fa-setup' || decoded.id !== req.user.id) {
      return res.status(400).json({ error: 'Invalid setup token' });
    }
    if (!verifyCode(decoded.candidate_secret, code)) {
      return res.status(400).json({ error: 'Code did not match. Make sure your phone\'s time is in sync and try again.' });
    }
    // Generate + hash backup codes. Plain codes are shown to the user EXACTLY
    // ONCE (here). Hashes go to the DB; the plain values are never recoverable.
    const plainCodes = generateBackupCodes(8);
    const hashedList = plainCodes.map(hashBackupCode);
    await pool.query(
      'UPDATE users SET totp_secret = ?, totp_enabled = 1, backup_codes_hash = ? WHERE id = ?',
      [decoded.candidate_secret, JSON.stringify(hashedList), req.user.id]
    );
    res.json({
      ok: true,
      backup_codes: plainCodes,
      message: 'Two-factor enabled. Save the backup codes — they are shown only once.',
    });
  } catch (err) {
    console.error('[2fa setupConfirm]', err);
    res.status(500).json({ error: 'Server error' });
  }
};

// User disables their own 2FA. Requires a current TOTP code (or backup code)
// so a stolen-but-unlocked session can't quietly remove the protection.
exports.disable = async (req, res) => {
  try {
    const { code } = req.body || {};
    if (!code) return res.status(400).json({ error: 'Current code required to disable 2FA' });
    const [[row]] = await pool.query(
      'SELECT totp_secret, totp_enabled, backup_codes_hash FROM users WHERE id = ?',
      [req.user.id]
    );
    if (!row?.totp_enabled) return res.status(400).json({ error: '2FA is not enabled on this account' });
    const valid = verifyCode(row.totp_secret, code) || await tryBackupCode(row, code);
    if (!valid) return res.status(400).json({ error: 'Code did not match' });
    // Global-require gate: admin can't disable their own 2FA if the global
    // setting requires it. They have to ask another admin to turn the setting
    // off first.
    try {
      const { getBoolSetting } = require('../utils/settings');
      const globalRequired = await getBoolSetting('require_admin_2fa', false);
      if (globalRequired && req.user.role === 'admin') {
        return res.status(403).json({ error: '2FA is required for admins globally — turn off the setting in Admin → Settings first.' });
      }
    } catch {}
    await pool.query(
      'UPDATE users SET totp_secret = NULL, totp_enabled = 0, backup_codes_hash = NULL WHERE id = ?',
      [req.user.id]
    );
    res.json({ ok: true, message: 'Two-factor disabled.' });
  } catch (err) {
    console.error('[2fa disable]', err);
    res.status(500).json({ error: 'Server error' });
  }
};

// Login step 2: takes the partial token from login + the 6-digit code (or a
// backup code), and if valid, issues the real session JWT exactly the way
// the password-only login would.
exports.verifyLogin = async (req, res) => {
  try {
    const { partial_token, code } = req.body || {};
    if (!partial_token || !code) return res.status(400).json({ error: 'partial_token and code are required' });
    let decoded;
    try {
      decoded = jwt.verify(partial_token, process.env.JWT_SECRET);
    } catch {
      return res.status(401).json({ error: 'Partial token expired. Please log in again.' });
    }
    if (decoded.step !== '2fa') return res.status(401).json({ error: 'Invalid partial token' });
    const [[user]] = await pool.query(
      'SELECT id, name, email, role, totp_secret, totp_enabled, backup_codes_hash, first_login_at FROM users WHERE id = ? AND is_active = TRUE',
      [decoded.id]
    );
    if (!user) return res.status(401).json({ error: 'Account not found' });
    if (!user.totp_enabled) {
      return res.status(400).json({ error: 'This account doesn\'t have 2FA yet — please go through the setup flow first.' });
    }
    const valid = verifyCode(user.totp_secret, code) || await tryBackupCode(user, code);
    if (!valid) return res.status(401).json({ error: 'Code did not match. Try again or use a backup code.' });

    // Look up customer_id if applicable
    let customerId = null;
    if (user.role === 'customer') {
      const [cRows] = await pool.query('SELECT id FROM customers WHERE user_id = ?', [user.id]);
      customerId = cRows[0]?.id || null;
    }
    if (!user.first_login_at) {
      pool.query('UPDATE users SET first_login_at = NOW() WHERE id = ? AND first_login_at IS NULL', [user.id]).catch(() => {});
    }
    const jti = await rotateSession(user.id);
    const token = signSessionToken(user, jti);
    res.json({
      token,
      user: {
        id: user.id, name: user.name, email: user.email, role: user.role,
        customerId, is_first_login: !user.first_login_at,
      },
    });
  } catch (err) {
    console.error('[2fa verifyLogin]', err);
    res.status(500).json({ error: 'Server error' });
  }
};

// Backup code path: matches a hashed entry, then removes it from the list so
// it can never be reused. Returns true if a match was found + consumed.
async function tryBackupCode(userRow, submitted) {
  try {
    const list = userRow.backup_codes_hash || [];
    if (!Array.isArray(list) || !list.length) return false;
    const target = require('../utils/totp').hashBackupCode(submitted);
    const idx = list.indexOf(target);
    if (idx === -1) return false;
    list.splice(idx, 1);
    await pool.query('UPDATE users SET backup_codes_hash = ? WHERE id = ?', [JSON.stringify(list), userRow.id]);
    console.log(`[2fa] Backup code consumed for ${userRow.email} (${list.length} remaining)`);
    return true;
  } catch (err) {
    console.error('[2fa tryBackupCode]', err);
    return false;
  }
}
