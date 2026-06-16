/**
 * Socket.io message tracker
 * -------------------------
 * Hangs an interceptor on the page's Socket.io client (via `addInitScript`)
 * that records every `emit` and every received event with timestamps. The
 * test reads `window.__socketLog` at the end of the scenario.
 *
 * Designed for the customer + agent stress specs to answer:
 *   - exact send→receive latency between two browser contexts
 *   - duplicate-event detection (same message twice)
 *   - message-loss detection (sent N, received < N)
 *   - typing-indicator latency
 *   - reconnect tracking
 *
 * Implementation note: Socket.io stores its `Manager` and `Socket` classes
 * on `window.io` in the dev build (Vite + socket.io-client@4). We monkey-
 * patch `io.connect` so every Socket instance the app creates is recorded.
 * The DSP frontend uses ONE socket created at SocketContext mount time, so
 * we typically end up with exactly one tracker per page.
 */

async function attachSocketTracker(page) {
  await page.addInitScript(() => {
    window.__socketLog = {
      emits: [],     // [{ ts, event, payload }]
      events: [],    // [{ ts, event, payload, _key }]
      reconnects: 0,
      disconnects: 0,
    };

    function safe(payload) {
      // Strip ArrayBuffer / large blobs from the log so JSON.stringify
      // doesn't blow up. Keep just enough to identify the message.
      try {
        const s = JSON.stringify(payload);
        return s.length > 1000 ? s.slice(0, 1000) + '…(truncated)' : JSON.parse(s);
      } catch { return String(payload); }
    }

    function instrument(socket) {
      if (!socket || socket.__instrumented) return socket;
      socket.__instrumented = true;
      const origEmit = socket.emit.bind(socket);
      socket.emit = (event, ...args) => {
        window.__socketLog.emits.push({ ts: performance.now(), event, payload: safe(args[0]) });
        return origEmit(event, ...args);
      };
      socket.onAny?.((event, payload) => {
        const entry = { ts: performance.now(), event, payload: safe(payload) };
        // Synthetic dedup key for new_message-style events with an id.
        const id = payload?.message?.id ?? payload?.id;
        if (id != null) entry._key = `${event}:${id}`;
        window.__socketLog.events.push(entry);
      });
      socket.on('connect', () => { /* counted by reconnects on reconnect */ });
      socket.on('disconnect', () => { window.__socketLog.disconnects += 1; });
      socket.io?.on?.('reconnect', () => { window.__socketLog.reconnects += 1; });
      return socket;
    }

    // The app builds its socket inside SocketContext using io(BASE, {...}).
    // We poll for the `io` global (only present if the app uses the UMD build —
    // it doesn't, but harmless to try) and for `window.__appSocket` which
    // SocketContext.jsx assigns after creating the socket.
    //
    // Under heavy concurrent load the customer's first-paint can take 7+ s on
    // Vite dev (each module is a separate fetch the dev server transforms on
    // the fly). The previous 3-second poll cap meant the first contexts gave
    // up before the SocketProvider mounted, and we got *zero* events for them.
    // The polls are cheap (one window-property lookup per tick) so we just let
    // them run until either match — no give-up.
    const io_installer = setInterval(() => {
      if (window.io && typeof window.io.connect === 'function') {
        const orig = window.io.connect;
        window.io.connect = (...args) => instrument(orig(...args));
        clearInterval(io_installer);
      }
    }, 50);

    const tap = setInterval(() => {
      if (window.__appSocket) {
        instrument(window.__appSocket);
        clearInterval(tap);
      }
    }, 50);

    // Stop polling after a generous ceiling — the user might never log in,
    // and forever-loops in production code are a smell. 60 s is well past
    // any realistic mount latency even on a hammered Vite dev server.
    setTimeout(() => { clearInterval(io_installer); clearInterval(tap); }, 60_000);
  });
}

async function harvest(page) {
  try {
    return await page.evaluate(() => window.__socketLog || { emits: [], events: [], reconnects: 0, disconnects: 0 });
  } catch {
    return { emits: [], events: [], reconnects: 0, disconnects: 0 };
  }
}

// Helpers the spec uses to compute latencies and detect anomalies.
function latencyBetween(senderLog, receiverLog, { eventName, matchBy }) {
  // matchBy(payload) → a key string used to match an emit to a receive.
  const latencies = [];
  const senderByKey = new Map();
  for (const e of senderLog.emits) {
    if (e.event !== eventName) continue;
    const key = matchBy(e.payload);
    if (key != null) senderByKey.set(key, e.ts);
  }
  for (const e of receiverLog.events) {
    if (e.event !== 'new_message') continue; // server broadcasts as new_message
    const key = matchBy(e.payload);
    const t0 = senderByKey.get(key);
    if (t0 != null) latencies.push(e.ts - t0);
  }
  return latencies;
}

function duplicateCount(log) {
  const seen = new Set();
  let dups = 0;
  for (const e of log.events) {
    if (!e._key) continue;
    if (seen.has(e._key)) dups += 1;
    else seen.add(e._key);
  }
  return dups;
}

module.exports = { attachSocketTracker, harvest, latencyBetween, duplicateCount };
