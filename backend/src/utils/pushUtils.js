// Web Push helper (PWA Phase 4).
//
// Mirrors the existing socket.io notifications to the OS push layer so users
// are alerted to new tickets / chats / calls / replies even when the app tab
// is closed or backgrounded. Everything here is BEST-EFFORT: a push failure
// must never block or fail the request that triggered it, so callers can fire
// and forget. Expired subscriptions (HTTP 404/410) are pruned automatically.

const webpush = require('web-push');
const { pool } = require('../config/database');

const PUBLIC_KEY  = process.env.VAPID_PUBLIC_KEY;
const PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const SUBJECT     = process.env.VAPID_SUBJECT || 'mailto:support@anutech.in';

const isConfigured = Boolean(PUBLIC_KEY && PRIVATE_KEY);
if (isConfigured) {
  webpush.setVapidDetails(SUBJECT, PUBLIC_KEY, PRIVATE_KEY);
} else {
  console.warn('[push] VAPID keys not set — web push disabled. Add VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY to .env.');
}

function getPublicKey() {
  return isConfigured ? PUBLIC_KEY : null;
}

// Persist (or refresh) a browser's push subscription for a user.
async function saveSubscription(userId, sub, userAgent = null) {
  const endpoint = sub?.endpoint;
  const p256dh   = sub?.keys?.p256dh;
  const auth     = sub?.keys?.auth;
  if (!endpoint || !p256dh || !auth) {
    throw new Error('invalid subscription');
  }
  // endpoint is UNIQUE — re-subscribing the same browser updates its keys +
  // re-points it at the current user instead of creating a duplicate row.
  await pool.query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), p256dh = VALUES(p256dh),
                             auth = VALUES(auth), user_agent = VALUES(user_agent)`,
    [userId, endpoint, p256dh, auth, userAgent ? String(userAgent).slice(0, 255) : null]
  );
}

async function removeSubscription(endpoint) {
  if (!endpoint) return;
  await pool.query('DELETE FROM push_subscriptions WHERE endpoint = ?', [endpoint]);
}

// Send a push to every device a user has registered. payload: { title, body,
// url?, tag? }. Never throws — logs and prunes dead subscriptions.
async function sendPushToUser(userId, payload) {
  if (!isConfigured || !userId) return;
  let subs;
  try {
    [subs] = await pool.query(
      'SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?',
      [userId]
    );
  } catch (err) {
    console.error('[push] failed to load subscriptions:', err.message);
    return;
  }
  if (!subs.length) return;

  const body = JSON.stringify({
    title: payload.title || 'Anutech DSP',
    body:  payload.body  || '',
    url:   payload.url   || '/',
    tag:   payload.tag   || undefined,
  });

  await Promise.all(subs.map(async (s) => {
    const subscription = { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } };
    try {
      await webpush.sendNotification(subscription, body);
    } catch (err) {
      // 404/410 = subscription gone (uninstalled / permission revoked) → prune.
      if (err.statusCode === 404 || err.statusCode === 410) {
        await removeSubscription(s.endpoint).catch(() => {});
      } else {
        console.error('[push] send failed:', err.statusCode || err.message);
      }
    }
  }));
}

module.exports = { getPublicKey, saveSubscription, removeSubscription, sendPushToUser, isConfigured };
