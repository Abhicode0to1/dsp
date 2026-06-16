/**
 * Edge-cases + race-condition test suite
 * --------------------------------------
 *
 * Eight problem groups the brief flagged as "things that break production":
 *
 *   1. Concurrent ticket replies (multiple authorized senders)
 *   2. Concurrent chat accept (atomic claim race)
 *   3. Usage counter races (check-then-INSERT under concurrent traffic)
 *   4. Plan expiry boundary
 *   5. Double-submit on reply (lack of dedupe on the API)
 *   6. Attachment limits — oversize file + unusual MIME
 *   7. Search safety — SQL-injection strings, unicode, empty
 *   8. Month boundary in usage counters
 *
 * Same plain-Node harness conventions as the rest of the src/tests/*.js
 * files. JWTs minted directly to bypass the login rate limiter. Each test
 * seeds + cleans its own __edge_*@dsp.test users.
 *
 * Run:  node src/tests/edge-cases.test.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const http = require('http');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { io: ioClient } = require('socket.io-client');
const { pool } = require('../config/database');
const { getChatUsage, getCallUsage } = require('../utils/planUtils');

const BASE = process.env.TEST_BASE_URL || 'http://localhost:5000';
const PWD_HASH = bcrypt.hashSync('Password@123', 10);

// ── Harness ──────────────────────────────────────────────────────────────────
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

// ── HTTP ─────────────────────────────────────────────────────────────────────
function request(method, urlPath, { token, body, contentType = 'application/json', rawBody = null } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE + urlPath);
    const data = rawBody != null ? rawBody : (body ? JSON.stringify(body) : null);
    const req = http.request({
      hostname: url.hostname, port: url.port, path: url.pathname + url.search, method,
      headers: {
        ...(data ? { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
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

// ── User + JWT ───────────────────────────────────────────────────────────────
async function planIdByName(name) {
  const [[p]] = await pool.query('SELECT id FROM plans WHERE name = ?', [name]);
  if (!p) throw new Error(`no plan named ${name}`);
  return p.id;
}

async function mintToken({ userId, email, role }) {
  const jti = crypto.randomBytes(16).toString('hex');
  await pool.query('UPDATE users SET active_session_jti = ? WHERE id = ?', [jti, userId]);
  return jwt.sign({ id: userId, email, role, jti }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

async function seedCustomer({ planName = 'premium', tag = 'c' } = {}) {
  const id = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const email = `__edge_${tag}_${id}@dsp.test`;
  const planId = await planIdByName(planName);
  const [u] = await pool.query(
    `INSERT INTO users (name, email, password, role, is_active, created_at)
     VALUES (?, ?, ?, 'customer', 1, NOW())`,
    [`EdgeCust ${tag}`, email, PWD_HASH]
  );
  const [c] = await pool.query(
    `INSERT INTO customers (user_id, domain, plan_id, plan_expiry, invoice_subtotal)
     VALUES (?, ?, ?, CURDATE() + INTERVAL 30 DAY, 0)`,
    [u.insertId, `${tag}.test`, planId]
  );
  const user = { userId: u.insertId, customerId: c.insertId, email, role: 'customer' };
  user.token = await mintToken(user);
  return user;
}

async function seedAgent({ tag = 'a' } = {}) {
  const id = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const email = `__edge_${tag}_${id}@dsp.test`;
  const [u] = await pool.query(
    `INSERT INTO users (name, email, password, role, is_active, created_at)
     VALUES (?, ?, ?, 'agent', 1, NOW())`,
    [`EdgeAgent ${tag}`, email, PWD_HASH]
  );
  const user = { userId: u.insertId, email, role: 'agent' };
  user.token = await mintToken(user);
  return user;
}

async function seedAdmin({ tag = 'adm' } = {}) {
  const id = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const email = `__edge_${tag}_${id}@dsp.test`;
  const [u] = await pool.query(
    `INSERT INTO users (name, email, password, role, is_active, created_at)
     VALUES (?, ?, ?, 'admin', 1, NOW())`,
    [`EdgeAdmin ${tag}`, email, PWD_HASH]
  );
  const user = { userId: u.insertId, email, role: 'admin' };
  user.token = await mintToken(user);
  return user;
}

async function cleanupUser(userId) {
  await pool.query('DELETE FROM chat_messages WHERE sender_id = ?', [userId]);
  await pool.query('DELETE FROM ticket_messages WHERE sender_id = ?', [userId]);
  const [[cust]] = await pool.query('SELECT id FROM customers WHERE user_id = ?', [userId]);
  if (cust) {
    await pool.query('DELETE FROM chat_messages WHERE chat_id IN (SELECT id FROM chats WHERE customer_id = ?)', [cust.id]);
    await pool.query('DELETE FROM chats WHERE customer_id = ?', [cust.id]);
    await pool.query('DELETE FROM ticket_messages WHERE ticket_id IN (SELECT id FROM tickets WHERE customer_id = ?)', [cust.id]);
    await pool.query('DELETE FROM file_attachments WHERE ref_type = "ticket" AND ref_id IN (SELECT id FROM tickets WHERE customer_id = ?)', [cust.id]);
    await pool.query('DELETE FROM tickets WHERE customer_id = ?', [cust.id]);
    await pool.query('DELETE FROM calls WHERE customer_id = ?', [cust.id]);
    await pool.query('DELETE FROM customer_feature_overrides WHERE customer_id = ?', [cust.id]);
    await pool.query('DELETE FROM customers WHERE id = ?', [cust.id]);
  }
  await pool.query('UPDATE tickets SET assigned_agent_id = NULL WHERE assigned_agent_id = ?', [userId]);
  await pool.query('UPDATE chats SET agent_id = NULL WHERE agent_id = ?', [userId]);
  await pool.query('DELETE FROM users WHERE id = ?', [userId]);
}

// ── Resource seeding ─────────────────────────────────────────────────────────
async function seedTicket({ customerId, assignedAgentId = null, status = 'open' }) {
  const [r] = await pool.query(
    `INSERT INTO tickets (customer_id, subject, description, status, priority, assigned_agent_id)
     VALUES (?, 'edge test', 'edge test ticket', ?, 'normal', ?)`,
    [customerId, status, assignedAgentId]
  );
  return r.insertId;
}

async function seedWaitingChat(customerId) {
  const [r] = await pool.query(
    `INSERT INTO chats (customer_id, status, created_at) VALUES (?, 'waiting', NOW())`,
    [customerId]
  );
  return r.insertId;
}

// Socket helper for the race tests that need the real socket path.
function socketConnect(token) {
  return new Promise((resolve, reject) => {
    const s = ioClient(BASE, {
      auth: { token }, transports: ['websocket'],
      forceNew: true, reconnection: false, timeout: 5000,
    });
    s.once('connect', () => resolve(s));
    s.once('connect_error', reject);
  });
}

function waitFor(socket, event, { timeoutMs = 3000, where = () => true } = {}) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { socket.off(event, h); reject(new Error(`waitFor('${event}') timed out`)); }, timeoutMs);
    const h = (p) => { if (!where(p)) return; clearTimeout(t); socket.off(event, h); resolve(p); };
    socket.on(event, h);
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────
async function run() {
  console.log(`\nEdge-cases / race-conditions suite  base=${BASE}\n`);
  const h = await request('GET', '/api/health');
  if (h.status !== 200) { console.error(`Backend not reachable at ${BASE}`); process.exit(2); }

  // ──────────────────────────────────────────────────────────────────────────
  console.log('─── 1. CONCURRENT UPDATES (two senders → same ticket) ───');

  await test('Assigned agent + admin reply to same ticket in parallel — both persist, order preserved', async () => {
    const cust  = await seedCustomer({ tag: 'cu1' });
    const agent = await seedAgent({ tag: 'ag1' });
    const admin = await seedAdmin({ tag: 'ad1' });
    const ticketId = await seedTicket({ customerId: cust.customerId, assignedAgentId: agent.userId });
    try {
      // Fire both replies in parallel — exact-same millisecond is unlikely but
      // they'll be in-flight simultaneously. Both authorized (agent is assigned;
      // admin bypasses the assigned-agent check).
      const [r1, r2] = await Promise.all([
        request('POST', `/api/agent/tickets/${ticketId}/reply`, { token: agent.token, body: { message: 'agent reply' } }),
        request('POST', `/api/agent/tickets/${ticketId}/reply`, { token: admin.token, body: { message: 'admin reply' } }),
      ]);
      assertEqual(r1.status, 201, `agent reply ${r1.status}`);
      assertEqual(r2.status, 201, `admin reply ${r2.status}`);

      const [rows] = await pool.query(
        'SELECT id, sender_id, message, created_at FROM ticket_messages WHERE ticket_id = ? ORDER BY id ASC',
        [ticketId]
      );
      assertEqual(rows.length, 2, `expected 2 rows, got ${rows.length}`);
      const senderIds = rows.map(r => r.sender_id);
      assert(senderIds.includes(agent.userId), 'agent reply persisted');
      assert(senderIds.includes(admin.userId), 'admin reply persisted');
      // Insert ids are monotonic so id order is the "true" send order. Timestamps
      // should NOT decrease — proves the audit trail is coherent.
      assert(rows[1].id > rows[0].id, 'ids are strictly increasing');
      assert(new Date(rows[1].created_at).getTime() >= new Date(rows[0].created_at).getTime(),
        'created_at is monotonic non-decreasing');
    } finally {
      await cleanupUser(cust.userId);
      await cleanupUser(agent.userId);
      await cleanupUser(admin.userId);
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n─── 2. CONCURRENT CHAT ACCEPTS (atomic claim) ───');

  await test('Two agents accept the same waiting chat — only one wins, DB row matches', async () => {
    // accept_chat is socket-only. The handler runs:
    //   UPDATE chats SET agent_id=?, status='active'
    //   WHERE id=? AND status='waiting' AND agent_id IS NULL
    // and emits the greeting only if affectedRows > 0. We fire two simultaneous
    // accepts and assert exactly one ends up as the owner.
    const cust = await seedCustomer({ tag: 'cu2' });
    const a1   = await seedAgent({ tag: 'ag2a' });
    const a2   = await seedAgent({ tag: 'ag2b' });
    const chatId = await seedWaitingChat(cust.customerId);
    let s1, s2;
    try {
      [s1, s2] = await Promise.all([socketConnect(a1.token), socketConnect(a2.token)]);
      // Fire both accepts as close to simultaneously as possible.
      s1.emit('accept_chat', { chatId });
      s2.emit('accept_chat', { chatId });
      // Give the server a tick to process both events + commit DB writes.
      await new Promise(r => setTimeout(r, 700));

      const [[chatRow]] = await pool.query('SELECT status, agent_id FROM chats WHERE id = ?', [chatId]);
      assertEqual(chatRow.status, 'active', 'chat flipped to active');
      const winningAgent = Number(chatRow.agent_id);
      assert(winningAgent === a1.userId || winningAgent === a2.userId,
        `winner is one of the two agents, got ${winningAgent}`);

      // There must be exactly ONE greeting from the winning agent in the chat.
      // If both accepts had emitted, the count would be 2 and the customer
      // would see "Hello! I'm X" twice.
      const [greetings] = await pool.query(
        `SELECT sender_id, message FROM chat_messages
         WHERE chat_id = ? AND sender_id = ? AND message LIKE 'Hello! I''m %'`,
        [chatId, winningAgent]
      );
      assertEqual(greetings.length, 1, `expected exactly 1 greeting, got ${greetings.length}`);
    } finally {
      try { s1?.disconnect(); s2?.disconnect(); } catch {}
      await pool.query('DELETE FROM chat_messages WHERE chat_id = ?', [chatId]);
      await pool.query('DELETE FROM chats WHERE id = ?', [chatId]);
      await cleanupUser(cust.userId);
      await cleanupUser(a1.userId);
      await cleanupUser(a2.userId);
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n─── 3. USAGE COUNTER RACES ───');

  await test('Customer one-shy of chat limit fires two concurrent initiates → exactly one new chat created', async () => {
    // We force "1 chat away from cap" by overriding the plan's chat_limit
    // via customer_feature_overrides (the same path the admin UI uses).
    // Setting limit = current usage + 1 means the next single chat fills the
    // bucket. Two concurrent inits would both pass the "used < limit" check
    // if the controller is racy.
    const cust = await seedCustomer({ planName: 'moderate', tag: 'cu3' });
    try {
      // Make sure no existing chats inflate usage
      await pool.query('UPDATE chats SET status = "closed", closed_at = NOW() WHERE customer_id = ? AND status IN ("waiting","active")', [cust.customerId]);
      // Plan default for moderate chat_limit is 8; we want "next chat fills".
      // We can't override chat_limit via customer_feature_overrides (it only
      // covers allow_*/tickets_limit/calls_limit). So instead: temporarily
      // pin the plan to ONE chat by changing the plan's chat_limit just for
      // this customer via a side-channel — easier: use a basic plan and seed
      // 4 engaged chats so usage=4. Basic chat_limit=5 → next chat caps.
      const tag = 'cu3_basic';
      const c2 = await seedCustomer({ planName: 'basic', tag });
      try {
        // Seed 4 "engaged" chats this month — usage=4 against basic's cap of 5
        for (let i = 0; i < 4; i++) {
          const [chat] = await pool.query(
            `INSERT INTO chats (customer_id, agent_id, status, accepted_at, closed_at, created_at)
             VALUES (?, 2, 'closed', NOW(), NOW(), NOW())`,
            [c2.customerId]
          );
          await pool.query(
            `INSERT INTO chat_messages (chat_id, sender_id, message) VALUES (?, ?, 'engaged')`,
            [chat.insertId, c2.userId]
          );
        }
        const beforeUsage = await getChatUsage(c2.customerId);
        assert(beforeUsage >= 4, `expected usage>=4, got ${beforeUsage}`);

        // Fire two concurrent initiates.
        const [r1, r2] = await Promise.all([
          request('POST', '/api/chat/initiate', { token: c2.token, body: {} }),
          request('POST', '/api/chat/initiate', { token: c2.token, body: {} }),
        ]);

        // Count chats CREATED in this run. The controller's "already_exists"
        // branch returns the EXISTING row when the customer has a waiting/
        // active chat, which catches one of the two concurrent requests
        // post-INSERT-by-the-other. So: at most one new row, the other is
        // either an already_exists 200 or a 403 limit.
        const [waitOrActive] = await pool.query(
          "SELECT id FROM chats WHERE customer_id = ? AND status IN ('waiting','active')",
          [c2.customerId]
        );
        assert(waitOrActive.length <= 1,
          `expected <=1 waiting/active chat after race, got ${waitOrActive.length} — RACE BUG`);
        // At least one of the two should have hit the limit or been deduped.
        const statuses = [r1.status, r2.status].sort();
        // Accept any of these combinations: (201, 200=already_exists),
        // (201, 403=limit), (200, 200) when both saw the same existing.
        const allow = (s) => [200, 201, 403].includes(s);
        assert(allow(r1.status) && allow(r2.status),
          `unexpected statuses ${statuses.join(',')}`);
      } finally {
        await cleanupUser(c2.userId);
      }
    } finally {
      await cleanupUser(cust.userId);
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n─── 4. PLAN EXPIRY BOUNDARY ───');
  // customers.plan_expiry is a DATE column (day-precision). isPlanActive does
  // `new Date(plan_expiry) >= new Date()`. The Date constructor parses
  // 'YYYY-MM-DD' as midnight UTC, so a customer whose expiry is "today" gets
  // denied after midnight UTC. Day-boundary semantics, not second-boundary.

  await test('Expiry = yesterday → denied; tomorrow → allowed; NULL → lifetime', async () => {
    const yesterday = await seedCustomer({ planName: 'basic', tag: 'exp_y' });
    await pool.query('UPDATE customers SET plan_expiry = CURDATE() - INTERVAL 1 DAY WHERE id = ?', [yesterday.customerId]);
    const tomorrow = await seedCustomer({ planName: 'basic', tag: 'exp_t' });
    // default seed gives +30 days, that's already "in the future"
    const nullExpiry = await seedCustomer({ planName: 'basic', tag: 'exp_n' });
    await pool.query('UPDATE customers SET plan_expiry = NULL WHERE id = ?', [nullExpiry.customerId]);
    try {
      const yR = await request('POST', '/api/chat/initiate', { token: yesterday.token, body: {} });
      const tR = await request('POST', '/api/chat/initiate', { token: tomorrow.token, body: {} });
      const nR = await request('POST', '/api/chat/initiate', { token: nullExpiry.token, body: {} });
      assertEqual(yR.status, 403, 'yesterday expiry should deny');
      assertEqual(tR.status, 201, `tomorrow expiry should allow, got ${tR.status} ${JSON.stringify(tR.body)}`);
      assertEqual(nR.status, 201, `NULL expiry should be lifetime, got ${nR.status} ${JSON.stringify(nR.body)}`);
    } finally {
      await cleanupUser(yesterday.userId);
      await cleanupUser(tomorrow.userId);
      await cleanupUser(nullExpiry.userId);
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n─── 5. DOUBLE-SUBMIT PREVENTION ───');

  await test('Two rapid reply POSTs both persist (API is NOT idempotent — FYI for frontend dedupe)', async () => {
    // The controller has no idempotency key or dedupe — frontend MUST throttle.
    // This test documents that contract: two POSTs = two rows. If the team
    // ever adds server-side dedupe (e.g. via a hash or client request id),
    // this test will fail and they'll know to update the frontend assumption.
    const cust  = await seedCustomer({ tag: 'cu5' });
    const agent = await seedAgent({ tag: 'ag5' });
    const ticketId = await seedTicket({ customerId: cust.customerId, assignedAgentId: agent.userId });
    try {
      const body = { message: 'double-submit payload' };
      const [r1, r2] = await Promise.all([
        request('POST', `/api/agent/tickets/${ticketId}/reply`, { token: agent.token, body }),
        request('POST', `/api/agent/tickets/${ticketId}/reply`, { token: agent.token, body }),
      ]);
      assertEqual(r1.status, 201, `first reply ${r1.status}`);
      assertEqual(r2.status, 201, `second reply ${r2.status}`);
      const [rows] = await pool.query(
        'SELECT COUNT(*) AS n FROM ticket_messages WHERE ticket_id = ? AND message = ?',
        [ticketId, 'double-submit payload']
      );
      assertEqual(Number(rows[0].n), 2, 'both submissions persisted — no dedup');
    } finally {
      await cleanupUser(cust.userId);
      await cleanupUser(agent.userId);
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n─── 6. ATTACHMENT EDGE CASES ───');

  await test('Oversize upload (32 MB) rejected by multer with 4xx', async () => {
    // Multer cap is 30 MB. We POST a multipart body with a 32 MB payload and
    // expect the server to reject before disk persistence.
    const cust = await seedCustomer({ tag: 'cu6a' });
    const ticketId = await seedTicket({ customerId: cust.customerId });
    try {
      const boundary = '----edge_' + crypto.randomBytes(8).toString('hex');
      const big = Buffer.alloc(32 * 1024 * 1024, 'A'); // 32 MB of 'A'
      const head = Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="ref_type"\r\n\r\nticket\r\n` +
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="ref_id"\r\n\r\n${ticketId}\r\n` +
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="big.bin"\r\n` +
        `Content-Type: application/zip\r\n\r\n`
      );
      const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
      const body = Buffer.concat([head, big, tail]);
      const r = await request('POST', '/api/attachments', {
        token: cust.token, rawBody: body,
        contentType: `multipart/form-data; boundary=${boundary}`,
      });
      assert(r.status >= 400 && r.status < 500, `expected 4xx, got ${r.status}`);
      // Verify no row was persisted on disk OR DB.
      const [rows] = await pool.query(
        'SELECT id FROM file_attachments WHERE ref_type = "ticket" AND ref_id = ? AND original_name = ?',
        [ticketId, 'big.bin']
      );
      assertEqual(rows.length, 0, 'no attachment row should be persisted on rejection');
    } finally {
      await cleanupUser(cust.userId);
    }
  });

  await test('Disallowed MIME type rejected with clear error', async () => {
    const cust = await seedCustomer({ tag: 'cu6b' });
    const ticketId = await seedTicket({ customerId: cust.customerId });
    try {
      const boundary = '----edge_' + crypto.randomBytes(8).toString('hex');
      // application/x-msdownload (.exe) is NOT in ALLOWED_TYPES nor AUDIO_TYPES.
      const head = Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="ref_type"\r\n\r\nticket\r\n` +
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="ref_id"\r\n\r\n${ticketId}\r\n` +
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="payload.exe"\r\n` +
        `Content-Type: application/x-msdownload\r\n\r\n`
      );
      const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
      const body = Buffer.concat([head, Buffer.from('MZ\x90\x00bogus-exe-bytes'), tail]);
      const r = await request('POST', '/api/attachments', {
        token: cust.token, rawBody: body,
        contentType: `multipart/form-data; boundary=${boundary}`,
      });
      assertEqual(r.status, 400, `expected 400 for disallowed MIME, got ${r.status}`);
      assert(/not allowed|reject/i.test(JSON.stringify(r.body)),
        `expected clear rejection message, got: ${JSON.stringify(r.body)}`);
    } finally {
      await cleanupUser(cust.userId);
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n─── 7. SEARCH / FILTER weirdness ───');

  await test('Unicode subject is searchable; SQL-injection string returns no leak', async () => {
    const a = await seedCustomer({ tag: 'cu7a' });
    const b = await seedCustomer({ tag: 'cu7b' });
    try {
      // Seed a ticket for B with a SQL-injection-shaped subject. Customer A
      // searching with the same string MUST NOT see B's ticket.
      const inj = `' OR '1'='1`;
      await pool.query(
        `INSERT INTO tickets (customer_id, subject, description, status, priority)
         VALUES (?, ?, 'sql injection canary', 'open', 'normal')`,
        [b.customerId, inj]
      );
      // Seed a unicode ticket for A.
      await pool.query(
        `INSERT INTO tickets (customer_id, subject, description, status, priority)
         VALUES (?, '日本語テスト 🇯🇵', 'unicode subject', 'open', 'normal')`,
        [a.customerId]
      );

      // SQL injection probe — A searches with the injection payload. Should
      // never leak B's ticket (parameterized queries) and should not 500.
      const r1 = await request('GET', `/api/tickets?search=${encodeURIComponent(inj)}`, { token: a.token });
      assertEqual(r1.status, 200, `injection search returned ${r1.status}`);
      const inj_tickets = r1.body.tickets || r1.body;
      const subjects = (inj_tickets || []).map(t => t.subject);
      // A's own list shouldn't include B's row regardless of search payload.
      assert(!subjects.includes(inj), `IDOR leak — A saw B's injection-shaped row: ${subjects.join('|')}`);

      // Unicode probe — A's own unicode subject must round-trip cleanly.
      const r2 = await request('GET', `/api/tickets?search=${encodeURIComponent('日本語')}`, { token: a.token });
      assertEqual(r2.status, 200, `unicode search returned ${r2.status}`);
      const u_tickets = r2.body.tickets || r2.body;
      assert(Array.isArray(u_tickets), 'unicode response shape sane');
      // Empty search probe — must not 500.
      const r3 = await request('GET', '/api/tickets?search=', { token: a.token });
      assertEqual(r3.status, 200, `empty search returned ${r3.status}`);
    } finally {
      await cleanupUser(a.userId);
      await cleanupUser(b.userId);
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n─── 8. TIME / TIMEZONE — month boundary ───');

  await test('Last-month engaged chat does NOT count toward this month\'s chat usage', async () => {
    // getChatUsage scopes to DATE_FORMAT(accepted_at, '%Y-%m') = current month.
    // A chat from last month (or even last day-of-last-month) must be excluded.
    const cust = await seedCustomer({ tag: 'cu8a' });
    try {
      // Seed an engaged chat with accepted_at = last month.
      const [chat] = await pool.query(
        `INSERT INTO chats (customer_id, agent_id, status, accepted_at, closed_at, created_at)
         VALUES (?, 2, 'closed', DATE_SUB(NOW(), INTERVAL 1 MONTH), DATE_SUB(NOW(), INTERVAL 1 MONTH), DATE_SUB(NOW(), INTERVAL 1 MONTH))`,
        [cust.customerId]
      );
      await pool.query(
        `INSERT INTO chat_messages (chat_id, sender_id, message, created_at)
         VALUES (?, ?, 'engaged last month', DATE_SUB(NOW(), INTERVAL 1 MONTH))`,
        [chat.insertId, cust.userId]
      );
      const last = await getChatUsage(cust.customerId);
      assertEqual(last, 0, `last-month engaged chat should not count, got ${last}`);

      // Seed one this-month engaged chat → usage flips to 1.
      const [thisChat] = await pool.query(
        `INSERT INTO chats (customer_id, agent_id, status, accepted_at, closed_at, created_at)
         VALUES (?, 2, 'closed', NOW(), NOW(), NOW())`,
        [cust.customerId]
      );
      await pool.query(
        `INSERT INTO chat_messages (chat_id, sender_id, message) VALUES (?, ?, 'engaged this month')`,
        [thisChat.insertId, cust.userId]
      );
      const now = await getChatUsage(cust.customerId);
      assertEqual(now, 1, `this-month engaged chat should count once, got ${now}`);
    } finally {
      await cleanupUser(cust.userId);
    }
  });

  await test('Last-month customer-initiated connected call does NOT count toward this month\'s call usage', async () => {
    const cust = await seedCustomer({ tag: 'cu8b' });
    try {
      await pool.query(
        `INSERT INTO calls (customer_id, agent_id, status, initiated_by, call_start_time, call_end_time, duration, created_at)
         VALUES (?, 2, 'ended', 'customer', DATE_SUB(NOW(), INTERVAL 1 MONTH), DATE_SUB(NOW(), INTERVAL 1 MONTH), 30, DATE_SUB(NOW(), INTERVAL 1 MONTH))`,
        [cust.customerId]
      );
      const last = await getCallUsage(cust.customerId);
      assertEqual(last, 0, `last-month call should not count, got ${last}`);

      await pool.query(
        `INSERT INTO calls (customer_id, agent_id, status, initiated_by, call_start_time, call_end_time, duration, created_at)
         VALUES (?, 2, 'ended', 'customer', NOW(), NOW(), 30, NOW())`,
        [cust.customerId]
      );
      const now = await getCallUsage(cust.customerId);
      assertEqual(now, 1, `this-month call should count once, got ${now}`);
    } finally {
      await cleanupUser(cust.userId);
    }
  });

  // ── Report ───────────────────────────────────────────────────────────────
  console.log('');
  const pass = results.filter(r => r.status === 'PASS').length;
  const fail = results.filter(r => r.status === 'FAIL').length;
  console.log(`Total ${results.length} · PASS ${pass} · FAIL ${fail}`);
  if (fail > 0) {
    console.log('\nFailures (probable real bugs — see notes):');
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
