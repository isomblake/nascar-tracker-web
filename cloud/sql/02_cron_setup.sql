-- Sets up pg_cron to trigger poll-nascar every minute.
-- Run this in Supabase SQL Editor AFTER deploying the edge functions.
--
-- IMPORTANT: Replace the two placeholder values below before running:
--   YOUR_PROJECT_REF  — from your Supabase URL (e.g. "ofqqgbgxoywnqoukvwth")
--   YOUR_SERVICE_ROLE_KEY — your Secret (service_role) key

-- Enable required extensions (usually already on in Supabase)
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Remove any existing job with this name (idempotent)
SELECT cron.unschedule('poll-nascar-every-minute')
WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'poll-nascar-every-minute'
);

-- Schedule the job. pg_net.http_post is async so cron returns fast.
SELECT cron.schedule(
  'poll-nascar-every-minute',
  '* * * * *',  -- every minute
  $$
  SELECT net.http_post(
    url := 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/poll-nascar',
    headers := jsonb_build_object(
      'Authorization', 'Bearer YOUR_SERVICE_ROLE_KEY',
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object('triggered_by', 'cron'),
    timeout_milliseconds := 60000
  );
  $$
);

-- Verify it's scheduled
SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'poll-nascar-every-minute';
