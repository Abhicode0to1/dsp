require('dotenv').config();
const { pool } = require('./src/config/database');
(async () => {
  // Check both NULL plan_id AND plan_id pointing to a non-existent plan
  const [orphans] = await pool.query(
    `SELECT c.id, u.email, c.plan_id, c.plan_expiry
     FROM customers c
     JOIN users u ON u.id = c.user_id
     LEFT JOIN plans p ON p.id = c.plan_id
     WHERE p.id IS NULL OR c.plan_id IS NULL`
  );
  console.log('Customers with no valid plan:');
  console.table(orphans);

  if (orphans.length) {
    const [[freePlan]] = await pool.query("SELECT id FROM plans WHERE name = 'free' LIMIT 1");
    if (!freePlan) { console.error('No Free plan in plans table!'); await pool.end(); process.exit(1); }
    const [res] = await pool.query(
      'UPDATE customers SET plan_id = ? WHERE plan_id IS NULL',
      [freePlan.id]
    );
    console.log('Updated', res.affectedRows, 'row(s) with NULL plan_id to Free');
  } else {
    console.log('No NULL-plan customers to fix.');
  }

  await pool.query(
    "INSERT INTO admin_settings (`key`, value) VALUES ('no_null_plan_v1_applied', '1') ON DUPLICATE KEY UPDATE value = '1'"
  );

  // Final dashboard math
  const [[tc]] = await pool.query('SELECT COUNT(*) AS n FROM customers');
  const [[active]] = await pool.query(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN p.name = 'free' THEN 1 ELSE 0 END) AS free_active,
       SUM(CASE WHEN p.name != 'free' THEN 1 ELSE 0 END) AS paid_active
     FROM customers c JOIN plans p ON p.id = c.plan_id
     WHERE p.name = 'free' OR c.plan_expiry >= CURDATE()`
  );
  const [dist] = await pool.query(
    `SELECT p.name AS plan, COUNT(c.id) AS n
     FROM plans p LEFT JOIN customers c ON c.plan_id = p.id
     GROUP BY p.name ORDER BY p.id`
  );
  console.log('\n=== Final dashboard math ===');
  console.log('Total customers:', tc.n);
  console.log('Active plans (total/free/paid):', active.total, '/', active.free_active, '/', active.paid_active);
  console.log('Plan distribution:');
  console.table(dist);
  const distSum = dist.reduce((s, r) => s + Number(r.n), 0);
  console.log('Plan distribution sum:', distSum, '(should equal Total customers)');
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
