-- DSP Migration 003 — atomic uniqueness for open chats
-- Run: mysql -u root dsp < migrations/003_chat_uniqueness.sql
--
-- WHAT THIS FIXES
--   Two concurrent POST /api/chat/initiate requests from the same customer
--   could both pass the controller's "already-have-an-open-chat" check
--   between read and INSERT — leaving the customer with TWO simultaneous
--   waiting/active chats. Edge-case test #3 (USAGE COUNTER RACES) caught
--   this reliably: parallel requests against a customer 1-shy of the cap
--   produced 2 chats and ringed two agents.
--
-- WHY NOT A FILTERED UNIQUE INDEX
--   PostgreSQL syntax (`CREATE UNIQUE INDEX … WHERE …`) does NOT work in
--   MySQL — MySQL has no partial / filtered indexes. The workaround below
--   uses a generated column that's NULL for closed chats (MySQL allows
--   multiple NULLs in a unique index, so "open" rows are constrained but
--   closed history is free to accumulate any number of rows per customer).
--
-- BEHAVIOUR
--   After this migration, a second concurrent INSERT for the same customer
--   with status='waiting' fails atomically with ER_DUP_ENTRY (errno 1062).
--   The controller catches that and re-reads the winning chat instead.

USE dsp;

-- 1. Best-effort pre-clean. If any customer currently has two+ open chats,
--    keep the newest (max id) and close the rest, so the unique key add
--    below doesn't fail. The Aug 2026 edge-case audit found 0 such rows,
--    but this guard keeps the migration safe to re-run on dirty data.
UPDATE chats c
JOIN (
  SELECT customer_id, MAX(id) AS keep_id
  FROM chats
  WHERE status IN ('waiting','active')
  GROUP BY customer_id
) keep ON keep.customer_id = c.customer_id
SET c.status = 'closed', c.closed_at = NOW()
WHERE c.status IN ('waiting','active') AND c.id <> keep.keep_id;

-- 2. Generated column — customer_id when the chat is open, NULL otherwise.
--    STORED rather than VIRTUAL so the unique-index lookup hits indexed
--    bytes and not an on-the-fly expression eval per row.
ALTER TABLE chats
  ADD COLUMN active_customer_marker INT
  GENERATED ALWAYS AS (
    CASE WHEN status IN ('waiting','active') THEN customer_id END
  ) STORED;

-- 3. Unique key on the marker. Multiple NULLs are allowed by MySQL unique
--    indexes, so closed chats (marker = NULL) don't collide; one open chat
--    per customer ⇔ at most one non-NULL marker per customer_id.
ALTER TABLE chats
  ADD UNIQUE KEY uq_chat_one_active_per_customer (active_customer_marker);
