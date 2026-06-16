/**
 * Node-side agent socket responder for the customer UI stress suite.
 * ------------------------------------------------------------------
 *
 * Spins up a socket.io-client connection authenticated as an agent and
 * auto-accepts every incoming chat request. Used by Customer Scenarios 2
 * + 3 so we can measure end-to-end customer→agent message delivery
 * latency without paying the RAM cost of an extra full browser context
 * per pair.
 *
 * Why timestamps via Date.now(): browser `performance.now()` and Node
 * `performance.now()` are relative to different epochs, so we can't
 * compare them directly. Date.now() in both processes is wall-clock
 * epoch ms — close enough on localhost (clock drift typically <5 ms),
 * and exactly what we want for "did the message reach the agent in
 * under 500 ms" SLO checks.
 *
 * Correlation: the customer's tracker logs each emit with the message
 * body and a `ts` (perf.now). To pair an agent receive to a customer
 * emit, we embed a marker token `__LAT_<rand>` in the message text and
 * match on that. The agent extracts the token and records receivedAt.
 */

const { io } = require('socket.io-client');

async function createAgentResponder({ token, baseURL }) {
  const socket = io(baseURL, {
    transports: ['websocket'],
    auth: { token },
    reconnection: true,
    reconnectionAttempts: 5,
  });

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('agent socket connect timeout (10s)')), 10_000);
    socket.once('connect', () => { clearTimeout(t); resolve(); });
    socket.once('connect_error', err => { clearTimeout(t); reject(err); });
  });

  // The server only adds an agent to the 'agents' room (and hydrates their
  // status into the in-memory map pickAgent reads from) on receipt of
  // `join_agent_room`. Without this, the responder is invisible to the chat
  // ring even though their JWT auth succeeded — pickAgent will skip them.
  socket.emit('join_agent_room');
  // Tiny gap so the join happens before the status flip — the server's
  // join_agent_room handler is async (DB lookup) and we want status to land
  // after the agent is in the room.
  await new Promise(r => setTimeout(r, 150));
  socket.emit('set_status', { status: 'online' });

  // Auto-accept any chat we're rung for. The server's accept_chat handler is
  // idempotent (atomic UPDATE on status='waiting'), so a duplicate emit from
  // multiple concurrent rings is harmless.
  socket.on('new_chat_request', ({ chatId }) => {
    socket.emit('accept_chat', { chatId });
  });

  // Capture every message we receive. We keep raw entries here; the test
  // reduces them to latency samples once the customer side has emitted.
  const receives = []; // { ts, chatId, body, markerToken }
  const MARKER_RE = /__LAT_([a-z0-9]+)__/i;
  socket.on('new_message', (payload) => {
    const m = payload?.message;
    if (!m) return;
    const match = MARKER_RE.exec(m.message || '');
    receives.push({
      ts: Date.now(),
      chatId: m.chat_id,
      body: m.message,
      markerToken: match ? match[1] : null,
      senderRole: m.sender_role,
    });
  });

  let disconnects = 0, reconnects = 0;
  socket.on('disconnect', () => { disconnects += 1; });
  socket.io.on('reconnect', () => { reconnects += 1; });

  return {
    socket,
    receives,
    counts: () => ({ disconnects, reconnects, received: receives.length }),
    /** Pair customer-side emit timestamps to agent-side receives via marker token. */
    matchLatencies(customerEmits /* [{ ts, marker }] */) {
      const byMarker = new Map();
      for (const e of customerEmits) {
        if (e.marker) byMarker.set(e.marker, e.ts);
      }
      const samples = [];
      for (const r of receives) {
        if (!r.markerToken) continue;
        const t0 = byMarker.get(r.markerToken);
        if (t0 != null) samples.push(r.ts - t0);
      }
      return samples;
    },
    close: () => socket.disconnect(),
  };
}

module.exports = { createAgentResponder };
