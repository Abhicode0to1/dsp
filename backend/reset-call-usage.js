/**
 * Resets call usage for gamma@client.com so test-call-signal.js can run.
 * Run: node reset-call-usage.js
 */
require('dotenv').config();
const { pool } = require('./src/config/database');

async function run() {
  const d = new Date();
  const my = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

  const [[user]] = await pool.query("SELECT id FROM users WHERE email = 'gamma@client.com'");
  if (!user) { console.error('User not found'); process.exit(1); }

  const [[cust]] = await pool.query("SELECT id FROM customers WHERE user_id = ?", [user.id]);
  if (!cust) { console.error('Customer not found'); process.exit(1); }

  const [r] = await pool.query(
    "UPDATE call_usage SET count = 0 WHERE customer_id = ? AND month_year = ?",
    [cust.id, my]
  );
  console.log(`Reset call_usage for customer ${cust.id} (${my}): ${r.affectedRows} row(s) updated`);
  process.exit(0);
}

run().catch(err => { console.error(err.message); process.exit(1); });
