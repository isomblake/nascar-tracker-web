-- Add practice_group column to drivers table. Safe to run multiple times.
-- Run this in the Supabase SQL Editor if practice Group 1/Group 2 filtering is broken.
--
-- practice_group is populated from NASCAR live-feed.json vehicles[].practice_group
-- during practice sessions (run_type 1 or 2). Value is 1 or 2 (integer), or null for races.

ALTER TABLE drivers ADD COLUMN IF NOT EXISTS practice_group integer;
