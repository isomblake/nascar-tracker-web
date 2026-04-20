-- Patch to support cloud polling. Safe to run multiple times.
-- Adds columns the edge functions need for coordination.

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS poll_url text;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS series integer DEFAULT 1;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS started_by text DEFAULT 'cloud';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_error text;

-- Index so poll-nascar can find the active session fast
CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions(is_active) WHERE is_active = true;

-- Helper: only one session can be active at a time (enforce on app side too)
-- We don't hard-constrain this so detect-session can flip old->inactive and insert new in one tx
