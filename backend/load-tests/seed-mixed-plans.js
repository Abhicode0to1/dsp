#!/usr/bin/env node
/**
 * Seed mixed-plan test data for the multi-channel load suite.
 * --------------------------------------------------------------
 *
 *   node backend/load-tests/seed-mixed-plans.js          # default scale (25 per plan)
 *   SCALE=2 node backend/load-tests/seed-mixed-plans.js  # 50 per plan
 *   SCALE=4 node backend/load-tests/seed-mixed-plans.js  # 100 per plan
 *
 * Output: writes ../../load-results/seed-manifest.json containing every
 * seeded user's id, email, plan, and a freshly-minted JWT. The four load
 * specs read this manifest instead of seeding their own customers — one
 * cold start, four spec runs.
 *
 * Why pre-seeded JWTs: the orchestrator runs all 4 specs serially. If each
 * spec seeded its own users we'd pay the cold-DB cost 4× and we'd
 * concurrent-edit `users.active_session_jti` across processes (single-session
 * enforcement means the most recent jti wins, which is exactly what we don't
 * want when 4 specs are reading the same manifest). Minting once + reusing
 * the same jti = stable sessions across the suite.
 *
 * Cleanup: writes the same manifest with a `cleanup_query_args` field listing
 * userIds; run `node backend/load-tests/seed-mixed-plans.js --cleanup` to
 * wipe everything seeded by the most recent run.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const fs = require('fs');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { pool } = require('../src/config/database');

const SCALE = Math.max(1, parseInt(process.env.SCALE || '1', 10));
const PER_PLAN = 25 * SCALE;
const AGENT_COUNT = 2;
const PWD_HASH = bcrypt.hashSync('Password@123', 10);
const MANIFEST_PATH = path.resolve(__dirname, '..', '..', 'load-results', 'seed-manifest.json');

const PLAN_DIST = [
  // Pre-fill some usage so we can test "near-limit" customers without a
  // separate setup step. ticketsUsed=2 means a basic customer has 3 tickets
  // left before the gate kicks in.
  { plan: 'free',     ticketsUsed: 0, callsUsed: 0 },
  { plan: 'basic',    ticketsUsed: 2, callsUsed: 0 },
  { plan: 'moderate', ticketsUsed: 2, callsUsed: 1 },
  { plan: 'premium',  ticketsUsed: 3, callsUsed: 2 },
];

async function planIdByName(name) {
  const [[p]] = await pool.query('SELECT id FROM plans WHERE name = ?', [name]);
  if (!p) throw new Error(`Plan not found in DB: ${name}`);
  return p.id;
}

function signToken({ id, email, role, jti }) {
  return jwt.sign({ id, email, role, jti }, process.env.JWT_SECRET, { expiresIn: '4h' });
}

async function seedCustomer({ idx, plan, ticketsUsed, callsUsed, planId }) {
  const tag = `${Date.now()}_${plan}_${idx}_${Math.floor(Math.random() * 1e4)}`;
  const email = `__mcload_${plan}_${tag}@dsp.test`;
  const name = `MC ${plan} ${idx}`;
  const [u] = await pool.query(
    `INSERT INTO users (name, email, password, role, is_active, created_at)
     VALUES (?, ?, ?, 'customer', 1, NOW())`,
    [name, email, PWD_HASH]
  );
  const [c] = await pool.query(
    `INSERT INTO customers (user_id, domain, plan_id, plan_expiry, invoice_subtotal)
     VALUES (?, ?, ?, CURDATE() + INTERVAL 60 DAY, 0)`,
    [u.insertId, `${plan}${idx}.mcload.test`, planId]
  );
  // Pre-fill monthly usage so we can hit limits deterministically. The DB
  // stores `month_year` as 'YYYY-MM' — matches how the controllers query.
  const month = new Date().toISOString().slice(0, 7);
  if (ticketsUsed > 0) {
    await pool.query(
      `INSERT INTO ticket_usage (customer_id, month_year, count) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE count = VALUES(count)`,
      [c.insertId, month, ticketsUsed]
    );
  }
  if (callsUsed > 0) {
    await pool.query(
      `INSERT INTO call_usage (customer_id, month_year, count) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE count = VALUES(count)`,
      [c.insertId, month, callsUsed]
    );
  }
  const jti = crypto.randomBytes(16).toString('hex');
  await pool.query('UPDATE users SET active_session_jti = ? WHERE id = ?', [jti, u.insertId]);
  return {
    userId: u.insertId,
    customerId: c.insertId,
    email, name, plan,
    ticketsUsed, callsUsed,
    token: signToken({ id: u.insertId, email, role: 'customer', jti }),
  };
}

async function seedAgent({ idx }) {
  const tag = `${Date.now()}_${idx}_${Math.floor(Math.random() * 1e4)}`;
  const email = `__mcload_agent_${tag}@dsp.test`;
  const name = `MC Agent ${idx === 0 ? 'A' : 'B'}`;
  const [u] = await pool.query(
    `INSERT INTO users (name, email, password, role, is_active, last_status, created_at)
     VALUES (?, ?, ?, 'agent', 1, 'online', NOW())`,
    [name, email, PWD_HASH]
  );
  const jti = crypto.randomBytes(16).toString('hex');
  await pool.query('UPDATE users SET active_session_jti = ? WHERE id = ?', [jti, u.insertId]);
  return {
    userId: u.insertId,
    email, name,
    token: signToken({ id: u.insertId, email, role: 'agent', jti }),
  };
}

async function cleanup(manifest) {
  if (!manifest) return;
  const allIds = [
    ...(manifest.customers || []).map(c => c.userId),
    ...(manifest.agents || []).map(a => a.userId),
  ];
  if (!allIds.length) return console.log('[cleanup] manifest empty — nothing to remove.');
  const inList = allIds.map(() => '?').join(',');
  // Detach FK-pointing rows first, then delete by user id.
  await pool.query(`UPDATE chats SET agent_id = NULL WHERE agent_id IN (${inList})`, allIds);
  await pool.query(`UPDATE tickets SET assigned_agent_id = NULL WHERE assigned_agent_id IN (${inList})`, allIds);
  // Customer-side: cascade by user_id → customer_id → tickets/chats/calls/usage.
  const customerIds = (manifest.customers || []).map(c => c.customerId);
  if (customerIds.length) {
    const cList = customerIds.map(() => '?').join(',');
    await pool.query(`DELETE FROM chat_messages WHERE chat_id IN (SELECT id FROM chats WHERE customer_id IN (${cList}))`, customerIds);
    await pool.query(`DELETE FROM chats WHERE customer_id IN (${cList})`, customerIds);
    await pool.query(`DELETE FROM ticket_messages WHERE ticket_id IN (SELECT id FROM tickets WHERE customer_id IN (${cList}))`, customerIds);
    await pool.query(`DELETE FROM tickets WHERE customer_id IN (${cList})`, customerIds);
    await pool.query(`DELETE FROM calls WHERE customer_id IN (${cList})`, customerIds);
    await pool.query(`DELETE FROM ticket_usage WHERE customer_id IN (${cList})`, customerIds);
    await pool.query(`DELETE FROM call_usage WHERE customer_id IN (${cList})`, customerIds);
    await pool.query(`DELETE FROM customers WHERE id IN (${cList})`, customerIds);
  }
  await pool.query(`DELETE FROM chat_messages WHERE sender_id IN (${inList})`, allIds);
  await pool.query(`DELETE FROM ticket_messages WHERE sender_id IN (${inList})`, allIds);
  await pool.query(`DELETE FROM users WHERE id IN (${inList})`, allIds);
  console.log(`[cleanup] removed ${allIds.length} users + their owned rows.`);
}

async function main() {
  const isCleanup = process.argv.includes('--cleanup');
  if (isCleanup) {
    let manifest = null;
    try { manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')); } catch {}
    await cleanup(manifest);
    try { fs.unlinkSync(MANIFEST_PATH); } catch {}
    await pool.end();
    return;
  }

  // If a previous manifest exists, clean it up first — leaving stale rows
  // from a prior run pollutes ticket_usage / call_usage and skews limits.
  try {
    const prior = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    console.log('[seed] cleaning up prior manifest first...');
    await cleanup(prior);
  } catch {}

  console.log(`[seed] SCALE=${SCALE} → ${PER_PLAN} customers per plan, ${AGENT_COUNT} agents`);

  // Resolve plan IDs once.
  const planIds = {};
  for (const { plan } of PLAN_DIST) planIds[plan] = await planIdByName(plan);

  // Seed customers: 4 plans × PER_PLAN each.
  const customers = [];
  for (const { plan, ticketsUsed, callsUsed } of PLAN_DIST) {
    for (let i = 0; i < PER_PLAN; i++) {
      const c = await seedCustomer({ idx: i, plan, ticketsUsed, callsUsed, planId: planIds[plan] });
      customers.push(c);
    }
    console.log(`  ${plan.padEnd(8)} × ${PER_PLAN} seeded`);
  }

  // Seed agents.
  const agents = [];
  for (let i = 0; i < AGENT_COUNT; i++) {
    agents.push(await seedAgent({ idx: i }));
  }
  console.log(`  agents   × ${AGENT_COUNT} seeded`);

  // Write manifest.
  fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify({
    seededAt: new Date().toISOString(),
    scale: SCALE,
    per_plan: PER_PLAN,
    customers,
    agents,
  }, null, 2));

  console.log(`[seed] manifest written → ${MANIFEST_PATH}`);
  await pool.end();
}

main().catch(async (err) => {
  console.error('[seed] error:', err);
  try { await pool.end(); } catch {}
  process.exit(1);
});
