-- HubSpot email activity on the roster. email_activity keeps the latest sales-email open, click and reply HubSpot
-- tracked for the contact ({opened, clicked, replied, checked_at}); opens and replies also land in the journey.
-- The activity mirror runs hourly (last two days) on top of the nightly full sync, so opens show up within the hour.
alter table public.leads add column if not exists email_activity jsonb;

select cron.unschedule('hubspot-activity') where exists (select 1 from cron.job where jobname = 'hubspot-activity');
select cron.schedule(
  'hubspot-activity',
  '17 * * * *',
  $cmd$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
           || '/functions/v1/hubspot-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := jsonb_build_object('source', 'cron', 'part', 'activity', 'days', 2),
    timeout_milliseconds := 300000
  ) as request_id;
  $cmd$
);
