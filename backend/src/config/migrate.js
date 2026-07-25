const { pool } = require('./database');

async function runMigrations() {
  const run = (sql) => pool.query(sql).catch(err => {
    if (!err.message.includes('Duplicate column') && !err.message.includes('already exists')) throw err;
  });

  // users — single-device session: last-seen timestamp powering reliable
  // block-new login (replaces the flaky live-socket check).
  await run(`ALTER TABLE users ADD COLUMN session_last_seen TIMESTAMP NULL DEFAULT NULL`);

  // tickets — add tags, due_date columns
  await run(`ALTER TABLE tickets ADD COLUMN tags JSON DEFAULT NULL`);
  await run(`ALTER TABLE tickets ADD COLUMN due_date DATE DEFAULT NULL`);
  await run(`ALTER TABLE tickets ADD COLUMN merged_into INT DEFAULT NULL`);

  // GW reseller ticket enhancements
  await run(`ALTER TABLE tickets ADD COLUMN request_type VARCHAR(50) DEFAULT NULL`);
  await run(`ALTER TABLE tickets ADD COLUMN gw_edition VARCHAR(50) DEFAULT NULL`);
  await run(`ALTER TABLE tickets ADD COLUMN affected_users INT DEFAULT NULL`);
  await run(`ALTER TABLE tickets ADD COLUMN pending_reason VARCHAR(100) DEFAULT NULL`);
  await run(`ALTER TABLE tickets ADD COLUMN google_case_id VARCHAR(100) DEFAULT NULL`);

  // Ticket templates (pre-filled forms for common GW requests)
  await run(`CREATE TABLE IF NOT EXISTS ticket_templates (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    subject_template VARCHAR(500) DEFAULT NULL,
    description_template TEXT NOT NULL,
    request_type VARCHAR(50) DEFAULT NULL,
    default_priority ENUM('low','normal','medium','high','urgent') DEFAULT 'normal',
    is_active TINYINT(1) DEFAULT 1,
    created_by INT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id)
  )`);

  // Screen-share support sessions (Phase 1: agent views customer's screen,
  // view-only, initiated from a live chat). One row per request; audit + history.
  // customer_id / agent_id are users.id (matches the `user_<id>` socket rooms).
  await run(`CREATE TABLE IF NOT EXISTS screen_share_sessions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    chat_id INT DEFAULT NULL,
    agent_id INT NOT NULL,
    customer_id INT NOT NULL,
    status ENUM('requested','active','ended','rejected','cancelled') DEFAULT 'requested',
    requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    accepted_at TIMESTAMP NULL DEFAULT NULL,
    ended_at TIMESTAMP NULL DEFAULT NULL,
    ended_by ENUM('agent','customer','system') DEFAULT NULL,
    INDEX (chat_id), INDEX (agent_id), INDEX (customer_id),
    FOREIGN KEY (agent_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (customer_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

  // Plan-level SLA config (tiered SLA by support plan)
  await run(`ALTER TABLE plans ADD COLUMN sla_response_hours INT DEFAULT NULL`);
  await run(`ALTER TABLE plans ADD COLUMN sla_resolve_hours INT DEFAULT NULL`);

  // Internal notes (agent-only)
  await run(`CREATE TABLE IF NOT EXISTS ticket_internal_notes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    ticket_id INT NOT NULL,
    agent_id INT NOT NULL,
    note TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
    FOREIGN KEY (agent_id) REFERENCES users(id)
  )`);

  // Time logs per ticket per agent
  await run(`CREATE TABLE IF NOT EXISTS ticket_time_logs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    ticket_id INT NOT NULL,
    agent_id INT NOT NULL,
    seconds INT NOT NULL DEFAULT 0,
    logged_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
    FOREIGN KEY (agent_id) REFERENCES users(id)
  )`);

  // Macros (quick action templates)
  await run(`CREATE TABLE IF NOT EXISTS ticket_macros (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    actions JSON NOT NULL,
    created_by INT NOT NULL,
    is_global TINYINT(1) DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id)
  )`);

  // Admin key-value settings
  await run(`CREATE TABLE IF NOT EXISTS admin_settings (
    \`key\` VARCHAR(100) PRIMARY KEY,
    value VARCHAR(500) NOT NULL
  )`);

  // Seed default auto-close threshold if not present
  await pool.query(
    `INSERT IGNORE INTO admin_settings (\`key\`, value) VALUES ('auto_close_days', '14')`
  );

  // chat improvements
  await run(`ALTER TABLE chats ADD COLUMN department VARCHAR(100) DEFAULT NULL`);
  await run(`ALTER TABLE chats ADD COLUMN transfer_note TEXT DEFAULT NULL`);
  await run(`ALTER TABLE chats ADD COLUMN first_response_at DATETIME DEFAULT NULL`);
  await run(`ALTER TABLE chats ADD COLUMN queue_warned TINYINT(1) DEFAULT 0`);
  await run(`ALTER TABLE chat_messages ADD COLUMN file_url VARCHAR(500) DEFAULT NULL`);
  await run(`ALTER TABLE chat_messages ADD COLUMN file_name VARCHAR(255) DEFAULT NULL`);
  await run(`ALTER TABLE chat_messages ADD COLUMN file_type VARCHAR(100) DEFAULT NULL`);
  await run(`ALTER TABLE chat_messages ADD COLUMN read_at DATETIME DEFAULT NULL`);

  await run(`CREATE TABLE IF NOT EXISTS chat_ratings (
    id INT AUTO_INCREMENT PRIMARY KEY,
    chat_id INT NOT NULL UNIQUE,
    rating TINYINT NOT NULL,
    comment TEXT DEFAULT NULL,
    agent_id INT DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
  )`);
  await run(`ALTER TABLE chat_ratings ADD COLUMN agent_id INT DEFAULT NULL`);

  await run(`CREATE TABLE IF NOT EXISTS chat_blacklist (
    id INT AUTO_INCREMENT PRIMARY KEY,
    customer_user_id INT NOT NULL UNIQUE,
    blocked_by INT NOT NULL,
    reason VARCHAR(500) DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (customer_user_id) REFERENCES users(id),
    FOREIGN KEY (blocked_by) REFERENCES users(id)
  )`);

  // Call blacklist — mirrors chat_blacklist. Lets admins disable voice calls
  // for a specific customer (tickets and live chat remain unaffected). One
  // row per blocked user; re-blocking updates the reason via ON DUPLICATE KEY.
  await run(`CREATE TABLE IF NOT EXISTS call_blacklist (
    id INT AUTO_INCREMENT PRIMARY KEY,
    customer_user_id INT NOT NULL UNIQUE,
    blocked_by INT NOT NULL,
    reason VARCHAR(500) DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (customer_user_id) REFERENCES users(id),
    FOREIGN KEY (blocked_by) REFERENCES users(id)
  )`);

  await pool.query(
    `INSERT IGNORE INTO admin_settings (\`key\`, value) VALUES ('queue_sla_minutes', '5')`
  );

  // Billing integration — link customers to billing app
  await run(`ALTER TABLE customers ADD COLUMN billing_customer_id VARCHAR(100) DEFAULT NULL`);
  await run(`ALTER TABLE customers ADD COLUMN billing_synced_at DATETIME DEFAULT NULL`);
  try {
    await pool.query('ALTER TABLE customers ADD UNIQUE INDEX idx_billing_customer_id (billing_customer_id)');
  } catch (e) {
    if (!e.message.includes('Duplicate key') && !e.message.includes('already exists')) throw e;
  }

  // Per-customer feature overrides (admin can override plan defaults)
  await run(`CREATE TABLE IF NOT EXISTS customer_feature_overrides (
    id INT AUTO_INCREMENT PRIMARY KEY,
    customer_id INT NOT NULL UNIQUE,
    allow_chat TINYINT(1) DEFAULT NULL,
    allow_calls TINYINT(1) DEFAULT NULL,
    tickets_limit INT DEFAULT NULL,
    calls_limit INT DEFAULT NULL,
    override_reason VARCHAR(255) DEFAULT NULL,
    updated_by INT DEFAULT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
    FOREIGN KEY (updated_by) REFERENCES users(id)
  )`);
  // Chat limit was missing from the original schema — gating logic could
  // only override the chat ON/OFF flag, not the per-month chat quota.
  // Added 2026-05-28 so admins can bump a Premium customer's chat cap
  // (default 15) up or down without changing their plan.
  await run(`ALTER TABLE customer_feature_overrides ADD COLUMN chat_limit INT DEFAULT NULL`);

  // Free plan never expires. Existing Free customers may have a stale
  // plan_expiry from when the field was always required — clear it so the
  // isPlanActive() check ("no expiry = always active") fires correctly and
  // the admin UI shows "Never" instead of a meaningless date.
  // Idempotent: the WHERE clause only touches rows that still need cleanup.
  await pool.query(
    `UPDATE customers c JOIN plans p ON p.id = c.plan_id
     SET c.plan_expiry = NULL
     WHERE p.name = 'free' AND c.plan_expiry IS NOT NULL`
  ).catch(err => console.error('[Migrate] free-expiry cleanup', err.message));

  // Everyone gets at least the Free plan (which never expires). Back-fill any
  // customer left plan-less — e.g. older billing-sync imports that set plan_id
  // NULL — to Free, so they're never shown as "Free · Expired" or blocked from
  // free-tier support. Idempotent (only touches NULL plan_id rows).
  await pool.query(
    `UPDATE customers SET plan_id = (SELECT id FROM plans WHERE name = 'free' LIMIT 1),
            plan_expiry = NULL
     WHERE plan_id IS NULL`
  ).catch(err => console.error('[Migrate] free default backfill', err.message));

  // Billing integration settings
  await pool.query(`INSERT IGNORE INTO admin_settings (\`key\`, value) VALUES ('billing_api_url', '')`);
  await pool.query(`INSERT IGNORE INTO admin_settings (\`key\`, value) VALUES ('billing_api_key', '')`);
  await pool.query(`INSERT IGNORE INTO admin_settings (\`key\`, value) VALUES ('billing_webhook_secret', '')`);
  await pool.query(`INSERT IGNORE INTO admin_settings (\`key\`, value) VALUES ('billing_last_sync', '')`);
  // Provider-agnostic connector: which billing app + how to authenticate.
  // provider: 'reselleros' | 'generic-rest' | 'zoho'  ·  auth_style: 'bearer' | 'x-api-key'
  await pool.query(`INSERT IGNORE INTO admin_settings (\`key\`, value) VALUES ('billing_provider', 'reselleros')`);
  await pool.query(`INSERT IGNORE INTO admin_settings (\`key\`, value) VALUES ('billing_auth_style', 'bearer')`);

  // Screen-share support sessions — off by default (feature flag).
  await pool.query(`INSERT IGNORE INTO admin_settings (\`key\`, value) VALUES ('screen_share_enabled', '0')`);

  // Razorpay payment gateway settings
  await pool.query(`INSERT IGNORE INTO admin_settings (\`key\`, value) VALUES ('razorpay_key_id', '')`);
  await pool.query(`INSERT IGNORE INTO admin_settings (\`key\`, value) VALUES ('razorpay_key_secret', '')`);

  // Working hours — Mon–Sat, 10 AM to 6 PM IST (day numbers: 0=Sun, 1=Mon, ..., 6=Sat)
  await pool.query(`INSERT IGNORE INTO admin_settings (\`key\`, value) VALUES ('work_hours_start', '10')`);
  await pool.query(`INSERT IGNORE INTO admin_settings (\`key\`, value) VALUES ('work_hours_end', '18')`);
  await pool.query(`INSERT IGNORE INTO admin_settings (\`key\`, value) VALUES ('work_hours_days', '1,2,3,4,5,6')`)

  // Plan v2: separate chat_limit from tickets_limit; tickets are now unlimited on all plans
  await run(`ALTER TABLE plans ADD COLUMN chat_limit INT DEFAULT NULL`);
  await pool.query(`UPDATE plans SET tickets_limit = NULL, chat_limit = NULL, calls_limit = NULL, sla_response_hours = 48  WHERE name = 'free'`);
  await pool.query(`UPDATE plans SET tickets_limit = NULL, chat_limit = 5,    calls_limit = NULL, sla_response_hours = 24  WHERE name = 'basic'`);
  await pool.query(`UPDATE plans SET tickets_limit = NULL, chat_limit = 8,    calls_limit = 5,    sla_response_hours = 10  WHERE name = 'moderate'`);
  await pool.query(`UPDATE plans SET tickets_limit = NULL, chat_limit = 15,   calls_limit = 10,   sla_response_hours = 2   WHERE name = 'premium'`);

  // Chat usage counter table — consistent with call_usage and ticket_usage
  await run(`CREATE TABLE IF NOT EXISTS chat_usage (
    customer_id INT NOT NULL,
    month_year  VARCHAR(7) NOT NULL,
    count       INT NOT NULL DEFAULT 0,
    PRIMARY KEY (customer_id, month_year),
    FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
  )`);

  // Keep chat_usage_reset for backwards compat if it exists (no longer used)
  await run(`CREATE TABLE IF NOT EXISTS chat_usage_reset (
    customer_id INT NOT NULL,
    month_year  VARCHAR(7) NOT NULL,
    offset_count INT NOT NULL DEFAULT 0,
    reset_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (customer_id, month_year),
    FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
  )`);

  await run(`CREATE TABLE IF NOT EXISTS chat_internal_notes (
    id       INT AUTO_INCREMENT PRIMARY KEY,
    chat_id  INT NOT NULL,
    agent_id INT NOT NULL,
    note     TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (chat_id)  REFERENCES chats(id) ON DELETE CASCADE,
    FOREIGN KEY (agent_id) REFERENCES users(id)
  )`);

  // Track who initiated a call: customer (default) or agent.
  // Agent-initiated calls bypass the customer's monthly calls_limit.
  await run(`ALTER TABLE calls ADD COLUMN initiated_by ENUM('customer','agent') DEFAULT 'customer'`);
  await run(`ALTER TABLE calls ADD COLUMN ticket_id INT DEFAULT NULL`);

  // Per-plan agent control: can an agent call out to customers on this plan?
  // Default: same as allow_calls (calls are bidirectional). Admin can disable
  // agent-initiated calls per-plan without affecting customer-initiated calls.
  await run(`ALTER TABLE plans ADD COLUMN agent_can_initiate_call TINYINT(1) DEFAULT NULL`);
  await pool.query(`UPDATE plans SET agent_can_initiate_call = allow_calls WHERE agent_can_initiate_call IS NULL`);

  // Routing settings (admin-controlled)
  await pool.query(`INSERT IGNORE INTO admin_settings (\`key\`, value) VALUES ('auto_assign_enabled', '0')`);
  await pool.query(`INSERT IGNORE INTO admin_settings (\`key\`, value) VALUES ('assignment_mode', 'least_loaded')`); // 'least_loaded' | 'round_robin'
  await pool.query(`INSERT IGNORE INTO admin_settings (\`key\`, value) VALUES ('heavy_load_threshold', '8')`);     // open tickets+chats per agent (ticket auto-assign only)
  await pool.query(`INSERT IGNORE INTO admin_settings (\`key\`, value) VALUES ('heavy_load_chat_threshold', '3')`); // active chats per agent before admin overflow
  await pool.query(`INSERT IGNORE INTO admin_settings (\`key\`, value) VALUES ('heavy_load_call_threshold', '1')`); // active calls per agent before admin overflow
  await pool.query(`INSERT IGNORE INTO admin_settings (\`key\`, value) VALUES ('enable_admin_overflow', '1')`);    // admin picks up chat/call overflow (never tickets)
  await pool.query(`INSERT IGNORE INTO admin_settings (\`key\`, value) VALUES ('block_outside_work_hours', '0')`); // block auto-assign outside work hours

  // Agent extensions: skill tags + break mode (auto-resume timer)
  await run(`ALTER TABLE users ADD COLUMN skill_tags JSON DEFAULT NULL`);
  await run(`ALTER TABLE users ADD COLUMN on_break_until DATETIME DEFAULT NULL`);

  // Persist agent's chosen availability across socket reconnects (refresh, network blip).
  // Without this, agentStatuses is in-memory only and reverts to 'online' on every reconnect.
  await run(`ALTER TABLE users ADD COLUMN last_status VARCHAR(16) DEFAULT NULL`);

  // Customer extensions: VIP flag + favorite agent
  await run(`ALTER TABLE customers ADD COLUMN is_vip TINYINT(1) DEFAULT 0`);
  await run(`ALTER TABLE customers ADD COLUMN favorite_agent_id INT DEFAULT NULL`);

  // Track last assignment time for round-robin
  await run(`ALTER TABLE users ADD COLUMN last_assigned_at DATETIME DEFAULT NULL`);

  // Call recording: FK to file_attachments. NULL = no recording (call not recorded
  // or recording failed/expired). Admin-only playback enforced in attachmentController.
  await run(`ALTER TABLE calls ADD COLUMN recording_attachment_id INT DEFAULT NULL`);

  // Widen file_attachments.ref_type so it can hold 'call_recording' and any
  // future ref types. Was an ENUM('ticket','ticket_message','chat_message') —
  // any new ref_type silently failed with "Data truncated for column".
  await run(`ALTER TABLE file_attachments MODIFY COLUMN ref_type VARCHAR(50) NOT NULL`);

  // Pre-chat category picker — customer selects "Billing / Technical / etc."
  // before starting a chat so agents see what they need help with up-front.
  // Plain VARCHAR (not enum) so admins can extend the vocabulary without a migration.
  await run(`ALTER TABLE chats ADD COLUMN category VARCHAR(40) DEFAULT NULL`);
  await run(`ALTER TABLE calls ADD COLUMN category VARCHAR(40) DEFAULT NULL`);

  // Track which chat (if any) a ticket was converted from. Lets the agent's
  // Archive view show "View Ticket #N" instead of "Convert to Ticket" when a
  // chat has already been escalated, so we don't end up with duplicate tickets
  // for the same conversation. Nullable — tickets created directly (not via
  // chat conversion) leave this NULL.
  await run(`ALTER TABLE tickets ADD COLUMN source_chat_id INT DEFAULT NULL`);

  // Single-device login enforcement. Every successful login mints a fresh
  // random session id (jti, embedded in the JWT) and stores it here. The auth
  // middleware compares the JWT's jti to this column on every request — if a
  // newer login overwrote it, the older JWT is invalidated. NULL = legacy
  // session (no jti enforced yet) or post-logout state.
  await run(`ALTER TABLE users ADD COLUMN active_session_jti VARCHAR(64) DEFAULT NULL`);

  // Per-call participants log. JSON array of agents who held the call, with
  // their joined_at timestamp:
  //   [
  //     { "agent_id": 2,  "agent_name": "Priya Sharma", "joined_at": "<ISO>" },
  //     { "agent_id": 16, "agent_name": "Anita Reddy",  "joined_at": "<ISO>" }
  //   ]
  // Populated on first accept (agent picks up / customer answers an outbound)
  // and appended on every accept_transfer. Per-agent duration is computed at
  // display time as `next_entry.joined_at - this_entry.joined_at` (or
  // `call_end_time - last.joined_at` for the final segment).
  await run(`ALTER TABLE calls ADD COLUMN participants JSON DEFAULT NULL`);

  // Admin-editable email templates. Empty until admin saves a customisation —
  // the email helpers in emailUtils.js fall back to their hardcoded HTML when
  // there's no row, so first-deploy is a no-op. Reset-to-default in the admin
  // UI = DELETE the row.
  await run(`CREATE TABLE IF NOT EXISTS email_templates (
    template_key VARCHAR(64) PRIMARY KEY,
    subject VARCHAR(500) NOT NULL,
    body_html MEDIUMTEXT NOT NULL,
    updated_by INT DEFAULT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
  ) ENGINE=InnoDB`);

  // Custom reports — admin-built saved queries that show up on the
  // "Custom Reports" tab of the Reports page. Shared across all admins
  // (no owner-scoped visibility). `resource` is one of
  // tickets/invoices/calls/chats/customers; `filters` and `columns` are
  // JSON arrays describing the saved query.
  await run(`CREATE TABLE IF NOT EXISTS custom_reports (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(120) NOT NULL,
    resource VARCHAR(32) NOT NULL,
    filters JSON NOT NULL,
    columns JSON NOT NULL,
    created_by INT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_resource (resource)
  ) ENGINE=InnoDB`);

  // Feedback / bug reports submitted from customer + agent panels. Lightweight
  // table; attachments are stored as a JSON array of file paths so we don't need
  // a join — feedback never feeds back into other entities and rarely has many
  // files per report. Admin reviews via /admin/feedback.
  await run(`CREATE TABLE IF NOT EXISTS feedback_reports (
    id INT AUTO_INCREMENT PRIMARY KEY,
    reporter_user_id INT NOT NULL,
    reporter_role VARCHAR(20) NOT NULL,
    panel VARCHAR(20) NOT NULL,
    title VARCHAR(255) NOT NULL,
    description TEXT NOT NULL,
    page_url VARCHAR(500) DEFAULT NULL,
    browser_info VARCHAR(500) DEFAULT NULL,
    attachments JSON DEFAULT NULL,
    status ENUM('new','reviewed','approved','rejected','fixed') NOT NULL DEFAULT 'new',
    admin_notes TEXT DEFAULT NULL,
    reviewed_by INT DEFAULT NULL,
    reviewed_at DATETIME DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_status (status),
    INDEX idx_reporter (reporter_user_id),
    FOREIGN KEY (reporter_user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL
  ) ENGINE=InnoDB`);

  // Extend tickets.priority ENUM to include 'urgent'. The SLA escalation worker
  // and customer-side AI categorizer have always tried to set priority='urgent'
  // on breach / emergency-language tickets; the column ENUM was missing this
  // value so those writes were silently dropped by MySQL. Adding it makes the
  // existing backend code start working. Idempotent — re-running the MODIFY
  // with the same definition is a no-op in MySQL.
  await run(`ALTER TABLE tickets MODIFY priority ENUM('low','normal','medium','high','urgent') DEFAULT 'low'`);

  // Seed product-specific canned responses, macros, and templates once.
  // Idempotent via the canned_seeds_v1_applied flag — admins can re-seed by
  // deleting the flag from admin_settings.
  const [[seedFlag]] = await pool.query(
    "SELECT value FROM admin_settings WHERE `key` = 'canned_seeds_v1_applied'"
  );
  if (!seedFlag || seedFlag.value !== '1') {
    const [[admin]] = await pool.query(
      "SELECT id FROM users WHERE role = 'admin' AND is_active = TRUE ORDER BY id LIMIT 1"
    );
    if (admin) {
      await seedProductCanned(admin.id);
      await seedProductMacros(admin.id);
      await seedProductTemplates(admin.id);
      await pool.query(
        "INSERT INTO admin_settings (`key`, value) VALUES ('canned_seeds_v1_applied', '1') ON DUPLICATE KEY UPDATE value = '1'"
      );
      console.log('[Migrate] Seeded canned responses, macros, and ticket templates');
    }
  }

  // Plan change history — one row per state transition (signup, upgrade,
  // downgrade, renewal, manual_admin, expiry_lapse). Source of truth for
  // churn metrics, customer-detail timeline, and "when did this customer
  // change plans" forensics. Plan names are SNAPSHOTTED so renaming a plan
  // later doesn't rewrite history.
  await run(`CREATE TABLE IF NOT EXISTS plan_change_history (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    customer_id INT NOT NULL,
    from_plan_id INT NULL,
    to_plan_id INT NOT NULL,
    from_plan_name VARCHAR(60) NULL,
    to_plan_name VARCHAR(60) NULL,
    change_kind ENUM('signup','upgrade','downgrade','renewal','manual_admin','expiry_lapse') NOT NULL,
    changed_by INT NULL,
    amount_paid DECIMAL(10,2) NULL,
    payment_ref VARCHAR(120) NULL,
    expiry_before DATE NULL,
    expiry_after DATE NULL,
    note TEXT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_customer_time (customer_id, created_at),
    INDEX idx_kind_time (change_kind, created_at),
    FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
    FOREIGN KEY (changed_by) REFERENCES users(id) ON DELETE SET NULL
  ) ENGINE=InnoDB`);

  // One-time backfill — give every existing customer one 'signup' row so the
  // history tab is never empty. Uses customers.created_at as the timestamp
  // and customer.plan_id as the to_plan_id. Idempotent via the
  // plan_history_backfill_v1_applied flag in admin_settings.
  const [[backfillFlag]] = await pool.query(
    "SELECT value FROM admin_settings WHERE `key` = 'plan_history_backfill_v1_applied'"
  );
  if (!backfillFlag || backfillFlag.value !== '1') {
    await pool.query(`
      INSERT INTO plan_change_history
        (customer_id, from_plan_id, to_plan_id, from_plan_name, to_plan_name,
         change_kind, expiry_after, note, created_at)
      SELECT c.id, NULL, c.plan_id, NULL, p.name,
             'signup', c.plan_expiry,
             'Backfilled from customer.created_at — exact signup history not preserved.',
             c.created_at
      FROM customers c
      LEFT JOIN plans p ON p.id = c.plan_id
      WHERE NOT EXISTS (
        SELECT 1 FROM plan_change_history h WHERE h.customer_id = c.id
      )
    `).catch(err => console.error('[Migrate] plan history backfill', err.message));
    await pool.query(
      "INSERT INTO admin_settings (`key`, value) VALUES ('plan_history_backfill_v1_applied', '1') ON DUPLICATE KEY UPDATE value = '1'"
    );
    console.log('[Migrate] Backfilled plan_change_history with signup rows');
  }

  // Phase 2 — queue of failed Zoho/billing-app sync attempts.
  // verifyUpgrade writes a row here when its Zoho notify call fails.
  // billingRetryWorker.js (cron, every 5 min) picks up rows where
  // synced_at IS NULL AND dismissed_at IS NULL AND attempts < 5 and re-tries.
  // Admin can also manually retry or dismiss from /admin/billing-syncs.
  await run(`CREATE TABLE IF NOT EXISTS pending_billing_syncs (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    customer_id INT NOT NULL,
    plan VARCHAR(40),
    payment_ref VARCHAR(120),
    amount DECIMAL(10,2) NULL,
    plan_expiry DATE NULL,
    attempts INT NOT NULL DEFAULT 0,
    last_error TEXT NULL,
    last_attempt_at DATETIME NULL,
    synced_at DATETIME NULL,
    dismissed_at DATETIME NULL,
    dismissed_by INT NULL,
    dismiss_note TEXT NULL,
    admin_notified TINYINT(1) NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_status (synced_at, dismissed_at, attempts),
    INDEX idx_customer (customer_id, created_at),
    FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
    FOREIGN KEY (dismissed_by) REFERENCES users(id) ON DELETE SET NULL
  ) ENGINE=InnoDB`);

  // Phase 1 — payment attempts log. Tracks every Razorpay upgrade attempt
  // (initiated → succeeded / failed / cancelled). Drives the soft-lock
  // (5 failures/hour → 30 min cooldown), the System Health failure card,
  // and post-mortem debugging when a customer says "my payment didn't go
  // through". One row per attempt, never updated except on the
  // initiate→success / initiate→failure flip.
  await run(`CREATE TABLE IF NOT EXISTS payment_attempts (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    customer_id INT NOT NULL,
    target_plan VARCHAR(40) NOT NULL,
    razorpay_order_id VARCHAR(120) NULL,
    razorpay_payment_id VARCHAR(120) NULL,
    amount DECIMAL(10,2) NULL,
    status ENUM('initiated','succeeded','failed','cancelled') NOT NULL DEFAULT 'initiated',
    error_code VARCHAR(100) NULL,
    error_description TEXT NULL,
    user_agent VARCHAR(500) NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_customer_time (customer_id, created_at),
    INDEX idx_status_time (status, created_at),
    INDEX idx_order (razorpay_order_id),
    FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`);

  // Phase 4 — renewal window + auto-lapse-to-Free settings
  await pool.query(`INSERT IGNORE INTO admin_settings (\`key\`, value) VALUES ('renewal_window_days', '30')`);
  await pool.query(`INSERT IGNORE INTO admin_settings (\`key\`, value) VALUES ('auto_lapse_to_free', '1')`);

  // Track who hung up a call. customer = customer cut it, agent = agent cut it,
  // admin = admin force-ended (block / redirect), system = network drop / disconnect cleanup.
  // Powers the admin Calls page "Ended by" column + the short-call abuse triage workflow.
  await run(`ALTER TABLE calls ADD COLUMN ended_by ENUM('customer','agent','admin','system') DEFAULT NULL`);

  // Preserve the full inbound email body — `snippet` is a 500-char collapsed
  // preview for the audit list, useless as a ticket-message body. This column
  // stores the raw plain-text body with line breaks intact so the "Attach to
  // ticket" admin action can drop in something readable.
  await run(`ALTER TABLE inbound_email ADD COLUMN body_text MEDIUMTEXT NULL`);

  // Razorpay payment reference on invoices — lets verifyUpgrade create a local
  // 'paid' invoice that closes the loop with the Dashboard's Revenue tile even
  // if the Zoho billing-app sync fails. Also acts as a dedup key so webhook
  // retries / accidental double-clicks don't create duplicate revenue rows.
  await run(`ALTER TABLE invoices ADD COLUMN payment_ref VARCHAR(120) DEFAULT NULL`);
  try {
    await pool.query('ALTER TABLE invoices ADD INDEX idx_invoices_payment_ref (payment_ref)');
  } catch (e) {
    if (!e.message.includes('Duplicate key') && !e.message.includes('already exists')) throw e;
  }

  // Background worker liveness — every worker calls heartbeat('name') at the
  // start of each tick (success or failure). System Health panel reads these
  // rows to show "last run X ago · OK/ERROR" so admin can spot a dead worker
  // before symptoms surface. Single row per worker (upsert on name).
  await run(`CREATE TABLE IF NOT EXISTS worker_heartbeats (
    name VARCHAR(64) PRIMARY KEY,
    last_run_at DATETIME NOT NULL,
    last_status ENUM('ok', 'error', 'skipped') NOT NULL DEFAULT 'ok',
    last_error TEXT NULL,
    expected_interval_seconds INT NOT NULL DEFAULT 60,
    run_count BIGINT NOT NULL DEFAULT 1
  ) ENGINE=InnoDB`);

  // Web Push subscriptions (Phase 4 PWA). One row per (user, browser/device)
  // endpoint. endpoint is unique so re-subscribing the same browser updates in
  // place instead of duplicating. Rows are deleted on unsubscribe or when a
  // push send returns 404/410 (subscription expired) — see pushUtils.js.
  await run(`CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    endpoint VARCHAR(512) NOT NULL UNIQUE,
    p256dh VARCHAR(255) NOT NULL,
    auth VARCHAR(255) NOT NULL,
    user_agent VARCHAR(255) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_push_user (user_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`);

  // One-time backfill: every customer must have a plan (the controllers enforce
  // this on create/update now, but legacy rows from before that defense may
  // still have plan_id = NULL). Assigns the Free plan to anyone missing one so
  // the dashboard counts add up (Total Customers = sum of Plan Distribution).
  // Idempotent via the no_null_plan_v1_applied flag.
  const [[noNullFlag]] = await pool.query(
    "SELECT value FROM admin_settings WHERE `key` = 'no_null_plan_v1_applied'"
  );
  if (!noNullFlag || noNullFlag.value !== '1') {
    const [[freePlan]] = await pool.query("SELECT id FROM plans WHERE name = 'free' LIMIT 1");
    if (freePlan) {
      const [res] = await pool.query(
        'UPDATE customers SET plan_id = ? WHERE plan_id IS NULL',
        [freePlan.id]
      );
      if (res.affectedRows > 0) {
        console.log(`[Migrate] Backfilled plan_id = Free on ${res.affectedRows} legacy customer(s)`);
      }
    }
    await pool.query(
      "INSERT INTO admin_settings (`key`, value) VALUES ('no_null_plan_v1_applied', '1') ON DUPLICATE KEY UPDATE value = '1'"
    );
  }

  // Pre-register the 4 known workers so the dashboard always shows all of them,
  // even before slowly-ticking ones (slaWorker every 15 min, expiryWorker every
  // 24h) have fired their first real heartbeat. Each row's last_run_at gets
  // overwritten on the first real tick, run_count starts at 0 and increments
  // from there. status='skipped' makes them appear in a neutral gray state.
  await pool.query(
    `INSERT IGNORE INTO worker_heartbeats (name, last_run_at, last_status, last_error, expected_interval_seconds, run_count)
     VALUES
       ('slaWorker',          NOW(), 'skipped', 'not yet run since boot', 900,   0),
       ('billingRetryWorker', NOW(), 'skipped', 'not yet run since boot', 300,   0),
       ('expiryWorker',       NOW(), 'skipped', 'not yet run since boot', 86400, 0),
       ('inboundEmailWorker', NOW(), 'skipped', 'not yet run since boot', 60,    0)`
  );

  console.log('[Migrate] DB migrations applied');
}

// ── Seed helpers — product-specific reply content ────────────────────────────
// Priority: Google Workspace > Microsoft 365 > Zoho > Hosting/Domain
// Placeholders: {{customer_name}}, {{ticket_id}}, {{agent_name}}, {{gw_edition}}, {{domain}}

const CANNED_SEEDS = [
  // ── General / cross-product ─────────────────────────────────────────
  { title: 'Acknowledge — investigating',
    body: 'Hi {{customer_name}}, thank you for reaching out. I have received ticket #{{ticket_id}} and am investigating now. I will share an update within the next 30 minutes.\n\nBest regards,\n{{agent_name}}' },
  { title: 'Need more info — screenshot',
    body: 'To investigate further, could you please share:\n1. A screenshot of the error\n2. The affected user email address\n3. The exact time the issue started\n\nThis will help me reproduce and resolve it faster.' },
  { title: 'Resolved — please confirm',
    body: 'The issue has been resolved on our end. Please verify and let me know if everything is working as expected. The ticket will auto-close in 24 hours if no further reply is received.\n\nThanks for your patience!' },
  { title: 'Apology — delay',
    body: 'Apologies for the delay in responding, {{customer_name}}. I am picking this up now and will share an update shortly.' },
  { title: 'Outside working hours',
    body: 'Our support team works Mon–Sat, 10 AM – 6 PM IST. I have logged your request and the assigned agent will respond first thing in the next working window.' },
  { title: 'Asking for admin console access',
    body: 'Could you please confirm whether you have super-admin access to the admin console? If not, please loop in the colleague who does — most fixes require admin rights.' },

  // ── Google Workspace (PRIMARY) ──────────────────────────────────────
  { title: 'GW — confirm domain & edition',
    body: 'Could you please confirm:\n1. Your Google Workspace edition (Business Starter / Standard / Plus / Enterprise)\n2. Your primary domain name\n3. The number of users on your account\n\nThis context will help me proceed correctly.' },
  { title: 'GW — DNS propagation note',
    body: 'DNS changes for Google Workspace can take up to 48 hours to propagate globally. We recommend checking after 4–6 hours using https://mxtoolbox.com. I will continue monitoring on my end.' },
  { title: 'GW — escalated to Google',
    body: 'I have escalated this to Google\'s technical support team. Their case ID is logged on this ticket and they typically respond within 1–2 business days. I will share their findings as soon as I hear back.' },
  { title: 'GW — emails going to spam',
    body: 'For emails landing in spam, please share:\n1. A sample message header (from the recipient side)\n2. Your SPF, DKIM, and DMARC records\n3. Whether this affects all recipients or specific domains only\n\nMost spam issues trace back to one of these three records.' },
  { title: 'GW — Drive sharing restriction',
    body: 'Google Workspace Drive sharing is governed by admin console policies (Apps → Drive and Docs → Sharing settings). Could you confirm whether external sharing is enabled at the organisation level?' },
  { title: 'GW — add new user steps',
    body: 'To add a new user to your Google Workspace:\n\n1. Sign in to admin.google.com as super admin\n2. Go to Directory → Users → Add new user\n3. Fill in name, primary email, optional secondary email\n4. Assign a strong temporary password\n5. Click "Add new user"\n\nThe new user can sign in immediately. Let me know if you hit any step.' },

  // ── Microsoft 365 ───────────────────────────────────────────────────
  { title: 'M365 — license assignment',
    body: 'To assign a Microsoft 365 license:\n\n1. Sign in to admin.microsoft.com\n2. Users → Active users → select the user\n3. Click "Licenses and apps"\n4. Tick the required license → Save\n\nThe license should activate within 10 minutes. Please share the username if you would like me to verify.' },
  { title: 'M365 — Outlook profile recreate',
    body: 'A corrupt Outlook profile is the most common cause of this issue. Please:\n\n1. Close Outlook\n2. Control Panel → Mail (Microsoft Outlook) → Show Profiles\n3. Remove the existing profile\n4. Add a new profile with the same email address\n5. Open Outlook and let it rebuild\n\nThis takes 5–15 minutes depending on mailbox size.' },

  // ── Zoho ────────────────────────────────────────────────────────────
  { title: 'Zoho Mail — MX record verification',
    body: 'For Zoho Mail to receive email correctly, your MX records must point to:\n\n• mx.zoho.in (Priority 10)\n• mx2.zoho.in (Priority 20)\n• mx3.zoho.in (Priority 30)\n\nPlease share a screenshot of your current MX records so I can confirm.' },

  // ── Hosting / Domain ────────────────────────────────────────────────
  { title: 'Hosting — DNS / nameserver check',
    body: 'For domain-level changes please confirm:\n1. The current nameservers (visible via https://whois.com)\n2. Where the domain is registered (GoDaddy / Hostinger / etc.)\n3. The specific record type you want updated (A / CNAME / MX / TXT)\n\nDNS edits typically propagate within 4 hours.' },
  { title: 'Domain — WHOIS / contact update',
    body: 'WHOIS contact updates can take 24–48 hours to reflect. Please raise the change at your registrar (GoDaddy / BigRock / etc.) and share a confirmation screenshot — I will follow up if it does not update within 48 hours.' },
];

async function seedProductCanned(adminId) {
  for (const c of CANNED_SEEDS) {
    await pool.query(
      'INSERT INTO canned_responses (created_by, title, body, is_global) VALUES (?, ?, ?, ?)',
      [adminId, c.title, c.body, 1]
    );
  }
}

const MACRO_SEEDS = [
  { name: 'Awaiting customer info',
    actions: [
      { type: 'reply',  value: 'I need a few more details to proceed — please reply with the information requested above. I will resume work as soon as I hear back.' },
      { type: 'status', value: 'pending' },
      { type: 'tag',    value: 'awaiting-customer' },
    ] },
  { name: 'Escalated to Google',
    actions: [
      { type: 'reply',  value: 'I have escalated this to Google Workspace technical support. Will share their response as soon as it arrives (typically 1–2 business days).' },
      { type: 'status', value: 'pending' },
      { type: 'tag',    value: 'escalated-google' },
    ] },
  { name: 'Mark resolved & close',
    actions: [
      { type: 'reply',  value: 'This issue has been resolved. Closing the ticket — please re-open within 24 hours if you face any further problems.' },
      { type: 'status', value: 'closed' },
      { type: 'tag',    value: 'resolved' },
    ] },
  { name: 'Investigating now',
    actions: [
      { type: 'reply',  value: 'Picked this up — investigating now. Will share an update within 30 minutes.' },
      { type: 'status', value: 'open' },
      { type: 'tag',    value: 'investigating' },
    ] },
  { name: 'Awaiting DNS propagation',
    actions: [
      { type: 'reply',  value: 'DNS changes have been made. Holding for propagation (up to 4 hours). I will verify and confirm once changes are live.' },
      { type: 'status', value: 'pending' },
      { type: 'tag',    value: 'dns-propagation' },
    ] },
];

async function seedProductMacros(adminId) {
  for (const m of MACRO_SEEDS) {
    await pool.query(
      'INSERT INTO ticket_macros (name, actions, created_by, is_global) VALUES (?, ?, ?, ?)',
      [m.name, JSON.stringify(m.actions), adminId, 1]
    );
  }
}

const TEMPLATE_SEEDS = [
  // ── Google Workspace ─────────────────────────────────────────────
  { name: 'GW — SPF/DKIM/DMARC setup walkthrough',
    subject_template: 'Email Authentication Setup — SPF, DKIM, DMARC',
    request_type: 'Email & Migration',
    default_priority: 'medium',
    description_template:
`Hi {{customer_name}},

Here is the complete setup for SPF, DKIM, and DMARC on your domain {{domain}}:

═══ 1. SPF Record (TXT) ═══
Host: @ (or your domain root)
Value: v=spf1 include:_spf.google.com ~all
TTL: 3600

═══ 2. DKIM Record (TXT) ═══
1. Sign in to admin.google.com
2. Apps → Google Workspace → Gmail → Authenticate email
3. Select your domain → GENERATE NEW RECORD (2048-bit)
4. Copy the TXT value provided
5. In your DNS, add a TXT record:
   Host: google._domainkey
   Value: (the long string Google gave you)
6. Wait 1 hour, then return to the admin console and click START AUTHENTICATION

═══ 3. DMARC Record (TXT) ═══
Host: _dmarc
Value: v=DMARC1; p=quarantine; rua=mailto:dmarc@{{domain}}
TTL: 3600

Allow up to 48 hours for full propagation. You can verify using https://mxtoolbox.com

Let me know once DNS is updated and I will confirm everything is green.

Best regards,
{{agent_name}}` },

  { name: 'GW — New user onboarding',
    subject_template: 'Adding a New User to Google Workspace',
    request_type: 'User Management',
    default_priority: 'normal',
    description_template:
`Hi {{customer_name}},

Here is the standard procedure for adding a new user to your Google Workspace ({{gw_edition}}):

1. Sign in to https://admin.google.com as super admin
2. Directory → Users → Add new user (top-right)
3. Fill in:
   • First name, Last name
   • Primary email address ([name]@{{domain}})
   • Optional recovery email
4. Choose "Create password" → use a strong temporary password
5. Tick "Ask for a password change at next sign-in" (recommended)
6. Click "Add new user"
7. Share the username + temporary password with the user

The new user can sign in immediately to https://gmail.com/a/{{domain}}

Note: A license is consumed only after the first sign-in. If you have run out of licenses, contact me before adding more users.

Best regards,
{{agent_name}}` },

  { name: 'GW — Domain verification troubleshooting',
    subject_template: 'Google Workspace Domain Verification',
    request_type: 'Domain & Setup',
    default_priority: 'high',
    description_template:
`Hi {{customer_name}},

If domain verification is failing for {{domain}}, here are the most common causes and fixes:

1. **TXT record not yet propagated** — verification records can take up to 48 hours. Check at https://mxtoolbox.com/SuperTool.aspx (run TXT lookup)

2. **Multiple SPF records** — having two SPF records causes Google to skip verification. Consolidate into one.

3. **Wrong record host** — the TXT record must be on the apex (@) not on www or subdomain.

4. **CNAME verification (alternative)** — if TXT does not work, Google supports CNAME verification under Domains → Manage domains.

5. **Cloudflare proxy interference** — if your DNS is behind Cloudflare proxy (orange cloud), set the verification record to "DNS only" (grey cloud).

Please confirm:
• Which method are you using (TXT / CNAME / Meta tag)?
• Where is the domain DNS hosted (registrar / Cloudflare / Route 53)?
• Have you placed the record at the correct host?

I will verify in real-time once you share these.

Best regards,
{{agent_name}}` },

  { name: 'GW — Emails going to spam diagnostic',
    subject_template: 'Investigating Spam Delivery for {{domain}}',
    request_type: 'Email & Migration',
    default_priority: 'high',
    description_template:
`Hi {{customer_name}},

To diagnose why emails from {{domain}} are landing in spam, I will need:

1. **A sample message header** from a recipient who got it in spam
   (Gmail: Open the message → 3-dot menu → Show original → Copy entire header)

2. **A test send** to a Gmail address from your end so I can inspect Google's reasoning

3. **Confirmation** of which records exist on your DNS:
   • SPF (TXT at @)
   • DKIM (TXT at google._domainkey)
   • DMARC (TXT at _dmarc)

Most spam issues trace to one of:
• Missing or misconfigured SPF/DKIM
• DMARC policy too strict (p=reject) before authentication is fully verified
• Sending volume spike triggering reputation drop
• Content matching spam signatures (links, images, all-caps subjects)

Once I have the header + records, I should be able to identify the cause within 30 minutes.

Best regards,
{{agent_name}}` },

  // ── Microsoft 365 ────────────────────────────────────────────────
  { name: 'M365 — Outlook reconfiguration steps',
    subject_template: 'Outlook Account Reconfiguration',
    request_type: 'Email & Migration',
    default_priority: 'normal',
    description_template:
`Hi {{customer_name}},

Please follow these steps to recreate your Outlook profile cleanly:

═══ Windows ═══
1. Close Outlook completely
2. Control Panel → Mail (Microsoft Outlook)
3. Show Profiles → Remove the existing profile
4. Add a new profile → enter your full email address
5. Outlook will auto-configure via Autodiscover
6. Open Outlook — let it download mail (size-dependent: 5min–2hrs)

═══ macOS ═══
1. Quit Outlook
2. Open Outlook → Tools → Accounts → remove the account
3. Re-add the account → email address → password
4. Allow the data sync to complete

If Autodiscover fails:
• Server: outlook.office365.com
• Encryption: SSL/TLS
• Username: full email address

Reach out if you see any specific error message — share a screenshot and I will walk through it.

Best regards,
{{agent_name}}` },

  // ── Zoho ─────────────────────────────────────────────────────────
  { name: 'Zoho Mail — Initial setup',
    subject_template: 'Zoho Mail Setup Walkthrough',
    request_type: 'Domain & Setup',
    default_priority: 'normal',
    description_template:
`Hi {{customer_name}},

Here is the complete Zoho Mail setup for {{domain}}:

═══ 1. Verify Domain ═══
Add this TXT record at your DNS:
Host: @
Value: zoho-verification=zb*****.zmverify.zoho.in
(Get your exact value from https://mailadmin.zoho.in → Domains)

═══ 2. MX Records ═══
Replace any existing MX records with:
• mx.zoho.in        — Priority 10
• mx2.zoho.in       — Priority 20
• mx3.zoho.in       — Priority 30

═══ 3. SPF + DKIM ═══
SPF (TXT @): v=spf1 include:zohomail.in ~all
DKIM: enable from mail admin → Domains → DKIM

═══ 4. Create Users & Test ═══
Add users in mailadmin → Users. Have one user send a test email both ways.

Propagation: 4–48 hours typically. Use https://mxtoolbox.com to verify.

Best regards,
{{agent_name}}` },

  // ── Hosting / Domain ─────────────────────────────────────────────
  { name: 'Hosting — DNS record update template',
    subject_template: 'DNS Record Update — {{domain}}',
    request_type: 'Domain & Setup',
    default_priority: 'normal',
    description_template:
`Hi {{customer_name}},

To update DNS records on {{domain}}, I will need to confirm a few details before making changes:

1. **Registrar** — where is the domain registered (GoDaddy / Hostinger / Namecheap / etc.)?
2. **DNS provider** — same as registrar, or are you using Cloudflare / Route 53?
3. **Current records** — share a screenshot of the existing record set (or run a quick lookup at https://mxtoolbox.com)
4. **Record type & change** — what exactly needs to change?
   • Type: A / AAAA / CNAME / MX / TXT / NS
   • Host: @ or subdomain
   • Value: new target
   • TTL: 3600 (1 hour) is fine for most records

After we agree on the change, I will:
• Walk you through it on your panel, OR
• Make the change myself if you provide temporary access

Propagation: typically 1–4 hours, max 24 hours.

Best regards,
{{agent_name}}` },
];

async function seedProductTemplates(adminId) {
  for (const t of TEMPLATE_SEEDS) {
    await pool.query(
      `INSERT INTO ticket_templates (name, subject_template, description_template, request_type, default_priority, is_active, created_by)
       VALUES (?, ?, ?, ?, ?, 1, ?)`,
      [t.name, t.subject_template, t.description_template, t.request_type, t.default_priority, adminId]
    );
  }
}

module.exports = { runMigrations };
