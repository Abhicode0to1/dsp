// Seed (or repair) the customers + agent the routing-limits test suite expects.
// Idempotent — if a user already exists, only the password + plan are updated
// (never deleted or renamed). Safe to run multiple times.
//
// Run:  node scripts/seed-test-users.js
//
// Targets the standard test fixture set:
//   cust4 / cust8 / cust9 → Basic plan, chat allowed
//   delta                  → Free plan (used to verify free-plan 403 blocks)
//   gamma                  → Premium plan, calls allowed
//   agent1@dsp.com         → agent role (R2/R4 reference this agent's id)
//
// Password for every seeded account: Password@123

require('dotenv').config();
const bcrypt = require('bcryptjs');
const { pool } = require('../src/config/database');

const PASSWORD = 'Password@123';
const HASH = bcrypt.hashSync(PASSWORD, 10);

const CUSTOMERS = [
  { email: 'cust4@client.com', name: 'Cust4 Test',  plan: 'basic',    domain: 'cust4.test'  },
  { email: 'cust8@client.com', name: 'Cust8 Test',  plan: 'basic',    domain: 'cust8.test'  },
  { email: 'cust9@client.com', name: 'Cust9 Test',  plan: 'basic',    domain: 'cust9.test'  },
  { email: 'delta@client.com', name: 'Delta Test',  plan: 'free',     domain: 'delta.test'  },
  { email: 'gamma@client.com', name: 'Gamma Test',  plan: 'premium',  domain: 'gamma.test'  },
];

const AGENTS = [
  { email: 'agent1@dsp.com', name: 'Agent One' },
];

async function planId(name) {
  const [[row]] = await pool.query('SELECT id FROM plans WHERE name = ? LIMIT 1', [name]);
  if (!row) throw new Error(`plans table missing required plan: ${name}`);
  return row.id;
}

async function upsertUser(email, name, role) {
  const [[existing]] = await pool.query('SELECT id, role, is_active FROM users WHERE email = ?', [email]);
  if (existing) {
    // Reset password + ensure role matches the seed spec.
    // Also NULL the active_session_jti so any browser tab currently logged in
    // as this user is kicked out cleanly on its next API call (returns 401 with
    // code: 'session_revoked'). Without this, the password change is silent —
    // the old JWT keeps working until expiry, then dies with a confusing error
    // for an unrelated reason.
    await pool.query(
      'UPDATE users SET password = ?, role = ?, name = ?, is_active = 1, active_session_jti = NULL WHERE id = ?',
      [HASH, role, name, existing.id]
    );
    return { id: existing.id, created: false };
  }
  const [r] = await pool.query(
    'INSERT INTO users (name, email, password, role, is_active, created_at) VALUES (?, ?, ?, ?, 1, NOW())',
    [name, email, HASH, role]
  );
  return { id: r.insertId, created: true };
}

async function upsertCustomer(userId, planName, domain) {
  const pid = await planId(planName);
  // Free plan → expiry NULL ("never"). Paid → 1 year out so tests don't trip on
  // expired plan paths.
  const expiry = planName === 'free' ? null : '2099-12-31';
  const [[existing]] = await pool.query('SELECT id FROM customers WHERE user_id = ?', [userId]);
  if (existing) {
    await pool.query(
      'UPDATE customers SET plan_id = ?, plan_expiry = ?, domain = COALESCE(?, domain) WHERE id = ?',
      [pid, expiry, domain, existing.id]
    );
    return { id: existing.id, created: false };
  }
  const [r] = await pool.query(
    'INSERT INTO customers (user_id, plan_id, plan_expiry, domain, invoice_subtotal) VALUES (?, ?, ?, ?, 0)',
    [userId, pid, expiry, domain]
  );
  return { id: r.insertId, created: true };
}

(async () => {
  console.log('Seeding routing-limits test fixtures…\n');
  const log = (msg) => console.log('  ' + msg);

  // ── Customers + plan assignment
  for (const c of CUSTOMERS) {
    try {
      const u = await upsertUser(c.email, c.name, 'customer');
      const cust = await upsertCustomer(u.id, c.plan, c.domain);
      log(`${u.created ? '✚' : '↻'} ${c.email} → user #${u.id}, customer #${cust.id} (${c.plan})`);
    } catch (e) {
      console.error('  ✗', c.email, e.message);
    }
  }

  // ── Agents (needed for R2/R4 chat-busy assertions)
  for (const a of AGENTS) {
    try {
      const u = await upsertUser(a.email, a.name, 'agent');
      log(`${u.created ? '✚' : '↻'} ${a.email} → user #${u.id} (agent)`);
    } catch (e) {
      console.error('  ✗', a.email, e.message);
    }
  }

  console.log('\nAll seeded. Test login: any of the above emails / password Password@123');
  await pool.end();
})().catch(err => { console.error(err); process.exit(1); });
