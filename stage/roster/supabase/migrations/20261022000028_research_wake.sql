-- Wake-up debounce for the research routine: queue-gate and prep-brief fire its API trigger when Claude work is
-- waiting, at most once per gap and never while a worker holds a lease (the running worker drains the queue itself).
create table if not exists public.research_wake (
  id            int primary key default 1 check (id = 1),
  last_wake_at  timestamptz
);
insert into public.research_wake (id) values (1) on conflict (id) do nothing;
alter table public.research_wake enable row level security;

create or replace function public.research_should_wake(p_gap_seconds int)
returns boolean
language sql
security definer
set search_path = public
as $$
  update public.research_wake
     set last_wake_at = now()
   where id = 1
     and (last_wake_at is null or last_wake_at < now() - make_interval(secs => p_gap_seconds))
     and exists (select 1 from public.research_queue
                  where status = 'pending' and kind not in ('post_call_email', 'reschedule_email'))
     and not exists (select 1 from public.research_queue
                      where status = 'running' and lease_until > now() and kind not in ('post_call_email', 'reschedule_email'))
  returning true;
$$;

create or replace function public.research_reset_wake()
returns void
language sql
security definer
set search_path = public
as $$
  update public.research_wake set last_wake_at = null where id = 1;
$$;

revoke all on function public.research_should_wake(int) from public, anon, authenticated;
revoke all on function public.research_reset_wake() from public, anon, authenticated;
grant execute on function public.research_should_wake(int) to service_role;
grant execute on function public.research_reset_wake() to service_role;
