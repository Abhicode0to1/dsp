import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// Silence the Vite dev-server's WebSocket-proxy ECONNABORTED / ECONNRESET stack traces.
// These fire when a tab refreshes, nodemon restarts the backend, or the client closes
// mid-write — completely normal in dev, but http-proxy-3 emits the error on a raw socket
// deep inside the readable→write pipe (after our proxy.on('error') handlers have fired
// or detached). This plugin attaches an error listener at the HTTP-server upgrade point
// — the earliest moment the raw socket is available — so subsequent writes that fail
// don't crash through to stderr. The process-level uncaughtException net catches the
// rare residual that escapes the socket-level handler.
const silenceWsProxyErrors = () => ({
  name: 'silence-ws-proxy-errors',
  configResolved() {
    // Attach once per Vite process. Only ECONNRESET / ECONNABORTED / EPIPE
    // bubbling from socket reads are swallowed — anything else crashes as normal.
    if (!process._dspProxyHandlerAttached) {
      process._dspProxyHandlerAttached = true;
      process.on('uncaughtException', (err) => {
        const benign = err && (err.code === 'ECONNRESET' || err.code === 'ECONNABORTED' || err.code === 'EPIPE');
        if (!benign) throw err;
      });
    }
  },
  configureServer(server) {
    const attach = (req, socket) => {
      if (socket && !socket._dspErrSilenced) {
        socket._dspErrSilenced = true;
        socket.on('error', () => {});
      }
    };
    server.httpServer?.on('upgrade', attach);
    server.httpServer?.on('connection', (socket) => attach(null, socket));
  },
});

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const backendUrl = env.VITE_BACKEND_URL || 'http://localhost:5000';

  return {
    plugins: [
      react(),
      silenceWsProxyErrors(),
      // ── PWA (Phase 3) ──────────────────────────────────────────────────
      // Installable app + offline app-shell. Deliberately conservative about
      // caching because this is a live support tool: the service worker
      // precaches the static shell (JS/CSS/icons) but NEVER caches API or
      // socket.io traffic — stale tickets/chats/auth would be worse than an
      // honest "you're offline". registerType 'prompt' means we surface a
      // "new version — reload" banner instead of silently reloading, so an
      // update can't interrupt a live call.
      VitePWA({
        registerType: 'prompt',
        injectRegister: false,            // we register via the React hook in PWAPrompt
        devOptions: { enabled: false },   // SW only in production builds → dev workflow untouched
        includeAssets: ['favicon.svg', 'favicon.ico', 'apple-touch-icon-180x180.png'],
        manifest: {
          name: 'Anutech Support',
          short_name: 'Anutech Support',
          description: 'Anutech Digital customer support panel — tickets, live chat, calls and billing.',
          theme_color: '#4f46e5',
          background_color: '#ffffff',
          display: 'standalone',
          orientation: 'portrait',
          scope: '/',
          start_url: '/',
          icons: [
            { src: 'pwa-64x64.png',           sizes: '64x64',   type: 'image/png' },
            { src: 'pwa-192x192.png',         sizes: '192x192', type: 'image/png' },
            { src: 'pwa-512x512.png',         sizes: '512x512', type: 'image/png' },
            { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },
        workbox: {
          globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
          // Layer our push / notificationclick handlers onto the generated SW.
          importScripts: ['push-sw.js'],
          // Our main JS chunk is ~1.2 MB; lift the precache size cap a little.
          maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
          cleanupOutdatedCaches: true,
          clientsClaim: true,
          // SPA deep-links work offline by falling back to the app shell —
          // EXCEPT API / socket.io / uploads, which must always hit the
          // network (never be served index.html or a cached response).
          navigateFallback: 'index.html',
          navigateFallbackDenylist: [/^\/api/, /^\/socket\.io/, /^\/uploads/],
        },
      }),
    ],
    server: {
      port: 5173,
      allowedHosts: true,
      proxy: {
        '/api': {
          target: backendUrl,
          changeOrigin: true,
          configure: (proxy) => { proxy.on('error', () => {}); },
        },
        '/uploads': {
          target: backendUrl,
          changeOrigin: true,
          configure: (proxy) => { proxy.on('error', () => {}); },
        },
        '/socket.io': {
          target: backendUrl,
          changeOrigin: true,
          ws: true,
          configure: (proxy) => {
            // Layered defense — these handle the documented http-proxy events.
            // The plugin above catches the rest (raw socket errors that bypass these).
            proxy.on('error', () => {});
            proxy.on('proxyReqWs', (proxyReq, _req, socket) => {
              socket.on('error', () => {});
              proxyReq.on('error', () => {});
            });
            proxy.on('open', (socket) => { socket.on('error', () => {}); });
            proxy.on('close', () => {});
            // http-proxy emits 'econnreset' specifically for reset-during-tunnel
            proxy.on('econnreset', () => {});
          },
        },
      },
    },
    // `vite preview` serves the production build (with the service worker) — this
    // is what we tunnel through ngrok for real-device PWA testing. It needs the
    // same API/socket proxy as the dev server (preview has none by default), and
    // allowedHosts:true so it accepts the ngrok Host header.
    preview: {
      port: 4173,
      host: true,
      allowedHosts: true,
      proxy: {
        '/api':       { target: backendUrl, changeOrigin: true },
        '/uploads':   { target: backendUrl, changeOrigin: true },
        '/socket.io': { target: backendUrl, changeOrigin: true, ws: true },
      },
    },
  };
});
