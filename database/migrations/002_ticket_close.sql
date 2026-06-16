-- DSP Migration 002 — ticket close_at timestamp
-- Run: mysql -u root dsp < migrations/002_ticket_close.sql

USE dsp;

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS closed_at TIMESTAMP DEFAULT NULL;
