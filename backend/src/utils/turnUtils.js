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

const KEY_ID    = process.env.CLOUDFLARE_TURN_KEY_ID;
const API_TOKEN = process.env.CLOUDFLARE_TURN_API_TOKEN;
const TTL_SECONDS = 86400; // 24h credential lifetime
const isConfigured = Boolean(KEY_ID && API_TOKEN);

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
// Refreshed at half the TTL so credentials never expire mid-call.
let cache = null; // { iceServers, expiresAt }

async function getIceServers() {
  if (!isConfigured) return FREE_ICE_SERVERS;
  if (cache && cache.expiresAt > Date.now()) return cache.iceServers;

  try {
    const resp = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${KEY_ID}/credentials/generate`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${API_TOKEN}`,
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
    cache = { iceServers, expiresAt: Date.now() + (TTL_SECONDS / 2) * 1000 };
    return iceServers;
  } catch (err) {
    console.error('[turn] Cloudflare credential fetch failed — using free fallback:', err.message);
    return FREE_ICE_SERVERS;
  }
}

module.exports = { getIceServers, isConfigured };
