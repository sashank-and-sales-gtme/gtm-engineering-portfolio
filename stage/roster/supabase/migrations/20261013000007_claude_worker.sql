-- Stage Prospect: Claude worker, per-rep segments, account ownership, CRM guard.
--
-- The app no longer calls the Anthropic API. Research and prep briefs are queued in research_queue and
-- done by a Claude Code worker (a scheduled routine or a local session on a Claude subscription) that
-- talks to the `claude-work` edge function. Supabase keeps the queue, validates every result and
-- writes the leads.

-- ===========================================================================
-- Settings
-- ===========================================================================
insert into public.app_settings (key, value) values
  ('roster', '{
     "contacts_per_account": 2,
     "overprovision": 1.5,
     "max_accounts_per_run": 15,
     "crm_recent_days": 90,
     "archive_after_days": 35,
     "exclude_cache_days": 120,
     "company_cache_days": 90
   }'::jsonb),
  ('claude_worker', '{"last_seen": null}'::jsonb)
on conflict (key) do nothing;

-- ===========================================================================
-- rep_settings: who is in the weekly rotation, their quota and their segment
-- ===========================================================================
create table if not exists public.rep_settings (
  user_id         uuid primary key references public.profiles(id) on delete cascade,
  in_rotation     boolean not null default false,
  weekly_accounts int     not null default 100 check (weekly_accounts between 0 and 500),
  employees_min   int     check (employees_min is null or employees_min >= 1),
  employees_max   int     check (employees_max is null or employees_max >= 1),
  revenue_min     bigint  check (revenue_min is null or revenue_min >= 0),   -- USD
  revenue_max     bigint  check (revenue_max is null or revenue_max >= 0),   -- USD
  funding_min     bigint  check (funding_min is null or funding_min >= 0),   -- USD, total funding
  funding_max     bigint  check (funding_max is null or funding_max >= 0),   -- USD, total funding
  updated_at      timestamptz default now(),
  updated_by      uuid default auth.uid(),
  constraint rep_settings_emp_order check (employees_min is null or employees_max is null or employees_min <= employees_max),
  constraint rep_settings_rev_order check (revenue_min is null or revenue_max is null or revenue_min <= revenue_max),
  constraint rep_settings_fund_order check (funding_min is null or funding_max is null or funding_min <= funding_max)
);

alter table public.rep_settings enable row level security;

drop policy if exists rep_settings_select on public.rep_settings;
create policy rep_settings_select on public.rep_settings
  for select to authenticated
  using (public.is_active_member());

drop policy if exists rep_settings_write on public.rep_settings;
create policy rep_settings_write on public.rep_settings
  for all to authenticated
  using (public.is_active_member() and public.has_perm('manage_users'))
  with check (public.is_active_member() and public.has_perm('manage_users'));

drop trigger if exists rep_settings_touch on public.rep_settings;
create trigger rep_settings_touch
  before update on public.rep_settings
  for each row execute function public.touch_updated_at();

-- ===========================================================================
-- account_claims: one rep per account (company domain)
--   reserved  = picked for a rep's batch, research not done yet
--   active    = researched and on the rep's roster
--   excluded  = failed the ICP or the CRM check; skipped until expires_at
--   released  = free again (archived or given up)
-- ===========================================================================
create table if not exists public.account_claims (
  domain      text primary key,
  company     text,
  rep_id      uuid references public.profiles(id) on delete set null,
  batch       text,
  status      text not null default 'reserved' check (status in ('reserved','active','excluded','released')),
  reason      text,
  claimed_at  timestamptz default now(),
  expires_at  timestamptz,
  updated_at  timestamptz default now()
);
create index if not exists account_claims_rep_idx on public.account_claims(rep_id, status);

alter table public.account_claims enable row level security;
revoke insert, update, delete, truncate on public.account_claims from anon, authenticated;
grant select on public.account_claims to authenticated;

drop policy if exists account_claims_select on public.account_claims;
create policy account_claims_select on public.account_claims
  for select to authenticated
  using (public.is_active_member() and (rep_id = auth.uid() or public.has_perm('view_all_accounts')));

drop trigger if exists account_claims_touch on public.account_claims;
create trigger account_claims_touch
  before update on public.account_claims
  for each row execute function public.touch_updated_at();

-- ===========================================================================
-- company_research: company-level research reused across contacts and weeks (service role only)
-- ===========================================================================
create table if not exists public.company_research (
  domain         text primary key,
  company        text,
  data           jsonb not null,
  excluded       boolean not null default false,
  researched_at  timestamptz not null default now()
);
alter table public.company_research enable row level security;
revoke all on public.company_research from anon, authenticated;

-- ===========================================================================
-- research_queue: account-level work items for the Claude worker
--   gating  = waiting for the CRM check (and Apollo enrichment for add-company "now")
--   held    = passed the CRM check, kept in reserve until the rep's quota needs it
--   pending = ready for Claude
--   running = claimed by a worker (lease_until)
--   done / failed / skipped
-- ===========================================================================
alter table public.research_queue drop constraint if exists research_queue_kind_check;
alter table public.research_queue drop constraint if exists research_queue_status_check;

-- Rows from the old per-person worker are not compatible with the new format.
update public.add_requests a
   set status = 'failed', note = 'Research moved to the Claude worker. Add this company again.'
 where a.status = 'enriching'
   and exists (select 1 from public.research_queue r
                where r.status in ('pending', 'running') and r.payload ->> 'request_id' = a.id::text);
update public.research_queue
   set status = 'failed', error = 'superseded by the Claude worker queue'
 where status in ('pending', 'running');

alter table public.research_queue
  add constraint research_queue_kind_check check (kind in ('weekly', 'account', 'add_request', 'prep_brief'));
alter table public.research_queue
  add constraint research_queue_status_check
  check (status in ('gating', 'held', 'pending', 'running', 'done', 'failed', 'skipped'));

alter table public.research_queue add column if not exists rep_id        uuid references public.profiles(id) on delete set null;
alter table public.research_queue add column if not exists priority      int not null default 5;
alter table public.research_queue add column if not exists lease_until   timestamptz;
alter table public.research_queue add column if not exists worker        text;
alter table public.research_queue add column if not exists result        jsonb;
alter table public.research_queue add column if not exists gate_attempts int not null default 0;
alter table public.research_queue add column if not exists next_gate_at  timestamptz;
alter table public.research_queue add column if not exists submits       int not null default 0;
alter table public.research_queue add column if not exists domain        text;

create index if not exists research_queue_claim_idx on public.research_queue(status, priority, created_at);
create index if not exists research_queue_rep_batch_idx on public.research_queue(rep_id, batch, status);
create index if not exists research_queue_domain_idx on public.research_queue(domain);

-- ===========================================================================
-- leads: archive flag, CRM guard cache, lookup indexes for dedupe
-- ===========================================================================
alter table public.leads add column if not exists archived     boolean not null default false;
alter table public.leads add column if not exists archived_at  timestamptz;
alter table public.leads add column if not exists guard        jsonb;
alter table public.leads add column if not exists account_key  text;   -- the account_claims key this lead came through
alter table public.leads add column if not exists person_check jsonb;  -- in role, India, function, seniority, scope, verdict
create index if not exists leads_active_idx on public.leads(archived, batch);
create index if not exists leads_account_key_idx on public.leads(account_key);
create index if not exists leads_linkedin_idx on public.leads(lower(linkedin));
create index if not exists leads_email_idx on public.leads(lower(enrichment ->> 'email'));

-- meetings: prep briefs are queued for the worker
alter table public.meetings add column if not exists prep_status text;
alter table public.meetings add column if not exists prep_requested_at timestamptz;

-- journeys: CRM activity mirrored from HubSpot (kind 'hubspot'); one row per HubSpot engagement
alter table public.journeys add column if not exists hs_engagement_id text;
create unique index if not exists journeys_hs_engagement_key
  on public.journeys(hs_engagement_id) where hs_engagement_id is not null;

-- ===========================================================================
-- RPC: claim_claude_work (service role). Reclaims expired leases first.
-- ===========================================================================
create or replace function public.claim_claude_work(p_n int, p_worker text, p_kinds text[])
returns setof public.research_queue
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null then
    raise exception 'claim_claude_work is service role only' using errcode = '42501';
  end if;

  -- Expired leases with attempts left go back to the queue. Rows out of attempts are closed by queue-gate,
  -- which also releases the account claim and closes add-company requests and prep briefs.
  update public.research_queue
     set status = 'pending', lease_until = null, worker = null
   where status = 'running' and lease_until < now() and attempts < 3;

  return query
  update public.research_queue q
     set status = 'running',
         attempts = q.attempts + 1,
         lease_until = now() + interval '40 minutes',
         worker = left(coalesce(p_worker, 'claude'), 80),
         submits = 0
   where q.id in (
     select r.id
       from public.research_queue r
      where r.status = 'pending'
        and (p_kinds is null or r.kind = any(p_kinds))
      order by r.priority, r.created_at
      limit greatest(least(coalesce(p_n, 5), 25), 0)
      for update skip locked
   )
  returning q.*;
end;
$$;

revoke execute on function public.claim_claude_work(int, text, text[]) from public, anon, authenticated;
grant  execute on function public.claim_claude_work(int, text, text[]) to service_role;

-- ===========================================================================
-- RPC: claim_gate_rows (service role). Leases gating rows for 3 minutes so overlapping queue-gate runs
-- never check (or pay to enrich) the same account twice.
-- ===========================================================================
create or replace function public.claim_gate_rows(p_n int)
returns setof public.research_queue
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null then
    raise exception 'claim_gate_rows is service role only' using errcode = '42501';
  end if;
  return query
  update public.research_queue q
     set next_gate_at = now() + interval '3 minutes'
   where q.id in (
     select r.id
       from public.research_queue r
      where r.status = 'gating'
        and (r.next_gate_at is null or r.next_gate_at <= now())
      order by r.priority, r.created_at
      limit greatest(least(coalesce(p_n, 30), 100), 0)
      for update skip locked
   )
  returning q.*;
end;
$$;

revoke execute on function public.claim_gate_rows(int) from public, anon, authenticated;
grant  execute on function public.claim_gate_rows(int) to service_role;

-- The old per-person claim RPC is no longer used.
drop function if exists public.claim_research_rows(int);

-- ===========================================================================
-- RPC: roster_progress — qualified accounts per rep for a batch (Admin > Reps)
-- ===========================================================================
create or replace function public.roster_progress(p_batch text)
returns table (rep_id uuid, qualified bigint, in_research bigint, in_reserve bigint, excluded bigint)
language sql
stable
security definer
set search_path = public
as $$
  with q as (
    select r.rep_id, r.status, r.result
      from public.research_queue r
     where r.batch = p_batch and r.kind in ('account', 'add_request') and r.rep_id is not null
  )
  select rep_id,
         count(*) filter (where status = 'done' and coalesce((result ->> 'leads')::int, 0) > 0),
         count(*) filter (where status in ('gating', 'pending', 'running')),
         count(*) filter (where status = 'held'),
         count(*) filter (where status in ('skipped') or (status = 'done' and coalesce((result ->> 'leads')::int, 0) = 0))
    from q
   where public.is_active_member() and public.has_perm('manage_users')
   group by rep_id
$$;

revoke execute on function public.roster_progress(text) from public, anon;
grant  execute on function public.roster_progress(text) to authenticated, service_role;

-- ===========================================================================
-- RPC: archive_stale_leads (service role). Leads from batches older than p_days that never progressed
-- are archived (kept for dedupe, hidden from the app) and their account claims are released.
-- ===========================================================================
create or replace function public.archive_stale_leads(p_days int)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cutoff text := to_char((now() at time zone 'Asia/Kolkata')::date - greatest(coalesce(p_days, 35), 14), 'YYYY-MM-DD');
  v_count  int;
begin
  if auth.uid() is not null then
    raise exception 'archive_stale_leads is service role only' using errcode = '42501';
  end if;
  update public.leads l
     set archived = true, archived_at = now()
   where l.archived = false
     and l.batch < v_cutoff
     and coalesce(l.stage, '') = ''
     and coalesce(l.last_outcome, 'no') = 'no'
     and not exists (select 1 from public.meetings m where m.lead_id = l.id and m.status <> 'canceled')
     and not exists (select 1 from public.callbacks c where c.lead_id = l.id and c.status = 'open');
  get diagnostics v_count = row_count;

  update public.account_claims a
     set status = 'released', reason = 'archived after ' || p_days || ' days without progress'
   where a.status = 'active'
     and not exists (
       select 1 from public.leads l
        where l.archived = false
          and (l.account_key = a.domain
               or (l.account_key is null and (lower(l.domain) = a.domain or lower(l.company) = lower(a.company))))
     );
  return v_count;
end;
$$;

revoke execute on function public.archive_stale_leads(int) from public, anon, authenticated;
grant  execute on function public.archive_stale_leads(int) to service_role;

create index if not exists account_claims_company_idx on public.account_claims(lower(company));

-- ===========================================================================
-- Realtime
-- ===========================================================================
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'rep_settings') then
    alter publication supabase_realtime add table public.rep_settings;
  end if;
end $$;

-- ===========================================================================
-- Cron: the queue gate replaces the old research worker. The weekly build moves to Friday evening
-- so the Claude worker has the weekend to research next Monday's batch inside subscription limits.
-- ===========================================================================
select cron.unschedule(j.jobid) from cron.job j where j.jobname in ('research-worker', 'queue-gate', 'weekly-roster');

-- Weekly roster: Friday 14:30 UTC = Friday 20:00 IST.
select cron.schedule(
  'weekly-roster',
  '30 14 * * 5',
  $cmd$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/weekly-roster',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := jsonb_build_object('source', 'cron'),
    timeout_milliseconds := 150000
  ) as request_id;
  $cmd$
);

-- Queue gate: every 5 minutes. CRM checks, enrichment, quota release, lease recovery.
select cron.schedule(
  'queue-gate',
  '*/5 * * * *',
  $cmd$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/queue-gate',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := jsonb_build_object('source', 'cron'),
    timeout_milliseconds := 150000
  ) as request_id;
  $cmd$
);
