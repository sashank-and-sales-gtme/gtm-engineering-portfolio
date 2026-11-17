-- Caricature campaign: state store and event log for the n8n workflows.
-- Run once in the Supabase SQL editor. n8n connects with the service role key, which bypasses RLS.

create table if not exists campaign_config (
  id                               int primary key default 1 check (id = 1),
  campaign_timezone                text not null default 'America/Los_Angeles',
  website_base_url                 text not null default 'https://interactlabs.ai',
  contact_path                     text not null default '/contact',
  n8n_base_url                     text,
  slack_channel_id                 text,
  hubspot_owner_id                 text,
  instantly_campaign_delivered     text,
  instantly_campaign_not_delivered text,
  instantly_campaign_nurture_1     text,
  instantly_campaign_nurture_2     text,
  instantly_campaign_nurture_3     text,
  sender_name                      text not null default 'Sudhir',
  meet_location                    text not null default 'Blue Bottle',
  updated_at                       timestamptz not null default now()
);
insert into campaign_config (id) values (1) on conflict (id) do nothing;

create table if not exists prospects (
  id                  uuid primary key default gen_random_uuid(),
  token               text not null unique default substr(md5(random()::text || clock_timestamp()::text), 1, 12),
  email               text not null unique,
  first_name          text not null,
  last_name           text,
  title               text,
  company_name        text not null,
  company_slug        text not null,
  company_domain      text,
  hubspot_contact_id  text,
  carrier             text,
  tracking_number     text unique,
  ship24_tracker_id   text,
  lp_url              text,
  qr_png_url          text,
  track               text not null default 'shipped'
                      check (track in ('shipped', 'untracked', 'delivered_not_scanned', 'not_delivered', 'qr_scanned')),
  status              text not null default 'active'
                      check (status in ('active', 'replied', 'stopped')),
  day1_at             timestamptz,
  enroll_at           timestamptz,
  enrolled_at         timestamptz,
  instantly_lead_id   text,
  first_qr_at         timestamptz,
  last_call_day       int not null default 0,
  intent_score        int not null default 0,
  intent_tier         text check (intent_tier in ('Hot', 'Warm', 'Cold', 'Ice')),
  score_updated_at    timestamptz,
  sales_ready_at      timestamptz,
  campaign_count      int not null default 0,
  last_nurture_at     timestamptz,
  cooldown_until      timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists prospects_domain_idx on prospects (company_domain);

create table if not exists events (
  id           bigserial primary key,
  prospect_id  uuid not null references prospects (id) on delete cascade,
  event_type   text not null check (event_type in (
                 'shipped', 'delivered', 'not_delivered', 'delivery_update',
                 'qr_scan', 'page_view', 'demo_engaged', 'lp_contact_session', 'account_visit',
                 'enrolled', 'email_sent', 'email_opened', 'email_clicked', 'email_replied',
                 'email_bounced', 'unsubscribed', 'maya_interaction',
                 'call_task_created', 'sales_ready', 'nurture_drafted', 'nurture_approved', 'cooldown')),
  occurred_at  timestamptz not null default now(),
  session_id   text,
  path         text,
  source       text,
  event_key    text not null unique,
  payload      jsonb not null default '{}'::jsonb
);
create index if not exists events_prospect_time_idx on events (prospect_id, occurred_at desc);

create table if not exists nurture_drafts (
  id              uuid primary key default gen_random_uuid(),
  prospect_id     uuid not null references prospects (id) on delete cascade,
  campaign_number int not null check (campaign_number between 1 and 3),
  subject         text not null,
  body            text not null,
  rationale       text,
  status          text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  approval_token  text not null default md5(random()::text || clock_timestamp()::text),
  created_at      timestamptz not null default now(),
  decided_at      timestamptz
);
create unique index if not exists nurture_one_pending_idx on nurture_drafts (prospect_id) where status = 'pending';

create or replace function touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists prospects_touch on prospects;
create trigger prospects_touch before update on prospects for each row execute function touch_updated_at();

-- Scoring: 30-day window, signals summed and capped at 100.
-- Tiers use cume_dist over score descending: the share of the cohort scoring at or above this prospect.
-- Tied prospects share the lower bucket, so a cohort of zero scores lands in Ice, not Hot.
create or replace view v_prospect_scores as
with cohort as (
  select p.* from prospects p
  where p.status <> 'stopped' and (p.cooldown_until is null or p.cooldown_until <= now())
),
signals as (
  select c.id,
    bool_or(e.event_type in ('page_view', 'account_visit', 'qr_scan')) as visited,
    count(distinct case when e.event_type in ('page_view', 'account_visit', 'qr_scan')
                         and e.occurred_at >= now() - interval '14 days'
                        then coalesce(e.session_id, e.event_key) end) as visits_14d,
    bool_or(e.event_type = 'qr_scan') as qr_visit,
    bool_or(e.event_type = 'demo_engaged') as demo,
    bool_or(e.event_type = 'lp_contact_session') as lp_to_contact
  from cohort c
  left join events e on e.prospect_id = c.id and e.occurred_at >= now() - interval '30 days'
  group by c.id
),
scored as (
  select s.*,
    least(100,
        case when coalesce(visited, false) then 2 else 0 end
      + case when visits_14d >= 3 then 15 else 0 end
      + case when coalesce(qr_visit, false) then 35 else 0 end
      + case when coalesce(demo, false) then 40 else 0 end
      + case when coalesce(lp_to_contact, false) then 45 else 0 end) as score
  from signals s
),
ranked as (
  select sc.*, cume_dist() over (order by sc.score desc) as pct from scored sc
)
select r.id, p.email, p.first_name, p.last_name, p.company_name, p.hubspot_contact_id,
       p.intent_tier as previous_tier, p.sales_ready_at,
       r.score, round(r.pct::numeric, 4) as pct,
       case when r.pct <= 0.25 then 'Hot' when r.pct <= 0.45 then 'Warm'
            when r.pct <= 0.60 then 'Cold' else 'Ice' end as tier,
       r.visited, r.visits_14d, r.qr_visit, r.demo, r.lp_to_contact
from ranked r join prospects p on p.id = r.id;

-- Prospects whose Instantly enrollment is due.
create or replace view v_due_enrollments as
select p.id, p.email, p.first_name, p.last_name, p.company_name, p.hubspot_contact_id, p.track, p.lp_url,
       case p.track when 'delivered_not_scanned' then cfg.instantly_campaign_delivered
                    else cfg.instantly_campaign_not_delivered end as campaign_id,
       to_char(m.meet_date, 'FMDay, FMMon FMDD') as meet_day
from prospects p
cross join campaign_config cfg
cross join lateral (
  select d + case extract(isodow from d) when 6 then 2 when 7 then 1 else 0 end as meet_date
  from (select ((p.day1_at at time zone cfg.campaign_timezone)::date + 8) as d) x
) m
where p.status = 'active'
  and p.track in ('delivered_not_scanned', 'not_delivered')
  and p.enroll_at <= now()
  and p.enrolled_at is null
  and (p.cooldown_until is null or p.cooldown_until <= now());

-- Call tasks due today. Day 1 is the delivery (or rejection) date in the campaign timezone.
-- Only the latest due call is returned, so a missed run never floods reps with stale tasks.
create or replace view v_due_calls as
with d as (
  select p.*, cfg.campaign_timezone,
         ((now() at time zone cfg.campaign_timezone)::date - (p.day1_at at time zone cfg.campaign_timezone)::date) + 1 as day_n
  from prospects p cross join campaign_config cfg
  where p.status = 'active'
    and p.track in ('delivered_not_scanned', 'not_delivered')
    and p.day1_at is not null
    and p.sales_ready_at is null
    and (p.cooldown_until is null or p.cooldown_until <= now())
)
select d.id, d.email, d.first_name, d.last_name, d.company_name, d.hubspot_contact_id, d.track, d.day_n,
       c.call_day, case c.call_day when 2 then 1 when 5 then 2 when 10 then 3 when 13 then 4 end as call_number
from d
cross join lateral (
  select max(x) as call_day from unnest(array[2, 5, 10, 13]) x
  where x <= d.day_n and x > d.last_call_day
) c
where c.call_day is not null;

-- Prospects ready for a personalised nurture email (flowchart "Personalised Email Campaign (Manual)").
create or replace view v_nurture_candidates as
with cfg as (select * from campaign_config where id = 1),
base as (
  select p.*,
         ((now() at time zone cfg.campaign_timezone)::date - (p.day1_at at time zone cfg.campaign_timezone)::date) + 1 as day_n,
         cfg.instantly_campaign_nurture_1, cfg.instantly_campaign_nurture_2, cfg.instantly_campaign_nurture_3
  from prospects p cross join cfg
  where p.status = 'active'
    and p.sales_ready_at is null
    and p.intent_tier in ('Cold', 'Ice')
    and p.campaign_count < 3
    and (p.cooldown_until is null or p.cooldown_until <= now())
    and (p.last_nurture_at is null or p.last_nurture_at < now() - interval '14 days')
    and not exists (select 1 from nurture_drafts nd where nd.prospect_id = p.id and nd.status = 'pending')
)
select b.id, b.email, b.first_name, b.last_name, b.title, b.company_name, b.hubspot_contact_id, b.track,
       b.intent_score, b.intent_tier, b.campaign_count + 1 as campaign_number,
       case b.campaign_count when 0 then b.instantly_campaign_nurture_1
                             when 1 then b.instantly_campaign_nurture_2
                             else b.instantly_campaign_nurture_3 end as campaign_id,
       coalesce((select jsonb_agg(jsonb_build_object('type', e.event_type, 'at', e.occurred_at, 'path', e.path)
                                  order by e.occurred_at desc)
                 from (select * from events e2 where e2.prospect_id = b.id
                         and e2.occurred_at >= now() - interval '30 days' order by e2.occurred_at desc limit 40) e),
                '[]'::jsonb) as recent_events
from base b
where (b.track in ('delivered_not_scanned', 'not_delivered') and b.day_n >= 14)
   or (b.track = 'qr_scanned' and b.first_qr_at < now() - interval '7 days');

-- Prospects that stayed Cold/Ice through three nurture campaigns: 90-day cooldown.
create or replace view v_cooldown_due as
select p.id, p.email, p.hubspot_contact_id, p.intent_tier, p.campaign_count
from prospects p
where p.status = 'active'
  and p.campaign_count >= 3
  and p.intent_tier in ('Cold', 'Ice')
  and p.last_nurture_at < now() - interval '14 days'
  and (p.cooldown_until is null or p.cooldown_until <= now());

alter table campaign_config enable row level security;
alter table prospects enable row level security;
alter table events enable row level security;
alter table nurture_drafts enable row level security;
