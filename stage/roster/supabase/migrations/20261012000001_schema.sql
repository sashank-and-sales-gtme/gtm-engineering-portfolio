-- Stage Prospect: core schema
-- Tables, indexes, realtime publication. RLS policies live in 20261012000002_rbac.sql.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- roles
-- ---------------------------------------------------------------------------
create table if not exists public.roles (
  id          text primary key,
  name        text not null,
  perms       text[] not null default '{}',
  system      boolean default false,
  created_at  timestamptz default now()
);

-- ---------------------------------------------------------------------------
-- profiles (one per auth user, created by trigger on auth.users)
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id                uuid primary key references auth.users(id) on delete cascade,
  email             text not null unique,
  full_name         text,
  avatar_url        text,
  role              text references public.roles(id),
  status            text not null default 'pending' check (status in ('pending','active','suspended')),
  is_owner          boolean default false,
  hubspot_owner_id  text,
  added_by          uuid,
  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);
create index if not exists profiles_role_idx on public.profiles(role);
create index if not exists profiles_status_idx on public.profiles(status);

-- ---------------------------------------------------------------------------
-- invites: pre-assign a role by email, consumed on first sign-in
-- ---------------------------------------------------------------------------
create table if not exists public.invites (
  email       text primary key,
  role        text references public.roles(id),
  created_by  uuid default auth.uid(),
  created_at  timestamptz default now()
);

-- ---------------------------------------------------------------------------
-- app_settings
-- ---------------------------------------------------------------------------
create table if not exists public.app_settings (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz default now()
);

-- ---------------------------------------------------------------------------
-- leads
-- ---------------------------------------------------------------------------
create table if not exists public.leads (
  id                  text primary key,
  name                text,
  title               text,
  company             text,
  domain              text,
  segment             text,
  employees           text,
  hq                  text,
  person_location     text,
  linkedin            text,
  tier                text,
  fit_reason          text,
  status_check        text,
  status_evidence     text,
  persona             text,
  adjacency           text,
  pain_points         jsonb default '[]',
  competitive         text,
  angle               text,
  proof_point         text,
  batch               text,
  title_scope         text,
  source              text default 'weekly',
  approved            boolean default false,
  approved_at         timestamptz,
  assigned_to         uuid references public.profiles(id),
  assigned_at         timestamptz,
  assigned_by         uuid,
  stage               text,
  last_outcome        text,
  last_call_at        timestamptz,
  hubspot_contact_id  text,
  hubspot_deal_id     text,
  enrichment          jsonb,
  created_at          timestamptz default now()
);
create index if not exists leads_company_lower_idx on public.leads(lower(company));
create index if not exists leads_assigned_to_idx on public.leads(assigned_to);
create index if not exists leads_batch_idx on public.leads(batch);
create index if not exists leads_domain_idx on public.leads(lower(domain));

-- ---------------------------------------------------------------------------
-- calls
-- ---------------------------------------------------------------------------
create table if not exists public.calls (
  id                  uuid primary key default gen_random_uuid(),
  lead_id             text references public.leads(id) on delete cascade,
  company             text,
  contact             text,
  title               text,
  segment             text,
  title_scope         text,
  outcome             text check (outcome in ('yes','no','callback')),
  at                  timestamptz default now(),
  from_kind           text,
  closed_callback_id  uuid,
  new_callback_id     uuid,
  meeting_id          text,
  prev_lead           jsonb,
  owner               uuid not null default auth.uid()
);
create index if not exists calls_lead_idx on public.calls(lead_id);
create index if not exists calls_owner_at_idx on public.calls(owner, at desc);
create index if not exists calls_at_idx on public.calls(at desc);

-- ---------------------------------------------------------------------------
-- callbacks
-- ---------------------------------------------------------------------------
create table if not exists public.callbacks (
  id            uuid primary key default gen_random_uuid(),
  lead_id       text references public.leads(id) on delete cascade,
  company       text,
  contact       text,
  title         text,
  segment       text,
  title_scope   text,
  "when"        timestamptz not null,
  agenda        text,
  status        text default 'open',
  cal_status    text,
  cal_event_id  text,
  cal_error     text,
  outcome       text,
  done_at       timestamptz,
  call_id       uuid,
  owner         uuid not null default auth.uid(),
  created_at    timestamptz default now()
);
create index if not exists callbacks_lead_idx on public.callbacks(lead_id);
create index if not exists callbacks_owner_status_idx on public.callbacks(owner, status, "when");

-- ---------------------------------------------------------------------------
-- meetings
-- ---------------------------------------------------------------------------
create table if not exists public.meetings (
  id               text primary key default gen_random_uuid()::text,
  lead_id          text references public.leads(id) on delete set null,
  company          text,
  contact          text,
  title            text,
  segment          text,
  title_scope      text,
  "when"           timestamptz,
  mode             text default 'online',
  location         text,
  meet_link        text,
  link_status      text,
  status           text default 'scheduled' check (status in ('scheduled','rescheduling','done','canceled')),
  reschedules      int default 0,
  no_shows         int default 0,
  prep             text,
  prep_at          timestamptz,
  history          jsonb default '[]',
  created_at       timestamptz default now(),
  done_at          timestamptz,
  page_updated_at  timestamptz,
  hs_deal_id       text,
  hs_contact_id    text,
  hs_meeting_ids   text[],
  hs_modified_at   timestamptz,
  hs_synced_at     timestamptz,
  hs_notes         text,
  source           text default 'roster',
  owner            uuid default auth.uid(),
  call_id          uuid,
  cal_event_id     text,
  cal_title        text,
  cal_link         text
);
create index if not exists meetings_lead_idx on public.meetings(lead_id);
create index if not exists meetings_owner_idx on public.meetings(owner);
create index if not exists meetings_when_idx on public.meetings("when");
create index if not exists meetings_status_idx on public.meetings(status);

-- ---------------------------------------------------------------------------
-- tasks
-- ---------------------------------------------------------------------------
create table if not exists public.tasks (
  id            uuid primary key default gen_random_uuid(),
  owner         uuid not null default auth.uid(),
  title         text not null,
  "when"        timestamptz not null,
  duration      int default 15,
  notes         text,
  done          boolean default false,
  done_at       timestamptz,
  cal_status    text,
  cal_event_id  text,
  cal_error     text,
  created_at    timestamptz default now()
);
create index if not exists tasks_owner_when_idx on public.tasks(owner, "when");

-- ---------------------------------------------------------------------------
-- journeys (deal journey / connected-call context)
-- ---------------------------------------------------------------------------
create table if not exists public.journeys (
  id            uuid primary key default gen_random_uuid(),
  lead_id       text references public.leads(id) on delete cascade,
  company       text,
  contact       text,
  text          text not null,
  at            timestamptz default now(),
  kind          text default 'context',
  stage         text,
  hs_status     text,
  hs_target     text,
  hs_target_id  text,
  hs_note_id    text,
  hs_error      text,
  owner         uuid not null default auth.uid()
);
create index if not exists journeys_lead_at_idx on public.journeys(lead_id, at desc);
create index if not exists journeys_owner_idx on public.journeys(owner);

-- ---------------------------------------------------------------------------
-- add_requests
-- ---------------------------------------------------------------------------
create table if not exists public.add_requests (
  id            uuid primary key default gen_random_uuid(),
  company       text not null,
  domain        text not null,
  mode          text check (mode in ('next','now')),
  status        text check (status in ('queued','searching','pick','enriching','done','failed')),
  contact       jsonb,
  candidates    jsonb default '[]',
  picked        jsonb default '[]',
  note          text,
  lead_ids      text[],
  credits_used  text,
  owner         uuid default auth.uid(),
  created_at    timestamptz default now()
);
create index if not exists add_requests_owner_idx on public.add_requests(owner, created_at desc);
create index if not exists add_requests_status_idx on public.add_requests(status);

-- ---------------------------------------------------------------------------
-- task_order (per-user Task Center ordering)
-- ---------------------------------------------------------------------------
create table if not exists public.task_order (
  user_id  uuid primary key references public.profiles(id) on delete cascade,
  "order"  text[] default '{}'
);

-- ---------------------------------------------------------------------------
-- audit_log
-- ---------------------------------------------------------------------------
create table if not exists public.audit_log (
  id      uuid primary key default gen_random_uuid(),
  at      timestamptz default now(),
  actor   uuid default auth.uid(),
  action  text,
  target  text,
  detail  text
);
create index if not exists audit_log_at_idx on public.audit_log(at desc);

-- ---------------------------------------------------------------------------
-- research_queue (service role only)
-- ---------------------------------------------------------------------------
create table if not exists public.research_queue (
  id          uuid primary key default gen_random_uuid(),
  kind        text check (kind in ('weekly','add_request')),
  payload     jsonb not null,
  status      text default 'pending' check (status in ('pending','running','done','failed')),
  attempts    int default 0,
  error       text,
  batch       text,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);
create index if not exists research_queue_status_idx on public.research_queue(status, created_at);

-- ---------------------------------------------------------------------------
-- RLS on every table (policies in rbac migration)
-- ---------------------------------------------------------------------------
alter table public.roles          enable row level security;
alter table public.profiles       enable row level security;
alter table public.invites        enable row level security;
alter table public.app_settings   enable row level security;
alter table public.leads          enable row level security;
alter table public.calls          enable row level security;
alter table public.callbacks      enable row level security;
alter table public.meetings       enable row level security;
alter table public.tasks          enable row level security;
alter table public.journeys       enable row level security;
alter table public.add_requests   enable row level security;
alter table public.task_order     enable row level security;
alter table public.audit_log      enable row level security;
alter table public.research_queue enable row level security;

-- research_queue is never exposed to browser roles
revoke all on public.research_queue from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Realtime
-- ---------------------------------------------------------------------------
alter publication supabase_realtime add table
  public.leads,
  public.calls,
  public.callbacks,
  public.meetings,
  public.tasks,
  public.journeys,
  public.add_requests,
  public.profiles,
  public.roles,
  public.app_settings,
  public.audit_log;
