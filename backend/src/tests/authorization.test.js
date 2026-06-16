/**
 * Authorization + multi-tenancy test suite
 * ----------------------------------------
 *
 * Drives every resource-bearing endpoint with both the legitimate owner and
 * an unrelated user — proves the controllers actually check ownership before
 * returning / mutating data. Covers:
 *
 *   1. Authentication baseline (no token, bad token, revoked session)
 *   2. Ticket IDOR (customer A vs B; agent X vs Y's assigned tickets)
 *   3. Chat IDOR
 *   4. Call IDOR
 *   5. Attachment IDOR
 *   6. Cross-role gating (customer → agent endpoints, agent → admin, etc.)
 *   7. Agent boundaries (assigned vs other-agent vs unassigned ticket)
 *   8. Admin universal access
 *
 * Test infrastructure (same as the other src/tests/*.js files in this repo)
 *   - Plain Node harness. No Jest, no supertest. `npm test` is not wired up.
 *     Run with:    node src/tests/authorization.test.js
 *   - Hits the live backend at TEST_BASE_URL (default http://localhost:5000).
 *   - Mints JWTs directly using the same shape `authController.signToken`
 *     produces, side-stepping the /login rate limit. This is a TEST-ONLY
 *     bypass — the socket and HTTP middleware still verify the JWT signature,
 *     jti, and is_active flag, which is all we're testing here anyway.
 *
 * Hermetic seeding
 *   Each scenario creates its own __auth_test_*@dsp.test users + resources
 *   and cleans them up in finally{}.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const http = require('http');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { pool } = require('../config/database');

const BASE = process.env.TEST_BASE_URL || 'http://localhost:5000';
const PWD_HASH = bcrypt.hashSync('Password@123', 10);

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

// Asserts a request is *denied*: explicitly 401 or 403. Used by IDOR + role
// checks so a 500 / 404 / 200 each fails loudly with a different message
// (helps distinguish "controller crashed" from "request was allowed through").
function assertForbidden(status, msg = 'expected forbidden') {
  if (status === 403 || status === 401) return;
  throw new Error(`${msg}: got ${status} (expected 401/403)`);
}

// ── HTTP ─────────────────────────────────────────────────────────────────────
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

// Convenience wrapper: makeRequest(user, METHOD, path, body?)
async function makeRequest(user, method, urlPath, body) {
  return request(method, urlPath, { token: user.token, body });
}

// Specifically used to assert that an endpoint *rejects* a given (wrong) user
// for any HTTP verb. Logs the response so the failure message tells you which
// endpoint slipped through and what status it returned.
async function expectForbidden(user, method, urlPath, body) {
  const r = await makeRequest(user, method, urlPath, body);
  assertForbidden(r.status, `${method} ${urlPath} should be denied for ${user.email}`);
}

// ── User seeding + JWT mint ──────────────────────────────────────────────────
async function planIdByName(name) {
  const [[p]] = await pool.query('SELECT id FROM plans WHERE name = ?', [name]);
  if (!p) throw new Error(`no plan named ${name}`);
  return p.id;
}

function mintToken(user) {
  const jti = crypto.randomBytes(16).toString('hex');
  // Promise wrapper — caller awaits both the DB update and the signature.
  return pool.query('UPDATE users SET active_session_jti = ? WHERE id = ?', [jti, user.userId])
    .then(() => jwt.sign(
      { id: user.userId, email: user.email, role: user.role, jti },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    ));
}

async function seedCustomer({ planName = 'premium', tag = 'c' } = {}) {
  const id = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const email = `__auth_test_${tag}_${id}@dsp.test`;
  const planId = await planIdByName(planName);
  const [u] = await pool.query(
    `INSERT INTO users (name, email, password, role, is_active, created_at)
     VALUES (?, ?, ?, 'customer', 1, NOW())`,
    [`AuthCust ${tag}`, email, PWD_HASH]
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
  const email = `__auth_test_${tag}_${id}@dsp.test`;
  const [u] = await pool.query(
    `INSERT INTO users (name, email, password, role, is_active, created_at)
     VALUES (?, ?, ?, 'agent', 1, NOW())`,
    [`AuthAgent ${tag}`, email, PWD_HASH]
  );
  const user = { userId: u.insertId, email, role: 'agent' };
  user.token = await mintToken(user);
  return user;
}

async function seedAdmin({ tag = 'adm' } = {}) {
  const id = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const email = `__auth_test_${tag}_${id}@dsp.test`;
  const [u] = await pool.query(
    `INSERT INTO users (name, email, password, role, is_active, created_at)
     VALUES (?, ?, ?, 'admin', 1, NOW())`,
    [`AuthAdmin ${tag}`, email, PWD_HASH]
  );
  const user = { userId: u.insertId, email, role: 'admin' };
  user.token = await mintToken(user);
  return user;
}

// ── Resource seeding ─────────────────────────────────────────────────────────
async function seedTicket({ customerId, assignedAgentId = null, status = 'open' }) {
  const [r] = await pool.query(
    `INSERT INTO tickets (customer_id, subject, description, status, priority, assigned_agent_id)
     VALUES (?, 'authz test', 'authorization test ticket', ?, 'normal', ?)`,
    [customerId, status, assignedAgentId]
  );
  return r.insertId;
}

async function seedChat({ customerId, agentId = null, status = 'active' }) {
  const accepted = status === 'active' ? 'NOW()' : 'NULL';
  const [r] = await pool.query(
    `INSERT INTO chats (customer_id, agent_id, status, accepted_at, created_at)
     VALUES (?, ?, ?, ${accepted}, NOW())`,
    [customerId, agentId, status]
  );
  return r.insertId;
}

async function seedCall({ customerId, agentId = null }) {
  const [r] = await pool.query(
    `INSERT INTO calls (customer_id, agent_id, status, initiated_by, call_start_time, created_at)
     VALUES (?, ?, 'active', 'customer', NOW(), NOW())`,
    [customerId, agentId]
  );
  return r.insertId;
}

// Create a dummy attachment row pointing at a known-good file on disk so the
// download path can run end-to-end. The stored_name is opaque to the controller.
async function seedAttachment({ refType, refId, uploaderId }) {
  // Re-use a tiny on-disk file we drop alongside the row so res.download() can
  // succeed when we want a HAPPY-path 200 / "Content-Disposition" check.
  const filename = `__authtest_${Date.now()}_${Math.floor(Math.random() * 1e6)}.txt`;
  const uploadsDir = path.join(__dirname, '..', '..', 'uploads');
  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
  fs.writeFileSync(path.join(uploadsDir, filename), 'authz test payload');
  const [r] = await pool.query(
    `INSERT INTO file_attachments (ref_type, ref_id, original_name, stored_name, mime_type, size_bytes, uploaded_by)
     VALUES (?, ?, 'authz.txt', ?, 'text/plain', 19, ?)`,
    [refType, refId, filename, uploaderId]
  );
  return { id: r.insertId, filename };
}

// Cleanup helpers — bottom-up to avoid FK trouble.
async function cleanupUser(userId) {
  // Resources owned by this user (as agent OR as customer)
  await pool.query('DELETE FROM chat_messages WHERE sender_id = ?', [userId]);
  await pool.query('DELETE FROM ticket_messages WHERE sender_id = ?', [userId]);
  // Defensive — internal notes table on tickets uses author_id
  await pool.query("DELETE FROM internal_notes WHERE author_id = ?", [userId]).catch(() => {});
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
  // Tickets where this user was the agent (orphan or with no customer match)
  await pool.query('UPDATE tickets SET assigned_agent_id = NULL WHERE assigned_agent_id = ?', [userId]);
  await pool.query('UPDATE chats SET agent_id = NULL WHERE agent_id = ?', [userId]);
  await pool.query('DELETE FROM users WHERE id = ?', [userId]);
}

// ── Tests ────────────────────────────────────────────────────────────────────
async function run() {
  console.log(`\nAuthorization suite  base=${BASE}\n`);

  const h = await request('GET', '/api/health');
  if (h.status !== 200) {
    console.error(`Backend not reachable at ${BASE} — start it first.`);
    process.exit(2);
  }

  // ──────────────────────────────────────────────────────────────────────────
  console.log('─── 1. AUTHENTICATION BASELINE ───');

  await test('No token → 401', async () => {
    const r = await request('GET', '/api/tickets');
    assertEqual(r.status, 401, 'expected 401 with no Authorization header');
  });

  await test('Garbage token → 401', async () => {
    const r = await request('GET', '/api/tickets', { token: 'not.a.jwt' });
    assertEqual(r.status, 401, 'expected 401 for malformed JWT');
  });

  await test('Revoked session (newer login overwrote jti) → 401', async () => {
    const u = await seedCustomer({ tag: 'revoked' });
    try {
      const oldToken = u.token;
      u.token = await mintToken(u); // mint a new token — overwrites active_session_jti
      const r = await request('GET', '/api/tickets', { token: oldToken });
      assertEqual(r.status, 401, 'old token should be rejected after re-mint');
      assert(/session|revoked|ended/i.test(JSON.stringify(r.body)), 'response mentions session');
    } finally { await cleanupUser(u.userId); }
  });

  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n─── 2. TICKET IDOR (customer vs customer) ───');

  await test('Customer views THEIR own ticket → 200', async () => {
    const c = await seedCustomer({ tag: 'tk_own' });
    const ticketId = await seedTicket({ customerId: c.customerId });
    try {
      const r = await makeRequest(c, 'GET', `/api/tickets/${ticketId}`);
      assertEqual(r.status, 200, `expected 200, got ${r.status}`);
      assert(r.body.ticket?.id === ticketId, 'ticket payload returned');
    } finally { await cleanupUser(c.userId); }
  });

  await test('Customer views ANOTHER customer\'s ticket → 403', async () => {
    const owner = await seedCustomer({ tag: 'tk_own2' });
    const intruder = await seedCustomer({ tag: 'tk_idor' });
    const ticketId = await seedTicket({ customerId: owner.customerId });
    try {
      await expectForbidden(intruder, 'GET', `/api/tickets/${ticketId}`);
    } finally {
      await cleanupUser(owner.userId);
      await cleanupUser(intruder.userId);
    }
  });

  await test('Customer replies to THEIR own ticket → 201', async () => {
    const c = await seedCustomer({ tag: 'tk_reply' });
    const ticketId = await seedTicket({ customerId: c.customerId });
    try {
      const r = await makeRequest(c, 'POST', `/api/tickets/${ticketId}/messages`, { message: 'my reply' });
      assertEqual(r.status, 201, `expected 201, got ${r.status} ${JSON.stringify(r.body)}`);
    } finally { await cleanupUser(c.userId); }
  });

  await test('Customer replies to ANOTHER customer\'s ticket → 403', async () => {
    const owner = await seedCustomer({ tag: 'tk_reply_o' });
    const intruder = await seedCustomer({ tag: 'tk_reply_i' });
    const ticketId = await seedTicket({ customerId: owner.customerId });
    try {
      await expectForbidden(intruder, 'POST', `/api/tickets/${ticketId}/messages`, { message: 'hijack' });
    } finally {
      await cleanupUser(owner.userId);
      await cleanupUser(intruder.userId);
    }
  });

  await test('Customer closes ANOTHER customer\'s ticket → 403', async () => {
    const owner = await seedCustomer({ tag: 'tk_close_o' });
    const intruder = await seedCustomer({ tag: 'tk_close_i' });
    const ticketId = await seedTicket({ customerId: owner.customerId });
    try {
      await expectForbidden(intruder, 'PUT', `/api/tickets/${ticketId}/close`);
    } finally {
      await cleanupUser(owner.userId);
      await cleanupUser(intruder.userId);
    }
  });

  await test('Customer reopens ANOTHER customer\'s ticket → 403', async () => {
    const owner = await seedCustomer({ tag: 'tk_reop_o' });
    const intruder = await seedCustomer({ tag: 'tk_reop_i' });
    const ticketId = await seedTicket({ customerId: owner.customerId, status: 'closed' });
    try {
      await expectForbidden(intruder, 'PUT', `/api/tickets/${ticketId}/reopen`);
    } finally {
      await cleanupUser(owner.userId);
      await cleanupUser(intruder.userId);
    }
  });

  await test('Customer mutates ANOTHER customer\'s CC list → 403', async () => {
    const owner = await seedCustomer({ tag: 'tk_cc_o' });
    const intruder = await seedCustomer({ tag: 'tk_cc_i' });
    const ticketId = await seedTicket({ customerId: owner.customerId });
    try {
      await expectForbidden(intruder, 'PUT', `/api/tickets/${ticketId}/cc-emails`, { cc_emails: ['x@y.com'] });
    } finally {
      await cleanupUser(owner.userId);
      await cleanupUser(intruder.userId);
    }
  });

  await test('Customer list endpoint returns only own tickets', async () => {
    const a = await seedCustomer({ tag: 'tk_list_a' });
    const b = await seedCustomer({ tag: 'tk_list_b' });
    const tA = await seedTicket({ customerId: a.customerId });
    await seedTicket({ customerId: b.customerId });
    try {
      const r = await makeRequest(a, 'GET', '/api/tickets');
      assertEqual(r.status, 200, 'list should succeed');
      const tickets = r.body.tickets || r.body;
      const ids = Array.isArray(tickets) ? tickets.map(t => t.id) : [];
      assert(ids.includes(tA), 'own ticket present');
      // Customer B's ticket id should not appear
      const aTicketIds = new Set(ids);
      const [[bRow]] = await pool.query('SELECT id FROM tickets WHERE customer_id = ?', [b.customerId]);
      assert(!aTicketIds.has(bRow.id), `cust A must not see cust B's ticket ${bRow.id}`);
    } finally {
      await cleanupUser(a.userId);
      await cleanupUser(b.userId);
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n─── 3. CHAT IDOR ───');

  await test('Customer closes ANOTHER customer\'s chat → 403/4xx', async () => {
    const owner = await seedCustomer({ tag: 'ch_close_o' });
    const intruder = await seedCustomer({ tag: 'ch_close_i' });
    const chatId = await seedChat({ customerId: owner.customerId });
    try {
      const r = await makeRequest(intruder, 'PUT', `/api/chat/${chatId}/close`);
      assertForbidden(r.status, `intruder closing another customer's chat should be denied`);
    } finally {
      await cleanupUser(owner.userId);
      await cleanupUser(intruder.userId);
    }
  });

  await test('Customer rates ANOTHER customer\'s chat → 403', async () => {
    // Controller field is `rating` (1–5). A malformed payload hits the 400
    // validation gate BEFORE the ownership check — sending a valid rating is
    // required to actually exercise the IDOR path.
    const owner = await seedCustomer({ tag: 'ch_rate_o' });
    const intruder = await seedCustomer({ tag: 'ch_rate_i' });
    const chatId = await seedChat({ customerId: owner.customerId, status: 'closed' });
    try {
      const r = await makeRequest(intruder, 'POST', `/api/chat/${chatId}/rate`, { rating: 5, comment: 'idor' });
      assertEqual(r.status, 403, `cross-customer chat rating should be 403, got ${r.status} ${JSON.stringify(r.body)}`);
    } finally {
      await cleanupUser(owner.userId);
      await cleanupUser(intruder.userId);
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n─── 4. CALL IDOR ───');

  await test('Customer ends ANOTHER customer\'s call → 403/4xx', async () => {
    const owner = await seedCustomer({ tag: 'cl_end_o' });
    const intruder = await seedCustomer({ tag: 'cl_end_i' });
    const callId = await seedCall({ customerId: owner.customerId });
    try {
      const r = await makeRequest(intruder, 'PUT', `/api/calls/${callId}/end`);
      assertForbidden(r.status, 'cross-customer call end should be denied');
    } finally {
      await cleanupUser(owner.userId);
      await cleanupUser(intruder.userId);
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n─── 5. ATTACHMENT IDOR ───');

  await test('Customer downloads attachment on THEIR ticket → 200', async () => {
    const c = await seedCustomer({ tag: 'at_own' });
    const ticketId = await seedTicket({ customerId: c.customerId });
    const att = await seedAttachment({ refType: 'ticket', refId: ticketId, uploaderId: c.userId });
    try {
      const r = await makeRequest(c, 'GET', `/api/attachments/${att.id}/download`);
      assertEqual(r.status, 200, 'owner should be able to download');
    } finally {
      await pool.query('DELETE FROM file_attachments WHERE id = ?', [att.id]);
      await cleanupUser(c.userId);
    }
  });

  await test('Customer downloads ANOTHER customer\'s ticket attachment → 403', async () => {
    const owner = await seedCustomer({ tag: 'at_o' });
    const intruder = await seedCustomer({ tag: 'at_i' });
    const ticketId = await seedTicket({ customerId: owner.customerId });
    const att = await seedAttachment({ refType: 'ticket', refId: ticketId, uploaderId: owner.userId });
    try {
      const r = await makeRequest(intruder, 'GET', `/api/attachments/${att.id}/download`);
      assertEqual(r.status, 403, 'cross-customer download should be 403');
    } finally {
      await pool.query('DELETE FROM file_attachments WHERE id = ?', [att.id]);
      await cleanupUser(owner.userId);
      await cleanupUser(intruder.userId);
    }
  });

  await test('Customer deletes attachment they did NOT upload → 403', async () => {
    // Two customers; A uploaded an attachment on their own ticket; B tries to delete it.
    const a = await seedCustomer({ tag: 'at_del_a' });
    const b = await seedCustomer({ tag: 'at_del_b' });
    const ticketA = await seedTicket({ customerId: a.customerId });
    const att = await seedAttachment({ refType: 'ticket', refId: ticketA, uploaderId: a.userId });
    try {
      const r = await makeRequest(b, 'DELETE', `/api/attachments/${att.id}`);
      assertEqual(r.status, 403, 'non-uploader (cross-customer) must not delete attachment');
    } finally {
      await pool.query('DELETE FROM file_attachments WHERE id = ?', [att.id]);
      await cleanupUser(a.userId);
      await cleanupUser(b.userId);
    }
  });

  await test('Call-recording attachments are admin-only', async () => {
    const c    = await seedCustomer({ tag: 'rec_c' });
    const ag   = await seedAgent({ tag: 'rec_a' });
    const callId = await seedCall({ customerId: c.customerId, agentId: ag.userId });
    const att = await seedAttachment({ refType: 'call_recording', refId: callId, uploaderId: ag.userId });
    try {
      const r1 = await makeRequest(c, 'GET', `/api/attachments/${att.id}/download`);
      assertEqual(r1.status, 403, 'customer cannot fetch call recording');
      const r2 = await makeRequest(ag, 'GET', `/api/attachments/${att.id}/download`);
      assertEqual(r2.status, 403, 'agent cannot fetch call recording');
    } finally {
      await pool.query('DELETE FROM file_attachments WHERE id = ?', [att.id]);
      await pool.query('DELETE FROM calls WHERE id = ?', [callId]);
      await cleanupUser(c.userId);
      await cleanupUser(ag.userId);
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n─── 6. CROSS-ROLE (wrong role → 403) ───');

  await test('Customer hits agent dashboard → 403', async () => {
    const c = await seedCustomer({ tag: 'xr_cd' });
    try { await expectForbidden(c, 'GET', '/api/agent/dashboard'); }
    finally { await cleanupUser(c.userId); }
  });

  await test('Customer hits admin customers list → 403', async () => {
    const c = await seedCustomer({ tag: 'xr_ad' });
    try { await expectForbidden(c, 'GET', '/api/admin/customers'); }
    finally { await cleanupUser(c.userId); }
  });

  await test('Agent hits admin customers list → 403', async () => {
    const a = await seedAgent({ tag: 'xr_aa' });
    try { await expectForbidden(a, 'GET', '/api/admin/customers'); }
    finally { await cleanupUser(a.userId); }
  });

  await test('Agent cannot create ticket via the customer-only bot endpoint', async () => {
    // Customer role is required by route guard. An agent token must be rejected
    // before the controller's plan checks run.
    const a = await seedAgent({ tag: 'xr_bot' });
    try { await expectForbidden(a, 'POST', '/api/customer/bot/ticket', { subject: 'x', description: 'y' }); }
    finally { await cleanupUser(a.userId); }
  });

  await test('Customer cannot directly create a ticket via /api/agent/tickets/create', async () => {
    const c = await seedCustomer({ tag: 'xr_tc' });
    try { await expectForbidden(c, 'POST', '/api/agent/tickets/create', { subject: 'x', description: 'y' }); }
    finally { await cleanupUser(c.userId); }
  });

  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n─── 7. AGENT BOUNDARIES ───');

  await test('Agent replies to ticket assigned to ANOTHER agent → 403', async () => {
    const cust = await seedCustomer({ tag: 'agb_c' });
    const a1   = await seedAgent({ tag: 'agb_a1' });
    const a2   = await seedAgent({ tag: 'agb_a2' });
    const ticketId = await seedTicket({ customerId: cust.customerId, assignedAgentId: a2.userId });
    try {
      const r = await makeRequest(a1, 'POST', `/api/agent/tickets/${ticketId}/reply`, { message: 'sneaky' });
      assertEqual(r.status, 403, `agent1 must not reply to agent2's ticket; got ${r.status}`);
    } finally {
      await cleanupUser(cust.userId);
      await cleanupUser(a1.userId);
      await cleanupUser(a2.userId);
    }
  });

  await test('Agent updates ticket assigned to ANOTHER agent → 403', async () => {
    const cust = await seedCustomer({ tag: 'agb2_c' });
    const a1   = await seedAgent({ tag: 'agb2_a1' });
    const a2   = await seedAgent({ tag: 'agb2_a2' });
    const ticketId = await seedTicket({ customerId: cust.customerId, assignedAgentId: a2.userId });
    try {
      const r = await makeRequest(a1, 'PUT', `/api/agent/tickets/${ticketId}`, { status: 'closed' });
      assertEqual(r.status, 403, 'cross-agent status update must be denied');
    } finally {
      await cleanupUser(cust.userId);
      await cleanupUser(a1.userId);
      await cleanupUser(a2.userId);
    }
  });

  await test('Agent claims unassigned ticket → 200; second claim by other agent → 409', async () => {
    // claimTicket is the only public path that legitimately mutates an unassigned ticket.
    // Verifies the atomic-claim guard prevents the second agent from stealing it.
    const cust = await seedCustomer({ tag: 'agb3_c' });
    const a1   = await seedAgent({ tag: 'agb3_a1' });
    const a2   = await seedAgent({ tag: 'agb3_a2' });
    const ticketId = await seedTicket({ customerId: cust.customerId, assignedAgentId: null });
    try {
      const r1 = await makeRequest(a1, 'POST', `/api/agent/tickets/${ticketId}/claim`);
      assertEqual(r1.status, 200, `first claim should succeed, got ${r1.status} ${JSON.stringify(r1.body)}`);
      const r2 = await makeRequest(a2, 'POST', `/api/agent/tickets/${ticketId}/claim`);
      assertEqual(r2.status, 409, 'second claim must conflict');
    } finally {
      await cleanupUser(cust.userId);
      await cleanupUser(a1.userId);
      await cleanupUser(a2.userId);
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n─── 8. ADMIN UNIVERSAL ACCESS ───');

  await test('Admin views ANY ticket → 200', async () => {
    const cust = await seedCustomer({ tag: 'adm_c' });
    const admin = await seedAdmin({ tag: 'adm_v' });
    const ticketId = await seedTicket({ customerId: cust.customerId });
    try {
      const r = await makeRequest(admin, 'GET', `/api/tickets/${ticketId}`);
      assertEqual(r.status, 200, `admin should view any ticket, got ${r.status}`);
    } finally {
      await cleanupUser(cust.userId);
      await cleanupUser(admin.userId);
    }
  });

  await test('Admin views ANY customer detail → 200', async () => {
    const cust = await seedCustomer({ tag: 'adm_c2' });
    const admin = await seedAdmin({ tag: 'adm_v2' });
    try {
      const r = await makeRequest(admin, 'GET', `/api/admin/customers/${cust.customerId}`);
      assertEqual(r.status, 200, `admin customer detail; got ${r.status}`);
    } finally {
      await cleanupUser(cust.userId);
      await cleanupUser(admin.userId);
    }
  });

  await test('Admin replies on a ticket assigned to a different agent → 201', async () => {
    // Admin should bypass the "only assigned agent can reply" rule.
    const cust = await seedCustomer({ tag: 'adm_r_c' });
    const ag   = await seedAgent({ tag: 'adm_r_a' });
    const admin = await seedAdmin({ tag: 'adm_r_x' });
    const ticketId = await seedTicket({ customerId: cust.customerId, assignedAgentId: ag.userId });
    try {
      const r = await makeRequest(admin, 'POST', `/api/agent/tickets/${ticketId}/reply`, { message: 'admin override' });
      assertEqual(r.status, 201, `admin reply on cross-agent ticket should succeed, got ${r.status} ${JSON.stringify(r.body)}`);
    } finally {
      await cleanupUser(cust.userId);
      await cleanupUser(ag.userId);
      await cleanupUser(admin.userId);
    }
  });

  // ── Report ───────────────────────────────────────────────────────────────
  console.log('');
  const pass = results.filter(r => r.status === 'PASS').length;
  const fail = results.filter(r => r.status === 'FAIL').length;
  console.log(`Total ${results.length} · PASS ${pass} · FAIL ${fail}`);
  if (fail > 0) {
    console.log('\nFailures (probable RED FLAGs — cross-tenant access not blocked):');
    results.filter(r => r.status === 'FAIL').forEach(r => console.log(`  - ${r.name}: ${r.err}`));
  } else {
    console.log('All authorization checks passed — no IDOR vulnerabilities surfaced.');
  }
  console.log('');
  await pool.end();
  process.exit(fail === 0 ? 0 : 1);
}

run().catch(err => {
  console.error('Suite crashed:', err);
  pool.end().finally(() => process.exit(2));
});
