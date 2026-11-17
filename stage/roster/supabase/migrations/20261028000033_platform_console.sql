-- The platform console: one place where the product owner sees every workspace and runs the platform.
--
-- * The product owner is fixed here, in code. No screen, function or setting can change it; changing it takes a new
--   migration. The owner is always a platform admin too.
-- * Everything the console reads or changes goes through the security-definer functions below. Each one checks
--   is_product_owner() first, so they are safe to grant to signed-in users: anyone else gets 42501.
-- * Every change the console makes is written to platform_audit, which only the owner can read.

create or replace function public.product_owner_email()
returns text
language sql
immutable
as $$ select 'sashankandsales@gmail.com'::text $$;

-- The signed-in user is the product owner: their auth record (not just the token's claim) has the owner's
-- address, confirmed.
create or replace function public.is_product_owner()
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (select 1 from auth.users u
                  where u.id = auth.uid()
                    and lower(u.email) = public.product_owner_email()
                    and u.email_confirmed_at is not null)
$$;
revoke all on function public.is_product_owner() from public, anon;
grant execute on function public.is_product_owner() to authenticated, service_role;

create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(auth.role(), '') = 'service_role'
      or public.is_product_owner()
      or exists (select 1 from public.platform_settings s
                  where s.key = 'admins' and s.value -> 'emails' ? lower(coalesce(auth.email(), '')))
$$;

create table if not exists public.platform_audit (
  id     bigint generated always as identity primary key,
  at     timestamptz not null default now(),
  actor  text not null,
  action text not null,
  target text not null default '',
  detail text not null default ''
);
alter table public.platform_audit enable row level security;
revoke all on public.platform_audit from anon, authenticated;

create or replace function public.platform_require_owner()
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_product_owner() then
    raise exception 'Only the product owner can use the platform console' using errcode = '42501';
  end if;
end;
$$;
revoke all on function public.platform_require_owner() from public, anon, authenticated;

create or replace function public.platform_log(p_action text, p_target text, p_detail text)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.platform_audit (actor, action, target, detail)
  values (coalesce(lower(auth.email()), 'service'), p_action, coalesce(p_target, ''), coalesce(p_detail, ''));
$$;
revoke all on function public.platform_log(text, text, text) from public, anon, authenticated;

-- Everything the console shows, in one call.
create or replace function public.platform_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_month date := date_trunc('month', (now() at time zone 'Asia/Kolkata'))::date;
  v_week  timestamptz := now() - interval '7 days';
  v_ws    jsonb;
begin
  perform public.platform_require_owner();

  select coalesce(jsonb_agg(x order by x.created_at), '[]'::jsonb) into v_ws from (
    select w.id, w.name, w.created_at,
           (select s.value ->> 'email' from public.app_settings s where s.workspace_id = w.id and s.key = 'owner_email') as owner_email,
           (select p.email from public.profiles p where p.workspace_id = w.id and p.is_owner limit 1) as owner_joined,
           (select count(*) from public.profiles p where p.workspace_id = w.id and p.status = 'active') as members,
           (select count(*) from public.profiles p where p.workspace_id = w.id and p.status = 'pending') as pending,
           (select count(*) from public.invites i where i.workspace_id = w.id) as invites,
           (select (s.value ->> 'completed_at') is not null from public.app_settings s where s.workspace_id = w.id and s.key = 'onboarding') as setup_done,
           (select count(*) from public.workspace_documents d where d.workspace_id = w.id) as documents,
           (select count(*) from public.leads l where l.workspace_id = w.id and not coalesce(l.archived, false)) as leads,
           (select count(*) from public.leads l where l.workspace_id = w.id and l.created_at >= v_week) as leads_7d,
           (select count(*) from public.calls c where c.workspace_id = w.id and c.logged_at >= v_week) as calls_7d,
           (select count(*) from public.meetings m where m.workspace_id = w.id and m.created_at >= v_week) as meetings_7d,
           (select count(*) from public.research_queue q where q.workspace_id = w.id and q.status in ('pending', 'running')) as queue_open,
           (select count(*) from public.research_queue q where q.workspace_id = w.id and q.status = 'failed' and q.updated_at >= v_week) as queue_failed_7d,
           coalesce((select jsonb_agg(distinct c.provider) from public.integration_connections c
                      where c.workspace_id = w.id and c.status = 'connected' and c.user_id is null), '[]'::jsonb) as connected,
           coalesce((select jsonb_agg(distinct c.provider) from public.integration_connections c
                      where c.workspace_id = w.id and c.status = 'error'), '[]'::jsonb) as errors,
           w.worker_token_sha256 is not null as worker_token,
           (select jsonb_build_object('input', coalesce(sum(u.input_tokens), 0), 'output', coalesce(sum(u.output_tokens), 0),
                                      'searches', coalesce(sum(u.web_searches), 0), 'calls', coalesce(sum(u.calls), 0))
              from public.claude_usage u where u.workspace_id = w.id and u.day >= v_month) as ai_month,
           (select s.value from public.app_settings s where s.workspace_id = w.id and s.key = 'ai_budget') as ai_budget,
           greatest((select max(a.at) from public.audit_log a where a.workspace_id = w.id),
                    (select max(p.signed_in_at) from public.profiles p where p.workspace_id = w.id),
                    (select max(c.logged_at) from public.calls c where c.workspace_id = w.id)) as last_active
      from public.workspaces w
  ) x;

  return jsonb_build_object(
    'owner', public.product_owner_email(),
    'signup', coalesce((select value from public.platform_settings where key = 'signup'), '{"open": false, "allow": []}'::jsonb),
    'admins', coalesce((select value -> 'emails' from public.platform_settings where key = 'admins'), '[]'::jsonb),
    'workspaces', v_ws,
    'audit', coalesce((select jsonb_agg(a order by a.at desc) from (select * from public.platform_audit order by at desc limit 40) a), '[]'::jsonb)
  );
end;
$$;

-- Open or close self-serve sign-up, and keep the list of addresses that may sign up while it's closed.
create or replace function public.platform_set_signup(p_open boolean, p_allow text[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_allow jsonb;
  v_bad   text;
begin
  perform public.platform_require_owner();
  select e into v_bad from unnest(coalesce(p_allow, '{}')) e where lower(btrim(e)) !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' limit 1;
  if v_bad is not null then
    raise exception '% is not an email address', v_bad using errcode = '22023';
  end if;
  select coalesce(jsonb_agg(distinct lower(btrim(e))), '[]'::jsonb) into v_allow from unnest(coalesce(p_allow, '{}')) e;
  insert into public.platform_settings (key, value, updated_at)
  values ('signup', jsonb_build_object('open', coalesce(p_open, false), 'allow', v_allow), now())
  on conflict (key) do update set value = excluded.value, updated_at = now();
  perform public.platform_log('signup.set', '', case when p_open then 'open' else 'closed' end || ', ' || jsonb_array_length(v_allow) || ' allowed');
  return (select value from public.platform_settings where key = 'signup');
end;
$$;

-- Platform admins (besides the owner, who always is one) may change the shared OAuth apps, the Exa key and the
-- scheduled jobs. They can't open this console.
create or replace function public.platform_set_admins(p_emails text[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_list jsonb;
  v_bad  text;
begin
  perform public.platform_require_owner();
  select e into v_bad from unnest(coalesce(p_emails, '{}')) e where lower(btrim(e)) !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' limit 1;
  if v_bad is not null then
    raise exception '% is not an email address', v_bad using errcode = '22023';
  end if;
  select jsonb_agg(distinct x) into v_list
    from (select lower(btrim(e)) x from unnest(coalesce(p_emails, '{}')) e
          union select public.product_owner_email()) s;
  insert into public.platform_settings (key, value, updated_at)
  values ('admins', jsonb_build_object('emails', v_list), now())
  on conflict (key) do update set value = excluded.value, updated_at = now();
  perform public.platform_log('admins.set', '', jsonb_array_length(v_list) || ' platform admins');
  return v_list;
end;
$$;

-- The product owner may seed the workspaces the console creates; everyone else signed in still may not.
create or replace function public.seed_workspace(p_workspace uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null and not public.is_product_owner() then
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

-- Seeding a new workspace inserts its super_admin role; the product owner may do that, nobody else signed in may.
create or replace function public.guard_roles()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.id = 'super_admin' and auth.uid() is not null and not public.is_product_owner() then
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

-- A workspace for a new customer. Whoever signs up with p_owner_email becomes its owner (see signup_plan), so
-- customers can be brought on while self-serve sign-up stays closed.
create or replace function public.platform_create_workspace(p_name text, p_owner_email text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name  text := btrim(coalesce(p_name, ''));
  v_email text := lower(btrim(coalesce(p_owner_email, '')));
  v_id    uuid;
begin
  perform public.platform_require_owner();
  if length(v_name) not between 1 and 120 then
    raise exception 'Name the workspace (up to 120 characters)' using errcode = '22023';
  end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'Give the owner''s email address' using errcode = '22023';
  end if;
  if exists (select 1 from public.profiles p where lower(p.email) = v_email) then
    raise exception '% already belongs to a workspace', v_email using errcode = '23505';
  end if;
  if exists (select 1 from public.app_settings s where s.key = 'owner_email' and lower(s.value ->> 'email') = v_email) then
    raise exception '% is already the owner of a workspace', v_email using errcode = '23505';
  end if;
  insert into public.workspaces (name, created_by) values (v_name, auth.uid()) returning id into v_id;
  perform public.seed_workspace(v_id);
  insert into public.app_settings (workspace_id, key, value) values (v_id, 'owner_email', jsonb_build_object('email', v_email))
  on conflict (workspace_id, key) do update set value = excluded.value;
  perform public.platform_log('workspace.create', v_name, 'owner ' || v_email);
  return v_id;
end;
$$;

-- Rename a workspace, or change the address that may claim it while nobody has.
create or replace function public.platform_update_workspace(p_id uuid, p_name text, p_owner_email text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name  text := btrim(coalesce(p_name, ''));
  v_email text := lower(btrim(coalesce(p_owner_email, '')));
  v_old   text;
begin
  perform public.platform_require_owner();
  select name into v_old from public.workspaces where id = p_id;
  if v_old is null then
    raise exception 'Workspace not found' using errcode = 'P0002';
  end if;
  if length(v_name) not between 1 and 120 then
    raise exception 'Name the workspace (up to 120 characters)' using errcode = '22023';
  end if;
  update public.workspaces set name = v_name where id = p_id;
  if v_email <> '' and v_email is distinct from (select lower(value ->> 'email') from public.app_settings where workspace_id = p_id and key = 'owner_email') then
    if exists (select 1 from public.profiles p where p.workspace_id = p_id and p.is_owner) then
      raise exception 'This workspace''s owner has already joined; ownership moves inside the workspace' using errcode = '22023';
    end if;
    if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
      raise exception 'Give the owner''s email address' using errcode = '22023';
    end if;
    if exists (select 1 from public.profiles p where lower(p.email) = v_email) then
      raise exception '% already belongs to a workspace', v_email using errcode = '23505';
    end if;
    insert into public.app_settings (workspace_id, key, value) values (p_id, 'owner_email', jsonb_build_object('email', v_email))
    on conflict (workspace_id, key) do update set value = excluded.value;
    perform public.platform_log('workspace.owner', v_name, v_email);
  end if;
  if v_name <> v_old then
    perform public.platform_log('workspace.rename', v_old, v_name);
  end if;
end;
$$;

revoke all on function public.platform_overview() from public, anon;
revoke all on function public.platform_set_signup(boolean, text[]) from public, anon;
revoke all on function public.platform_set_admins(text[]) from public, anon;
revoke all on function public.platform_create_workspace(text, text) from public, anon;
revoke all on function public.platform_update_workspace(uuid, text, text) from public, anon;
grant execute on function public.platform_overview() to authenticated;
grant execute on function public.platform_set_signup(boolean, text[]) to authenticated;
grant execute on function public.platform_set_admins(text[]) to authenticated;
grant execute on function public.platform_create_workspace(text, text) to authenticated;
grant execute on function public.platform_update_workspace(uuid, text, text) to authenticated;

-- The owner is on the admin list in every environment.
update public.platform_settings
   set value = jsonb_build_object('emails', (select jsonb_agg(distinct x) from (
                 select jsonb_array_elements_text(coalesce(value -> 'emails', '[]'::jsonb)) x
                 union select public.product_owner_email()) s)),
       updated_at = now()
 where key = 'admins';
