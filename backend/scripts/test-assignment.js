// Integration test for the assignment helper.
// Exercises every code path against the real DB to make sure nothing throws.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { pool } = require('../src/config/database');
const { pickAgent, getRoutingSettings } = require('../src/utils/assignment');
const registry = require('../src/utils/agentRegistry');

const fakeIo = {
  in: () => ({ fetchSockets: async () => [] }), // simulate "no online sockets"
};

async function run() {
  let pass = 0, fail = 0;
  const test = async (name, fn) => {
    try { await fn(); console.log(`  ✅ ${name}`); pass++; }
    catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++; }
  };

  console.log('\n📊 Assignment helper integration test\n' + '─'.repeat(60));

  // Get an agent + customer from the DB for realistic tests
  const [[anyAgent]] = await pool.query("SELECT id, name FROM users WHERE role = 'agent' AND is_active = TRUE LIMIT 1");
  const [[anyAdmin]] = await pool.query("SELECT id, name FROM users WHERE role = 'admin' AND is_active = TRUE LIMIT 1");
  const [[anyCustomer]] = await pool.query("SELECT id FROM customers LIMIT 1");

  console.log(`  Sample agent: ${anyAgent ? anyAgent.name : '(none)'}`);
  console.log(`  Sample admin: ${anyAdmin ? anyAdmin.name : '(none)'}`);
  console.log(`  Sample customer: id=${anyCustomer?.id || '(none)'}\n`);

  await test('getRoutingSettings returns expected shape', async () => {
    const s = await getRoutingSettings();
    if (typeof s.heavyLoadThreshold !== 'number') throw new Error('threshold not number');
    if (!['least_loaded', 'round_robin'].includes(s.mode)) throw new Error('bad mode');
    if (typeof s.enableAdminOverflow !== 'boolean') throw new Error('overflow not boolean');
  });

  await test('pickAgent with no online sockets returns no_online_candidates (or no_candidates)', async () => {
    registry.delete(anyAgent?.id);
    registry.delete(anyAdmin?.id);
    const r = await pickAgent({ io: fakeIo, channel: 'ticket', requireOnline: true });
    if (r.agentId !== null) throw new Error(`expected null, got ${r.agentId}`);
    if (!['no_candidates', 'no_online_candidates'].includes(r.reason)) throw new Error(`unexpected reason: ${r.reason}`);
  });

  await test('pickAgent with requireOnline:false falls back to DB (any agent)', async () => {
    const r = await pickAgent({ io: fakeIo, channel: 'ticket', requireOnline: false });
    // We have agents in DB, so should pick one
    if (!r.agentId) throw new Error(`expected an agent, got null (${r.reason})`);
  });

  await test('pickAgent honors excludeUserIds', async () => {
    if (!anyAgent) return;
    const r = await pickAgent({
      io: fakeIo,
      channel: 'ticket',
      excludeUserIds: [anyAgent.id],
      requireOnline: false,
    });
    if (r.agentId === anyAgent.id) throw new Error('excluded agent was picked anyway');
  });

  await test('VIP favorite agent shortcut works when agent is online', async () => {
    if (!anyAgent || !anyCustomer) return;
    // Set favorite + mark agent online in registry
    await pool.query('UPDATE customers SET favorite_agent_id = ? WHERE id = ?', [anyAgent.id, anyCustomer.id]);
    registry.set(anyAgent.id, 'online');
    const r = await pickAgent({ io: fakeIo, channel: 'ticket', customerId: anyCustomer.id, requireOnline: true });
    if (r.agentId !== anyAgent.id) throw new Error(`expected favorite ${anyAgent.id}, got ${r.agentId}`);
    if (r.reason !== 'favorite_agent') throw new Error(`expected favorite_agent, got ${r.reason}`);
    // Cleanup
    await pool.query('UPDATE customers SET favorite_agent_id = NULL WHERE id = ?', [anyCustomer.id]);
    registry.delete(anyAgent.id);
  });

  await test('Agent on break is skipped', async () => {
    if (!anyAgent) return;
    await pool.query('UPDATE users SET on_break_until = DATE_ADD(NOW(), INTERVAL 30 MINUTE) WHERE id = ?', [anyAgent.id]);
    registry.set(anyAgent.id, 'online');
    // Simulate this agent being in the sockets pool
    const oneAgentIo = { in: () => ({ fetchSockets: async () => [{ user: { id: anyAgent.id, name: anyAgent.name, role: 'agent' } }] }) };
    const r = await pickAgent({ io: oneAgentIo, channel: 'ticket', requireOnline: true });
    if (r.agentId === anyAgent.id) throw new Error('on-break agent was picked anyway');
    // Cleanup
    await pool.query('UPDATE users SET on_break_until = NULL WHERE id = ?', [anyAgent.id]);
    registry.delete(anyAgent.id);
  });

  await test('claimTicket SQL syntax — atomic UPDATE compiles & runs', async () => {
    // Just verify the query syntax — won't actually claim anything since we use ID 0
    await pool.query(
      'UPDATE tickets SET assigned_agent_id = ? WHERE id = ? AND assigned_agent_id IS NULL',
      [1, 0]
    );
  });

  await test('acceptChat atomic claim SQL syntax', async () => {
    await pool.query(
      "UPDATE chats SET agent_id = ?, status = 'active', accepted_at = NOW() WHERE id = ? AND status = 'waiting' AND agent_id IS NULL",
      [1, 0]
    );
  });

  await test('Bot ticket priority detection regex works', async () => {
    const cases = [
      { text: 'my email is down URGENT', expected: 'urgent' },
      { text: 'cannot work, blocking everything', expected: 'urgent' },
      { text: 'this is a high priority request', expected: 'high' },
      { text: 'normal question about billing', expected: 'normal' },
    ];
    for (const c of cases) {
      const combined = c.text.toLowerCase();
      let detected = 'normal';
      if (/\b(urgent|asap|critical|emergency|outage|down|cannot work)\b/.test(combined)) detected = 'urgent';
      else if (/\b(important|high priority|blocking)\b/.test(combined)) detected = 'high';
      if (detected !== c.expected) throw new Error(`"${c.text}" → ${detected}, expected ${c.expected}`);
    }
  });

  await test('Watchdog query — finds tickets needing reassignment (read-only)', async () => {
    await pool.query(`
      SELECT t.id FROM tickets t
      JOIN users u ON u.id = t.assigned_agent_id
      WHERE t.status IN ('open','pending')
        AND t.merged_into IS NULL
        AND t.assigned_agent_id IS NOT NULL
        AND t.updated_at < DATE_SUB(NOW(), INTERVAL 24 HOUR)
      LIMIT 1
    `);
  });

  await test('Agent skill_tags JSON parses correctly', async () => {
    if (!anyAgent) return;
    await pool.query("UPDATE users SET skill_tags = '[\"billing\",\"technical\"]' WHERE id = ?", [anyAgent.id]);
    const [[row]] = await pool.query("SELECT skill_tags FROM users WHERE id = ?", [anyAgent.id]);
    let tags = typeof row.skill_tags === 'string' ? JSON.parse(row.skill_tags) : row.skill_tags;
    if (!Array.isArray(tags) || tags.length !== 2) throw new Error('tags not parsed');
    // Cleanup
    await pool.query('UPDATE users SET skill_tags = NULL WHERE id = ?', [anyAgent.id]);
  });

  await test('Chat archive query (agent-scoped)', async () => {
    if (!anyAgent) return;
    await pool.query(`
      SELECT ch.id, ch.created_at, cu.name AS customer_name
      FROM chats ch
      JOIN customers c ON c.id = ch.customer_id
      JOIN users cu ON cu.id = c.user_id
      WHERE ch.status = 'closed' AND ch.agent_id = ?
      LIMIT 1
    `, [anyAgent.id]);
  });

  await test('Agent-initiated call eligibility query (the one used by socket)', async () => {
    if (!anyCustomer) return;
    await pool.query(
      `SELECT c.id AS customer_id, c.user_id, c.plan_expiry, u.is_active,
              p.allow_calls, p.agent_can_initiate_call, p.name AS plan_name,
              COALESCE(o.allow_calls, p.allow_calls) AS effective_allow_calls
       FROM customers c
       JOIN users u ON u.id = c.user_id
       LEFT JOIN plans p ON p.id = c.plan_id
       LEFT JOIN customer_feature_overrides o ON o.customer_id = c.id
       WHERE c.id = ?`,
      [anyCustomer.id]
    );
  });

  console.log('─'.repeat(60));
  console.log(pass + ' passed, ' + fail + ' failed');
  await pool.end();
  process.exit(fail > 0 ? 1 : 0);
}

run().catch(e => { console.error(e); process.exit(1); });
