// One-off verification: confirms the new columns and settings exist.
// Run with: node scripts/verify-migration.js
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { pool } = require('../src/config/database');

async function check() {
  const results = [];
  const probe = async (label, sql) => {
    try {
      const [rows] = await pool.query(sql);
      results.push({ label, status: '✅', detail: Array.isArray(rows) && rows.length ? JSON.stringify(rows[0]).slice(0, 80) : 'present' });
    } catch (err) {
      results.push({ label, status: '❌', detail: err.message.slice(0, 80) });
    }
  };

  await probe('plans.agent_can_initiate_call', "SELECT agent_can_initiate_call FROM plans LIMIT 1");
  await probe('calls.initiated_by',             "SELECT initiated_by FROM calls LIMIT 1");
  await probe('calls.ticket_id',                "SELECT ticket_id FROM calls LIMIT 1");
  await probe('users.skill_tags',               "SELECT skill_tags FROM users LIMIT 1");
  await probe('users.on_break_until',           "SELECT on_break_until FROM users LIMIT 1");
  await probe('users.last_assigned_at',         "SELECT last_assigned_at FROM users LIMIT 1");
  await probe('customers.is_vip',               "SELECT is_vip FROM customers LIMIT 1");
  await probe('customers.favorite_agent_id',    "SELECT favorite_agent_id FROM customers LIMIT 1");
  await probe('calls.recording_attachment_id',  "SELECT recording_attachment_id FROM calls LIMIT 1");
  await probe('chat_internal_notes table',      "SELECT 1 FROM chat_internal_notes LIMIT 1");

  const settings = ['auto_assign_enabled', 'assignment_mode', 'heavy_load_threshold', 'enable_admin_overflow', 'block_outside_work_hours'];
  for (const key of settings) {
    const [rows] = await pool.query("SELECT value FROM admin_settings WHERE `key` = ?", [key]);
    results.push({
      label: `settings.${key}`,
      status: rows.length ? '✅' : '❌',
      detail: rows.length ? `value = "${rows[0].value}"` : 'MISSING',
    });
  }

  console.log('\n📊 Migration verification\n' + '─'.repeat(60));
  results.forEach(r => console.log(`${r.status}  ${r.label.padEnd(34)} ${r.detail}`));

  const failed = results.filter(r => r.status === '❌').length;
  console.log('─'.repeat(60));
  console.log(failed === 0 ? '✅ All checks passed.' : `❌ ${failed} check(s) failed.`);

  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

check().catch(err => { console.error(err); process.exit(1); });
