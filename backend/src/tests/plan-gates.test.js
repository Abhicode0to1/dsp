/**
 * Plan-gating integration test suite
 * ----------------------------------
 *
 * Verifies the 403/201 contract for the three customer-facing channels (chat,
 * call, ticket) across the four product plans (free / basic / moderate /
 * premium), plus plan-expiry edge cases and `customer_feature_overrides`.
 *
 * Why this matters: if a free-plan customer can dial in, or a moderate-plan
 * customer can exceed their monthly call cap, every downstream invariant
 * (billing, SLA, agent queue) breaks. The tests below catch a regression in
 * the gate logic before it hits production.
 *
 * Run model
 *   - This project has no Jest/Mocha. Tests use a plain Node harness identical
 *     to `tests/routing-limits.test.js`. Run with:
 *         node src/tests/plan-gates.test.js
 *     The user's requested `npm test ...` is not wired into package.json.
 *   - Requires the backend running at TEST_BASE_URL (default http://localhost:5000)
 *     AND the dsp DB reachable via the same credentials src/config/database.js uses.
 *
 * Hermetic seeding
 *   Each scenario that needs a precise plan state creates a TEMP customer
 *   (email prefix `__plan_gates_…@dsp.test`) with a known plan, plan_expiry,
 *   and optional customer_feature_overrides row. Cleanup runs in a try/finally
 *   so a mid-test crash doesn't leave junk in the DB.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const http = require('http');
const bcrypt = require('bcryptjs');
const { pool } = require('../config/database');
const { getCallUsage } = require('../utils/planUtils');

const BASE = process.env.TEST_BASE_URL || 'http://localhost:5000';
const PASSWORD = 'Password@123';
const PWD_HASH = bcrypt.hashSync(PASSWORD, 10);

// ── Tiny test harness (matches tests/routing-limits.test.js style) ───────────
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
function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
function assertEqual(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || 'expected equal'} — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

// ── HTTP helper ──────────────────────────────────────────────────────────────
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
        let parsed;
        try { parsed = JSON.parse(chunks); } catch { parsed = chunks; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function login(email) {
  const r = await request('POST', '/api/auth/login', { body: { email, password: PASSWORD } });
  if (r.status !== 200) throw new Error(`login ${email} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.token;
}

// ── Seed helpers ─────────────────────────────────────────────────────────────
//
// createTempCustomer returns { email, token, userId, customerId, cleanup }.
// `cleanup` MUST be called in the test's finally{} so failed assertions don't
// leak rows. Override params are optional; pass `override` to seed a row in
// customer_feature_overrides (which the planUtils query LEFT-JOINs against).
async function planIdByName(name) {
  const [[p]] = await pool.query('SELECT id FROM plans WHERE name = ?', [name]);
  if (!p) throw new Error(`no plan named ${name}`);
  return p.id;
}

async function createTempCustomer({ planName, planExpiry = null, override = null, tag = 'gate' }) {
  const id = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const email = `__plan_gates_${tag}_${id}@dsp.test`;
  const planId = await planIdByName(planName);

  const [user] = await pool.query(
    `INSERT INTO users (name, email, password, role, is_active, created_at)
     VALUES (?, ?, ?, 'customer', 1, NOW())`,
    [`PlanGate ${tag} ${id}`, email, PWD_HASH]
  );
  const userId = user.insertId;

  // planExpiry: null (lifetime), Date, or 'SQL:<expr>' (e.g. 'SQL:CURDATE() + INTERVAL 1 DAY')
  let expiryClause = 'NULL', expiryParam = [];
  if (planExpiry instanceof Date) { expiryClause = '?'; expiryParam = [planExpiry]; }
  else if (typeof planExpiry === 'string' && planExpiry.startsWith('SQL:')) {
    expiryClause = planExpiry.slice(4);
  }

  const [cust] = await pool.query(
    `INSERT INTO customers (user_id, domain, plan_id, plan_expiry, invoice_subtotal)
     VALUES (?, ?, ?, ${expiryClause}, 0)`,
    [userId, `${tag}.test`, planId, ...expiryParam]
  );
  const customerId = cust.insertId;

  if (override) {
    // override = { allow_chat, allow_calls, tickets_limit, calls_limit }
    await pool.query(
      `INSERT INTO customer_feature_overrides
         (customer_id, allow_chat, allow_calls, tickets_limit, calls_limit, override_reason, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        customerId,
        override.allow_chat ?? null,
        override.allow_calls ?? null,
        override.tickets_limit ?? null,
        override.calls_limit ?? null,
        'plan-gates test',
        1,
      ]
    );
  }

  const token = await login(email);

  const cleanup = async () => {
    // Order matters because of FKs.
    await pool.query('DELETE FROM customer_feature_overrides WHERE customer_id = ?', [customerId]);
    await pool.query('DELETE FROM ticket_messages WHERE ticket_id IN (SELECT id FROM tickets WHERE customer_id = ?)', [customerId]);
    await pool.query('DELETE FROM tickets WHERE customer_id = ?', [customerId]);
    await pool.query('DELETE FROM ticket_usage WHERE customer_id = ?', [customerId]);
    await pool.query('DELETE FROM chat_messages WHERE chat_id IN (SELECT id FROM chats WHERE customer_id = ?)', [customerId]);
    await pool.query('DELETE FROM chats WHERE customer_id = ?', [customerId]);
    await pool.query('DELETE FROM calls WHERE customer_id = ?', [customerId]);
    await pool.query('DELETE FROM customers WHERE id = ?', [customerId]);
    await pool.query('DELETE FROM users WHERE id = ?', [userId]);
  };

  return { email, token, userId, customerId, cleanup };
}

// Seed a "connected, customer-initiated, current-month" call row — increments
// getCallUsage by exactly 1. Used to push a customer up to (or over) the cap
// without making a real WebRTC call.
async function seedConnectedCall(customerId) {
  // status ENUM is ('initiated','ringing','active','ended','failed','missed') — use 'ended'.
  // call_start_time IS NOT NULL + initiated_by != 'agent' + this month is what
  // getCallUsage() counts against the cap.
  const [r] = await pool.query(
    `INSERT INTO calls (customer_id, agent_id, status, initiated_by, call_start_time, call_end_time, duration, created_at)
     VALUES (?, 2, 'ended', 'customer', NOW(), NOW(), 30, NOW())`,
    [customerId]
  );
  return r.insertId;
}

// ── Tests ────────────────────────────────────────────────────────────────────
async function run() {
  console.log(`\nPlan-gating suite  base=${BASE}\n`);

  // Pre-flight: backend reachable + plans seeded
  const h = await request('GET', '/api/health');
  if (h.status !== 200) {
    console.error(`Backend not reachable at ${BASE}. Start it (npm run dev) first.`);
    process.exit(2);
  }
  for (const p of ['free', 'basic', 'moderate', 'premium']) {
    const [[row]] = await pool.query('SELECT id FROM plans WHERE name = ?', [p]);
    if (!row) { console.error(`Plan '${p}' missing — run seed.sql.`); process.exit(2); }
  }

  // ──────────────────────────────────────────────────────────────────────────
  console.log('─── 1. CHAT FEATURE GATING ───');

  await test('Chat: free plan denied with upgrade_required', async () => {
    const c = await createTempCustomer({ planName: 'free', planExpiry: 'SQL:CURDATE() + INTERVAL 30 DAY', tag: 'free_chat' });
    try {
      const r = await request('POST', '/api/chat/initiate', { token: c.token, body: {} });
      assertEqual(r.status, 403, 'free-plan chat should be denied');
      assert(r.body.upgrade_required === true, 'upgrade_required flag set');
      assertEqual(r.body.current_plan, 'free', 'error names the current plan');
    } finally { await c.cleanup(); }
  });

  await test('Chat: basic plan can initiate (201)', async () => {
    const c = await createTempCustomer({ planName: 'basic', planExpiry: 'SQL:CURDATE() + INTERVAL 30 DAY', tag: 'basic_chat' });
    try {
      const r = await request('POST', '/api/chat/initiate', { token: c.token, body: {} });
      assertEqual(r.status, 201, `basic-plan chat should succeed, got ${r.status} ${JSON.stringify(r.body)}`);
      assert(r.body.chat?.id, 'chat row returned');
      assertEqual(r.body.chat.status, 'waiting', 'new chat in waiting');
    } finally { await c.cleanup(); }
  });

  await test('Chat: moderate plan can initiate (201)', async () => {
    const c = await createTempCustomer({ planName: 'moderate', planExpiry: 'SQL:CURDATE() + INTERVAL 30 DAY', tag: 'mod_chat' });
    try {
      const r = await request('POST', '/api/chat/initiate', { token: c.token, body: {} });
      assertEqual(r.status, 201, 'moderate-plan chat should succeed');
    } finally { await c.cleanup(); }
  });

  await test('Chat: expired plan denied (plan_expired)', async () => {
    const c = await createTempCustomer({ planName: 'basic', planExpiry: 'SQL:CURDATE() - INTERVAL 1 DAY', tag: 'expired_chat' });
    try {
      const r = await request('POST', '/api/chat/initiate', { token: c.token, body: {} });
      assertEqual(r.status, 403, 'expired plan should deny chat');
      assert(/expired/i.test(r.body.error || ''), `expected expiry error, got: ${r.body.error}`);
      assert(r.body.upgrade_required === true, 'upgrade_required flag set');
    } finally { await c.cleanup(); }
  });

  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n─── 2. CALL FEATURE GATING ───');

  await test('Call: free plan denied', async () => {
    const c = await createTempCustomer({ planName: 'free', planExpiry: 'SQL:CURDATE() + INTERVAL 30 DAY', tag: 'free_call' });
    try {
      const r = await request('POST', '/api/calls/initiate', { token: c.token, body: {} });
      assertEqual(r.status, 403, 'free-plan call should be denied');
      assert(r.body.upgrade_required === true, 'upgrade_required flag set');
    } finally { await c.cleanup(); }
  });

  await test('Call: basic plan denied (calls_not_available)', async () => {
    const c = await createTempCustomer({ planName: 'basic', planExpiry: 'SQL:CURDATE() + INTERVAL 30 DAY', tag: 'basic_call' });
    try {
      const r = await request('POST', '/api/calls/initiate', { token: c.token, body: {} });
      assertEqual(r.status, 403, 'basic-plan call should be denied');
      assertEqual(r.body.current_plan, 'basic', 'error names current plan');
    } finally { await c.cleanup(); }
  });

  await test('Call: moderate plan can initiate (201)', async () => {
    const c = await createTempCustomer({ planName: 'moderate', planExpiry: 'SQL:CURDATE() + INTERVAL 30 DAY', tag: 'mod_call' });
    try {
      const r = await request('POST', '/api/calls/initiate', { token: c.token, body: {} });
      assertEqual(r.status, 201, `moderate-plan call should succeed, got ${r.status} ${JSON.stringify(r.body)}`);
      assert(r.body.call?.id, 'call row returned');
    } finally { await c.cleanup(); }
  });

  await test('Call: premium plan can initiate (201)', async () => {
    const c = await createTempCustomer({ planName: 'premium', planExpiry: 'SQL:CURDATE() + INTERVAL 30 DAY', tag: 'prem_call' });
    try {
      const r = await request('POST', '/api/calls/initiate', { token: c.token, body: {} });
      assertEqual(r.status, 201, 'premium-plan call should succeed');
    } finally { await c.cleanup(); }
  });

  await test('Call: at limit returns 403 limit_exceeded', async () => {
    // moderate plan default = 5 calls/month. Seed 5 connected calls, then attempt one more.
    const c = await createTempCustomer({ planName: 'moderate', planExpiry: 'SQL:CURDATE() + INTERVAL 30 DAY', tag: 'limit_call' });
    try {
      // Verify the cap is what we expect — defensive against future plan tweaks
      const [[plan]] = await pool.query('SELECT calls_limit FROM plans WHERE name = ?', ['moderate']);
      const cap = Number(plan.calls_limit);
      assert(cap > 0, `moderate calls_limit should be > 0, got ${cap}`);
      for (let i = 0; i < cap; i++) await seedConnectedCall(c.customerId);
      const used = await getCallUsage(c.customerId);
      assert(used >= cap, `seeded usage (${used}) should be >= cap (${cap})`);

      const r = await request('POST', '/api/calls/initiate', { token: c.token, body: {} });
      assertEqual(r.status, 403, 'at-limit call should be denied');
      assert(r.body.limit_exceeded === true, 'limit_exceeded flag set');
      assertEqual(r.body.limit, cap, 'limit echoed back');
    } finally { await c.cleanup(); }
  });

  await test('Call: under limit allowed (201)', async () => {
    // Moderate plan, seed cap-1 calls, the next one should still succeed.
    const c = await createTempCustomer({ planName: 'moderate', planExpiry: 'SQL:CURDATE() + INTERVAL 30 DAY', tag: 'under_call' });
    try {
      const [[plan]] = await pool.query('SELECT calls_limit FROM plans WHERE name = ?', ['moderate']);
      const cap = Number(plan.calls_limit);
      for (let i = 0; i < cap - 1; i++) await seedConnectedCall(c.customerId);
      const r = await request('POST', '/api/calls/initiate', { token: c.token, body: {} });
      assertEqual(r.status, 201, 'under-limit call should succeed');
    } finally { await c.cleanup(); }
  });

  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n─── 3. TICKET FEATURE GATING ───');
  // Customer-side ticket creation goes through POST /api/customer/bot/ticket
  // (the direct POST /api/tickets is blocked for role=customer by design).
  //
  // Note on plan defaults: after migration 001 the seeded plans all have
  // tickets_limit = NULL (unlimited). To test the limit branch we therefore
  // OVERRIDE tickets_limit via customer_feature_overrides — the same path
  // the admin UI uses. This is the only realistic way to exercise the gate
  // against current production seed data.

  await test('Ticket: free plan can create (unlimited by default)', async () => {
    const c = await createTempCustomer({ planName: 'free', planExpiry: 'SQL:CURDATE() + INTERVAL 30 DAY', tag: 'free_ticket' });
    try {
      const r = await request('POST', '/api/customer/bot/ticket', {
        token: c.token,
        body: { subject: 'gate-test ticket', description: 'hermetic plan-gate integration test ticket' },
      });
      assert(r.status === 200 || r.status === 201, `expected 200/201, got ${r.status} ${JSON.stringify(r.body)}`);
      assert(r.body.ticket_id, 'ticket_id returned');
    } finally { await c.cleanup(); }
  });

  await test('Ticket: tickets_limit override hit returns 403 limit_exceeded', async () => {
    // Override tickets_limit = 1 via customer_feature_overrides → first ticket
    // succeeds, second is denied with limit_exceeded.
    const c = await createTempCustomer({
      planName: 'basic',
      planExpiry: 'SQL:CURDATE() + INTERVAL 30 DAY',
      override: { tickets_limit: 1 },
      tag: 'limit_ticket',
    });
    try {
      const first = await request('POST', '/api/customer/bot/ticket', {
        token: c.token, body: { subject: 'first', description: 'first allowed under override' },
      });
      assert(first.status === 200 || first.status === 201, `first ticket should succeed, got ${first.status}`);

      const second = await request('POST', '/api/customer/bot/ticket', {
        token: c.token, body: { subject: 'second', description: 'second must be blocked by limit' },
      });
      assertEqual(second.status, 403, 'second ticket should be denied');
      assert(second.body.limit_exceeded === true, 'limit_exceeded flag set');
    } finally { await c.cleanup(); }
  });

  await test('Ticket: usage counter advances per ticket', async () => {
    // Sanity — ticket_usage row should bump from 0 → 1 → 2 as tickets are created.
    const c = await createTempCustomer({ planName: 'basic', planExpiry: 'SQL:CURDATE() + INTERVAL 30 DAY', tag: 'usage_ticket' });
    try {
      const beforeRow = await pool.query('SELECT count FROM ticket_usage WHERE customer_id = ?', [c.customerId]);
      const before = beforeRow[0][0]?.count || 0;
      await request('POST', '/api/customer/bot/ticket', { token: c.token, body: { subject: 'u1', description: 'usage test 1' } });
      await request('POST', '/api/customer/bot/ticket', { token: c.token, body: { subject: 'u2', description: 'usage test 2' } });
      const afterRow = await pool.query('SELECT count FROM ticket_usage WHERE customer_id = ?', [c.customerId]);
      const after = afterRow[0][0]?.count || 0;
      assertEqual(after - before, 2, 'usage row incremented twice');
    } finally { await c.cleanup(); }
  });

  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n─── 4. PLAN EXPIRY EDGE CASES ───');
  // NB: customers.plan_expiry is a DATE column (day granularity), so the
  // user's "expired by 1 second" is approximated as "yesterday" and
  // "expires in 1 second" as "tomorrow". The truthy intent — boundary
  // checks around expiry — is preserved.

  await test('Expiry: yesterday → denied (plan_expired)', async () => {
    const c = await createTempCustomer({ planName: 'basic', planExpiry: 'SQL:CURDATE() - INTERVAL 1 DAY', tag: 'exp_yest' });
    try {
      const r = await request('POST', '/api/chat/initiate', { token: c.token, body: {} });
      assertEqual(r.status, 403, 'yesterday-expired plan should deny');
      assert(/expired/i.test(r.body.error || ''), `expected expiry error, got: ${r.body.error}`);
    } finally { await c.cleanup(); }
  });

  await test('Expiry: tomorrow → allowed', async () => {
    const c = await createTempCustomer({ planName: 'basic', planExpiry: 'SQL:CURDATE() + INTERVAL 1 DAY', tag: 'exp_tom' });
    try {
      const r = await request('POST', '/api/chat/initiate', { token: c.token, body: {} });
      assertEqual(r.status, 201, 'tomorrow-expiring plan should still allow');
    } finally { await c.cleanup(); }
  });

  await test('Expiry: NULL plan_expiry → lifetime, always allowed', async () => {
    // isPlanActive(): no plan_expiry → return true unconditionally.
    const c = await createTempCustomer({ planName: 'basic', planExpiry: null, tag: 'exp_null' });
    try {
      const r = await request('POST', '/api/chat/initiate', { token: c.token, body: {} });
      assertEqual(r.status, 201, 'NULL expiry should be treated as lifetime');
    } finally { await c.cleanup(); }
  });

  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n─── 5. PLAN OVERRIDES (customer_feature_overrides) ───');

  await test('Override: free plan + allow_chat=1 → can chat', async () => {
    const c = await createTempCustomer({
      planName: 'free',
      planExpiry: 'SQL:CURDATE() + INTERVAL 30 DAY',
      override: { allow_chat: 1 }, // grant chat on a free plan
      tag: 'ov_free_chat',
    });
    try {
      const r = await request('POST', '/api/chat/initiate', { token: c.token, body: {} });
      assertEqual(r.status, 201, `free-plan-with-override should chat, got ${r.status} ${JSON.stringify(r.body)}`);
    } finally { await c.cleanup(); }
  });

  await test('Override: premium plan + allow_calls=0 → cannot call', async () => {
    const c = await createTempCustomer({
      planName: 'premium',
      planExpiry: 'SQL:CURDATE() + INTERVAL 30 DAY',
      override: { allow_calls: 0 }, // revoke calls on a premium plan
      tag: 'ov_prem_call',
    });
    try {
      const r = await request('POST', '/api/calls/initiate', { token: c.token, body: {} });
      assertEqual(r.status, 403, 'premium-with-override should deny calls');
      assert(r.body.upgrade_required === true, 'upgrade_required flag set');
    } finally { await c.cleanup(); }
  });

  await test('Override: free plan + calls override grants calls', async () => {
    const c = await createTempCustomer({
      planName: 'free',
      planExpiry: 'SQL:CURDATE() + INTERVAL 30 DAY',
      override: { allow_calls: 1, calls_limit: 5 },
      tag: 'ov_free_call',
    });
    try {
      const r = await request('POST', '/api/calls/initiate', { token: c.token, body: {} });
      assertEqual(r.status, 201, 'free-with-override should allow calls');
    } finally { await c.cleanup(); }
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
