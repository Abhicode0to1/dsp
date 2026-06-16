require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { pool } = require('../src/config/database');

(async () => {
  const [c] = await pool.query('SELECT COUNT(*) AS n FROM canned_responses');
  const [m] = await pool.query('SELECT COUNT(*) AS n FROM ticket_macros');
  const [t] = await pool.query('SELECT COUNT(*) AS n FROM ticket_templates');
  const [[flag]] = await pool.query("SELECT value FROM admin_settings WHERE `key` = 'canned_seeds_v1_applied'");

  console.log('\n📋 Seed verification');
  console.log('─'.repeat(50));
  console.log('  Canned responses:', c[0].n);
  console.log('  Macros:          ', m[0].n);
  console.log('  Templates:       ', t[0].n);
  console.log('  Seed flag:       ', flag?.value || '(not set)');

  console.log('\n  📝 Canned titles:');
  const [titles] = await pool.query("SELECT title FROM canned_responses ORDER BY id LIMIT 25");
  titles.forEach((row, i) => console.log(`   ${(i+1).toString().padStart(2)}. ${row.title}`));

  console.log('\n  ⚡ Macros:');
  const [mnames] = await pool.query("SELECT name FROM ticket_macros");
  mnames.forEach((row, i) => console.log(`   ${(i+1).toString().padStart(2)}. ${row.name}`));

  console.log('\n  📄 Templates (with priority):');
  const [tnames] = await pool.query("SELECT name, default_priority, request_type FROM ticket_templates");
  tnames.forEach((row, i) => console.log(`   ${(i+1).toString().padStart(2)}. ${row.name}  [${row.default_priority}, ${row.request_type || 'no-type'}]`));

  await pool.end();
})();
