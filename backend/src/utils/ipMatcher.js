// IPv4 matcher used by the admin IP allowlist gate.
// Accepts a comma-separated string of single IPs and/or CIDR blocks
// (e.g. "203.0.113.5, 198.51.100.0/24") and returns whether the candidate
// IP is in the list. IPv6 not supported — express's req.ip strips the
// IPv4-mapped prefix for us, and the rest of the codebase doesn't require v6.

function ipToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = parseInt(p, 10);
    if (isNaN(v) || v < 0 || v > 255) return null;
    n = (n * 256) + v;
  }
  return n;
}

function cidrToRange(cidr) {
  const [base, bitsStr] = cidr.split('/');
  const bits = parseInt(bitsStr, 10);
  if (isNaN(bits) || bits < 0 || bits > 32) return null;
  const baseInt = ipToInt(base);
  if (baseInt === null) return null;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  const network = (baseInt & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  return [network, broadcast];
}

function ipAllowed(candidate, allowlist) {
  if (!candidate || !allowlist) return false;
  const candidateInt = ipToInt(candidate);
  if (candidateInt === null) return false;
  const entries = allowlist.split(',').map(s => s.trim()).filter(Boolean);
  for (const entry of entries) {
    if (entry.includes('/')) {
      const range = cidrToRange(entry);
      if (range && candidateInt >= range[0] && candidateInt <= range[1]) return true;
    } else {
      const entryInt = ipToInt(entry);
      if (entryInt !== null && entryInt === candidateInt) return true;
    }
  }
  return false;
}

module.exports = { ipAllowed, ipToInt, cidrToRange };
