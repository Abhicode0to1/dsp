-- DSP Feature Migration 001
-- Run: mysql -u root dsp < migrations/001_features.sql

USE dsp;

-- ── File Attachments ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS file_attachments (
  id INT PRIMARY KEY AUTO_INCREMENT,
  ref_type ENUM('ticket', 'ticket_message', 'chat_message') NOT NULL,
  ref_id INT NOT NULL,
  original_name VARCHAR(255) NOT NULL,
  stored_name VARCHAR(255) NOT NULL,
  mime_type VARCHAR(100),
  size_bytes INT,
  uploaded_by INT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (uploaded_by) REFERENCES users(id)
);

-- ── CSAT Ratings ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ratings (
  id INT PRIMARY KEY AUTO_INCREMENT,
  ref_type ENUM('ticket', 'call') NOT NULL,
  ref_id INT NOT NULL,
  customer_id INT NOT NULL,
  agent_id INT DEFAULT NULL,
  score TINYINT NOT NULL CHECK (score BETWEEN 1 AND 5),
  comment TEXT DEFAULT NULL,
  gmb_clicked BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_rating (ref_type, ref_id),
  FOREIGN KEY (customer_id) REFERENCES customers(id),
  FOREIGN KEY (agent_id) REFERENCES users(id)
);

-- ── Canned Responses ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS canned_responses (
  id INT PRIMARY KEY AUTO_INCREMENT,
  created_by INT NOT NULL,
  title VARCHAR(255) NOT NULL,
  body TEXT NOT NULL,
  is_global BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
);

-- ── Audit Log ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  id INT PRIMARY KEY AUTO_INCREMENT,
  actor_id INT NOT NULL,
  actor_name VARCHAR(255) NOT NULL,
  actor_role ENUM('customer', 'agent', 'admin') NOT NULL,
  action VARCHAR(100) NOT NULL,
  entity_type VARCHAR(50) NOT NULL,
  entity_id INT DEFAULT NULL,
  old_value TEXT DEFAULT NULL,
  new_value TEXT DEFAULT NULL,
  ip_address VARCHAR(45) DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (actor_id) REFERENCES users(id)
);

-- ── Customer Notes ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS customer_notes (
  id INT PRIMARY KEY AUTO_INCREMENT,
  customer_id INT NOT NULL,
  author_id INT NOT NULL,
  note TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
  FOREIGN KEY (author_id) REFERENCES users(id)
);

-- ── SLA Configuration ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sla_configs (
  id INT PRIMARY KEY AUTO_INCREMENT,
  priority ENUM('low', 'normal', 'medium', 'high') NOT NULL UNIQUE,
  response_hours INT NOT NULL DEFAULT 24,
  resolve_hours INT NOT NULL DEFAULT 72,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Default SLA rules
INSERT IGNORE INTO sla_configs (priority, response_hours, resolve_hours) VALUES
  ('low',    48, 120),
  ('normal', 24,  72),
  ('medium', 12,  48),
  ('high',    4,  24);

-- ── SLA tracking columns on tickets ──────────────────────────────────────────
ALTER TABLE tickets ADD COLUMN sla_response_due TIMESTAMP DEFAULT NULL;
ALTER TABLE tickets ADD COLUMN sla_resolve_due  TIMESTAMP DEFAULT NULL;
ALTER TABLE tickets ADD COLUMN sla_breached     BOOLEAN DEFAULT FALSE;
ALTER TABLE tickets ADD COLUMN first_response_at TIMESTAMP DEFAULT NULL;

-- ── 2FA OTP codes ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS otp_codes (
  id INT PRIMARY KEY AUTO_INCREMENT,
  user_id INT NOT NULL,
  code VARCHAR(6) NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  used BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ── GMB link in settings (stored as admin setting) ───────────────────────────
CREATE TABLE IF NOT EXISTS app_settings (
  id INT PRIMARY KEY AUTO_INCREMENT,
  setting_key VARCHAR(100) UNIQUE NOT NULL,
  setting_value TEXT DEFAULT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

INSERT IGNORE INTO app_settings (setting_key, setting_value) VALUES
  ('gmb_review_url', NULL),
  ('csat_prompt_threshold', '4'),
  ('sla_notifications_enabled', 'true');
