// TOTP (RFC 6238) implementation — no third-party deps, written against the
// HMAC-SHA1 / 30-second-window standard that Google Authenticator, Authy,
// 1Password, Microsoft Authenticator, etc. all implement by default.
//
// Why hand-rolled: avoids a runtime dep + lets us share the same code with
// any browser-side preview if we ever need one. ~80 LOC.
const crypto = require('crypto');

// Base32 alphabet (RFC 4648, no padding) — what authenticator apps expect.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function toBase32(buffer) {
  let bits = 0, value = 0, out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function fromBase32(str) {
  const clean = str.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// Generate a 160-bit (20-byte) random secret, base32-encoded for app entry.
function generateSecret() {
  return toBase32(crypto.randomBytes(20));
}

// Compute the 6-digit TOTP for a given secret + epoch counter. Window = 30s.
function totpForCounter(secret, counter) {
  const key = fromBase32(secret);
  const buf = Buffer.alloc(8);
  // 64-bit big-endian counter; counter < 2^53 in practice so high bytes are 0.
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24)
             | ((hmac[offset + 1] & 0xff) << 16)
             | ((hmac[offset + 2] & 0xff) << 8)
             | (hmac[offset + 3] & 0xff);
  return String(code % 1000000).padStart(6, '0');
}

function nowCounter() {
  return Math.floor(Date.now() / 1000 / 30);
}

// Verify a user-submitted 6-digit code against the secret. Accepts ±1 window
// (90 seconds total) to tolerate clock drift between server and phone.
function verifyCode(secret, code) {
  if (!secret || !code) return false;
  const clean = String(code).replace(/\s/g, '').padStart(6, '0');
  if (!/^\d{6}$/.test(clean)) return false;
  const c = nowCounter();
  for (const delta of [-1, 0, 1]) {
    if (totpForCounter(secret, c + delta) === clean) return true;
  }
  return false;
}

// Build the otpauth:// URI that authenticator apps consume from a QR code.
// `label` is what the app shows the user (e.g. "DSP Support · admin@x.com").
function otpauthUri({ secret, label, issuer = 'DSP Support' }) {
  const safeLabel = encodeURIComponent(label);
  const safeIssuer = encodeURIComponent(issuer);
  return `otpauth://totp/${safeIssuer}:${safeLabel}`
       + `?secret=${secret}&issuer=${safeIssuer}&algorithm=SHA1&digits=6&period=30`;
}

// Backup codes: 8 codes, 8 characters each (groups of 4, dash-separated for
// readability). Stored hashed; verifying compares the submitted code's hash
// against the stored list and removes it on use (one-time).
function generateBackupCodes(count = 8) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    const buf = crypto.randomBytes(4);
    const hex = buf.toString('hex').toUpperCase();
    codes.push(`${hex.slice(0, 4)}-${hex.slice(4, 8)}`);
  }
  return codes;
}

function hashBackupCode(code) {
  return crypto.createHash('sha256').update(code.toUpperCase().replace(/[^A-F0-9]/g, '')).digest('hex');
}

module.exports = {
  generateSecret,
  verifyCode,
  otpauthUri,
  generateBackupCodes,
  hashBackupCode,
  totpForCounter, // exported for tests
};
