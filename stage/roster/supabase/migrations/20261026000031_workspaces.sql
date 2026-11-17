-- Workspaces: every customer's data lives in shared tables, tagged with workspace_id.
--
-- * Each person belongs to exactly one workspace (profiles.workspace_id). Their role and status are per workspace.
-- * Every tenant table gets workspace_id (not null, defaulting to the caller's workspace) and a RESTRICTIVE policy
--   "same workspace only", which is ANDed with the existing permissive policies. The old rules keep deciding what a
--   role may do; the new one makes sure it only ever applies inside the caller's own workspace.
-- * Keys that were global become per workspace: roles, app settings, invites, account claims, company research,
--   AI usage and leads. Child rows reference leads by (workspace_id, lead_id), so a call, meeting or draft can't
--   point at another workspace's contact even by mistake.
-- * Security-definer functions skip RLS, so each one now filters by workspace itself. The service role (edge
--   functions, cron) also skips RLS; the edge functions scope every query to the workspace of the request
--   (_shared/workspace.ts).
-- * Integration secrets are stored per workspace in Vault. The platform's own OAuth apps stay platform-wide.
-- * Sign-up: invited people join the inviting workspace. Anyone else gets a new workspace of their own, but only
--   while platform sign-ups are open or their address is on the allow list (platform_settings 'signup').
--
-- Existing rows move into one starting workspace.

-- ---------------------------------------------------------------------------------------------------------------
-- Workspaces and platform settings
-- ---------------------------------------------------------------------------------------------------------------

create table if not exists public.workspaces (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null check (length(btrim(name)) between 1 and 120),
  created_by          uuid references auth.users(id) on delete set null,
  -- The workspace's Claude worker authenticates with a token; only its hash is kept.
  worker_token_sha256 text unique,
  created_at          timestamptz not null default now()
);
alter table public.workspaces enable row level security;

-- Platform-wide settings, read and written by the service role only (no policies).
create table if not exists public.platform_settings (
  key        text primary key,
  value      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.platform_settings enable row level security;

insert into public.platform_settings (key, value) values
  ('signup', '{"open": false, "allow": []}'::jsonb),
  ('admins', '{"emails": []}'::jsonb)
on conflict (key) do nothing;

-- The starting workspace takes every existing row. Its name comes from the saved seller profile, if any.
insert into public.workspaces (id, name)
values ('00000000-0000-4000-8000-000000000001',
        coalesce(nullif(btrim((select value ->> 'company_name' from public.app_settings where key = 'profile')), ''), 'My workspace'))
on conflict (id) do nothing;

-- The starting workspace's owner email is also the platform's first admin.
update public.platform_settings
   set value = jsonb_build_object('emails', jsonb_build_array(lower(s.value ->> 'email')))
  from public.app_settings s
 where platform_settings.key = 'admins' and s.key = 'owner_email' and coalesce(s.value ->> 'email', '') <> ''
   and platform_settings.value -> 'emails' = '[]'::jsonb;

-- ---------------------------------------------------------------------------------------------------------------
-- workspace_id on every tenant table
-- ---------------------------------------------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array[
    'roles', 'profiles', 'invites', 'app_settings', 'leads', 'calls', 'callbacks', 'meetings', 'tasks', 'journeys',
    'add_requests', 'task_order', 'audit_log', 'research_queue', 'integration_connections', 'claude_usage',
    'email_drafts', 'rep_settings', 'account_claims', 'company_research', 'reschedule_drafts'
  ] loop
    execute format('alter table public.%I add column if not exists workspace_id uuid references public.workspaces(id) on delete cascade', t);
    execute format('update public.%I set workspace_id = %L where workspace_id is null', t, '00000000-0000-4000-8000-000000000001');
    execute format('alter table public.%I alter column workspace_id set not null', t);
    execute format('create index if not exists %I on public.%I (workspace_id)', t || '_workspace_idx', t);
  end loop;
end $$;

create or replace function public.current_workspace_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select p.workspace_id from public.profiles p where p.id = auth.uid()
$$;
revoke all on function public.current_workspace_id() from public;
grant execute on function public.current_workspace_id() to authenticated, service_role;

do $$
declare
  t text;
begin
  foreach t in array array[
    'roles', 'profiles', 'invites', 'app_settings', 'leads', 'calls', 'callbacks', 'meetings', 'tasks', 'journeys',
    'add_requests', 'task_order', 'audit_log', 'research_queue', 'integration_connections', 'claude_usage',
    'email_drafts', 'rep_settings', 'account_claims', 'company_research', 'reschedule_drafts'
  ] loop
    execute format('alter table public.%I alter column workspace_id set default public.current_workspace_id()', t);
    execute format('drop policy if exists %I on public.%I', t || '_same_workspace', t);
    execute format(
      'create policy %I on public.%I as restrictive for all to authenticated '
      'using (workspace_id = (select public.current_workspace_id())) '
      'with check (workspace_id = (select public.current_workspace_id()))',
      t || '_same_workspace', t);
  end loop;
end $$;

-- People see their own workspace and Super Admins may rename it. Nothing else is user-writable.
drop policy if exists workspaces_select on public.workspaces;
create policy workspaces_select on public.workspaces for select to authenticated
  using (id = (select public.current_workspace_id()));
drop policy if exists workspaces_update on public.workspaces;
create policy workspaces_update on public.workspaces for update to authenticated
  using (id = (select public.current_workspace_id()) and public.my_role() = 'super_admin')
  with check (id = (select public.current_workspace_id()));
revoke all on public.workspaces from anon, authenticated;
grant select (id, name, created_at) on public.workspaces to authenticated;
grant update (name) on public.workspaces to authenticated;
revoke all on public.platform_settings from anon, authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- Keys become per workspace
-- ---------------------------------------------------------------------------------------------------------------

-- Roles: (workspace_id, id). People and invites point at a role in their own workspace.
alter table public.profiles drop constraint if exists profiles_role_fkey;
alter table public.invites drop constraint if exists invites_role_fkey;
alter table public.roles drop constraint if exists roles_pkey;
alter table public.roles add primary key (workspace_id, id);
alter table public.profiles add constraint profiles_role_fkey
  foreign key (workspace_id, role) references public.roles (workspace_id, id);
alter table public.invites add constraint invites_role_fkey
  foreign key (workspace_id, role) references public.roles (workspace_id, id);

alter table public.app_settings drop constraint if exists app_settings_pkey;
alter table public.app_settings add primary key (workspace_id, key);

alter table public.invites drop constraint if exists invites_pkey;
alter table public.invites add primary key (workspace_id, email);

alter table public.claude_usage drop constraint if exists claude_usage_pkey;
alter table public.claude_usage add primary key (workspace_id, day, feature);

alter table public.account_claims drop constraint if exists account_claims_pkey;
alter table public.account_claims add primary key (workspace_id, domain);

alter table public.company_research drop constraint if exists company_research_pkey;
alter table public.company_research add primary key (workspace_id, domain);

-- Leads: Apollo person ids are the lead ids, so two workspaces can hold the same person.
alter table public.calls drop constraint if exists calls_lead_id_fkey;
alter table public.callbacks drop constraint if exists callbacks_lead_id_fkey;
alter table public.meetings drop constraint if exists meetings_lead_id_fkey;
alter table public.journeys drop constraint if exists journeys_lead_id_fkey;
alter table public.email_drafts drop constraint if exists email_drafts_lead_id_fkey;
alter table public.reschedule_drafts drop constraint if exists reschedule_drafts_lead_id_fkey;
alter table public.leads drop constraint if exists leads_pkey;
alter table public.leads add primary key (workspace_id, id);
alter table public.calls add constraint calls_lead_id_fkey
  foreign key (workspace_id, lead_id) references public.leads (workspace_id, id) on delete cascade;
alter table public.callbacks add constraint callbacks_lead_id_fkey
  foreign key (workspace_id, lead_id) references public.leads (workspace_id, id) on delete cascade;
alter table public.meetings add constraint meetings_lead_id_fkey
  foreign key (workspace_id, lead_id) references public.leads (workspace_id, id) on delete set null (lead_id);
alter table public.journeys add constraint journeys_lead_id_fkey
  foreign key (workspace_id, lead_id) references public.leads (workspace_id, id) on delete cascade;
alter table public.email_drafts add constraint email_drafts_lead_id_fkey
  foreign key (workspace_id, lead_id) references public.leads (workspace_id, id) on delete cascade;
alter table public.reschedule_drafts add constraint reschedule_drafts_lead_id_fkey
  foreign key (workspace_id, lead_id) references public.leads (workspace_id, id) on delete cascade;

drop index if exists public.integration_connections_provider_scope_user_key;
create unique index integration_connections_provider_scope_user_key on public.integration_connections
  (workspace_id, provider, scope, coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid));

drop index if exists public.journeys_hs_engagement_key;
create unique index journeys_hs_engagement_key on public.journeys (workspace_id, hs_engagement_id)
  where hs_engagement_id is not null;

-- ---------------------------------------------------------------------------------------------------------------
-- New workspace defaults
-- ---------------------------------------------------------------------------------------------------------------

create or replace function public.seed_workspace(p_workspace uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null then
    raise exception 'seed_workspace is service role only' using errcode = '42501';
  end if;
  insert into public.roles (workspace_id, id, name, perms, system) values
    (p_workspace, 'super_admin', 'Super Admin', array['view_all_accounts', 'work_leads', 'work_any_lead', 'assign_leads', 'add_company', 'enrich_now', 'hubspot_notes', 'manage_meetings', 'view_all_meetings', 'view_dashboard', 'manage_tasks', 'delete_records', 'manage_users', 'manage_roles', 'manage_integrations', 'view_audit']::text[], true),
    (p_workspace, 'admin', 'Admin', array['view_all_accounts', 'work_leads', 'work_any_lead', 'assign_leads', 'add_company', 'enrich_now', 'hubspot_notes', 'manage_meetings', 'view_all_meetings', 'view_dashboard', 'manage_tasks', 'delete_records', 'manage_users', 'view_audit']::text[], true),
    (p_workspace, 'sdr', 'SDR', array['work_leads', 'add_company', 'hubspot_notes', 'manage_meetings', 'view_dashboard', 'manage_tasks', 'delete_records']::text[], true),
    (p_workspace, 'viewer', 'Viewer', array['view_all_accounts', 'view_dashboard']::text[], true)
  on conflict (workspace_id, id) do nothing;
  insert into public.app_settings (workspace_id, key, value) values
    (p_workspace, 'super_admin_limit', '{"limit": 2}'::jsonb),
    (p_workspace, 'hubspot_sync', '{"last_run": null}'::jsonb),
    (p_workspace, 'claude', '{"model": null, "max_web_searches": 6, "research_tier_model": null}'::jsonb),
    (p_workspace, 'claude_worker', '{"last_seen": null}'::jsonb),
    (p_workspace, 'icp', '{"cap_small": 3, "cap_large": 5, "large_threshold": 1000}'::jsonb),
    (p_workspace, 'roster', '{"overprovision": 1.5, "crm_recent_days": 90, "archive_after_days": 35, "company_cache_days": 90, "exclude_cache_days": 120, "contacts_per_account": 2, "max_accounts_per_run": 15}'::jsonb),
    (p_workspace, 'ai_budget', '{"monthly_usd": 50, "warn_at": 0.8, "input_usd_per_mtok": 4, "output_usd_per_mtok": 20, "web_search_usd": 0}'::jsonb)
  on conflict (workspace_id, key) do nothing;
end;
$$;
revoke all on function public.seed_workspace(uuid) from public, anon, authenticated;

select public.seed_workspace('00000000-0000-4000-8000-000000000001');

-- ---------------------------------------------------------------------------------------------------------------
-- Permission helpers
-- ---------------------------------------------------------------------------------------------------------------

create or replace function public.has_perm(p text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    public.my_role() = 'super_admin'
    or exists (
      select 1 from public.roles r
      where r.workspace_id = public.current_workspace_id()
        and r.id = public.my_role()
        and p = any(r.perms)
    ),
    false)
$$;

create or replace function public.setting_text(p_key text, p_field text, p_default text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select s.value ->> p_field from public.app_settings s
      where s.key = p_key and s.workspace_id = public.current_workspace_id()),
    p_default)
$$;

create or replace function public.setting_text(p_workspace uuid, p_key text, p_field text, p_default text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select s.value ->> p_field from public.app_settings s where s.key = p_key and s.workspace_id = p_workspace),
    p_default)
$$;
revoke all on function public.setting_text(uuid, text, text, text) from public, anon, authenticated;

create or replace function public.my_account_companies()
returns setof text
language sql
stable
security definer
set search_path = public
as $$
  select distinct lower(l.company)
  from public.leads l
  where l.assigned_to = auth.uid()
    and l.workspace_id = public.current_workspace_id()
    and l.company is not null
$$;

create or replace function public.can_work_leads(p_ids text[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_active_member() and (
    public.has_perm('work_any_lead') or public.has_perm('assign_leads')
    or (public.has_perm('work_leads') and exists (
      select 1 from public.leads
       where workspace_id = public.current_workspace_id() and id = any(p_ids) and assigned_to = (select auth.uid())))
  );
$$;

-- Platform admins run the shared scheduler. Workspace admins no longer can.
create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(auth.role(), '') = 'service_role'
      or exists (select 1 from public.platform_settings s
                  where s.key = 'admins' and s.value -> 'emails' ? lower(coalesce(auth.email(), '')))
$$;

create or replace function public.list_cron_jobs()
returns table(jobid bigint, jobname text, schedule text, active boolean, command text)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  return query
    select j.jobid::bigint, j.jobname::text, j.schedule::text, j.active, j.command::text
    from cron.job j
    order by j.jobname;
end;
$$;

create or replace function public.set_cron_job_active(jobname text, active boolean)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id bigint;
begin
  if not public.is_platform_admin() then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  select j.jobid into v_id from cron.job j where j.jobname = set_cron_job_active.jobname;
  if v_id is null then
    raise exception 'Cron job % not found', set_cron_job_active.jobname using errcode = 'P0002';
  end if;
  perform cron.alter_job(job_id := v_id, active := set_cron_job_active.active);
  return set_cron_job_active.active;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Sign-up
-- ---------------------------------------------------------------------------------------------------------------

-- Where a new address goes: an invite, an unclaimed workspace whose owner_email it is, a workspace whose
-- allowed_domain it matches (joins as pending), or a new workspace of its own. Null means refused.
create or replace function public.signup_plan(p_email text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_email  text := lower(btrim(coalesce(p_email, '')));
  v_signup jsonb := coalesce((select value from public.platform_settings where key = 'signup'), '{}'::jsonb);
  r        record;
begin
  if v_email = '' then
    return null;
  end if;

  select i.workspace_id, i.role, i.created_by into r
    from public.invites i where lower(i.email) = v_email
   order by i.created_at desc nulls last limit 1;
  if found then
    return jsonb_build_object('kind', 'invite', 'workspace_id', r.workspace_id, 'role', r.role, 'added_by', r.created_by);
  end if;

  select s.workspace_id into r
    from public.app_settings s
   where s.key = 'owner_email' and lower(s.value ->> 'email') = v_email
     and not exists (select 1 from public.profiles p where p.workspace_id = s.workspace_id and p.is_owner)
   order by s.workspace_id limit 1;
  if found then
    return jsonb_build_object('kind', 'owner', 'workspace_id', r.workspace_id);
  end if;

  select s.workspace_id into r
    from public.app_settings s join public.workspaces w on w.id = s.workspace_id
   where s.key = 'allowed_domain' and coalesce(s.value ->> 'domain', '') <> ''
     and v_email like '%@' || lower(s.value ->> 'domain')
   order by w.created_at limit 1;
  if found then
    return jsonb_build_object('kind', 'domain', 'workspace_id', r.workspace_id);
  end if;

  if coalesce((v_signup ->> 'open')::boolean, false) or coalesce(v_signup -> 'allow', '[]'::jsonb) ? v_email then
    return jsonb_build_object('kind', 'new');
  end if;
  return null;
end;
$$;
revoke all on function public.signup_plan(text) from public, anon, authenticated;

create or replace function public.enforce_allowed_domain()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(new.email, '') = '' then
    raise exception 'Sign-in needs an email address' using errcode = '42501';
  end if;
  if public.signup_plan(new.email) is null then
    raise exception 'Sign-up is by invitation only. Ask an admin to invite %', lower(new.email)
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email    text := lower(new.email);
  v_plan     jsonb := public.signup_plan(new.email);
  v_ws       uuid;
  v_role     text := null;
  v_status   text := 'pending';
  v_is_owner boolean := false;
  v_added_by uuid := null;
  v_limit    int;
  v_name     text;
begin
  if v_plan is null then
    raise exception 'Sign-up is by invitation only. Ask an admin to invite %', v_email using errcode = '42501';
  end if;

  if v_plan ->> 'kind' = 'new' then
    v_name := coalesce(nullif(btrim(new.raw_user_meta_data ->> 'workspace_name'), ''),
                       nullif(btrim(new.raw_user_meta_data ->> 'company'), ''),
                       split_part(v_email, '@', 2));
    insert into public.workspaces (name, created_by) values (left(v_name, 120), new.id) returning id into v_ws;
    perform public.seed_workspace(v_ws);
    insert into public.app_settings (workspace_id, key, value)
    values (v_ws, 'owner_email', jsonb_build_object('email', v_email));
    v_role := 'super_admin'; v_status := 'active'; v_is_owner := true;
  else
    v_ws := (v_plan ->> 'workspace_id')::uuid;
    if v_plan ->> 'kind' = 'owner' then
      v_role := 'super_admin'; v_status := 'active'; v_is_owner := true;
    elsif v_plan ->> 'kind' = 'invite' then
      v_added_by := nullif(v_plan ->> 'added_by', '')::uuid;
      v_limit := coalesce(public.setting_text(v_ws, 'super_admin_limit', 'limit', '2')::int, 2);
      if v_plan ->> 'role' is not null
         and (v_plan ->> 'role' <> 'super_admin'
              or (select count(*) from public.profiles
                   where workspace_id = v_ws and role = 'super_admin' and status = 'active') < v_limit) then
        v_role := v_plan ->> 'role';
        v_status := 'active';
      end if;
    end if;
  end if;
  delete from public.invites where lower(email) = v_email;

  insert into public.profiles (id, workspace_id, email, full_name, avatar_url, role, status, is_owner, added_by)
  values (
    new.id, v_ws, v_email,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
    coalesce(new.raw_user_meta_data ->> 'avatar_url', new.raw_user_meta_data ->> 'picture'),
    v_role, v_status, v_is_owner, v_added_by
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------------------------------------------

create or replace function public.guard_profiles()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_me     text := public.my_role();
  v_ws     uuid := case when tg_op = 'DELETE' then old.workspace_id else new.workspace_id end;
  v_limit  int  := coalesce(public.setting_text(v_ws, 'super_admin_limit', 'limit', '2')::int, 2);
  v_count  int;
begin
  -- owner_leave() hands ownership over and removes the owner in one transaction. It marks the transaction with
  -- the leaving owner's id, so only that owner's own call passes here.
  if v_uid is not null and current_setting('roster.owner_handover', true) = v_uid::text then
    if tg_op = 'DELETE' then
      return old;
    end if;
    new.updated_at := now();
    return new;
  end if;

  if tg_op = 'DELETE' then
    if old.is_owner then
      raise exception 'The owner can only be removed by the owner, using Leave roster' using errcode = '42501';
    end if;
    if v_uid is not null then
      if old.id = v_uid then
        raise exception 'You cannot remove your own account' using errcode = '42501';
      end if;
      if old.role = 'super_admin' and coalesce(v_me, '') <> 'super_admin' then
        raise exception 'Only a super admin can remove a super admin' using errcode = '42501';
      end if;
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if v_uid is not null then
      if coalesce(new.is_owner, false) then
        raise exception 'Owner flag cannot be set' using errcode = '42501';
      end if;
      if new.id = v_uid then
        raise exception 'You cannot create your own profile' using errcode = '42501';
      end if;
      if new.role = 'super_admin' and coalesce(v_me, '') <> 'super_admin' then
        raise exception 'Only a super admin can grant super admin' using errcode = '42501';
      end if;
      new.added_by := coalesce(new.added_by, v_uid);
    end if;
  else
    new.id := old.id;
    new.created_at := old.created_at;
    new.workspace_id := old.workspace_id;
    if old.is_owner and (new.role is distinct from old.role
                         or new.status is distinct from old.status
                         or new.is_owner is distinct from old.is_owner) then
      raise exception 'The owner role and status cannot be changed' using errcode = '42501';
    end if;
    if v_uid is not null then
      if new.is_owner is distinct from old.is_owner then
        raise exception 'Owner flag cannot be changed' using errcode = '42501';
      end if;
      if new.email is distinct from old.email then
        raise exception 'Email cannot be changed' using errcode = '42501';
      end if;
      if old.id = v_uid and (new.role is distinct from old.role or new.status is distinct from old.status) then
        raise exception 'You cannot change your own role or status' using errcode = '42501';
      end if;
      if (new.role = 'super_admin' or old.role = 'super_admin')
         and (new.role is distinct from old.role or new.status is distinct from old.status)
         and coalesce(v_me, '') <> 'super_admin' then
        raise exception 'Only a super admin can grant or revoke super admin' using errcode = '42501';
      end if;
    end if;
  end if;

  if new.role = 'super_admin' and new.status = 'active'
     and (tg_op = 'INSERT' or old.role is distinct from 'super_admin' or old.status <> 'active') then
    select count(*) into v_count from public.profiles
     where workspace_id = new.workspace_id and role = 'super_admin' and status = 'active' and id <> new.id;
    if v_count >= v_limit then
      raise exception 'Super admin limit of % reached', v_limit using errcode = '42501';
    end if;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

create or replace function public.guard_roles()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.id = 'super_admin' and auth.uid() is not null then
      raise exception 'The super_admin role is reserved' using errcode = '42501';
    end if;
    return new;
  end if;

  if old.id = 'super_admin' and auth.uid() is not null then
    raise exception 'The super_admin role cannot be changed' using errcode = '42501';
  end if;

  if tg_op = 'DELETE' then
    if exists (select 1 from public.profiles where workspace_id = old.workspace_id and role = old.id) then
      raise exception 'Role % is still assigned to users', old.id using errcode = '23503';
    end if;
    delete from public.invites where workspace_id = old.workspace_id and role = old.id;
    return old;
  end if;

  if new.id is distinct from old.id or new.workspace_id is distinct from old.workspace_id then
    raise exception 'Role id cannot be changed' using errcode = '42501';
  end if;
  return new;
end;
$$;

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
      from public.app_settings where workspace_id = new.workspace_id and key = 'hubspot';
    if v_id is not null then
      new.hubspot_owner_id := v_id;
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.owner_leave()
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_ws   uuid := public.current_workspace_id();
  v_next uuid;
begin
  if v_uid is null or not exists (select 1 from public.profiles where id = v_uid and is_owner) then
    raise exception 'Only the owner can leave this way' using errcode = '42501';
  end if;
  select id into v_next from public.profiles
   where workspace_id = v_ws and role = 'super_admin' and status = 'active' and id <> v_uid
   order by created_at
   limit 1;
  if v_next is null then
    raise exception 'Make someone else an active Super Admin first. They become the owner when you leave.' using errcode = 'P0001';
  end if;
  perform set_config('roster.owner_handover', v_uid::text, true);
  update public.profiles set is_owner = false where id = v_uid;
  update public.profiles set is_owner = true  where id = v_next;
  insert into public.audit_log (workspace_id, actor, action, target, detail)
  values (v_ws, v_uid, 'owner left', v_next::text, 'ownership passed on');
  delete from public.profiles where id = v_uid;
  perform set_config('roster.owner_handover', '', true);
  return v_next;
end;
$$;

create or replace function public.flag_backdated()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_gap interval := coalesce(new.logged_at, now()) - new.at;
  v_kind text := case when tg_table_name = 'calls' then 'call' else 'note' end;
  v_what text;
begin
  if new.at is null or v_gap < interval '30 minutes' then
    return new;
  end if;
  v_what := case when tg_table_name = 'calls' then 'Call outcome "' || coalesce(to_jsonb(new) ->> 'outcome', '') || '"' else 'Connected-call note' end;
  insert into public.audit_log (workspace_id, actor, action, target, detail)
  values (
    new.workspace_id,
    new.owner,
    v_kind || '.backdated',
    coalesce(new.company, ''),
    v_what || ' with ' || coalesce(new.contact, 'a contact')
      || ' logged for ' || to_char(new.at at time zone 'Asia/Kolkata', 'DD Mon YYYY HH24:MI')
      || ' IST, entered ' || to_char(coalesce(new.logged_at, now()) at time zone 'Asia/Kolkata', 'DD Mon YYYY HH24:MI')
      || ' IST (' || case when v_gap >= interval '1 day' then extract(day from v_gap)::int || 'd ' else '' end
      || extract(hour from v_gap)::int || 'h ' || extract(minute from v_gap)::int || 'm later). id:' || new.id
  );
  return new;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Secrets: per workspace in Vault, except the platform's own OAuth apps and state key (p_workspace null).
-- ---------------------------------------------------------------------------------------------------------------

create or replace function public.secret_vault_name(p_workspace uuid, p_name text)
returns text
language sql
immutable
set search_path = public
as $$
  select case when p_workspace is null then p_name
              else 'ws_' || replace(p_workspace::text, '-', '') || '_' || p_name end
$$;

drop function if exists public.secret_get(text);
drop function if exists public.secret_set(text, text);
drop function if exists public.secret_delete(text);

create or replace function public.secret_get(p_workspace uuid, p_name text)
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
  where d.name = public.secret_vault_name(p_workspace, p_name)
  limit 1;
  return v;
end;
$$;

create or replace function public.secret_set(p_workspace uuid, p_name text, p_value text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_name text := public.secret_vault_name(p_workspace, p_name);
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

  select s.id into v_id from vault.secrets s where s.name = v_name limit 1;
  if v_id is null then
    perform vault.create_secret(p_value, v_name, 'Stage Prospect integration secret');
  else
    perform vault.update_secret(v_id, p_value);
  end if;
end;
$$;

create or replace function public.secret_delete(p_workspace uuid, p_name text)
returns void
language plpgsql
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
  delete from vault.secrets s where s.name = public.secret_vault_name(p_workspace, p_name);
end;
$$;

revoke all on function public.secret_get(uuid, text) from public, anon, authenticated;
revoke all on function public.secret_set(uuid, text, text) from public, anon, authenticated;
revoke all on function public.secret_delete(uuid, text) from public, anon, authenticated;

-- Existing integration secrets belong to the starting workspace; the worker token hash moves to its row.
update public.workspaces w
   set worker_token_sha256 = d.decrypted_secret
  from vault.decrypted_secrets d
 where w.id = '00000000-0000-4000-8000-000000000001' and d.name = 'int_worker_token_sha256'
   and w.worker_token_sha256 is null;
delete from vault.secrets where name = 'int_worker_token_sha256';
-- Renamed through vault.update_secret: the migration role may not update vault.secrets directly.
select vault.update_secret(d.id, d.decrypted_secret, public.secret_vault_name('00000000-0000-4000-8000-000000000001', d.name))
  from vault.decrypted_secrets d
 where d.name like 'int\_%'
   and d.name not in ('int_hubspot_app', 'int_google_app', 'int_oauth_state_secret');

-- ---------------------------------------------------------------------------------------------------------------
-- AI usage and budget, per workspace
-- ---------------------------------------------------------------------------------------------------------------

drop function if exists public.claude_usage_add(text, bigint, bigint, integer);
create or replace function public.claude_usage_add(p_workspace uuid, p_feature text, p_in bigint, p_out bigint, p_ws integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null then
    raise exception 'claude_usage_add is service role only' using errcode = '42501';
  end if;
  if p_workspace is null then
    raise exception 'Workspace required' using errcode = '22023';
  end if;
  if p_feature is null or p_feature !~ '^[a-z_]{1,40}$' then
    raise exception 'Invalid feature' using errcode = '22023';
  end if;
  insert into public.claude_usage as u (workspace_id, day, feature, input_tokens, output_tokens, web_searches, calls)
  values (p_workspace, (now() at time zone 'Asia/Kolkata')::date, p_feature,
          greatest(coalesce(p_in, 0), 0), greatest(coalesce(p_out, 0), 0), greatest(coalesce(p_ws, 0), 0), 1)
  on conflict (workspace_id, day, feature) do update set
    input_tokens  = u.input_tokens  + excluded.input_tokens,
    output_tokens = u.output_tokens + excluded.output_tokens,
    web_searches  = u.web_searches  + excluded.web_searches,
    calls         = u.calls + 1;
end;
$$;
revoke all on function public.claude_usage_add(uuid, text, bigint, bigint, integer) from public, anon, authenticated;

-- Signed-in callers always get their own workspace; the service role names one.
drop function if exists public.ai_spend_this_month();
create or replace function public.ai_spend_this_month(p_workspace uuid default null)
returns table(spent_usd numeric, limit_usd numeric, warn_at numeric)
language sql
stable
security definer
set search_path = public
as $$
  with ws as (select case when auth.uid() is null then p_workspace else public.current_workspace_id() end as id),
       b as (select coalesce((select value from public.app_settings s, ws where s.workspace_id = ws.id and s.key = 'ai_budget'), '{}'::jsonb) as v),
       u as (
         select coalesce(sum(input_tokens), 0) as i, coalesce(sum(output_tokens), 0) as o, coalesce(sum(web_searches), 0) as w
         from public.claude_usage c, ws
         where c.workspace_id = ws.id
           and c.day >= date_trunc('month', (now() at time zone 'Asia/Kolkata'))::date
       )
  select round(u.i / 1e6 * coalesce((b.v->>'input_usd_per_mtok')::numeric, 4)
             + u.o / 1e6 * coalesce((b.v->>'output_usd_per_mtok')::numeric, 20)
             + u.w * coalesce((b.v->>'web_search_usd')::numeric, 0), 4),
         (b.v->>'monthly_usd')::numeric,
         coalesce((b.v->>'warn_at')::numeric, 0.8)
  from u, b
$$;
revoke all on function public.ai_spend_this_month(uuid) from public, anon;
grant execute on function public.ai_spend_this_month(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------------
-- Research queue
-- ---------------------------------------------------------------------------------------------------------------

-- A worker belongs to one workspace and only ever claims that workspace's tasks.
drop function if exists public.claim_claude_work(integer, text, text[]);
create or replace function public.claim_claude_work(p_workspace uuid, p_n integer, p_worker text, p_kinds text[])
returns setof public.research_queue
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null then
    raise exception 'claim_claude_work is service role only' using errcode = '42501';
  end if;
  if p_workspace is null then
    raise exception 'Workspace required' using errcode = '22023';
  end if;

  -- Expired leases with attempts left go back to the queue. Rows out of attempts are closed by queue-gate,
  -- which also releases the account claim and closes add-company requests and prep briefs.
  update public.research_queue
     set status = 'pending', lease_until = null, worker = null
   where workspace_id = p_workspace and status = 'running' and lease_until < now() and attempts < 3;

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
      where r.workspace_id = p_workspace
        and r.status = 'pending'
        and (p_kinds is null or r.kind = any(p_kinds))
      order by r.priority, r.created_at
      limit greatest(least(coalesce(p_n, 5), 25), 0)
      for update skip locked
   )
  returning q.*;
end;
$$;
revoke all on function public.claim_claude_work(uuid, integer, text, text[]) from public, anon, authenticated;

create or replace function public.roster_progress(p_batch text)
returns table(rep_id uuid, qualified bigint, in_research bigint, in_reserve bigint, excluded bigint)
language sql
stable
security definer
set search_path = public
as $$
  with q as (
    select r.rep_id, r.status, r.result
      from public.research_queue r
     where r.workspace_id = public.current_workspace_id()
       and r.batch = p_batch and r.kind in ('account', 'add_request') and r.rep_id is not null
       and coalesce(r.payload ->> 'followup', 'false') <> 'true'
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

drop function if exists public.archive_stale_leads(integer);
create or replace function public.archive_stale_leads(p_workspace uuid, p_days integer)
returns integer
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
   where l.workspace_id = p_workspace
     and l.archived = false
     and l.batch < v_cutoff
     and coalesce(l.stage, '') = ''
     and coalesce(l.last_outcome, 'no') = 'no'
     and not exists (select 1 from public.meetings m where m.workspace_id = l.workspace_id and m.lead_id = l.id and m.status <> 'canceled')
     and not exists (select 1 from public.callbacks c where c.workspace_id = l.workspace_id and c.lead_id = l.id and c.status = 'open');
  get diagnostics v_count = row_count;

  update public.account_claims a
     set status = 'released', reason = 'archived after ' || p_days || ' days without progress'
   where a.workspace_id = p_workspace
     and a.status = 'active'
     and not exists (
       select 1 from public.leads l
        where l.workspace_id = a.workspace_id
          and l.archived = false
          and (l.account_key = a.domain
               or (l.account_key is null and (lower(l.domain) = a.domain or lower(l.company) = lower(a.company))))
     );
  return v_count;
end;
$$;
revoke all on function public.archive_stale_leads(uuid, integer) from public, anon, authenticated;

create or replace function public.ensure_dnp_callbacks()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  c record;
  v_cb uuid;
  v_when timestamptz;
  v_day date;
  n int := 0;
begin
  for c in
    select k.* from public.calls k
    where k.outcome = 'dnp'
      and k.new_callback_id is null
      and k.at > now() - interval '7 days'
      and k.at < now() - interval '10 minutes'
      and not exists (select 1 from public.callbacks b where b.workspace_id = k.workspace_id and b.lead_id = k.lead_id and b.status = 'open')
      and not exists (select 1 from public.calls x where x.workspace_id = k.workspace_id and x.lead_id = k.lead_id and x.at > k.at)
  loop
    v_day := (now() at time zone 'Asia/Kolkata')::date + 1;
    while extract(isodow from v_day) in (6, 7) loop
      v_day := v_day + 1;
    end loop;
    v_when := (v_day + time '11:00') at time zone 'Asia/Kolkata';
    insert into public.callbacks (workspace_id, lead_id, company, contact, title, segment, title_scope, "when", agenda, status, cal_status, cal_error, call_id, owner)
    values (c.workspace_id, c.lead_id, c.company, c.contact, c.title, c.segment, c.title_scope, v_when,
            'Retry after DNP (set automatically).', 'open', 'failed', 'Set automatically. Add it to Google Tasks from here.', c.id, c.owner)
    returning id into v_cb;
    update public.calls set new_callback_id = v_cb where id = c.id;
    update public.leads set stage = 'callback'
     where workspace_id = c.workspace_id and id = c.lead_id and coalesce(stage, '') not in ('meeting');
    insert into public.audit_log (workspace_id, actor, action, target, detail)
    values (c.workspace_id, null, 'callback.auto_dnp', c.lead_id, 'DNP had no callback; set ' || to_char(v_when at time zone 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') || ' IST');
    n := n + 1;
  end loop;
  return n;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Lead actions called by signed-in people: every lookup stays inside the caller's workspace.
-- ---------------------------------------------------------------------------------------------------------------

create or replace function public.assign_leads_bulk(p_ids text[], p_rep uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n int;
  v_ws uuid := public.current_workspace_id();
  v_name text;
begin
  if not (public.is_active_member() and public.has_perm('assign_leads')) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  if p_rep is not null then
    select coalesce(full_name, email) into v_name from public.profiles
     where id = p_rep and workspace_id = v_ws and status = 'active' and role is not null;
    if not found then raise exception 'That person is not an active member' using errcode = 'P0002'; end if;
  end if;
  update public.leads
     set assigned_to = p_rep, assigned_at = now(), assigned_by = auth.uid()
   where workspace_id = v_ws and id = any(p_ids) and assigned_to is distinct from p_rep;
  get diagnostics n = row_count;
  if n > 0 then
    insert into public.audit_log (workspace_id, actor, action, target, detail)
    values (v_ws, auth.uid(), 'leads.bulk_assigned', coalesce(v_name, 'Unassigned'),
            n || case when n = 1 then ' contact' else ' contacts' end || ' across '
            || (select count(distinct public.lead_company_key(domain, company)) from public.leads where workspace_id = v_ws and id = any(p_ids))
            || ' accounts');
  end if;
  return n;
end;
$$;

create or replace function public.set_account_dq(p_company text, p_on boolean, p_reason text default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ws  uuid := public.current_workspace_id();
  v_ids text[];
begin
  select array_agg(id) into v_ids from public.leads where workspace_id = v_ws and lower(company) = lower(p_company);
  if v_ids is null then raise exception 'Company not found' using errcode = 'P0002'; end if;
  if not public.can_work_leads(v_ids) then raise exception 'Not allowed' using errcode = '42501'; end if;
  if p_on then
    update public.leads set dq_at = now(), dq_reason = coalesce(nullif(trim(p_reason), ''), 'Not a fit'),
      dq_by = auth.uid(), dq_scope = 'company' where workspace_id = v_ws and id = any(v_ids);
  else
    update public.leads set dq_at = null, dq_reason = null, dq_by = null, dq_scope = null
     where workspace_id = v_ws and id = any(v_ids);
  end if;
  insert into public.audit_log (workspace_id, actor, action, target, detail)
  values (v_ws, auth.uid(), case when p_on then 'company.disqualified' else 'company.requalified' end, p_company,
          array_length(v_ids, 1) || ' contacts' || case when p_on then ' · ' || coalesce(nullif(trim(p_reason), ''), 'Not a fit') else '' end);
  return array_length(v_ids, 1);
end;
$$;

create or replace function public.set_account_lost(p_company text, p_on boolean, p_reason text default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ws  uuid := public.current_workspace_id();
  v_ids text[];
begin
  select array_agg(id) into v_ids from public.leads where workspace_id = v_ws and lower(company) = lower(p_company);
  if v_ids is null then raise exception 'Company not found' using errcode = 'P0002'; end if;
  if not public.can_work_leads(v_ids) then raise exception 'Not allowed' using errcode = '42501'; end if;
  if p_on then
    update public.leads set lost_at = now(), lost_reason = coalesce(nullif(trim(p_reason), ''), 'Went cold'),
      lost_by = auth.uid() where workspace_id = v_ws and id = any(v_ids);
  else
    update public.leads set lost_at = null, lost_reason = null, lost_by = null where workspace_id = v_ws and id = any(v_ids);
  end if;
  insert into public.audit_log (workspace_id, actor, action, target, detail)
  values (v_ws, auth.uid(), case when p_on then 'account.lost' else 'account.reopened' end, p_company,
          case when p_on then coalesce(nullif(trim(p_reason), ''), 'Went cold') else 'Back in the pipeline' end);
  return array_length(v_ids, 1);
end;
$$;

create or replace function public.set_lead_dq(p_lead_id text, p_on boolean, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ws uuid := public.current_workspace_id();
  v public.leads%rowtype;
begin
  select * into v from public.leads where workspace_id = v_ws and id = p_lead_id;
  if not found then raise exception 'Contact not found' using errcode = 'P0002'; end if;
  if not public.can_work_leads(array[p_lead_id]) then raise exception 'Not allowed' using errcode = '42501'; end if;
  if p_on then
    update public.leads set dq_at = now(), dq_reason = coalesce(nullif(trim(p_reason), ''), 'Not a fit'),
      dq_by = auth.uid(), dq_scope = 'contact' where workspace_id = v_ws and id = p_lead_id;
  else
    update public.leads set dq_at = null, dq_reason = null, dq_by = null, dq_scope = null
     where workspace_id = v_ws and id = p_lead_id;
  end if;
  insert into public.audit_log (workspace_id, actor, action, target, detail)
  values (v_ws, auth.uid(), case when p_on then 'contact.disqualified' else 'contact.requalified' end, v.company,
          v.name || coalesce(' · ' || nullif(v.title, ''), '') || case when p_on then ' · ' || coalesce(nullif(trim(p_reason), ''), 'Not a fit') else '' end);
end;
$$;

create or replace function public.undo_call(p_call_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ws      uuid := public.current_workspace_id();
  v_call    public.calls%rowtype;
  v_cal_id  text := null;
  v_prev    jsonb;
begin
  if not public.is_active_member() then
    raise exception 'Not allowed' using errcode = '42501';
  end if;

  select * into v_call from public.calls where id = p_call_id and workspace_id = v_ws for update;
  if not found then
    raise exception 'Call not found' using errcode = 'P0002';
  end if;

  if not (v_call.owner = auth.uid()
          or (public.has_perm('view_all_meetings') and public.has_perm('delete_records'))) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;

  -- meeting booked by this call
  if v_call.meeting_id is not null then
    delete from public.meetings where workspace_id = v_ws and id = v_call.meeting_id;
  end if;
  delete from public.meetings where workspace_id = v_ws and call_id = v_call.id;

  -- callback created by this call
  if v_call.new_callback_id is not null then
    delete from public.callbacks
    where workspace_id = v_ws and id = v_call.new_callback_id
    returning cal_event_id into v_cal_id;
  end if;

  -- callback closed by this call goes back to open
  if v_call.closed_callback_id is not null then
    update public.callbacks
       set status = 'open', outcome = null, done_at = null, call_id = null
     where workspace_id = v_ws and id = v_call.closed_callback_id;
  end if;

  -- restore lead state
  v_prev := v_call.prev_lead;
  if v_call.lead_id is not null and v_prev is not null then
    update public.leads
       set stage        = v_prev ->> 'stage',
           last_outcome = v_prev ->> 'last_outcome',
           last_call_at = nullif(v_prev ->> 'last_call_at', '')::timestamptz
     where workspace_id = v_ws and id = v_call.lead_id;
  end if;

  delete from public.calls where id = v_call.id;

  return jsonb_build_object('deleted_callback_cal_event_id', v_cal_id);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Lead distribution, per workspace
-- ---------------------------------------------------------------------------------------------------------------

drop function if exists public.lead_distribution_plan();
create or replace function public.lead_distribution_plan(p_workspace uuid)
returns table(lead_id text, rep_id uuid, company_key text, company text, reason text)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  g record;
  v_rep uuid;
  v_load jsonb := '{}'::jsonb;  -- rep id -> open contacts, including what this plan hands out
begin
  -- Current open load of every in-rotation rep.
  select coalesce(jsonb_object_agg(r.user_id::text, (
           select count(*) from public.leads l
           where l.workspace_id = p_workspace and l.assigned_to = r.user_id and not coalesce(l.archived, false)
             and l.dq_at is null and l.lost_at is null)), '{}'::jsonb)
    into v_load
    from public.rep_settings r
    join public.profiles p on p.id = r.user_id and p.status = 'active' and p.role is not null
   where r.workspace_id = p_workspace and p.workspace_id = p_workspace and r.in_rotation;

  -- Biggest companies first so the greedy balance comes out even.
  for g in
    with pool as (
      select l.id, l.company, l.employees,
             public.lead_company_key(l.domain, l.company) as k
        from public.leads l
       where l.workspace_id = p_workspace
         and l.assigned_to is null and not coalesce(l.archived, false)
         and l.dq_at is null and l.lost_at is null
    )
    select k, min(company) as company, array_agg(id order by id) as ids,
           (array_agg(public.employee_range(employees)) filter (where public.employee_range(employees) is not null))[1] as emp,
           (select o.assigned_to
              from public.leads o
              join public.profiles op on op.id = o.assigned_to and op.status = 'active' and op.role is not null
             where o.workspace_id = p_workspace
               and public.lead_company_key(o.domain, o.company) = pool.k
               and not coalesce(o.archived, false)
             group by o.assigned_to
             order by count(*) desc, min(o.assigned_at) nulls last, o.assigned_to
             limit 1) as owner
      from pool
     group by k
     order by count(*) desc, k
  loop
    if g.owner is not null then
      v_rep := g.owner;
      reason := 'company_owner';
    else
      select r.user_id into v_rep
        from public.rep_settings r
        join public.profiles p on p.id = r.user_id and p.status = 'active' and p.role is not null
       where r.workspace_id = p_workspace and p.workspace_id = p_workspace
         and r.in_rotation
         and public.segment_matches(r.employees_min, r.employees_max, r.revenue_min, r.revenue_max,
                                    r.funding_min, r.funding_max, g.emp, null, null)
       order by coalesce((v_load ->> r.user_id::text)::int, 0), r.user_id
       limit 1;
      reason := case when v_rep is null then 'no_match' else 'segment' end;
    end if;
    if v_rep is not null and v_load ? v_rep::text then
      v_load := jsonb_set(v_load, array[v_rep::text], to_jsonb((v_load ->> v_rep::text)::int + cardinality(g.ids)));
    end if;
    rep_id := v_rep;
    company_key := g.k;
    company := g.company;
    foreach lead_id in array g.ids loop
      return next;
    end loop;
  end loop;
end;
$$;
revoke all on function public.lead_distribution_plan(uuid) from public, anon, authenticated;

create or replace function public.run_lead_distribution(p_workspace uuid, p_apply boolean, p_source text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_plan jsonb;
  v_done int := 0;
  n int;
  c record;
begin
  -- One distribution per workspace at a time, so two saves can't hand the same contact out twice.
  perform pg_advisory_xact_lock(hashtext('lead_distribution:' || p_workspace::text));

  create temp table if not exists _ld_plan (lead_id text, rep_id uuid, company_key text, company text, reason text) on commit drop;
  truncate _ld_plan;
  insert into _ld_plan select * from public.lead_distribution_plan(p_workspace);

  if p_apply then
    for c in
      select rep_id, company_key, min(company) as company, min(reason) as reason, array_agg(lead_id) as ids
        from _ld_plan where rep_id is not null
       group by rep_id, company_key
    loop
      update public.leads
         set assigned_to = c.rep_id, assigned_at = now(), assigned_by = auth.uid()
       where workspace_id = p_workspace and id = any(c.ids) and assigned_to is null;
      get diagnostics n = row_count;
      if n > 0 then
        v_done := v_done + n;
        insert into public.audit_log (workspace_id, actor, action, target, detail)
        select p_workspace, auth.uid(), 'leads.auto_assigned', c.company,
               n || case when n = 1 then ' contact' else ' contacts' end || ' → '
               || coalesce(p.full_name, p.email, c.rep_id::text)
               || case c.reason when 'company_owner' then ' (already owns this company)' else ' (segment match)' end
               || ' · ' || p_source
          from public.profiles p where p.id = c.rep_id;
      end if;
    end loop;
    if v_done > 0 then
      insert into public.audit_log (workspace_id, actor, action, target, detail)
      values (p_workspace, auth.uid(), 'leads.distributed', '', v_done || ' unassigned contacts distributed · ' || p_source);
    end if;
  end if;

  select jsonb_build_object(
           'applied', p_apply,
           'assigned', case when p_apply then v_done else (select count(*) from _ld_plan where rep_id is not null) end,
           'unmatched', (select count(*) from _ld_plan where rep_id is null),
           'by_reason', coalesce((select jsonb_object_agg(z.reason, z.cnt)
                                    from (select reason, count(*) as cnt from _ld_plan group by reason) z), '{}'::jsonb),
           'reps', coalesce((
             select jsonb_agg(jsonb_build_object('rep_id', x.rep_id, 'name', coalesce(p.full_name, p.email),
                                                 'contacts', x.contacts, 'accounts', x.accounts)
                              order by x.contacts desc, coalesce(p.full_name, p.email))
               from (select rep_id, count(*) as contacts, count(distinct company_key) as accounts
                       from _ld_plan where rep_id is not null group by rep_id) x
               join public.profiles p on p.id = x.rep_id), '[]'::jsonb),
           'unmatched_companies', coalesce((
             select jsonb_agg(distinct company) from _ld_plan where rep_id is null), '[]'::jsonb))
    into v_plan;
  return v_plan;
end;
$$;
revoke all on function public.run_lead_distribution(uuid, boolean, text) from public, anon, authenticated;

-- The daily scheduler job runs every workspace.
create or replace function public.run_lead_distribution(p_apply boolean, p_source text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  w record;
  v_total int := 0;
begin
  if auth.uid() is not null then
    raise exception 'Use distribute_unassigned_leads' using errcode = '42501';
  end if;
  for w in select id from public.workspaces order by created_at loop
    v_total := v_total + coalesce((public.run_lead_distribution(w.id, p_apply, p_source) ->> 'assigned')::int, 0);
  end loop;
  return jsonb_build_object('applied', p_apply, 'assigned', v_total);
end;
$$;
revoke all on function public.run_lead_distribution(boolean, text) from public, anon, authenticated;

create or replace function public.distribute_unassigned_leads(p_apply boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not (public.is_active_member() and (public.has_perm('assign_leads') or public.has_perm('manage_users'))) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  return public.run_lead_distribution(public.current_workspace_id(), p_apply, 'admin');
end;
$$;

create or replace function public.distribute_on_member_active()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'active' and new.role is not null
     and (tg_op = 'INSERT' or old.status is distinct from 'active' or old.role is null)
     and exists (select 1 from public.rep_settings where user_id = new.id and in_rotation) then
    perform public.run_lead_distribution(new.workspace_id, true, 'member activated');
  end if;
  return null;
end;
$$;

create or replace function public.distribute_on_rep_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.in_rotation and (
       tg_op = 'INSERT'
       or not old.in_rotation
       or (old.employees_min, old.employees_max, old.revenue_min, old.revenue_max, old.funding_min, old.funding_max)
          is distinct from
          (new.employees_min, new.employees_max, new.revenue_min, new.revenue_max, new.funding_min, new.funding_max)) then
    perform public.run_lead_distribution(new.workspace_id, true, 'segment saved');
  end if;
  return null;
end;
$$;

-- Rows that point at a person must stay in that person's workspace.
create or replace function public.same_workspace_as_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := to_jsonb(new) ->> tg_argv[0];
begin
  if v_user is not null
     and not exists (select 1 from public.profiles p where p.id = v_user and p.workspace_id = new.workspace_id) then
    raise exception '% belongs to another workspace', tg_argv[0] using errcode = '42501';
  end if;
  return new;
end;
$$;

do $$
declare
  r record;
begin
  for r in select * from (values
    ('leads', 'assigned_to'), ('rep_settings', 'user_id'), ('task_order', 'user_id'),
    ('integration_connections', 'user_id'), ('research_queue', 'rep_id'), ('account_claims', 'rep_id'),
    ('email_drafts', 'owner'), ('reschedule_drafts', 'owner'), ('calls', 'owner'), ('callbacks', 'owner'),
    ('meetings', 'owner'), ('journeys', 'owner'), ('tasks', 'owner'), ('add_requests', 'owner')
  ) as t(tbl, col) loop
    execute format('drop trigger if exists %I on public.%I', r.tbl || '_' || r.col || '_same_workspace', r.tbl);
    execute format(
      'create trigger %I before insert or update of %I, workspace_id on public.%I '
      'for each row execute function public.same_workspace_as_user(%L)',
      r.tbl || '_' || r.col || '_same_workspace', r.col, r.tbl, r.col);
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Queue gate and worker wake-ups, per workspace
-- ---------------------------------------------------------------------------------------------------------------

drop function if exists public.claim_gate_rows(integer);
create or replace function public.claim_gate_rows(p_workspace uuid, p_n integer)
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
      where r.workspace_id = p_workspace
        and r.status = 'gating'
        and (r.next_gate_at is null or r.next_gate_at <= now())
      order by r.priority, r.created_at
      limit greatest(least(coalesce(p_n, 30), 100), 0)
      for update skip locked
   )
  returning q.*;
end;
$$;
revoke all on function public.claim_gate_rows(uuid, integer) from public, anon, authenticated;

-- When each workspace's research and post-call routines were last woken (debounce).
create table if not exists public.wake_state (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  kind         text not null check (kind in ('research', 'post_call')),
  last_wake_at timestamptz,
  primary key (workspace_id, kind)
);
alter table public.wake_state enable row level security;
revoke all on public.wake_state from anon, authenticated;

drop function if exists public.research_should_wake(integer);
drop function if exists public.research_reset_wake();
drop function if exists public.post_call_should_wake(integer);
drop function if exists public.post_call_reset_wake();
drop table if exists public.research_wake;
drop table if exists public.post_call_wake;

create or replace function public.research_should_wake(p_workspace uuid, p_gap_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.research_queue
                  where workspace_id = p_workspace and status = 'pending' and kind not in ('post_call_email', 'reschedule_email'))
     or exists (select 1 from public.research_queue
                 where workspace_id = p_workspace and status = 'running' and lease_until > now()
                   and kind not in ('post_call_email', 'reschedule_email')) then
    return false;
  end if;
  insert into public.wake_state as w (workspace_id, kind, last_wake_at) values (p_workspace, 'research', now())
  on conflict (workspace_id, kind) do update set last_wake_at = now()
   where w.last_wake_at is null or w.last_wake_at < now() - make_interval(secs => p_gap_seconds);
  return found;
end;
$$;

create or replace function public.post_call_should_wake(p_workspace uuid, p_gap_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.wake_state as w (workspace_id, kind, last_wake_at) values (p_workspace, 'post_call', now())
  on conflict (workspace_id, kind) do update set last_wake_at = now()
   where w.last_wake_at is null or w.last_wake_at < now() - make_interval(secs => p_gap_seconds);
  return found;
end;
$$;

create or replace function public.research_reset_wake(p_workspace uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.wake_state set last_wake_at = null where workspace_id = p_workspace and kind = 'research';
$$;

create or replace function public.post_call_reset_wake(p_workspace uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.wake_state set last_wake_at = null where workspace_id = p_workspace and kind = 'post_call';
$$;

revoke all on function public.research_should_wake(uuid, integer) from public, anon, authenticated;
revoke all on function public.post_call_should_wake(uuid, integer) from public, anon, authenticated;
revoke all on function public.research_reset_wake(uuid) from public, anon, authenticated;
revoke all on function public.post_call_reset_wake(uuid) from public, anon, authenticated;
