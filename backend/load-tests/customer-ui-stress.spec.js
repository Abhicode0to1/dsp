/**
 * Customer UI stress suite — Playwright
 * --------------------------------------
 *
 * Scenarios (numbers in the brief specify 80–100 concurrent users; that's
 * realistic only in CI on a machine with 32 GB+ RAM. The default here is
 * CONC = 20 so the suite actually runs on a dev box. Scale up with:
 *
 *     CUSTOMER_CONC=80 npx playwright test customer-ui-stress.spec.js
 *
 * Each scenario records:
 *   - Core Web Vitals per page (FCP / LCP / CLS / Long Tasks)
 *   - Interaction durations (click → response visible) via the recorder
 *   - Socket emit/receive log via the tracker
 *
 * Results are written as JSONL to ../../load-results/<scenario>.jsonl;
 * the analyzer slurps them up and prints percentiles + alerts.
 *
 * Design notes
 *   - One browser, N contexts. Each context is an isolated session. This
 *     avoids the ~150 MB/per-browser overhead of N full browser instances.
 *   - Each context logs in by injecting a freshly-minted JWT into
 *     localStorage before navigation (same trick as ui.spec.js).
 *   - Seeded users are namespaced `__loadui_*@dsp.test` so cleanup is trivial.
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
const { createAgentResponder } = require('./node-agent-responder');

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:5000';

const CONC = Number(process.env.CUSTOMER_CONC || 20);
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

async function seedCustomer(idx, plan = 'premium') {
  const tag = `${Date.now()}_${idx}_${Math.floor(Math.random() * 1e4)}`;
  const email = `__loadui_cust_${tag}@dsp.test`;
  const planId = await planIdByName(plan);
  const [u] = await pool.query(
    `INSERT INTO users (name, email, password, role, is_active, created_at)
     VALUES (?, ?, ?, 'customer', 1, NOW())`,
    [`LoadCust ${idx}`, email, PWD_HASH]
  );
  const [c] = await pool.query(
    `INSERT INTO customers (user_id, domain, plan_id, plan_expiry, invoice_subtotal)
     VALUES (?, ?, ?, CURDATE() + INTERVAL 30 DAY, 0)`,
    [u.insertId, `cust${idx}.test`, planId]
  );
  return { userId: u.insertId, customerId: c.insertId, email, role: 'customer', name: `LoadCust ${idx}` };
}

async function seedAgent(idx) {
  const tag = `${Date.now()}_${idx}_${Math.floor(Math.random() * 1e4)}`;
  const email = `__loadui_resp_${tag}@dsp.test`;
  const [u] = await pool.query(
    `INSERT INTO users (name, email, password, role, is_active, last_status, created_at)
     VALUES (?, ?, ?, 'agent', 1, 'online', NOW())`,
    [`Responder ${idx}`, email, PWD_HASH]
  );
  return { userId: u.insertId, email, role: 'agent', name: `Responder ${idx}` };
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
    await pool.query('DELETE FROM customers WHERE id = ?', [cust.id]);
  }
  // Detach any rows pointing back at this user before deleting (FK guard).
  await pool.query('UPDATE chats SET agent_id = NULL WHERE agent_id = ?', [userId]);
  await pool.query('UPDATE tickets SET assigned_agent_id = NULL WHERE assigned_agent_id = ?', [userId]);
  await pool.query('DELETE FROM users WHERE id = ?', [userId]);
}

async function loginAs(page, user) {
  const token = await mintToken(user);
  await page.addInitScript(([t, u]) => {
    localStorage.setItem('dsp_token', t);
    localStorage.setItem('dsp_user', u);
  }, [token, JSON.stringify({ id: user.userId, email: user.email, role: user.role, name: user.name })]);
}

// Drive a single "customer ticket-raise" flow on one context.
async function driveOneTicketRaise(context, user, scenarioLabel) {
  const page = await context.newPage();
  const rec = createRecorder({ label: `cust_${user.userId}` });
  await rec.attach(page);
  await attachSocketTracker(page);
  await loginAs(page, user);

  // 1) Land on the tickets page and time it.
  await rec.recordInteraction('nav→tickets', async () => {
    await page.goto('/customer/tickets', { waitUntil: 'domcontentloaded' });
    await page.getByTestId('CustomerTickets-RaiseTicketButton').waitFor({ state: 'visible' });
  });
  // 2) Click Raise a Ticket — the bot widget pops up. We can't deterministically
  //    script the conversational flow, so we capture click responsiveness and
  //    fall back to a direct API seed for the "ticket exists" outcome.
  await rec.recordInteraction('click→raise-ticket', async () => {
    await page.getByTestId('CustomerTickets-RaiseTicketButton').click();
    await page.waitForTimeout(200);
  });

  // 3) Direct API seed: simulate the "submit" outcome without scripting the
  //    bot — gives a real DB row to assert against and exercises the row-
  //    render path.
  const [t] = await pool.query(
    `INSERT INTO tickets (customer_id, subject, description, status, priority)
     VALUES (?, 'load-test ticket', 'created by customer stress spec', 'open', 'normal')`,
    [user.customerId]
  );
  const ticketId = t.insertId;
  // Force reload and time list rendering.
  await rec.recordInteraction('reload→see-new-ticket', async () => {
    await page.goto('/customer/tickets', { waitUntil: 'networkidle' });
    await page.getByTestId(`CustomerTickets-Row-${ticketId}`).waitFor({ state: 'visible' });
  });

  const sockets = await harvestSocket(page);
  const result = await rec.harvest();
  appendResult(`${scenarioLabel}.jsonl`, { ...result, sockets });
  await page.close();
  await pool.query('DELETE FROM tickets WHERE id = ?', [ticketId]);
}

// Warm the Vite dev server module graph for a given customer route. Under
// concurrent first-load (20 contexts × hundreds of ES module fetches each)
// Vite serializes transform work and the herd waits 7+ seconds on FCP. A
// single warm-up pass that loads the route once means the dev server has
// already transformed and cached every module — subsequent contexts hit the
// hot path. Production builds don't need this (everything is pre-bundled).
//
// Critical: do NOT use waitUntil:'networkidle' — the SocketContext keeps a
// WebSocket open from the moment the app mounts, so the network never goes
// idle and we hang on the timeout (was eating 30 s per warm-up, blowing
// past the gains). domcontentloaded + an explicit module-settled pause is
// enough to make Vite cache the route's import graph.
async function warmRoute(browser, user, route) {
  const ctx = await browser.newContext();
  try {
    const page = await ctx.newPage();
    await loginAs(page, user);
    await page.goto(route, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    // Give Vite a beat to finish on-the-fly transforms for any modules that
    // weren't critical-path. 2s on a hammered dev server is enough to land
    // every JSX/CSS file in its transform cache.
    await page.waitForTimeout(2000);
    await page.close();
  } catch { /* swallow — warm-up is best-effort */ }
  finally { await ctx.close().catch(() => {}); }
}

// ── Scenario 1: customers form-filling race ─────────────────────────────────
test(`Scenario 1: ${process.env.CUSTOMER_CONC || 20} customers raise ticket concurrently`, async ({ browser }) => {
  test.setTimeout(240_000);
  const users = await Promise.all(
    Array.from({ length: CONC }, (_, i) => seedCustomer(i, 'basic'))
  );
  // Warm the route once (using user 0) so the dev server has cached every
  // module the herd will fetch. Skips on production-style preview servers.
  await warmRoute(browser, users[0], '/customer/tickets');
  // One context per "customer" — independent sessions, shared browser process.
  const contexts = await Promise.all(users.map(() => browser.newContext()));
  try {
    await Promise.all(users.map((u, i) => driveOneTicketRaise(contexts[i], u, 'scenario1-ticket-raise')));
  } finally {
    await Promise.all(contexts.map(c => c.close().catch(() => {})));
    await Promise.all(users.map(u => cleanupUser(u.userId)));
  }
});

// ── Scenario 2: customers start chat concurrently ───────────────────────────
// Two-phase test:
//   Phase A — all CONC customers click Start Chat at the same moment (measures
//             modal-open latency under concurrent init).
//   Phase B — for a small subset (LATENCY_PAIRS), bring up a Node-side agent
//             responder that auto-accepts. Each paired customer then sends 5
//             messages with embedded marker tokens; we compute customer→agent
//             delivery latency by matching markers across the two socket logs.
test(`Scenario 2: ${process.env.CUSTOMER_CONC || 20} customers initiate chat concurrently`, async ({ browser }) => {
  test.setTimeout(240_000);
  const LATENCY_PAIRS = Math.min(CONC, Number(process.env.LATENCY_PAIRS || 5));
  const users = await Promise.all(
    Array.from({ length: CONC }, (_, i) => seedCustomer(i, 'moderate'))
  );
  await warmRoute(browser, users[0], '/customer/chat');
  const contexts = await Promise.all(users.map(() => browser.newContext()));
  let responder = null;
  let responderAgent = null;
  try {
    // ── Phase A: concurrent click → waiting modal ─────────────────────────
    await Promise.all(users.map(async (u, i) => {
      // Skip the latency-pair customers in Phase A — they get a dedicated
      // run in Phase B that includes the message-delivery measurement.
      if (i < LATENCY_PAIRS) return;
      const page = await contexts[i].newPage();
      const rec = createRecorder({ label: `cust_${u.userId}` });
      await rec.attach(page);
      await attachSocketTracker(page);
      await loginAs(page, u);

      await rec.recordInteraction('nav→chat', async () => {
        await page.goto('/customer/chat', { waitUntil: 'domcontentloaded' });
        await page.getByTestId('CustomerChat-StartChatButton').waitFor({ state: 'visible' });
      });
      await rec.recordInteraction('click→start-chat→waiting', async () => {
        await page.getByTestId('CustomerChat-StartChatButton').click();
        await page.waitForTimeout(700);
      });

      const sockets = await harvestSocket(page);
      appendResult('scenario2-chat-init.jsonl', { ...(await rec.harvest()), sockets });
      await page.close();
    }));

    // ── Phase B: end-to-end message-delivery latency ─────────────────────
    if (LATENCY_PAIRS > 0) {
      responderAgent = await seedAgent(999);
      const agentToken = await mintToken(responderAgent);
      responder = await createAgentResponder({ token: agentToken, baseURL: API_BASE_URL });
      // Give the responder a moment to register its 'online' status before
      // the customers fire — otherwise pickAgent won't see them.
      await new Promise(r => setTimeout(r, 500));

      await Promise.all(users.slice(0, LATENCY_PAIRS).map(async (u, i) => {
        const page = await contexts[i].newPage();
        const rec = createRecorder({ label: `cust_${u.userId}_latency` });
        await rec.attach(page);
        await attachSocketTracker(page);
        await loginAs(page, u);

        await page.goto('/customer/chat', { waitUntil: 'domcontentloaded' });
        await page.getByTestId('CustomerChat-StartChatButton').waitFor({ state: 'visible' });

        // Click Start — responder auto-accepts on its side.
        await rec.recordInteraction('start-chat→accepted', async () => {
          await page.getByTestId('CustomerChat-StartChatButton').click();
          // Composer becomes visible once the chat is 'active' (agent accepted).
          await page.getByTestId('CustomerChat-MessageInput').waitFor({ state: 'visible', timeout: 15_000 });
        });

        // Send 5 messages with markers. Marker = unique 8-char hex per message,
        // embedded in the body so the Node-side agent can pair on receive.
        const markers = Array.from({ length: 5 }, () => crypto.randomBytes(4).toString('hex'));
        const customerEmits = [];
        for (const marker of markers) {
          const body = `hello __LAT_${marker}__ message`;
          // Stamp Date.now() AT THE MOMENT we kick off the fill+press sequence —
          // close enough to the actual emit ts for localhost latency comparison.
          customerEmits.push({ marker, ts: Date.now() });
          const input = page.getByTestId('CustomerChat-MessageInput');
          await input.fill(body);
          await input.press('Enter');
          // Tiny gap so we don't coalesce the next fill into the input element
          // before React processes the send.
          await page.waitForTimeout(40);
        }
        // Wait briefly for the agent to receive everything.
        await page.waitForTimeout(1500);

        const sockets = await harvestSocket(page);
        const latencies = responder.matchLatencies(customerEmits);
        appendResult('scenario2-chat-latency.jsonl', {
          ...(await rec.harvest()),
          sockets,
          customer_emits: customerEmits.length,
          agent_receives: latencies.length,
          message_loss: customerEmits.length - latencies.length,
          latency_ms: latencies,
        });
        await page.close();
      }));
    }
  } finally {
    if (responder) try { responder.close(); } catch {}
    await Promise.all(contexts.map(c => c.close().catch(() => {})));
    if (responderAgent) await cleanupUser(responderAgent.userId);
    await Promise.all(users.map(u => cleanupUser(u.userId)));
  }
});

// ── Scenario 3: dashboard while notifications arrive ────────────────────────
// Per-customer setup:
//   1. Seed an open ticket assigned to a shared notifier-agent.
//   2. Customer browser lands on /customer.
//   3. While the test records interaction latencies (bell click, open
//      assistant), it concurrently fires 10 REST POSTs as the notifier-agent
//      against /api/tickets/:id/messages — each triggers a `ticket_agent_reply`
//      socket event into the customer's user room. That's the real production
//      notification path (see ticketController.js#addMessage).
//   4. We harvest both the recorder (UI lag during flood) AND the socket
//      tracker (count of ticket_agent_reply events that actually landed).
test(`Scenario 3: ${process.env.CUSTOMER_CONC || 20} customers on Dashboard during notification flood`, async ({ browser, request }) => {
  test.setTimeout(240_000);
  const FLOOD_N = Number(process.env.NOTIF_FLOOD_N || 10);
  const users = await Promise.all(
    Array.from({ length: CONC }, (_, i) => seedCustomer(i, 'premium'))
  );
  await warmRoute(browser, users[0], '/customer');
  const contexts = await Promise.all(users.map(() => browser.newContext()));
  // One shared notifier-agent + one token, hammers REST in the flood loop.
  const notifierAgent = await seedAgent(998);
  const notifierToken = await mintToken(notifierAgent);
  let ticketIds = [];
  try {
    // Seed an open ticket per customer, ASSIGN it to the notifier so the agent
    // is authorised to post replies via /api/tickets/:id/messages.
    ticketIds = await Promise.all(users.map(async u => {
      const [t] = await pool.query(
        `INSERT INTO tickets (customer_id, subject, description, status, priority, assigned_agent_id)
         VALUES (?, 'notif test', 'noise', 'open', 'normal', ?)`,
        [u.customerId, notifierAgent.userId]
      );
      return t.insertId;
    }));

    await Promise.all(users.map(async (u, i) => {
      const page = await contexts[i].newPage();
      const rec = createRecorder({ label: `cust_${u.userId}` });
      await rec.attach(page);
      await attachSocketTracker(page);
      await loginAs(page, u);

      await rec.recordInteraction('nav→dashboard', async () => {
        await page.goto('/customer', { waitUntil: 'domcontentloaded' });
      });
      // CRITICAL: wait for the customer's socket to actually connect before
      // firing the flood. Otherwise the server emits ticket_agent_reply to
      // user_<id> room but no socket has joined that room yet — events go to
      // the void and the customer "loses" them. Was eating the first 5
      // customers (slowest to mount on Vite dev) for ~25% measured loss.
      await page.waitForFunction(() => !!(window.__appSocket && window.__appSocket.connected), null, { timeout: 30_000 }).catch(() => {});

      // Kick off the notification flood in the background — fire-and-forget so
      // the bell/assistant interactions happen DURING the flood, not after.
      // Each POST is ~50–150ms; spacing them with no delay produces a tight
      // burst that the customer's socket must process while React is busy.
      const ticketId = ticketIds[i];
      const floodStart = Date.now();
      const floodResults = [];
      const flood = (async () => {
        for (let n = 0; n < FLOOD_N; n++) {
          const r = await request.post(`${API_BASE_URL}/api/tickets/${ticketId}/messages`, {
            headers: { Authorization: `Bearer ${notifierToken}`, 'Content-Type': 'application/json' },
            data: { message: `flood notification ${n + 1}/${FLOOD_N} __LAT_flood${n}__` },
            failOnStatusCode: false,
          }).catch(err => ({ status: () => 0, _err: err.message }));
          floodResults.push({ n, status: typeof r.status === 'function' ? r.status() : 0, ts: Date.now() });
          // Small gap so we don't accidentally trip the express rate-limit on
          // the same agent token. 50ms = 20 req/s, well under default limits.
          await new Promise(s => setTimeout(s, 50));
        }
      })();

      // Click the bell + Open Assistant DURING the flood — these are what we
      // care about for UI responsiveness numbers.
      await rec.recordInteraction('click→bell', async () => {
        await page.getByTestId('CustomerNotificationBell-Toggle').click();
        await page.waitForTimeout(150);
      });
      await rec.recordInteraction('click→open-assistant', async () => {
        await page.getByTestId('Dashboard-OpenAssistantButton').click();
        await page.waitForTimeout(150);
      });

      // Make sure the flood finished before harvesting socket logs — otherwise
      // we'd undercount the events the customer actually received.
      await flood;
      // Settling window: the last POST returned `ok` from the server, but its
      // socket emit is still in flight to the browser when the loop exits.
      // Without this pause we'd undercount by 1-2 events per customer = 5-20%
      // false-positive notification loss in a clean run.
      await page.waitForTimeout(1500);
      const floodDurationMs = Date.now() - floodStart;

      // Verify the bell actually saw the notifications. The customer's
      // `ticket_agent_reply` handler increments the unread badge.
      const ticketAgentReplyCount = await page.evaluate(() =>
        (window.__socketLog?.events || []).filter(e => e.event === 'ticket_agent_reply').length
      );

      const sockets = await harvestSocket(page);
      appendResult('scenario3-dashboard-notif.jsonl', {
        ...(await rec.harvest()),
        sockets,
        flood: {
          sent: FLOOD_N,
          succeeded: floodResults.filter(r => r.status >= 200 && r.status < 300).length,
          duration_ms: floodDurationMs,
          received_on_customer: ticketAgentReplyCount,
          loss: FLOOD_N - ticketAgentReplyCount,
        },
      });
      await page.close();
    }));
  } finally {
    if (ticketIds.length) {
      await pool.query(`DELETE FROM ticket_messages WHERE ticket_id IN (${ticketIds.map(() => '?').join(',')})`, ticketIds);
      await pool.query(`DELETE FROM tickets WHERE id IN (${ticketIds.map(() => '?').join(',')})`, ticketIds);
    }
    await Promise.all(contexts.map(c => c.close().catch(() => {})));
    await cleanupUser(notifierAgent.userId);
    await Promise.all(users.map(u => cleanupUser(u.userId)));
  }
});

test.afterAll(async () => { try { await pool.end(); } catch {} });
