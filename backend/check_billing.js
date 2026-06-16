const { pool } = require('./src/config/database');
(async () => {
  const [[cust]] = await pool.query(
    'SELECT c.id, u.email, c.billing_customer_id FROM customers c JOIN users u ON u.id = c.user_id WHERE u.email = ? LIMIT 1',
    ['abhishek@exceltechnologies.in']
  );
  console.log('Customer row:', JSON.stringify(cust));

  const [settings] = await pool.query(
    'SELECT `key`, value FROM admin_settings WHERE `key` IN (?, ?)',
    ['billing_api_url', 'billing_api_key']
  );
  console.log('Settings:', JSON.stringify(settings));

  if (cust?.billing_customer_id) {
    const url = settings.find(s => s.key === 'billing_api_url')?.value;
    const key = settings.find(s => s.key === 'billing_api_key')?.value;
    if (url && key) {
      const https = require('https');
      const http  = require('http');
      const fullUrl = `${url}/api/customer/subscriptions?id=${encodeURIComponent(cust.billing_customer_id)}`;
      console.log('Calling:', fullUrl);
      const parsed = new URL(fullUrl);
      const lib = parsed.protocol === 'https:' ? https : http;
      lib.request({
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: { Authorization: `Bearer ${key}` },
      }, (resp) => {
        let buf = '';
        resp.on('data', c => buf += c);
        resp.on('end', () => {
          console.log('Status:', resp.statusCode);
          console.log('Response:', buf.substring(0, 2000));
          process.exit(0);
        });
      }).on('error', e => { console.error('HTTP error:', e.message); process.exit(1); }).end();
    } else {
      console.log('No billing URL/key configured');
      process.exit(0);
    }
  } else {
    console.log('No billing_customer_id set for this customer');
    process.exit(0);
  }
})().catch(e => { console.error(e.message); process.exit(1); });
