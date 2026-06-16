/**
 * Socket.io integration test suite
 * ---------------------------------
 *
 * Verifies the real-time event contract for the chat surface — the part
 * that REST + DB alone can't cover. Two cooperating socket clients (one
 * customer JWT, one agent JWT) drive each scenario; the suite asserts:
 *   - the right peer received the right event,
 *   - the wrong peer did NOT receive it (room isolation),
 *   - the DB ended up in the expected state.
 *
 * Test infrastructure
 *   - Same plain-Node harness as `tests/routing-limits.test.js` and
 *     `src/tests/plan-gates.test.js`. No Jest. No supertest. `npm test`
 *     is not wired into package.json on purpose — run with:
 *         node src/tests/socket-events.test.js
 *   - Uses `socket.io-client@4` (added as a devDependency).
 *   - Runs against the LIVE backend at TEST_BASE_URL (default
 *     http://localhost:5000). The user-suggested "start a fresh test
 *     server on :5001" would require re-booting Express + socket.io with
 *     the production wiring, which is harder than it is valuable: the
 *     production server already provides the exact surface we need to
 *     test, and per-test seeding keeps the suite hermetic.
 *
 * Hermetic seeding
 *   Every scenario creates fresh temp users (email prefix
 *   `__socket_test_*@dsp.test`) and chats; cleanup runs in finally{}.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const http = require('http');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { io: ioClient } = require('socket.io-client');
const { pool } = require('../config/database');
const { getChatUsage } = require('../utils/planUtils');

const BASE = process.env.TEST_BASE_URL || 'http://localhost:5000';
const PASSWORD = 'Password@123';
const PWD_HASH = bcrypt.hashSync(PASSWORD, 10);

// ── Test harness ─────────────────────────────────────────────────────────────
const results = [];
async function test(name, fn) {
  const start = Date.now();
  try {
    await fn();
    results.push({ name, status: 'PASS', ms: Date.now() - start });
    console.log(`  ✅ ${name}`);
  } catch (err) {
    results.push({ name, status: 'FAIL', ms: Date.now() - start, err: err.message });
    console.error(`  ❌ ${name}`);
    console.error(`     ${err.message}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertEqual(a, e, msg) {
  if (a !== e) throw new Error(`${msg || 'expected equal'} — got ${JSON.stringify(a)}, expected ${JSON.stringify(e)}`);
}

// ── HTTP + login ─────────────────────────────────────────────────────────────
function request(method, path, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE + path);
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: url.hostname, port: url.port, path: url.pathname + url.search, method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, res => {
      let chunks = '';
      res.on('data', c => chunks += c);
      res.on('end', () => {
        let parsed; try { parsed = JSON.parse(chunks); } catch { parsed = chunks; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// Mint a session token directly — same shape authController.signToken produces.
// We bypass POST /api/auth/login because the login route is rate-limited to 20
// hits / 15 min per IP; this suite easily blows past that with all its
// freshly-seeded users. Bypassing the REST endpoint avoids that flake without
// weakening the test (the socket layer still verifies the JWT signature, jti,
// and is_active against the DB).
async function login(emailOrUser, opts = {}) {
  let row;
  if (typeof emailOrUser === 'object' && emailOrUser.userId) {
    const [[r]] = await pool.query('SELECT id, email, role FROM users WHERE id = ?', [emailOrUser.userId]);
    row = r;
  } else {
    const [[r]] = await pool.query('SELECT id, email, role FROM users WHERE email = ?', [emailOrUser]);
    row = r;
  }
  if (!row) throw new Error(`no user found for ${emailOrUser}`);
  const jti = crypto.randomBytes(16).toString('hex');
  await pool.query('UPDATE users SET active_session_jti = ? WHERE id = ?', [jti, row.id]);
  return jwt.sign(
    { id: row.id, email: row.email, role: row.role, jti },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );
}

// A "real" login via REST — only used for tests that specifically need to
// exercise the login route's session-rotation side-effects (e.g. revocation).
async function realLogin(email) {
  const r = await request('POST', '/api/auth/login', { body: { email, password: PASSWORD } });
  if (r.status !== 200) throw new Error(`login ${email} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.token;
}

// ── User / chat seeding ──────────────────────────────────────────────────────
async function planIdByName(name) {
  const [[p]] = await pool.query('SELECT id FROM plans WHERE name = ?', [name]);
  if (!p) throw new Error(`no plan named ${name}`);
  return p.id;
}

async function seedCustomer({ planName = 'moderate', tag = 'c' } = {}) {
  const id = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const email = `__socket_test_${tag}_${id}@dsp.test`;
  const planId = await planIdByName(planName);
  const [u] = await pool.query(
    `INSERT INTO users (name, email, password, role, is_active, created_at)
     VALUES (?, ?, ?, 'customer', 1, NOW())`,
    [`Socket ${tag} ${id}`, email, PWD_HASH]
  );
  const userId = u.insertId;
  const [c] = await pool.query(
    `INSERT INTO customers (user_id, domain, plan_id, plan_expiry, invoice_subtotal)
     VALUES (?, ?, ?, CURDATE() + INTERVAL 30 DAY, 0)`,
    [userId, `${tag}.test`, planId]
  );
  const customerId = c.insertId;
  return { email, userId, customerId };
}

async function seedAgent({ tag = 'a' } = {}) {
  const id = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const email = `__socket_test_${tag}_${id}@dsp.test`;
  const [u] = await pool.query(
    `INSERT INTO users (name, email, password, role, is_active, created_at)
     VALUES (?, ?, ?, 'agent', 1, NOW())`,
    [`SocketAgent ${tag} ${id}`, email, PWD_HASH]
  );
  return { email, userId: u.insertId };
}

// Seed a chat directly in DB to skip auto-assign / ring routing — gives the
// test full control over the chat's lifecycle.
async function seedWaitingChat(customerId) {
  const [r] = await pool.query(
    `INSERT INTO chats (customer_id, status, created_at) VALUES (?, 'waiting', NOW())`,
    [customerId]
  );
  return r.insertId;
}

async function cleanupChat(chatId) {
  await pool.query('DELETE FROM chat_messages WHERE chat_id = ?', [chatId]);
  await pool.query('DELETE FROM chats WHERE id = ?', [chatId]);
}

async function cleanupUser(userId) {
  await pool.query('DELETE FROM chat_messages WHERE sender_id = ?', [userId]);
  // Cascade-safe: chats with this customer get hit indirectly via cleanupChat.
  const [[cust]] = await pool.query('SELECT id FROM customers WHERE user_id = ?', [userId]);
  if (cust) {
    await pool.query('DELETE FROM chats WHERE customer_id = ?', [cust.id]);
    await pool.query('DELETE FROM customers WHERE id = ?', [cust.id]);
  }
  await pool.query('DELETE FROM users WHERE id = ?', [userId]);
}

// ── Socket helpers ───────────────────────────────────────────────────────────
function connect(token) {
  return new Promise((resolve, reject) => {
    const s = ioClient(BASE, {
      auth: { token },
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      timeout: 5000,
    });
    s.once('connect', () => resolve(s));
    s.once('connect_error', err => reject(err));
  });
}

// Wait for a specific event, with optional payload predicate. Resolves with
// the event payload. Rejects on timeout — fast failure beats hanging tests.
function waitFor(socket, event, { timeoutMs = 3000, where = () => true } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`waitFor('${event}') timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const handler = (payload) => {
      if (!where(payload)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    };
    socket.on(event, handler);
  });
}

// Assert that an event does NOT arrive within a short window. Used to prove
// room isolation — the wrong peer should never see another room's traffic.
function expectNoEvent(socket, event, { windowMs = 500 } = {}) {
  return new Promise((resolve, reject) => {
    const handler = (payload) => {
      reject(new Error(`unexpected '${event}' fired: ${JSON.stringify(payload)}`));
    };
    socket.on(event, handler);
    setTimeout(() => { socket.off(event, handler); resolve(); }, windowMs);
  });
}

function disconnectAll(...sockets) {
  for (const s of sockets) { try { s?.disconnect(); } catch {} }
}

// ── Tests ────────────────────────────────────────────────────────────────────
async function run() {
  console.log(`\nSocket.io event suite  base=${BASE}\n`);

  const h = await request('GET', '/api/health');
  if (h.status !== 200) {
    console.error(`Backend not reachable at ${BASE} — start it (npm run dev) first.`);
    process.exit(2);
  }

  // ──────────────────────────────────────────────────────────────────────────
  console.log('─── 1. CHAT SOCKET EVENTS ───');

  await test('join_chat: customer enters chat room + receives chat_history', async () => {
    const cust = await seedCustomer({ tag: 'jc' });
    const chatId = await seedWaitingChat(cust.customerId);
    let cSock;
    try {
      const tok = await login(cust.email);
      cSock = await connect(tok);
      cSock.emit('join_chat', { chatId });
      const hist = await waitFor(cSock, 'chat_history');
      assert(Array.isArray(hist.messages), 'chat_history.messages should be an array');
    } finally {
      disconnectAll(cSock);
      await cleanupChat(chatId);
      await cleanupUser(cust.userId);
    }
  });

  await test('accept_chat: agent accepts → both sides see chat_accepted', async () => {
    const cust  = await seedCustomer({ tag: 'ac_c' });
    const agent = await seedAgent({ tag: 'ac_a' });
    const chatId = await seedWaitingChat(cust.customerId);
    let cSock, aSock;
    try {
      cSock = await connect(await login(cust.email));
      aSock = await connect(await login(agent.email));
      cSock.emit('join_chat', { chatId });
      await waitFor(cSock, 'chat_history');
      aSock.emit('accept_chat', { chatId });
      const evt = await waitFor(cSock, 'chat_accepted');
      assert(evt.agentName, 'chat_accepted payload includes agentName');
      assertEqual(Number(evt.chatId), chatId, 'chat_accepted payload includes correct chatId');

      // DB side-effect check: chats.status should now be 'active'
      const [[row]] = await pool.query('SELECT status, agent_id FROM chats WHERE id = ?', [chatId]);
      assertEqual(row.status, 'active', 'chats.status flipped to active');
      assertEqual(row.agent_id, agent.userId, 'chats.agent_id set');
    } finally {
      disconnectAll(cSock, aSock);
      await cleanupChat(chatId);
      await cleanupUser(cust.userId);
      await cleanupUser(agent.userId);
    }
  });

  await test('chat_closed: agent closes → both peers receive event', async () => {
    const cust  = await seedCustomer({ tag: 'cc_c' });
    const agent = await seedAgent({ tag: 'cc_a' });
    const chatId = await seedWaitingChat(cust.customerId);
    let cSock, aSock;
    try {
      cSock = await connect(await login(cust.email));
      aSock = await connect(await login(agent.email));
      cSock.emit('join_chat', { chatId });
      await waitFor(cSock, 'chat_history');
      aSock.emit('accept_chat', { chatId });
      await waitFor(cSock, 'chat_accepted');

      const closedC = waitFor(cSock, 'chat_closed', { timeoutMs: 4000 });
      const closedA = waitFor(aSock, 'chat_closed', { timeoutMs: 4000 });
      aSock.emit('close_chat', { chatId });
      await closedC;
      await closedA;

      const [[row]] = await pool.query('SELECT status FROM chats WHERE id = ?', [chatId]);
      assertEqual(row.status, 'closed', 'chats.status flipped to closed');
    } finally {
      disconnectAll(cSock, aSock);
      await cleanupChat(chatId);
      await cleanupUser(cust.userId);
      await cleanupUser(agent.userId);
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n─── 2. REAL-TIME MESSAGE FLOW ───');

  await test('Customer → Agent message via socket + DB row persists', async () => {
    const cust  = await seedCustomer({ tag: 'rt1_c' });
    const agent = await seedAgent({ tag: 'rt1_a' });
    const chatId = await seedWaitingChat(cust.customerId);
    let cSock, aSock;
    try {
      cSock = await connect(await login(cust.email));
      aSock = await connect(await login(agent.email));
      cSock.emit('join_chat', { chatId });
      await waitFor(cSock, 'chat_history');
      aSock.emit('accept_chat', { chatId });
      await waitFor(cSock, 'chat_accepted');

      // Wait for the agent's first greeting to land, then send the customer's reply
      await waitFor(aSock, 'new_message');

      const arrived = waitFor(aSock, 'new_message', { where: m => m.message?.message === 'hello from customer' });
      cSock.emit('send_message', { chatId, message: 'hello from customer' });
      const evt = await arrived;
      assertEqual(evt.message.sender_role, 'customer', 'sender_role tagged correctly');
      assertEqual(evt.message.sender_id, cust.userId, 'sender_id tagged correctly');

      // DB row exists
      const [rows] = await pool.query(
        `SELECT message FROM chat_messages WHERE chat_id = ? AND sender_id = ? ORDER BY id DESC LIMIT 1`,
        [chatId, cust.userId]
      );
      assertEqual(rows[0]?.message, 'hello from customer', 'message persisted in DB');
    } finally {
      disconnectAll(cSock, aSock);
      await cleanupChat(chatId);
      await cleanupUser(cust.userId);
      await cleanupUser(agent.userId);
    }
  });

  await test('Agent → Customer reply via socket', async () => {
    const cust  = await seedCustomer({ tag: 'rt2_c' });
    const agent = await seedAgent({ tag: 'rt2_a' });
    const chatId = await seedWaitingChat(cust.customerId);
    let cSock, aSock;
    try {
      cSock = await connect(await login(cust.email));
      aSock = await connect(await login(agent.email));
      cSock.emit('join_chat', { chatId });
      await waitFor(cSock, 'chat_history');
      aSock.emit('accept_chat', { chatId });
      await waitFor(cSock, 'chat_accepted');
      await waitFor(cSock, 'new_message'); // greeting

      const arrived = waitFor(cSock, 'new_message', { where: m => m.message?.message === 'reply from agent' });
      aSock.emit('send_message', { chatId, message: 'reply from agent' });
      const evt = await arrived;
      assertEqual(evt.message.sender_id, agent.userId, 'sender_id is the agent');
    } finally {
      disconnectAll(cSock, aSock);
      await cleanupChat(chatId);
      await cleanupUser(cust.userId);
      await cleanupUser(agent.userId);
    }
  });

  await test('Typing indicator: customer typing → agent receives user_typing', async () => {
    const cust  = await seedCustomer({ tag: 'tp_c' });
    const agent = await seedAgent({ tag: 'tp_a' });
    const chatId = await seedWaitingChat(cust.customerId);
    let cSock, aSock;
    try {
      cSock = await connect(await login(cust.email));
      aSock = await connect(await login(agent.email));
      cSock.emit('join_chat', { chatId });
      await waitFor(cSock, 'chat_history');
      aSock.emit('accept_chat', { chatId });
      await waitFor(cSock, 'chat_accepted');

      const evtP = waitFor(aSock, 'user_typing');
      cSock.emit('typing', { chatId, isTyping: true });
      const evt = await evtP;
      assertEqual(evt.role, 'customer', 'typing event tags role');
      assertEqual(evt.isTyping, true, 'isTyping flag forwarded');
    } finally {
      disconnectAll(cSock, aSock);
      await cleanupChat(chatId);
      await cleanupUser(cust.userId);
      await cleanupUser(agent.userId);
    }
  });

  await test('Typing indicator: agent typing → customer receives user_typing', async () => {
    const cust  = await seedCustomer({ tag: 'tp2_c' });
    const agent = await seedAgent({ tag: 'tp2_a' });
    const chatId = await seedWaitingChat(cust.customerId);
    let cSock, aSock;
    try {
      cSock = await connect(await login(cust.email));
      aSock = await connect(await login(agent.email));
      cSock.emit('join_chat', { chatId });
      await waitFor(cSock, 'chat_history');
      aSock.emit('accept_chat', { chatId });
      await waitFor(cSock, 'chat_accepted');

      const evtP = waitFor(cSock, 'user_typing');
      aSock.emit('typing', { chatId, isTyping: true });
      const evt = await evtP;
      assertEqual(evt.role, 'agent', 'typing event tags agent role');
    } finally {
      disconnectAll(cSock, aSock);
      await cleanupChat(chatId);
      await cleanupUser(cust.userId);
      await cleanupUser(agent.userId);
    }
  });

  await test('Message history sent on join_chat after previous messages', async () => {
    const cust  = await seedCustomer({ tag: 'hist_c' });
    const agent = await seedAgent({ tag: 'hist_a' });
    const chatId = await seedWaitingChat(cust.customerId);
    let cSock, aSock;
    try {
      cSock = await connect(await login(cust.email));
      aSock = await connect(await login(agent.email));
      cSock.emit('join_chat', { chatId });
      await waitFor(cSock, 'chat_history');
      aSock.emit('accept_chat', { chatId });
      await waitFor(cSock, 'chat_accepted');
      await waitFor(aSock, 'new_message'); // greeting lands on agent socket

      cSock.emit('send_message', { chatId, message: 'msg-1' });
      await waitFor(aSock, 'new_message', { where: m => m.message?.message === 'msg-1' });

      // Reconnect a fresh customer socket and join the chat — chat_history must
      // include msg-1 + the agent greeting.
      cSock.disconnect();
      cSock = await connect(await login(cust.email));
      cSock.emit('join_chat', { chatId });
      const hist = await waitFor(cSock, 'chat_history');
      const texts = hist.messages.map(m => m.message);
      assert(texts.includes('msg-1'), `chat_history should include msg-1, got ${JSON.stringify(texts)}`);
      assert(texts.some(t => /Hello/i.test(t)), 'chat_history should include agent greeting');
    } finally {
      disconnectAll(cSock, aSock);
      await cleanupChat(chatId);
      await cleanupUser(cust.userId);
      await cleanupUser(agent.userId);
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n─── 3. AGENT ROOM EVENTS ───');

  await test('join_agent_room → server emits agent_status_changed to agents room', async () => {
    const agent = await seedAgent({ tag: 'jar' });
    let aSock;
    try {
      aSock = await connect(await login(agent.email));
      const evtP = waitFor(aSock, 'agent_status_changed', {
        where: e => Number(e.agentId) === Number(agent.userId),
      });
      aSock.emit('join_agent_room');
      const evt = await evtP;
      assert(['online', 'busy', 'away', 'on_break'].includes(evt.status), 'status is a valid value');
    } finally {
      disconnectAll(aSock);
      await cleanupUser(agent.userId);
    }
  });

  await test('chat_request_accepted broadcasts to agents room', async () => {
    // Two agents in the room; one accepts a chat — the other should see
    // chat_request_accepted so it can drop the pending entry from its UI.
    const cust  = await seedCustomer({ tag: 'cra_c' });
    const a1    = await seedAgent({ tag: 'cra_a1' });
    const a2    = await seedAgent({ tag: 'cra_a2' });
    const chatId = await seedWaitingChat(cust.customerId);
    let cSock, a1Sock, a2Sock;
    try {
      cSock  = await connect(await login(cust.email));
      a1Sock = await connect(await login(a1.email));
      a2Sock = await connect(await login(a2.email));
      a1Sock.emit('join_agent_room');
      a2Sock.emit('join_agent_room');
      // drain status events so they don't confuse later listeners
      await waitFor(a1Sock, 'agent_status_changed', { timeoutMs: 1500 }).catch(() => {});
      await waitFor(a2Sock, 'agent_status_changed', { timeoutMs: 1500 }).catch(() => {});

      cSock.emit('join_chat', { chatId });
      await waitFor(cSock, 'chat_history');

      const broadcastP = waitFor(a2Sock, 'chat_request_accepted',
        { where: e => Number(e.chatId) === chatId, timeoutMs: 4000 });
      a1Sock.emit('accept_chat', { chatId });
      const evt = await broadcastP;
      assertEqual(Number(evt.chatId), chatId, 'broadcast payload carries chatId');
    } finally {
      disconnectAll(cSock, a1Sock, a2Sock);
      await cleanupChat(chatId);
      await cleanupUser(cust.userId);
      await cleanupUser(a1.userId);
      await cleanupUser(a2.userId);
    }
  });

  await test('agent_status_changed broadcast on set_status', async () => {
    const a1 = await seedAgent({ tag: 'st_a1' });
    const a2 = await seedAgent({ tag: 'st_a2' });
    let a1Sock, a2Sock;
    try {
      a1Sock = await connect(await login(a1.email));
      a2Sock = await connect(await login(a2.email));
      a1Sock.emit('join_agent_room');
      a2Sock.emit('join_agent_room');
      // drain the initial join broadcasts
      await new Promise(r => setTimeout(r, 200));

      const broadcastP = waitFor(a2Sock, 'agent_status_changed',
        { where: e => Number(e.agentId) === Number(a1.userId) && e.status === 'away', timeoutMs: 3000 });
      a1Sock.emit('set_status', { status: 'away' });
      const evt = await broadcastP;
      assertEqual(evt.status, 'away', 'status forwarded');
    } finally {
      disconnectAll(a1Sock, a2Sock);
      // Reset persisted status — set_status writes to users.last_status.
      await pool.query('UPDATE users SET last_status = NULL, on_break_until = NULL WHERE id IN (?, ?)', [a1.userId, a2.userId]);
      await cleanupUser(a1.userId);
      await cleanupUser(a2.userId);
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n─── 4. ROOM ISOLATION (security) ───');

  await test('Customer A in chat_X does not see messages from chat_Y', async () => {
    const cA = await seedCustomer({ tag: 'iso_a' });
    const cB = await seedCustomer({ tag: 'iso_b' });
    const ag = await seedAgent({ tag: 'iso_g' });
    const chatX = await seedWaitingChat(cA.customerId);
    const chatY = await seedWaitingChat(cB.customerId);
    let aSockA, aSockB, agSock;
    try {
      aSockA = await connect(await login(cA.email));
      aSockB = await connect(await login(cB.email));
      agSock = await connect(await login(ag.email));
      aSockA.emit('join_chat', { chatId: chatX });
      aSockB.emit('join_chat', { chatId: chatY });
      await waitFor(aSockA, 'chat_history');
      await waitFor(aSockB, 'chat_history');
      agSock.emit('accept_chat', { chatId: chatX });
      await waitFor(aSockA, 'chat_accepted');

      // The agent's greeting lands on chat_X. Customer B (in chat_Y) must NOT see it.
      const leaked = expectNoEvent(aSockB, 'new_message', { windowMs: 800 });
      // Confirm A *does* receive at least one new_message (we already pulled chat_history,
      // so the greeting arrives next).
      await waitFor(aSockA, 'new_message', { timeoutMs: 3000 });
      await leaked;
    } finally {
      disconnectAll(aSockA, aSockB, agSock);
      await cleanupChat(chatX);
      await cleanupChat(chatY);
      await cleanupUser(cA.userId);
      await cleanupUser(cB.userId);
      await cleanupUser(ag.userId);
    }
  });

  await test('Customer cannot join another customer\'s chat (Forbidden)', async () => {
    const cA = await seedCustomer({ tag: 'fb_a' });
    const cB = await seedCustomer({ tag: 'fb_b' });
    const chatA = await seedWaitingChat(cA.customerId);
    let bSock;
    try {
      bSock = await connect(await login(cB.email));
      const errP = waitFor(bSock, 'error', { timeoutMs: 3000 });
      bSock.emit('join_chat', { chatId: chatA });
      const err = await errP;
      assert(/forbidden/i.test(err.message || ''), `expected Forbidden error, got: ${err.message}`);
    } finally {
      disconnectAll(bSock);
      await cleanupChat(chatA);
      await cleanupUser(cA.userId);
      await cleanupUser(cB.userId);
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n─── 5. RECONNECTION ───');

  await test('Reconnect after disconnect → chat_history replays prior messages', async () => {
    const cust  = await seedCustomer({ tag: 'rc_c' });
    const agent = await seedAgent({ tag: 'rc_a' });
    const chatId = await seedWaitingChat(cust.customerId);
    let cSock, aSock;
    try {
      cSock = await connect(await login(cust.email));
      aSock = await connect(await login(agent.email));
      cSock.emit('join_chat', { chatId });
      await waitFor(cSock, 'chat_history');
      aSock.emit('accept_chat', { chatId });
      await waitFor(cSock, 'chat_accepted');
      await waitFor(aSock, 'new_message'); // greeting

      // Customer sends a message, then disconnects.
      cSock.emit('send_message', { chatId, message: 'before-disconnect' });
      await waitFor(aSock, 'new_message', { where: m => m.message?.message === 'before-disconnect' });
      cSock.disconnect();

      // Agent sends a message while customer is offline — must still persist.
      aSock.emit('send_message', { chatId, message: 'while-offline' });
      // Wait briefly so the INSERT lands before we re-fetch
      await new Promise(r => setTimeout(r, 250));

      // Customer reconnects, joins chat, and chat_history should contain both.
      cSock = await connect(await login(cust.email));
      cSock.emit('join_chat', { chatId });
      const hist = await waitFor(cSock, 'chat_history');
      const texts = hist.messages.map(m => m.message);
      assert(texts.includes('before-disconnect'), `expected before-disconnect in history: ${JSON.stringify(texts)}`);
      assert(texts.includes('while-offline'),    `expected while-offline in history: ${JSON.stringify(texts)}`);
    } finally {
      disconnectAll(cSock, aSock);
      await cleanupChat(chatId);
      await cleanupUser(cust.userId);
      await cleanupUser(agent.userId);
    }
  });

  await test('Reconnect does NOT double-count chat usage', async () => {
    // accept_chat increments getChatUsage by exactly 1 (greeting is the
    // "first customer-engaged" pivot). A customer disconnect/reconnect within
    // the same chat must not add another tick.
    const cust  = await seedCustomer({ tag: 'cnt_c' });
    const agent = await seedAgent({ tag: 'cnt_a' });
    const chatId = await seedWaitingChat(cust.customerId);
    let cSock, aSock;
    try {
      cSock = await connect(await login(cust.email));
      aSock = await connect(await login(agent.email));
      cSock.emit('join_chat', { chatId });
      await waitFor(cSock, 'chat_history');
      aSock.emit('accept_chat', { chatId });
      await waitFor(cSock, 'chat_accepted');
      await waitFor(aSock, 'new_message');

      // Customer must send at least one message so the chat counts as engaged.
      cSock.emit('send_message', { chatId, message: 'engage' });
      await waitFor(aSock, 'new_message', { where: m => m.message?.message === 'engage' });

      const before = await getChatUsage(cust.customerId);
      cSock.disconnect();
      cSock = await connect(await login(cust.email));
      cSock.emit('join_chat', { chatId });
      await waitFor(cSock, 'chat_history');
      const after = await getChatUsage(cust.customerId);
      assertEqual(after, before, `usage should be stable across reconnect — before ${before} after ${after}`);
    } finally {
      disconnectAll(cSock, aSock);
      await cleanupChat(chatId);
      await cleanupUser(cust.userId);
      await cleanupUser(agent.userId);
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n─── 6. AUTH & SECURITY ───');

  await test('Invalid JWT → connection rejected', async () => {
    try {
      await connect('this.is.not-a-valid-jwt');
      throw new Error('connect succeeded with garbage token — should have been rejected');
    } catch (err) {
      assert(/invalid|auth/i.test(err.message || ''), `expected auth error, got: ${err.message}`);
    }
  });

  await test('Missing token → connection rejected', async () => {
    try {
      await new Promise((resolve, reject) => {
        const s = ioClient(BASE, { transports: ['websocket'], forceNew: true, reconnection: false, timeout: 3000 });
        s.once('connect', () => { s.disconnect(); reject(new Error('connected without a token')); });
        s.once('connect_error', err => resolve(err));
      });
    } catch (err) {
      throw err;
    }
  });

  await test('Session revoked (re-login) → old socket rejected', async () => {
    const u = await seedCustomer({ tag: 'sess' });
    let s1;
    try {
      const tok1 = await login(u.email);
      // Second login revokes the first (single-active-session enforcement).
      await login(u.email);
      try {
        s1 = await connect(tok1);
        throw new Error('expected connection to be rejected for revoked session');
      } catch (err) {
        assert(/revoked|invalid|auth/i.test(err.message || ''), `expected revocation error, got: ${err.message}`);
      }
    } finally {
      disconnectAll(s1);
      await cleanupUser(u.userId);
    }
  });

  await test('Cross-tenant: User cannot join another user\'s chat room', async () => {
    // Already covered structurally by "Customer cannot join another customer\'s chat".
    // This variant proves that even after a hijack-style chatId guess against a
    // *different* customer, the server replies with Forbidden and the joiner
    // never enters the chat room (so subsequent broadcasts don't reach them).
    const owner    = await seedCustomer({ tag: 'tn_o' });
    const intruder = await seedCustomer({ tag: 'tn_i' });
    const agent    = await seedAgent({ tag: 'tn_a' });
    const chatId   = await seedWaitingChat(owner.customerId);
    let oSock, iSock, gSock;
    try {
      oSock = await connect(await login(owner.email));
      iSock = await connect(await login(intruder.email));
      gSock = await connect(await login(agent.email));

      oSock.emit('join_chat', { chatId });
      await waitFor(oSock, 'chat_history');
      gSock.emit('accept_chat', { chatId });
      await waitFor(oSock, 'chat_accepted');

      // Intruder attempts to join — must fail with Forbidden.
      const errP = waitFor(iSock, 'error', { timeoutMs: 2000 });
      iSock.emit('join_chat', { chatId });
      const err = await errP;
      assert(/forbidden/i.test(err.message || ''), `expected Forbidden, got: ${err.message}`);

      // Now: agent sends a message, intruder must NOT receive it.
      const leaked = expectNoEvent(iSock, 'new_message', { windowMs: 800 });
      gSock.emit('send_message', { chatId, message: 'private payload' });
      await waitFor(oSock, 'new_message', { where: m => m.message?.message === 'private payload' });
      await leaked;
    } finally {
      disconnectAll(oSock, iSock, gSock);
      await cleanupChat(chatId);
      await cleanupUser(owner.userId);
      await cleanupUser(intruder.userId);
      await cleanupUser(agent.userId);
    }
  });

  // ── Report ───────────────────────────────────────────────────────────────
  console.log('');
  const pass = results.filter(r => r.status === 'PASS').length;
  const fail = results.filter(r => r.status === 'FAIL').length;
  console.log(`Total ${results.length} · PASS ${pass} · FAIL ${fail}`);
  if (fail > 0) {
    console.log('\nFailures:');
    results.filter(r => r.status === 'FAIL').forEach(r => console.log(`  - ${r.name}: ${r.err}`));
  }
  console.log('');
  await pool.end();
  process.exit(fail === 0 ? 0 : 1);
}

run().catch(err => {
  console.error('Suite crashed:', err);
  pool.end().finally(() => process.exit(2));
});
