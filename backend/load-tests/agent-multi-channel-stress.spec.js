/**
 * Agent-panel stress under multi-channel queue depth.
 * ----------------------------------------------------
 * Seeds queue depth via direct INSERT (chats waiting + tickets unassigned +
 * calls pending) then drives one agent's browser through the dashboard to
 * see whether the UI stays responsive. Mirrors the existing agent-ui-stress
 * scenario 1 but with all THREE channels populated, not just chats.
 *
 * Reads the seed-mixed-plans.js manifest to get test agent tokens.
 */

const { test, expect } = require('@playwright/test');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const fs = require('fs');
const { pool } = require('../src/config/database');
const { createRecorder, appendResult } = require('./ui-metrics-recorder');
const { attachSocketTracker, harvest: harvestSocket } = require('./socket-message-tracker');

const MANIFEST_PATH = path.resolve(__dirname, '..', '..', 'load-results', 'seed-manifest.json');
const TICKET_DEPTH = Number(process.env.MC_TICKET_DEPTH || 40);
const CHAT_DEPTH   = Number(process.env.MC_CHAT_DEPTH   || 30);
const CALL_DEPTH   = Number(process.env.MC_CALL_DEPTH   || 10);

function loadManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
}

async function seedQueueDepth(manifest) {
  // Spread the queued items across customers from the manifest. Tickets go
  // to any plan; chats only to plans that allow chat; calls only to plans
  // that allow calls. Reusing manifest customers means cleanup is the
  // orchestrator's job — we don't make new rows here.
  const chatEligible = manifest.customers.filter(c => c.plan !== 'free');
  const callEligible = manifest.customers.filter(c => c.plan === 'moderate' || c.plan === 'premium');

  // Defensive cleanup: prior specs in the suite may have left waiting/active
  // chats for these customers, and migration 003 enforces ONE active chat
  // per customer at the DB level. Close them before seeding so the inserts
  // below don't trip uq_chat_one_active_per_customer.
  const allCustomerIds = manifest.customers.map(c => c.customerId);
  if (allCustomerIds.length) {
    const list = allCustomerIds.map(() => '?').join(',');
    await pool.query(
      `UPDATE chats SET status = 'closed', closed_at = NOW()
       WHERE customer_id IN (${list}) AND status IN ('waiting', 'active')`,
      allCustomerIds
    );
  }

  const insertedTicketIds = [];
  const insertedChatIds = [];
  const insertedCallIds = [];

  for (let i = 0; i < TICKET_DEPTH; i++) {
    const c = manifest.customers[i % manifest.customers.length];
    const [r] = await pool.query(
      `INSERT INTO tickets (customer_id, subject, description, status, priority, created_at)
       VALUES (?, ?, 'queue-depth seed', 'open', 'normal', NOW())`,
      [c.customerId, `mc-stress ticket ${i}`]
    );
    insertedTicketIds.push(r.insertId);
  }
  // Chat seeding: each customer can hold at most one waiting/active chat at
  // a time (DB-enforced). To hit CHAT_DEPTH we need that many DISTINCT
  // chat-eligible customers — fail fast if the manifest doesn't have enough.
  if (CHAT_DEPTH > chatEligible.length) {
    throw new Error(`CHAT_DEPTH=${CHAT_DEPTH} exceeds chat-eligible customers (${chatEligible.length}). Lower MC_CHAT_DEPTH or raise SCALE.`);
  }
  for (let i = 0; i < CHAT_DEPTH; i++) {
    const c = chatEligible[i];
    const [r] = await pool.query(
      `INSERT INTO chats (customer_id, status, created_at) VALUES (?, 'waiting', NOW())`,
      [c.customerId]
    );
    insertedChatIds.push(r.insertId);
  }
  // calls.status is an ENUM: initiated | ringing | active | ended | failed | missed.
  // "initiated" is the agent-pending state — what a customer-requested call
  // looks like before any agent has picked up.
  for (let i = 0; i < CALL_DEPTH; i++) {
    const c = callEligible[i % callEligible.length];
    const [r] = await pool.query(
      `INSERT INTO calls (customer_id, status, created_at) VALUES (?, 'initiated', NOW())`,
      [c.customerId]
    );
    insertedCallIds.push(r.insertId);
  }
  return { insertedTicketIds, insertedChatIds, insertedCallIds };
}

async function teardownQueueDepth({ insertedTicketIds, insertedChatIds, insertedCallIds }) {
  const del = async (table, ids) => {
    if (!ids.length) return;
    const list = ids.map(() => '?').join(',');
    if (table === 'chats') {
      await pool.query(`DELETE FROM chat_messages WHERE chat_id IN (${list})`, ids);
    }
    if (table === 'tickets') {
      await pool.query(`DELETE FROM ticket_messages WHERE ticket_id IN (${list})`, ids);
    }
    await pool.query(`DELETE FROM ${table} WHERE id IN (${list})`, ids);
  };
  await del('tickets', insertedTicketIds);
  await del('chats',   insertedChatIds);
  await del('calls',   insertedCallIds);
}

async function loginAs(page, agent) {
  await page.addInitScript(([t, u]) => {
    localStorage.setItem('dsp_token', t);
    localStorage.setItem('dsp_user', u);
  }, [agent.token, JSON.stringify({ id: agent.userId, email: agent.email, role: 'agent', name: agent.name })]);
}

test('Agent dashboard FCP/LCP with mixed queue depth', async ({ browser }) => {
  test.setTimeout(180_000);
  const manifest = loadManifest();
  const agent = manifest.agents[0];

  const queueIds = await seedQueueDepth(manifest);
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const rec = createRecorder({ label: `agent_${agent.userId}_mc_dashboard` });
    await rec.attach(page);
    await attachSocketTracker(page);
    await loginAs(page, agent);

    await rec.recordInteraction('nav→agent-dashboard', async () => {
      await page.goto('/agent', { waitUntil: 'domcontentloaded', timeout: 30_000 });
      // Dashboard shows aggregate counters — wait for a heading rather than
      // a specific data row since we're not asserting content here.
      await page.locator('h1, h2').first().waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});
    });

    await rec.recordInteraction('nav→agent-chats', async () => {
      await page.goto('/agent/chats', { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.getByRole('button', { name: /^Accept$/ }).first().waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {});
    });

    await rec.recordInteraction('nav→agent-tickets', async () => {
      await page.goto('/agent/tickets', { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForTimeout(500);
    });

    // Heap snapshot — production threshold from the brief: <200 MB.
    const heap = await page.evaluate(() => {
      const m = performance.memory;
      return m ? { usedJSHeap: m.usedJSHeapSize, totalJSHeap: m.totalJSHeapSize } : null;
    });

    const sockets = await harvestSocket(page);
    appendResult('mc-agent-stress.jsonl', {
      ...(await rec.harvest()),
      heap,
      queue_depth: { tickets: TICKET_DEPTH, chats: CHAT_DEPTH, calls: CALL_DEPTH },
      sockets,
    });
    await page.close();
    await ctx.close().catch(() => {});
  } finally {
    await teardownQueueDepth(queueIds);
  }
});

test.afterAll(async () => { try { await pool.end(); } catch {} });
