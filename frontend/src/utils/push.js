// Web Push client helper (PWA Phase 4).
//
// Handles the browser side of push: permission, subscribing via the active
// service worker's PushManager (using the server's VAPID public key), and
// registering/clearing the subscription with the backend. All functions are
// safe to call on unsupported browsers — they return a clear status instead
// of throwing.

import { getVapidPublicKey, subscribePush, unsubscribePush } from '../services/api';

export function isPushSupported() {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

export function getPermission() {
  return isPushSupported() ? Notification.permission : 'unsupported';
}

// VAPID public keys are base64url; PushManager wants a Uint8Array.
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// Is this browser already subscribed (and known to the SW)?
export async function getExistingSubscription() {
  if (!isPushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return null;
  return reg.pushManager.getSubscription();
}

// Request permission (if needed), subscribe, and register with the backend.
// Returns { ok, reason? }.
export async function enablePush() {
  if (!isPushSupported()) return { ok: false, reason: 'unsupported' };

  // No service worker means we're on the dev server (devOptions disabled) or a
  // non-secure context — `serviceWorker.ready` would hang forever here, so bail
  // out cleanly instead. Push only works in the built/served app.
  const existing = await navigator.serviceWorker.getRegistration();
  if (!existing) return { ok: false, reason: 'no-sw' };

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return { ok: false, reason: 'denied' };

  const reg = await navigator.serviceWorker.ready;

  // Reuse an existing subscription if present, else create one.
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    let key;
    try {
      const res = await getVapidPublicKey();
      key = res.data.publicKey;
    } catch {
      return { ok: false, reason: 'server-unconfigured' };
    }
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key),
    });
  }

  await subscribePush(sub.toJSON());
  return { ok: true };
}

// Unsubscribe locally and tell the backend to drop the record.
export async function disablePush() {
  if (!isPushSupported()) return { ok: false, reason: 'unsupported' };
  const sub = await getExistingSubscription();
  if (sub) {
    try { await unsubscribePush(sub.endpoint); } catch { /* best effort */ }
    try { await sub.unsubscribe(); } catch { /* best effort */ }
  }
  return { ok: true };
}
