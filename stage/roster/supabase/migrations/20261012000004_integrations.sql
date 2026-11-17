-- Stage Prospect: in-app integrations (HubSpot, Google Calendar, Apollo, FullEnrich, Anthropic).
--
-- Connection metadata lives in integration_connections (readable by members, written only by the
-- service role from edge functions). Keys and OAuth tokens live in Supabase Vault and are reachable
-- only through the service-role-only RPCs secret_set / secret_get / secret_delete.

-- ===========================================================================
-- integration_connections
-- ===========================================================================

create table if not exists public.integration_connections (
  id              uuid primary key default gen_random_uuid(),
  provider        text not null check (provider in ('hubspot','google_calendar','apollo','fullenrich','anthropic','hubspot_app','google_app')),
  scope           text not null check (scope in ('org','user')),
  user_id         uuid references public.profiles(id) on delete cascade,
  status          text not null default 'connected' check (status in ('connected','error','disconnected')),
  account_label   text,
  meta            jsonb default '{}'::jsonb,
  connected_by    uuid,
  connected_at    timestamptz default now(),
  last_checked_at timestamptz,
  error           text,
  constraint integration_connections_scope_user check (
    (scope = 'org' and user_id is null) or (scope = 'user' and user_id is not null)
  )
);

-- NULL user_id (org rows) would defeat a plain unique constraint, so key on a coalesced uuid.
create unique index if not exists integration_connections_provider_scope_user_key
  on public.integration_connections (provider, scope, coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid));

create index if not exists integration_connections_user_idx
  on public.integration_connections (user_id) where user_id is not null;

alter table public.integration_connections enable row level security;

-- Browser roles may read (subject to RLS) but never write; edge functions use the service role.
revoke insert, update, delete, truncate on public.integration_connections from anon, authenticated;
grant select on public.integration_connections to authenticated;

drop policy if exists integration_connections_select on public.integration_connections;
create policy integration_connections_select on public.integration_connections
  for select to authenticated
  using (
    public.is_active_member()
    and (scope = 'org' or user_id = auth.uid())
  );

-- No insert/update/delete policies: only the service role (bypasses RLS) writes.

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'integration_connections'
  ) then
    alter publication supabase_realtime add table public.integration_connections;
  end if;
end $$;

-- ===========================================================================
-- Vault RPCs (service role only)
-- ===========================================================================

-- Create or update a Vault secret by name. Names are restricted to the int_ namespace so these
-- RPCs can never read or overwrite unrelated secrets such as project_url or cron_secret.
create or replace function public.secret_set(p_name text, p_value text)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if auth.uid() is not null then
    raise exception 'secret_set is service role only' using errcode = '42501';
  end if;
  if p_name is null or p_name !~ '^int_[a-z0-9_-]{1,80}$' then
    raise exception 'Invalid secret name' using errcode = '22023';
  end if;
  if p_value is null or p_value = '' then
    raise exception 'Secret value is empty' using errcode = '22023';
  end if;

  select s.id into v_id from vault.secrets s where s.name = p_name limit 1;
  if v_id is null then
    perform vault.create_secret(p_value, p_name, 'Stage Prospect integration secret');
  else
    perform vault.update_secret(v_id, p_value);
  end if;
end;
$$;

create or replace function public.secret_get(p_name text)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v text;
begin
  if auth.uid() is not null then
    raise exception 'secret_get is service role only' using errcode = '42501';
  end if;
  if p_name is null or p_name !~ '^int_[a-z0-9_-]{1,80}$' then
    raise exception 'Invalid secret name' using errcode = '22023';
  end if;
  select d.decrypted_secret into v
  from vault.decrypted_secrets d
  where d.name = p_name
  limit 1;
  return v;
end;
$$;

create or replace function public.secret_delete(p_name text)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null then
    raise exception 'secret_delete is service role only' using errcode = '42501';
  end if;
  if p_name is null or p_name !~ '^int_[a-z0-9_-]{1,80}$' then
    raise exception 'Invalid secret name' using errcode = '22023';
  end if;
  delete from vault.secrets s where s.name = p_name;
end;
$$;

revoke execute on function public.secret_set(text, text) from public, anon, authenticated;
revoke execute on function public.secret_get(text)       from public, anon, authenticated;
revoke execute on function public.secret_delete(text)    from public, anon, authenticated;
grant  execute on function public.secret_set(text, text) to service_role;
grant  execute on function public.secret_get(text)       to service_role;
grant  execute on function public.secret_delete(text)    to service_role;
