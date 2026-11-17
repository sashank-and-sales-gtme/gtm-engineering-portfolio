-- Reschedule replies (October 2026)
-- From a meeting in the reschedule queue, the reschedule-email function reads the rep's Gmail thread with the
-- prospect and their calendar, works out free slots, and queues a research_queue row (kind 'reschedule_email').
-- The Claude worker picks 5 of those slots to suit what the prospect said and writes a copyable reply.

alter table public.research_queue drop constraint if exists research_queue_kind_check;
alter table public.research_queue
  add constraint research_queue_kind_check
  check (kind in ('weekly', 'account', 'add_request', 'prep_brief', 'post_call_email', 'reschedule_email'));

create table if not exists public.reschedule_drafts (
  id          uuid primary key default gen_random_uuid(),
  meeting_id  text not null unique references public.meetings(id) on delete cascade,
  lead_id     text references public.leads(id) on delete cascade,
  status      text not null default 'drafting' check (status in ('drafting', 'ready', 'failed')),
  subject     text,
  body        text,
  slots       jsonb not null default '[]',
  read        jsonb not null default '{}',
  flags       jsonb not null default '[]',
  error       text,
  edited      boolean not null default false,
  owner       uuid not null references public.profiles(id) on delete cascade,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists reschedule_drafts_owner_idx on public.reschedule_drafts(owner);

alter table public.reschedule_drafts enable row level security;

drop policy if exists reschedule_drafts_select on public.reschedule_drafts;
create policy reschedule_drafts_select on public.reschedule_drafts
  for select to authenticated
  using (public.is_active_member()
         and (owner = (select auth.uid()) or public.has_perm('view_all_meetings')));

drop policy if exists reschedule_drafts_update on public.reschedule_drafts;
create policy reschedule_drafts_update on public.reschedule_drafts
  for update to authenticated
  using (public.is_active_member()
         and (owner = (select auth.uid()) or public.has_perm('view_all_meetings')))
  with check (public.is_active_member()
         and (owner = (select auth.uid()) or public.has_perm('view_all_meetings')));

revoke all on public.reschedule_drafts from anon, authenticated;
grant select on public.reschedule_drafts to authenticated;
grant update (subject, body, edited, updated_at) on public.reschedule_drafts to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'reschedule_drafts'
  ) then
    alter publication supabase_realtime add table public.reschedule_drafts;
  end if;
end $$;
