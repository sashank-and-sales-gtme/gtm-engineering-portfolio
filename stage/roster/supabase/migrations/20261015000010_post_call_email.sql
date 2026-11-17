-- Post-call emails (October 2026)
-- Saving a call note queues a follow-up email draft for the Claude worker (research_queue kind
-- 'post_call_email'). The draft lands in email_drafts, under the note in the deal journey.

alter table public.research_queue drop constraint if exists research_queue_kind_check;
alter table public.research_queue
  add constraint research_queue_kind_check
  check (kind in ('weekly', 'account', 'add_request', 'prep_brief', 'post_call_email'));

create table if not exists public.email_drafts (
  id          uuid primary key default gen_random_uuid(),
  journey_id  uuid not null unique references public.journeys(id) on delete cascade,
  lead_id     text references public.leads(id) on delete cascade,
  status      text not null default 'drafting' check (status in ('drafting', 'ready', 'failed')),
  format      text check (format in ('note', 'brief')),
  subject     text,
  body        text,
  flags       jsonb not null default '[]',
  words       int,
  error       text,
  edited      boolean not null default false,
  owner       uuid not null references public.profiles(id) on delete cascade,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists email_drafts_lead_idx on public.email_drafts(lead_id);
create index if not exists email_drafts_owner_idx on public.email_drafts(owner);

alter table public.email_drafts enable row level security;

-- Same visibility as the call note it belongs to.
drop policy if exists email_drafts_select on public.email_drafts;
create policy email_drafts_select on public.email_drafts
  for select to authenticated
  using (public.is_active_member()
         and (owner = (select auth.uid()) or public.has_perm('view_all_meetings')));

-- Reps edit the subject and body; everything else is written by the functions.
drop policy if exists email_drafts_update on public.email_drafts;
create policy email_drafts_update on public.email_drafts
  for update to authenticated
  using (public.is_active_member()
         and (owner = (select auth.uid()) or public.has_perm('view_all_meetings')))
  with check (public.is_active_member()
         and (owner = (select auth.uid()) or public.has_perm('view_all_meetings')));

revoke all on public.email_drafts from anon, authenticated;
grant select on public.email_drafts to authenticated;
grant update (subject, body, edited, updated_at) on public.email_drafts to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'email_drafts'
  ) then
    alter publication supabase_realtime add table public.email_drafts;
  end if;
end $$;

-- Optional wake-up of a post-call routine: one row records the last wake, so a burst of notes shares one run.
create table if not exists public.post_call_wake (
  id            int primary key default 1 check (id = 1),
  last_wake_at  timestamptz
);
insert into public.post_call_wake (id) values (1) on conflict (id) do nothing;
alter table public.post_call_wake enable row level security;
revoke all on public.post_call_wake from anon, authenticated;

create or replace function public.post_call_should_wake(p_gap_seconds int)
returns boolean
language sql
security definer
set search_path = public
as $$
  update public.post_call_wake
     set last_wake_at = now()
   where id = 1
     and (last_wake_at is null or last_wake_at < now() - make_interval(secs => p_gap_seconds))
  returning true;
$$;

create or replace function public.post_call_reset_wake()
returns void
language sql
security definer
set search_path = public
as $$
  update public.post_call_wake set last_wake_at = null where id = 1;
$$;

revoke all on function public.post_call_should_wake(int) from public, anon, authenticated;
revoke all on function public.post_call_reset_wake() from public, anon, authenticated;
grant execute on function public.post_call_should_wake(int) to service_role;
grant execute on function public.post_call_reset_wake() to service_role;
