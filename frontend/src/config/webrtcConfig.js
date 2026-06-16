// Shared ICE server config for ALL WebRTC peer connections (customer + agent,
// inbound + outbound). Free OpenRelay credentials are public — fine for dev /
// small-scale, but consider swapping for Twilio/Cloudflare TURN before serious
// production usage (rate limits + reliability).
//
// Why TURN matters: STUN-only configs fail when both peers are behind symmetric
// NAT (corporate networks, most mobile carriers). The classic symptom is a call
// that "connects" at signaling but never carries audio — exactly what bug #11
// reported. TURN relays the media stream through a public server so the path is
// guaranteed to work regardless of NAT type.
// NOTE: these are all FREE/public servers — better than nothing and good for
// testing, but free TURN is rate-limited and intermittently down. For reliable
// calls in production, set a paid TURN provider (Twilio / Cloudflare / metered
// paid) — ideally via env so it's swappable without a code change.
import api from '../services/api';

export const ICE_CONFIG = {
  iceServers: [
    // STUN — multiple providers so candidate gathering still works if one is down.
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
    { urls: 'stun:global.stun.twilio.com:3478' },
    // TURN relays — needed when both peers are behind symmetric NAT (mobile
    // carriers, corporate networks). Listed on every port/transport so at least
    // one path survives restrictive firewalls (443/tcp usually gets through).
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
  ],
  iceCandidatePoolSize: 4,
};

// Preferred way to get the RTCPeerConnection config: ask the backend, which
// returns Cloudflare TURN credentials in production (short-lived, minted via
// their API) or the free fallback above otherwise. Result is cached briefly so
// rapid call setup doesn't refetch. Always falls back to the static ICE_CONFIG
// if the request fails, so calls never break on a network hiccup.
let _iceCache = null; // { config, expiresAt }

export async function getIceConfig() {
  if (_iceCache && _iceCache.expiresAt > Date.now()) return _iceCache.config;
  try {
    const res = await api.get('/turn/credentials');
    const iceServers = res?.data?.iceServers;
    if (Array.isArray(iceServers) && iceServers.length) {
      const config = { iceServers, iceCandidatePoolSize: 4 };
      _iceCache = { config, expiresAt: Date.now() + 10 * 60 * 1000 }; // 10 min client cache
      return config;
    }
  } catch { /* fall through to static fallback */ }
  return ICE_CONFIG;
}
