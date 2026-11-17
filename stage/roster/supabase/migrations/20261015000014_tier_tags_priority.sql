-- Tier tags and priority.
--   Tiers are editable tags on an account: people with edit_tiers (Admin and Super Admin by default, editable per
--   role) can re-tag every contact at an account. tier_set_by/at mark a manual tag so research never overwrites it;
--   fit_tier keeps what research found.
--   priority_override pins an account's High/Medium/Low; without it the app derives priority from tier, journey
--   and notes.
alter table public.leads add column if not exists tier_set_by uuid;
alter table public.leads add column if not exists tier_set_at timestamptz;
alter table public.leads add column if not exists priority_override text;
alter table public.leads add column if not exists priority_set_by uuid;
alter table public.leads drop constraint if exists leads_priority_override_check;
alter table public.leads add constraint leads_priority_override_check check (priority_override is null or priority_override in ('high', 'medium', 'low'));
alter table public.leads drop constraint if exists leads_tier_check;
alter table public.leads add constraint leads_tier_check check (tier is null or tier in ('S', 'A', 'B', 'C', 'X'));

update public.roles set perms = perms || array['edit_tiers'] where id = 'admin' and not ('edit_tiers' = any(perms));

create or replace function public.guard_lead_tags()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Service-role writes (research, the worker) carry no user; they never replace a manual tag.
  if auth.uid() is null then
    if old.tier_set_by is not null and new.tier is distinct from old.tier then
      new.tier := old.tier;
    end if;
    return new;
  end if;
  if new.tier is distinct from old.tier or new.tier_set_by is distinct from old.tier_set_by then
    if not public.has_perm('edit_tiers') then
      raise exception 'Your role cannot change account tiers' using errcode = '42501';
    end if;
    new.tier_set_by := case when new.tier_set_by is null then null else auth.uid() end;
    new.tier_set_at := case when new.tier_set_by is null then null else now() end;
  end if;
  if new.priority_override is distinct from old.priority_override then
    new.priority_set_by := case when new.priority_override is null then null else auth.uid() end;
  end if;
  return new;
end;
$$;
revoke execute on function public.guard_lead_tags() from public, anon, authenticated;
drop trigger if exists guard_lead_tags on public.leads;
create trigger guard_lead_tags before update on public.leads for each row execute function public.guard_lead_tags();
