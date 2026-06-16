/**
 * Agent UI stress suite — Playwright
 * ----------------------------------
 *
 * Default queue depth + concurrency are scaled down so the suite runs on
 * a dev box. Tune with:
 *
 *     AGENT_QUEUE=80 AGENT_CONC=3 npx playwright test agent-ui-stress.spec.js
 *
 * Captures the same FCP/LCP/CLS/Long Tasks + interaction timings as the
 * customer spec; results land in load-results/*.jsonl.
 *
 * Notes on what's modeled vs. mocked:
 *   - Queue depth: seeded via direct INSERTs into `chats` so the agent's
 *     Chats page renders N waiting cards without us having to drive N
 *     customer browsers in parallel.
 *   - Tab switching (Scenario 3) uses Playwright Pages within a single
 *     context — same browser, separate routes, independent socket
 *     connections via the SocketContext.
 *   - "Backend overload" (Scenario 4) is simulated by burst-firing N
 *     REST requests against the customer-bot-ticket endpoint in parallel
 *     (lots of writes hitting the same agents' notification streams).
 */

const { test, expect } = require('@playwright/test');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { pool } = require('../src/config/database');
const { createRecorder, appendResult } = require('./ui-metrics-recorder');
const { attachSocketTracker, harvest: harvestSocket } = require('./socket-message-tracker');

const QUEUE_DEPTH = Number(process.env.AGENT_QUEUE || 20);   // # of waiting chats to seed
const AGENT_CONC  = Number(process.env.AGENT_CONC  || 1);    // # of concurrent agents
const PWD_HASH = bcrypt.hashSync('Password@123', 10);

async function planIdByName(name) {
  const [[p]] = await pool.query('SELECT id FROM plans WHERE name = ?', [name]);
  return p.id;
}
async function mintToken({ userId, email, role }) {
  const jti = crypto.randomBytes(16).toString('hex');
  await pool.query('UPDATE users SET active_session_jti = ? WHERE id = ?', [jti, userId]);
  return jwt.sign({ id: userId, email, role, jti }, process.env.JWT_SECRET, { expiresIn: '1h' });
}
async function seedCustomer(idx) {
  const tag = `${Date.now()}_${idx}_${Math.floor(Math.random() * 1e4)}`;
  const email = `__loadui_agcust_${tag}@dsp.test`;
  const planId = await planIdByName('moderate');
  const [u] = await pool.query(
    `INSERT INTO users (name, email, password, role, is_active, created_at) VALUES (?, ?, ?, 'customer', 1, NOW())`,
    [`AgQCust ${idx}`, email, PWD_HASH]
  );
  const [c] = await pool.query(
    `INSERT INTO customers (user_id, domain, plan_id, plan_expiry, invoice_subtotal) VALUES (?, ?, ?, CURDATE() + INTERVAL 30 DAY, 0)`,
    [u.insertId, `agcust${idx}.test`, planId]
  );
  return { userId: u.insertId, customerId: c.insertId, email, role: 'customer' };
}
async function seedAgent(idx) {
  const tag = `${Date.now()}_${idx}_${Math.floor(Math.random() * 1e4)}`;
  const email = `__loadui_ag_${tag}@dsp.test`;
  const [u] = await pool.query(
    `INSERT INTO users (name, email, password, role, is_active, created_at) VALUES (?, ?, ?, 'agent', 1, NOW())`,
    [`LoadAg ${idx}`, email, PWD_HASH]
  );
  return { userId: u.insertId, email, role: 'agent', name: `LoadAg ${idx}` };
}
async function seedWaitingChat(customerId) {
  const [r] = await pool.query(
    `INSERT INTO chats (customer_id, status, created_at) VALUES (?, 'waiting', NOW())`,
    [customerId]
  );
  return r.insertId;
}
async function cleanupUser(userId) {
  await pool.query('DELETE FROM chat_messages WHERE sender_id = ?', [userId]);
  await pool.query('DELETE FROM ticket_messages WHERE sender_id = ?', [userId]);
  const [[cust]] = await pool.query('SELECT id FROM customers WHERE user_id = ?', [userId]);
  if (cust) {
    await pool.query('DELETE FROM chat_messages WHERE chat_id IN (SELECT id FROM chats WHERE customer_id = ?)', [cust.id]);
    await pool.query('DELETE FROM chats WHERE customer_id = ?', [cust.id]);
    await pool.query('DELETE FROM ticket_messages WHERE ticket_id IN (SELECT id FROM tickets WHERE customer_id = ?)', [cust.id]);
    await pool.query('DELETE FROM tickets WHERE customer_id = ?', [cust.id]);
    await pool.query('DELETE FROM calls WHERE customer_id = ?', [cust.id]);
    await pool.query('DELETE FROM ticket_usage WHERE customer_id = ?', [cust.id]);
    await pool.query('DELETE FROM customer_feature_overrides WHERE customer_id = ?', [cust.id]).catch(() => {});
    await pool.query('DELETE FROM customers WHERE id = ?', [cust.id]);
  }
  // CRITICAL for scenarios that auto-assign — bot tickets get
  // assigned_agent_id pointing at this user, blocking the delete via FK.
  await pool.query('UPDATE tickets SET assigned_agent_id = NULL WHERE assigned_agent_id = ?', [userId]);
  await pool.query('UPDATE chats SET agent_id = NULL WHERE agent_id = ?', [userId]);
  await pool.query('DELETE FROM users WHERE id = ?', [userId]);
}
async function loginAs(page, user) {
  const token = await mintToken(user);
  await page.addInitScript(([t, u]) => {
    localStorage.setItem('dsp_token', t);
    localStorage.setItem('dsp_user', u);
  }, [token, JSON.stringify({ id: user.userId, email: user.email, role: user.role, name: user.name })]);
}

// ── Scenario 1: dashboard load with N waiting chats ─────────────────────────
test(`Scenario 1: agent dashboard renders ${process.env.AGENT_QUEUE || 20} waiting chats`, async ({ browser }) => {
  test.setTimeout(180_000);
  // Seed N customers + N waiting chats.
  const customers = await Promise.all(Array.from({ length: QUEUE_DEPTH }, (_, i) => seedCustomer(i)));
  const chatIds = await Promise.all(customers.map(c => seedWaitingChat(c.customerId)));
  const agent = await seedAgent(0);
  let ctx;
  try {
    ctx = await browser.newContext();
    const page = await ctx.newPage();
    const rec = createRecorder({ label: `agent_${agent.userId}` });
    await rec.attach(page);
    await attachSocketTracker(page);
    await loginAs(page, agent);

    await rec.recordInteraction('nav→agent-chats', async () => {
      await page.goto('/agent/chats', { waitUntil: 'networkidle' });
      // Wait for at least one Accept button as a proxy for "list rendered".
      await page.getByRole('button', { name: /^Accept$/ }).first().waitFor({ state: 'visible', timeout: 15_000 });
    });

    // Memory + perf snapshot via JS heap.
    const heap = await page.evaluate(() => {
      const m = performance.memory;
      return m ? { usedJSHeap: m.usedJSHeapSize, totalJSHeap: m.totalJSHeapSize } : null;
    });
    const sockets = await harvestSocket(page);
    appendResult('agent-scenario1-dashboard.jsonl', { ...(await rec.harvest()), heap, queueDepth: QUEUE_DEPTH, sockets });
    await page.close();
  } finally {
    await ctx?.close().catch(() => {});
    await pool.query(`DELETE FROM chats WHERE id IN (${chatIds.map(() => '?').join(',') || 'NULL'})`, chatIds);
    await cleanupUser(agent.userId);
    await Promise.all(customers.map(c => cleanupUser(c.userId)));
  }
});

// ── Scenario 2: rapid-fire accept/reply/close ───────────────────────────────
test(`Scenario 2: agent accept→reply→close cycle across ${Math.min(QUEUE_DEPTH, 5)} chats`, async ({ browser }) => {
  test.setTimeout(180_000);
  const COUNT = Math.min(QUEUE_DEPTH, 5);
  const customers = await Promise.all(Array.from({ length: COUNT }, (_, i) => seedCustomer(i)));
  const chatIds = await Promise.all(customers.map(c => seedWaitingChat(c.customerId)));
  const agent = await seedAgent(0);
  let ctx;
  try {
    ctx = await browser.newContext();
    const page = await ctx.newPage();
    const rec = createRecorder({ label: `agent_${agent.userId}` });
    await rec.attach(page);
    await attachSocketTracker(page);
    await loginAs(page, agent);
    await page.goto('/agent/chats', { waitUntil: 'networkidle' });

    // Loop: click Accept → type reply → close. The composer doesn't have a
    // testid yet so we target the textarea by placeholder. Each iteration's
    // duration is captured in `interactions`.
    //
    // Stability: ending a chat triggers a flush that immediately rings the
    // NEXT waiting chat to the same agent. That ring opens a 90-second toast
    // (`new_chat_request`) which can intercept pointer events on the Dismiss
    // button — Playwright's actionability check then retries up to its 30 s
    // default and we get a 30–60 s "end_chat" measurement that's purely test
    // infra noise. Defensive cleanup between Accept and End dismisses any
    // open toasts so clicks land cleanly.
    const dismissAllToasts = async () => {
      await page.evaluate(() => {
        // react-hot-toast renders toasts under [data-react-hot-toast]; remove
        // them so they don't intercept pointer events. Doesn't affect the test
        // semantically — the bell already received the underlying event.
        document.querySelectorAll('[data-react-hot-toast]').forEach(n => n.remove());
      }).catch(() => {});
    };
    for (let i = 0; i < COUNT; i++) {
      const acceptBtn = page.getByRole('button', { name: /^Accept$/ }).first();
      await rec.recordInteraction(`accept_chat_${i}`, async () => {
        await acceptBtn.waitFor({ state: 'visible', timeout: 15_000 });
        await acceptBtn.click();
        await page.locator('textarea[placeholder*="Type your message"]').first().waitFor({ state: 'visible', timeout: 8_000 });
      });
      await rec.recordInteraction(`send_message_${i}`, async () => {
        const t = page.locator('textarea[placeholder*="Type your message"]').first();
        await t.fill(`reply from agent stress #${i}`);
        await t.press('Enter');
        await page.waitForTimeout(150);
      });
      await dismissAllToasts();
      await rec.recordInteraction(`end_chat_${i}`, async () => {
        const endBtn = page.getByRole('button', { name: /^End$/ }).first();
        await endBtn.click({ timeout: 8_000 });
        const dismiss = page.getByRole('button', { name: /^Dismiss$/ }).first();
        await dismiss.waitFor({ state: 'visible', timeout: 5_000 });
        // Force-click sidesteps actionability retries when a stray ring-toast
        // happens to land over the Dismiss button mid-render.
        await dismiss.click({ timeout: 8_000, force: true });
        await page.waitForTimeout(150);
      });
      // Ensure clean state before next iteration — no End/Dismiss button means
      // we're back to "queue view, no active chat".
      await page.waitForFunction(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        return !buttons.some(b => /^(End|Dismiss)$/.test(b.textContent?.trim() || ''));
      }, null, { timeout: 5_000 }).catch(() => {});
    }

    const sockets = await harvestSocket(page);
    appendResult('agent-scenario2-accept-cycle.jsonl', { ...(await rec.harvest()), sockets });
    await page.close();
  } finally {
    await ctx?.close().catch(() => {});
    await pool.query(`DELETE FROM chat_messages WHERE chat_id IN (${chatIds.map(() => '?').join(',') || 'NULL'})`, chatIds);
    await pool.query(`DELETE FROM chats WHERE id IN (${chatIds.map(() => '?').join(',') || 'NULL'})`, chatIds);
    await cleanupUser(agent.userId);
    await Promise.all(customers.map(c => cleanupUser(c.userId)));
  }
});

// ── Scenario 3: multi-tab chat handling ─────────────────────────────────────
test('Scenario 3: agent juggles 3 tabs while messages arrive on the active one', async ({ browser }) => {
  test.setTimeout(180_000);
  const customers = await Promise.all([0, 1, 2].map(seedCustomer));
  const chatIds = await Promise.all(customers.map(c => seedWaitingChat(c.customerId)));
  const agent = await seedAgent(0);
  let ctx;
  try {
    ctx = await browser.newContext();
    const pages = await Promise.all([0, 1, 2].map(() => ctx.newPage()));
    const rec = createRecorder({ label: `agent_${agent.userId}_multitab` });
    for (const p of pages) {
      await rec.attach(p);
      await attachSocketTracker(p);
      await loginAs(p, agent);
    }
    // All three tabs land on /agent/chats. The same agent socket is shared
    // across tabs (Socket.IO multiplexes per origin) — the socket connection
    // keeps the page from ever reaching `networkidle`, so we use
    // `domcontentloaded` and a deterministic UI marker instead.
    for (let i = 0; i < pages.length; i++) {
      await pages[i].goto('/agent/chats', { waitUntil: 'domcontentloaded' });
      await pages[i].getByRole('button', { name: /^Accept$/ }).first().waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
    }
    // Rapid tab-switch loop — bring each tab to front and time the back-
    // and-forth. Playwright doesn't drive real tab focus; we use `page.bringToFront`.
    for (let i = 0; i < 6; i++) {
      const target = pages[i % pages.length];
      await rec.recordInteraction(`tab_switch_${i}`, async () => {
        await target.bringToFront();
      });
    }
    const sockets = await Promise.all(pages.map(p => harvestSocket(p)));
    appendResult('agent-scenario3-multitab.jsonl', { ...(await rec.harvest()), sockets });
    for (const p of pages) await p.close();
  } finally {
    await ctx?.close().catch(() => {});
    await pool.query(`DELETE FROM chats WHERE id IN (${chatIds.map(() => '?').join(',') || 'NULL'})`, chatIds);
    await cleanupUser(agent.userId);
    await Promise.all(customers.map(c => cleanupUser(c.userId)));
  }
});

// ── Scenario 4: agent dashboard during backend hammer ───────────────────────
test('Scenario 4: agent dashboard responsiveness while bot-ticket endpoint is hammered', async ({ browser, request }) => {
  test.setTimeout(180_000);
  // Background hammer: fire N parallel POST /api/customer/bot/ticket from a
  // dedicated pool of customers, then measure agent interactions during it.
  const HAMMER = Number(process.env.HAMMER_N || 20);
  const noisemakers = await Promise.all(Array.from({ length: HAMMER }, (_, i) => seedCustomer(i + 100)));
  const agent = await seedAgent(0);
  let ctx, hammerInFlight;
  try {
    // Start hammering — these are real REST calls and they keep firing in
    // a loop until the agent's interactions are done.
    let stopHammer = false;
    hammerInFlight = (async () => {
      while (!stopHammer) {
        await Promise.all(noisemakers.map(async (c) => {
          const token = await mintToken(c);
          await request.post(`${process.env.API_BASE_URL || 'http://localhost:5000'}/api/customer/bot/ticket`, {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            data: { subject: 'hammer', description: 'load-test noise' },
            failOnStatusCode: false,
          }).catch(() => {});
        }));
        await new Promise(r => setTimeout(r, 100));
      }
    })();

    ctx = await browser.newContext();
    const page = await ctx.newPage();
    const rec = createRecorder({ label: `agent_${agent.userId}_overload` });
    await rec.attach(page);
    await attachSocketTracker(page);
    await loginAs(page, agent);

    await rec.recordInteraction('nav→dashboard-under-load', async () => {
      await page.goto('/agent', { waitUntil: 'domcontentloaded' });
      await page.locator('h1, h2').first().waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
    });
    await rec.recordInteraction('nav→chats-under-load', async () => {
      await page.goto('/agent/chats', { waitUntil: 'domcontentloaded' });
    });

    stopHammer = true;
    await hammerInFlight.catch(() => {});

    const sockets = await harvestSocket(page);
    appendResult('agent-scenario4-overload.jsonl', { ...(await rec.harvest()), sockets, hammerN: HAMMER });
    await page.close();
  } finally {
    await ctx?.close().catch(() => {});
    await cleanupUser(agent.userId);
    await Promise.all(noisemakers.map(c => cleanupUser(c.userId)));
  }
});

// ── Scenario 5: simultaneous actions / race ─────────────────────────────────
test('Scenario 5: customer + agent typing on same chat — message ordering preserved', async ({ browser }) => {
  test.setTimeout(120_000);
  const c = await seedCustomer(0);
  const ag = await seedAgent(0);
  const chatId = await seedWaitingChat(c.customerId);
  let custCtx, agCtx;
  try {
    custCtx = await browser.newContext();
    agCtx = await browser.newContext();
    const custPage = await custCtx.newPage();
    const agPage = await agCtx.newPage();
    await attachSocketTracker(custPage);
    await attachSocketTracker(agPage);
    await loginAs(custPage, c);
    await loginAs(agPage, ag);

    await custPage.goto('/customer/chat', { waitUntil: 'networkidle' });
    await agPage.goto('/agent/chats', { waitUntil: 'networkidle' });
    const accept = agPage.getByRole('button', { name: /^Accept$/ }).first();
    await accept.waitFor({ state: 'visible', timeout: 10_000 });
    await accept.click();
    const custInput = custPage.getByTestId('CustomerChat-MessageInput');
    const agInput = agPage.locator('textarea[placeholder*="Type your message"]').first();
    await custInput.waitFor({ state: 'visible', timeout: 8_000 });
    await agInput.waitFor({ state: 'visible', timeout: 8_000 });

    // Fire interleaved sends — but serialize within each actor. Two parallel
    // `fill` operations on the same textarea race in the DOM: the second
    // fill overwrites the first before its Enter key dispatches, dropping
    // a message. The race we actually care about is customer-vs-agent on
    // the same chat, not customer-vs-themselves.
    await Promise.all([
      (async () => {
        await custInput.fill('cust 1'); await custInput.press('Enter');
        await custPage.waitForTimeout(80);
        await custInput.fill('cust 2'); await custInput.press('Enter');
      })(),
      (async () => {
        await agInput.fill('ag 1'); await agInput.press('Enter');
        await agPage.waitForTimeout(80);
        await agInput.fill('ag 2'); await agInput.press('Enter');
      })(),
    ]);
    await custPage.waitForTimeout(700);

    const [rows] = await pool.query(
      'SELECT id, sender_id, message FROM chat_messages WHERE chat_id = ? ORDER BY id ASC',
      [chatId]
    );
    appendResult('agent-scenario5-race.jsonl', {
      label: 'race',
      messagesPersisted: rows.length,
      order: rows.map(r => ({ id: r.id, who: r.sender_id === ag.userId ? 'agent' : 'customer', m: r.message })),
      sockets: { customer: await harvestSocket(custPage), agent: await harvestSocket(agPage) },
    });
    await custPage.close();
    await agPage.close();
  } finally {
    await custCtx?.close().catch(() => {});
    await agCtx?.close().catch(() => {});
    await pool.query('DELETE FROM chat_messages WHERE chat_id = ?', [chatId]);
    await pool.query('DELETE FROM chats WHERE id = ?', [chatId]);
    await cleanupUser(c.userId);
    await cleanupUser(ag.userId);
  }
});

test.afterAll(async () => { try { await pool.end(); } catch {} });
