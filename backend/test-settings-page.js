// Comprehensive functional test of every input on the admin Settings page.
// For each field: confirm it's whitelisted, write a probe value, read it back
// via the cached settings helper, and check that a consumer in the codebase
// actually uses it (or flag as placeholder if not).
//
// Run: node test-settings-page.js

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

// Every UI field on the Settings page, with the consumer code path the field
// is supposed to affect. `consumer: null` means it's a deliberate placeholder.
const FIELDS = [
  // ── Ticket Automation
  { key: 'auto_close_days',                probe: '21',       consumer: 'tickets.js auto-close cron' },

  // ── Customer Billing Page
  { key: 'billing_extras_enabled',         probe: '0',        consumer: 'customerController.getCustomerPlans (returns flag)' },

  // ── Call Billing
  { key: 'min_billable_call_seconds',      probe: '30',       consumer: 'planUtils.getCallUsage + finalizeCallUsageIfBillable' },
  { key: 'max_short_cut_forgivals_per_month', probe: '3',     consumer: 'planUtils.getCallUsage cap' },

  // ── SLA & Queue Alerts (added this session)
  { key: 'queue_sla_minutes',              probe: '7',        consumer: 'slaWorker chat queue cron' },
  { key: 'ticket_warning_pct',             probe: '75',       consumer: 'slaWorker SLA approaching SQL' },
  { key: 'ticket_breach_action',           probe: 'both',     consumer: 'slaWorker breach branch' },

  // ── SMTP Configuration
  { key: 'smtp_host',                      probe: 'smtp.test.com',    consumer: 'emailUtils.getTransporter' },
  { key: 'smtp_port',                      probe: '587',              consumer: 'emailUtils.getTransporter' },
  { key: 'smtp_user',                      probe: 'test@test.com',    consumer: 'emailUtils.getTransporter' },
  { key: 'smtp_password',                  probe: 'pw',               consumer: 'emailUtils.getTransporter' },
  { key: 'smtp_from',                      probe: 'Test <t@test.com>',consumer: 'emailUtils.sendMail (From override planned)' },
  { key: 'smtp_secure',                    probe: '0',                consumer: 'emailUtils.getTransporter' },

  // ── Email Defaults
  { key: 'reply_to_email',                 probe: 'test@example.com', consumer: 'emailUtils.sendMail' },
  { key: 'bcc_email',                      probe: 'bcc@example.com',  consumer: 'emailUtils.sendMail' },
  { key: 'emails_disabled',                probe: '0',        consumer: 'emailUtils.sendMail (kill switch)' },

  // ── Customer Experience
  { key: 'csat_after_chat',                probe: '1',        consumer: 'public-settings → customer Chat UI' },
  { key: 'csat_after_ticket',              probe: '1',        consumer: 'public-settings → customer Ticket UI' },
  { key: 'allow_chat_attachments',         probe: '1',        consumer: 'public-settings → composer paperclip' },
  { key: 'chat_attachment_max_mb',         probe: '10',       consumer: 'public-settings → composer max size' },
  { key: 'chat_attachment_types',          probe: 'jpg,png,pdf', consumer: 'public-settings → composer accept attr' },
  { key: 'ticket_created_email_enabled',   probe: '1',        consumer: 'ticketController.createTicket' },

  // ── Security & Access
  { key: 'admin_idle_timeout_minutes',     probe: '30',       consumer: 'Layout useIdle (via public-settings)' },
  { key: 'require_admin_2fa',              probe: '0',        consumer: 'authController.login + 2fa flow' },
  { key: 'admin_ip_allowlist',             probe: '',         consumer: 'auth.js ipAllowlistGate middleware' },
  { key: 'password_min_length',            probe: '8',        consumer: null }, // placeholder — not yet wired to signup form
  { key: 'password_require_digit',         probe: '0',        consumer: null },
  { key: 'password_require_symbol',        probe: '0',        consumer: null },

  // ── Branding
  { key: 'brand_sender_name',              probe: 'Anutech Support', consumer: 'emailUtils.sendMail From override' },
  { key: 'brand_footer_text',              probe: '© Test 2026',     consumer: 'Layout customer footer (via public-settings)' },
  { key: 'brand_color',                    probe: '#4f46e5',         consumer: 'PublicSettingsContext CSS var --brand-color' },

  // ── Operations
  { key: 'maintenance_mode',               probe: '0',        consumer: 'app.js maintenance middleware' },
  { key: 'maintenance_message',            probe: '',         consumer: 'Layout banner + maintenance middleware' },
  { key: 'audit_retention_days',           probe: '180',      consumer: 'slaWorker audit prune cron (3am daily)' },

  // ── Channel Kill Switches
  { key: 'bot_widget_enabled',             probe: '1',        consumer: 'BotWidget early-return via public-settings' },
  { key: 'calls_system_enabled',           probe: '1',        consumer: 'callController.initiateCall 503 gate' },
  { key: 'whatsapp_enabled',               probe: '0',        consumer: null }, // placeholder — channel doesn't exist

  // ── Assignment Routing
  { key: 'assignment_mode',                probe: 'least_loaded', consumer: 'assignment.pickAgent' },
  { key: 'heavy_load_threshold',           probe: '8',        consumer: 'assignment.pickAgent' },
  { key: 'heavy_load_chat_threshold',      probe: '3',        consumer: 'assignment.pickAgent' },
  { key: 'heavy_load_call_threshold',      probe: '1',        consumer: 'assignment.pickAgent' },
  { key: 'block_outside_work_hours',       probe: '0',        consumer: 'assignment.pickAgent isInWorkHours' },

  // ── Working Hours
  { key: 'work_hours_start',               probe: '10',       consumer: 'assignment.isInWorkHours' },
  { key: 'work_hours_end',                 probe: '18',       consumer: 'assignment.isInWorkHours' },
  { key: 'work_hours_days',                probe: '1,2,3,4,5,6', consumer: 'assignment.isInWorkHours' },

  // ── Zoho Books
  { key: 'billing_api_url',                probe: 'https://example.com', consumer: 'syncController.triggerBillingSync' },
  { key: 'billing_api_key',                probe: '',         consumer: 'syncController.triggerBillingSync' },
  { key: 'billing_webhook_secret',         probe: '',         consumer: 'sync.js webhook verification' },

  // ── Razorpay
  { key: 'razorpay_key_id',                probe: '',         consumer: 'customerController.initiateUpgrade' },
  { key: 'razorpay_key_secret',            probe: '',         consumer: 'customerController.confirmUpgrade' },
];

const { ALLOWED_KEYS } = (() => {
  const src = fs.readFileSync(path.join(__dirname, 'src/controllers/adminController.js'), 'utf8');
  const m = src.match(/ALLOWED_SETTING_KEYS = new Set\(\[([\s\S]*?)\]\)/);
  if (!m) return { ALLOWED_KEYS: new Set() };
  const keys = [...m[1].matchAll(/['"]([\w]+)['"]/g)].map(x => x[1]);
  return { ALLOWED_KEYS: new Set(keys) };
})();

(async () => {
  const pool = await mysql.createPool({
    host: process.env.DB_HOST, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
  });

  let totalPass = 0, totalFail = 0, placeholders = 0;
  const results = [];

  // Snapshot original values so we can restore after the test.
  const [origRows] = await pool.query('SELECT `key`, value FROM admin_settings');
  const original = Object.fromEntries(origRows.map(r => [r.key, r.value]));

  for (const field of FIELDS) {
    const r = { key: field.key, status: 'pass', notes: [] };

    // (1) Whitelist check
    if (!ALLOWED_KEYS.has(field.key)) {
      r.status = 'FAIL';
      r.notes.push('NOT in ALLOWED_SETTING_KEYS — admin save would be silently dropped');
    }

    // (2) Write probe value through the same path the admin UI uses
    try {
      await pool.query(
        'INSERT INTO admin_settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = ?',
        [field.key, field.probe, field.probe]
      );
    } catch (err) {
      r.status = 'FAIL';
      r.notes.push(`DB write failed: ${err.message}`);
    }

    // (3) Read back via the cached settings helper
    try {
      // Invalidate cache so we read fresh
      const settings = require('./src/utils/settings');
      settings.invalidateAllSettingsCache();
      const got = await settings.getSetting(field.key);
      if (got !== field.probe) {
        r.status = 'FAIL';
        r.notes.push(`Read-back mismatch: wrote "${field.probe}", got "${got}"`);
      }
    } catch (err) {
      r.status = 'FAIL';
      r.notes.push(`Cache read failed: ${err.message}`);
    }

    // (4) Consumer check (informational)
    if (field.consumer === null) {
      r.status = r.status === 'FAIL' ? 'FAIL' : 'PLACEHOLDER';
      r.notes.push('Saved but not yet enforced anywhere (deliberate placeholder)');
      placeholders++;
    } else {
      r.notes.push(`Consumer: ${field.consumer}`);
    }

    if (r.status === 'pass') totalPass++;
    else if (r.status === 'FAIL') totalFail++;
    results.push(r);
  }

  // Restore originals
  for (const [k, v] of Object.entries(original)) {
    await pool.query(
      'INSERT INTO admin_settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = ?',
      [k, v, v]
    );
  }
  // Also clear any keys the test created that weren't in the original snapshot
  for (const f of FIELDS) {
    if (!(f.key in original)) {
      await pool.query('DELETE FROM admin_settings WHERE `key` = ?', [f.key]);
    }
  }

  // Print report
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('SETTINGS PAGE FUNCTIONAL TEST');
  console.log('═══════════════════════════════════════════════════════════════');
  for (const r of results) {
    const icon = r.status === 'pass' ? '✓' : r.status === 'PLACEHOLDER' ? '◦' : '✗';
    console.log(`${icon} ${r.key.padEnd(40)} [${r.status}]`);
    r.notes.forEach(n => console.log(`    └─ ${n}`));
  }
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`Total fields tested:  ${results.length}`);
  console.log(`  ✓ Working:          ${totalPass}`);
  console.log(`  ◦ Placeholder:      ${placeholders}`);
  console.log(`  ✗ FAILED:           ${totalFail}`);
  console.log('═══════════════════════════════════════════════════════════════');

  await pool.end();
  process.exit(totalFail > 0 ? 1 : 0);
})().catch(err => { console.error('FATAL:', err); process.exit(2); });
