/* Custom push handlers layered onto the Workbox-generated service worker via
   workbox.importScripts (see vite.config.js). The generated sw.js handles
   precaching/offline; this file adds OS-level push notifications. */

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { /* non-JSON payload */ }

  const title = data.title || 'Anutech DSP';
  const options = {
    body: data.body || '',
    icon: '/pwa-192x192.png',
    badge: '/pwa-64x64.png',
    tag: data.tag || undefined,          // collapses duplicate alerts for the same chat/ticket
    renotify: Boolean(data.tag),
    data: { url: data.url || '/' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      // Focus an already-open tab (and navigate it) rather than spawning a new one.
      for (const w of wins) {
        if ('focus' in w) {
          w.focus();
          if ('navigate' in w) { try { w.navigate(targetUrl); } catch (e) { /* cross-origin */ } }
          return;
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
