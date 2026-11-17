-- Stage Prospect: scheduled jobs (pg_cron + pg_net).
--
-- ===========================================================================
-- BEFORE THESE JOBS CAN RUN, CREATE TWO SECRETS IN SUPABASE VAULT
-- (Dashboard > Project Settings > Vault, or run in the SQL editor):
--
--   select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
--   select vault.create_secret('<same value as the CRON_SECRET edge function secret>', 'cron_secret');
--
--   1. project_url : your project URL, no trailing slash.
--   2. cron_secret : must equal the CRON_SECRET edge function secret
--                    (supabase secrets set CRON_SECRET=...).
--
-- The jobs read both values at run time, so they can be created or rotated
-- after this migration without rescheduling anything.
-- ===========================================================================

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

grant usage on schema cron to postgres;

-- Idempotent: drop any previous copies of our jobs.
select cron.unschedule(j.jobid)
from cron.job j
where j.jobname in ('weekly-roster', 'hubspot-sync', 'research-worker');

-- Weekly roster: Sunday 17:20 UTC = Sunday 22:50 IST, ahead of the Monday batch.
select cron.schedule(
  'weekly-roster',
  '20 17 * * 0',
  $cmd$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
           || '/functions/v1/weekly-roster',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := jsonb_build_object('source', 'cron'),
    timeout_milliseconds := 300000
  ) as request_id;
  $cmd$
);

-- HubSpot sync: daily 17:52 UTC = 23:22 IST.
select cron.schedule(
  'hubspot-sync',
  '52 17 * * *',
  $cmd$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
           || '/functions/v1/hubspot-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := jsonb_build_object('source', 'cron'),
    timeout_milliseconds := 300000
  ) as request_id;
  $cmd$
);

-- Research worker: every 2 minutes, drains research_queue a few rows at a time.
select cron.schedule(
  'research-worker',
  '*/2 * * * *',
  $cmd$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
           || '/functions/v1/research-worker',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := jsonb_build_object('source', 'cron'),
    timeout_milliseconds := 150000
  ) as request_id;
  $cmd$
);
