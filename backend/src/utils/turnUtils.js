// TURN / ICE server provider.
//
// Production uses Cloudflare Realtime TURN (https://developers.cloudflare.com/realtime/turn/),
// which issues SHORT-LIVED credentials via API — so we mint them server-side
// and hand the resulting iceServers to the client before each call. If the
// Cloudflare env vars aren't set (or the API call fails), we fall back to the
// free public STUN/TURN list so calls still work in dev / before keys are set.
//
// Set in production:
//   CLOUDFLARE_TURN_KEY_ID      — the Turn Key ID from the Cloudflare dashboard
//   CLOUDFLARE_TURN_API_TOKEN   — that key's API token

const TTL_SECONDS = 86400; // 24h credential lifetime

// Read the TURN creds from admin_settings first (manageable from the Settings
// UI), falling back to env. Read live so a Settings change takes effect on the
// next call without a restart.
async function getCreds() {
  let keyId = '', token = '';
  try {
    const { getSetting } = require('./settings');
    keyId = (await getSetting('cloudflare_turn_key_id', '')).toString().trim();
    token = (await getSetting('cloudflare_turn_api_token', '')).toString().trim();
  } catch {}
  keyId = keyId || process.env.CLOUDFLARE_TURN_KEY_ID || '';
  token = token || process.env.CLOUDFLARE_TURN_API_TOKEN || '';
  return { keyId, token };
}

// Free public fallback — fine for dev / small scale, unreliable at scale.
const FREE_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:global.stun.twilio.com:3478' },
  {
    urls: [
      'turn:openrelay.metered.ca:80',
      'turn:openrelay.metered.ca:80?transport=tcp',
      'turn:openrelay.metered.ca:443',
      'turn:openrelay.metered.ca:443?transport=tcp',
      'turns:openrelay.metered.ca:443',
    ],
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
];

// Cache the minted Cloudflare creds so we don't hit their API on every call.
// Refreshed at half the TTL; keyed by the key id so changing creds in Settings
// invalidates the cache automatically. invalidateTurnCache() drops it on save.
let cache = null; // { iceServers, expiresAt, sig }

function invalidateTurnCache() { cache = null; }

async function getIceServers() {
  const { keyId, token } = await getCreds();
  if (!keyId || !token) return FREE_ICE_SERVERS;
  if (cache && cache.sig === keyId && cache.expiresAt > Date.now()) return cache.iceServers;

  try {
    const resp = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ttl: TTL_SECONDS }),
      }
    );
    if (!resp.ok) throw new Error(`Cloudflare TURN responded ${resp.status}`);
    const data = await resp.json();
    // Cloudflare returns { iceServers: { urls: [...], username, credential } }
    const cf = data?.iceServers;
    if (!cf || !cf.urls) throw new Error('Cloudflare TURN: no iceServers in response');

    const iceServers = [cf];
    cache = { iceServers, expiresAt: Date.now() + (TTL_SECONDS / 2) * 1000, sig: keyId };
    return iceServers;
  } catch (err) {
    console.error('[turn] Cloudflare credential fetch failed — using free fallback:', err.message);
    return FREE_ICE_SERVERS;
  }
}

// Async because creds now come from the settings store. Kept for callers that
// want to know whether real TURN (vs the free fallback) is active.
async function isConfigured() {
  const { keyId, token } = await getCreds();
  return Boolean(keyId && token);
}

module.exports = { getIceServers, isConfigured, invalidateTurnCache };
