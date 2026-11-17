-- UI audit fixes (October 2026)
-- 1. The shared HubSpot booking link is edited from Admin only (manage_integrations),
--    no longer by everyone with manage_meetings.
-- 2. The owner's HubSpot owner id is filled from app_settings.hubspot.owner_id_sashank
--    when it is empty, both for the existing row and when the owner first signs in.

drop policy if exists app_settings_update on public.app_settings;
create policy app_settings_update on public.app_settings
  for update to authenticated
  using (public.is_active_member() and public.has_perm('manage_integrations'))
  with check (public.is_active_member() and public.has_perm('manage_integrations'));

create or replace function public.owner_hubspot_default()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id text;
begin
  if coalesce(new.is_owner, false) and coalesce(new.hubspot_owner_id, '') = '' then
    select nullif(value->>'owner_id_sashank', '') into v_id
      from public.app_settings where key = 'hubspot';
    if v_id is not null then
      new.hubspot_owner_id := v_id;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_owner_hubspot_default on public.profiles;
create trigger profiles_owner_hubspot_default
  before insert or update on public.profiles
  for each row execute function public.owner_hubspot_default();

update public.profiles p
   set hubspot_owner_id = s.value->>'owner_id_sashank'
  from public.app_settings s
 where s.key = 'hubspot'
   and p.is_owner
   and coalesce(p.hubspot_owner_id, '') = ''
   and coalesce(s.value->>'owner_id_sashank', '') <> '';
