-- Stage Prospect: RBAC, auth triggers, RLS policies and RPCs.
--
-- Convention: checks are skipped when auth.uid() is null. That is the case for
-- the service role (edge functions), the auth.users sign-up triggers and SQL run
-- by the project owner in the dashboard. Browser sessions always carry a uid.

-- ===========================================================================
-- Helper functions
-- ===========================================================================

create or replace function public.my_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select p.role
  from public.profiles p
  where p.id = auth.uid()
    and p.status = 'active'
$$;

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
      where r.id = public.my_role()
        and p = any(r.perms)
    ),
    false)
$$;

create or replace function public.is_active_member()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.status = 'active'
      and p.role is not null
  )
$$;

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
    and l.company is not null
$$;

-- Small internal helper: read an app_settings value with a fallback.
create or replace function public.setting_text(p_key text, p_field text, p_default text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select s.value ->> p_field from public.app_settings s where s.key = p_key),
    p_default)
$$;

-- ===========================================================================
-- auth.users triggers
-- ===========================================================================

-- BEFORE INSERT: sign-up is by invitation. The owner and anyone with a pending invite may create an account. If an
-- allowed domain is set (app setting allowed_domain), anyone at that domain may also sign up and waits for a role.
create or replace function public.enforce_allowed_domain()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email  text := lower(coalesce(new.email, ''));
  v_owner  text := lower(public.setting_text('owner_email', 'email', ''));
  v_domain text := lower(public.setting_text('allowed_domain', 'domain', ''));
begin
  if v_email = '' then
    raise exception 'Sign-in needs an email address' using errcode = '42501';
  end if;
  if v_owner <> '' and v_email = v_owner then
    return new;
  end if;
  if exists (select 1 from public.invites where lower(email) = v_email) then
    return new;
  end if;
  if v_domain <> '' and v_email like '%@' || v_domain then
    return new;
  end if;
  raise exception 'Sign-in is by invitation only. Ask an admin to invite %', v_email
    using errcode = '42501';
end;
$$;

drop trigger if exists enforce_allowed_domain on auth.users;
create trigger enforce_allowed_domain
  before insert on auth.users
  for each row execute function public.enforce_allowed_domain();

-- AFTER INSERT: create the profile, consume an invite, bootstrap the owner.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email      text := lower(new.email);
  v_owner      text := lower(public.setting_text('owner_email', 'email', ''));
  v_limit      int  := coalesce(public.setting_text('super_admin_limit', 'limit', '2')::int, 2);
  v_role       text := null;
  v_status     text := 'pending';
  v_is_owner   boolean := false;
  v_added_by   uuid := null;
  v_invite     public.invites%rowtype;
  v_sa_count   int;
begin
  select count(*) into v_sa_count
  from public.profiles
  where role = 'super_admin' and status = 'active';

  if v_email = v_owner then
    v_role := 'super_admin';
    v_status := 'active';
    v_is_owner := true;
  else
    select * into v_invite from public.invites where lower(email) = v_email;
    if found then
      v_added_by := v_invite.created_by;
      if v_invite.role is not null
         and (v_invite.role <> 'super_admin' or v_sa_count < v_limit) then
        v_role := v_invite.role;
        v_status := 'active';
      end if;
      delete from public.invites where lower(email) = v_email;
    end if;
  end if;

  insert into public.profiles (id, email, full_name, avatar_url, role, status, is_owner, added_by)
  values (
    new.id,
    v_email,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
    coalesce(new.raw_user_meta_data ->> 'avatar_url', new.raw_user_meta_data ->> 'picture'),
    v_role,
    v_status,
    v_is_owner,
    v_added_by
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ===========================================================================
-- guard_profiles
-- ===========================================================================
create or replace function public.guard_profiles()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_me     text := public.my_role();
  v_limit  int  := coalesce(public.setting_text('super_admin_limit', 'limit', '2')::int, 2);
  v_count  int;
begin
  if tg_op = 'DELETE' then
    if old.is_owner then
      raise exception 'The owner account cannot be removed' using errcode = '42501';
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
  else -- UPDATE
    new.id := old.id;
    new.created_at := old.created_at;

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
      if old.id = v_uid and (new.role is distinct from old.role
                             or new.status is distinct from old.status) then
        raise exception 'You cannot change your own role or status' using errcode = '42501';
      end if;
      if (new.role = 'super_admin' or old.role = 'super_admin')
         and (new.role is distinct from old.role or new.status is distinct from old.status)
         and coalesce(v_me, '') <> 'super_admin' then
        raise exception 'Only a super admin can grant or revoke super admin' using errcode = '42501';
      end if;
    end if;
  end if;

  -- super admin seat limit (always enforced)
  if new.role = 'super_admin' and new.status = 'active'
     and (tg_op = 'INSERT' or old.role is distinct from 'super_admin' or old.status <> 'active') then
    select count(*) into v_count
    from public.profiles
    where role = 'super_admin' and status = 'active' and id <> new.id;
    if v_count >= v_limit then
      raise exception 'Super admin limit of % reached', v_limit using errcode = '42501';
    end if;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists guard_profiles on public.profiles;
create trigger guard_profiles
  before insert or update or delete on public.profiles
  for each row execute function public.guard_profiles();

-- ===========================================================================
-- guard_roles
-- ===========================================================================
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
    if exists (select 1 from public.profiles where role = old.id) then
      raise exception 'Role % is still assigned to users', old.id using errcode = '23503';
    end if;
    delete from public.invites where role = old.id;
    return old;
  end if;

  if new.id is distinct from old.id then
    raise exception 'Role id cannot be changed' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists guard_roles on public.roles;
create trigger guard_roles
  before insert or update or delete on public.roles
  for each row execute function public.guard_roles();

-- research_queue.updated_at
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists research_queue_touch on public.research_queue;
create trigger research_queue_touch
  before update on public.research_queue
  for each row execute function public.touch_updated_at();

drop trigger if exists app_settings_touch on public.app_settings;
create trigger app_settings_touch
  before update on public.app_settings
  for each row execute function public.touch_updated_at();

-- ===========================================================================
-- RLS policies
-- ===========================================================================

-- roles ---------------------------------------------------------------------
drop policy if exists roles_select on public.roles;
create policy roles_select on public.roles
  for select to authenticated
  using (public.is_active_member());

drop policy if exists roles_insert on public.roles;
create policy roles_insert on public.roles
  for insert to authenticated
  with check (public.is_active_member() and public.has_perm('manage_roles'));

drop policy if exists roles_update on public.roles;
create policy roles_update on public.roles
  for update to authenticated
  using (public.is_active_member() and public.has_perm('manage_roles'))
  with check (public.is_active_member() and public.has_perm('manage_roles'));

drop policy if exists roles_delete on public.roles;
create policy roles_delete on public.roles
  for delete to authenticated
  using (public.is_active_member() and public.has_perm('manage_roles'));

-- profiles ------------------------------------------------------------------
-- Any signed-in user can read their own row (so a pending user sees "Access needed").
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated
  using (public.is_active_member() or id = auth.uid());

drop policy if exists profiles_insert on public.profiles;
create policy profiles_insert on public.profiles
  for insert to authenticated
  with check (public.is_active_member() and public.has_perm('manage_users'));

drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles
  for update to authenticated
  using (public.is_active_member() and public.has_perm('manage_users'))
  with check (public.is_active_member() and public.has_perm('manage_users'));

drop policy if exists profiles_delete on public.profiles;
create policy profiles_delete on public.profiles
  for delete to authenticated
  using (public.is_active_member() and public.has_perm('manage_users'));

-- invites -------------------------------------------------------------------
drop policy if exists invites_all on public.invites;
create policy invites_all on public.invites
  for all to authenticated
  using (public.is_active_member() and public.has_perm('manage_users'))
  with check (
    public.is_active_member() and public.has_perm('manage_users')
    and (role is distinct from 'super_admin' or public.my_role() = 'super_admin')
  );

-- app_settings --------------------------------------------------------------
drop policy if exists app_settings_select on public.app_settings;
create policy app_settings_select on public.app_settings
  for select to authenticated
  using (public.is_active_member());

drop policy if exists app_settings_insert on public.app_settings;
create policy app_settings_insert on public.app_settings
  for insert to authenticated
  with check (public.is_active_member() and public.has_perm('manage_integrations'));

drop policy if exists app_settings_update on public.app_settings;
create policy app_settings_update on public.app_settings
  for update to authenticated
  using (public.is_active_member() and (
    public.has_perm('manage_integrations')
    or (key = 'booking_link' and public.has_perm('manage_meetings'))))
  with check (public.is_active_member() and (
    public.has_perm('manage_integrations')
    or (key = 'booking_link' and public.has_perm('manage_meetings'))));

drop policy if exists app_settings_delete on public.app_settings;
create policy app_settings_delete on public.app_settings
  for delete to authenticated
  using (public.is_active_member() and public.has_perm('manage_integrations'));

-- leads (insert/delete: service role only, so no policies for those) --------
drop policy if exists leads_select on public.leads;
create policy leads_select on public.leads
  for select to authenticated
  using (public.is_active_member() and (
    public.has_perm('view_all_accounts')
    or lower(company) in (select public.my_account_companies())));

drop policy if exists leads_update on public.leads;
create policy leads_update on public.leads
  for update to authenticated
  using (public.is_active_member() and (
    public.has_perm('work_any_lead')
    or public.has_perm('assign_leads')
    or (assigned_to = auth.uid() and public.has_perm('work_leads'))))
  with check (public.is_active_member() and (
    public.has_perm('work_any_lead')
    or public.has_perm('assign_leads')
    or (assigned_to = auth.uid() and public.has_perm('work_leads'))));

-- owner-scoped activity tables ----------------------------------------------
do $do$
declare
  t text;
begin
  foreach t in array array['calls','callbacks','meetings','tasks','journeys','add_requests'] loop
    execute format('drop policy if exists %1$s_select on public.%1$I', t);
    execute format($p$
      create policy %1$s_select on public.%1$I
        for select to authenticated
        using (public.is_active_member()
               and (owner = auth.uid() or public.has_perm('view_all_meetings')))
    $p$, t);

    execute format('drop policy if exists %1$s_insert on public.%1$I', t);
    execute format($p$
      create policy %1$s_insert on public.%1$I
        for insert to authenticated
        with check (public.is_active_member() and owner = auth.uid())
    $p$, t);

    execute format('drop policy if exists %1$s_update on public.%1$I', t);
    execute format($p$
      create policy %1$s_update on public.%1$I
        for update to authenticated
        using (public.is_active_member()
               and (owner = auth.uid() or public.has_perm('view_all_meetings')))
        with check (public.is_active_member()
               and (owner = auth.uid() or public.has_perm('view_all_meetings')))
    $p$, t);

    execute format('drop policy if exists %1$s_delete on public.%1$I', t);
    execute format($p$
      create policy %1$s_delete on public.%1$I
        for delete to authenticated
        using (public.is_active_member()
               and public.has_perm('delete_records')
               and (owner = auth.uid() or public.has_perm('view_all_meetings')))
    $p$, t);
  end loop;
end
$do$;

-- task_order: own row only --------------------------------------------------
drop policy if exists task_order_own on public.task_order;
create policy task_order_own on public.task_order
  for all to authenticated
  using (public.is_active_member() and user_id = auth.uid())
  with check (public.is_active_member() and user_id = auth.uid());

-- audit_log -----------------------------------------------------------------
drop policy if exists audit_log_insert on public.audit_log;
create policy audit_log_insert on public.audit_log
  for insert to authenticated
  with check (public.is_active_member() and actor = auth.uid());

drop policy if exists audit_log_select on public.audit_log;
create policy audit_log_select on public.audit_log
  for select to authenticated
  using (public.is_active_member() and public.has_perm('view_audit'));

-- research_queue: no policies (service role bypasses RLS).

-- ===========================================================================
-- RPC: undo_call
-- ===========================================================================
create or replace function public.undo_call(p_call_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_call    public.calls%rowtype;
  v_cal_id  text := null;
  v_prev    jsonb;
begin
  if not public.is_active_member() then
    raise exception 'Not allowed' using errcode = '42501';
  end if;

  select * into v_call from public.calls where id = p_call_id for update;
  if not found then
    raise exception 'Call not found' using errcode = 'P0002';
  end if;

  if not (v_call.owner = auth.uid()
          or (public.has_perm('view_all_meetings') and public.has_perm('delete_records'))) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;

  -- meeting booked by this call
  if v_call.meeting_id is not null then
    delete from public.meetings where id = v_call.meeting_id;
  end if;
  delete from public.meetings where call_id = v_call.id;

  -- callback created by this call
  if v_call.new_callback_id is not null then
    delete from public.callbacks
    where id = v_call.new_callback_id
    returning cal_event_id into v_cal_id;
  end if;

  -- callback closed by this call goes back to open
  if v_call.closed_callback_id is not null then
    update public.callbacks
       set status = 'open', outcome = null, done_at = null, call_id = null
     where id = v_call.closed_callback_id;
  end if;

  -- restore lead state
  v_prev := v_call.prev_lead;
  if v_call.lead_id is not null and v_prev is not null then
    update public.leads
       set stage        = v_prev ->> 'stage',
           last_outcome = v_prev ->> 'last_outcome',
           last_call_at = nullif(v_prev ->> 'last_call_at', '')::timestamptz
     where id = v_call.lead_id;
  end if;

  delete from public.calls where id = v_call.id;

  return jsonb_build_object('deleted_callback_cal_event_id', v_cal_id);
end;
$$;

-- ===========================================================================
-- RPC: cron job listing / toggling (Admin > Integrations)
-- ===========================================================================
create or replace function public.list_cron_jobs()
returns table (jobid bigint, jobname text, schedule text, active boolean, command text)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not (public.has_perm('manage_integrations') or coalesce(auth.role(), '') = 'service_role') then
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
  if not (public.has_perm('manage_integrations') or coalesce(auth.role(), '') = 'service_role') then
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

-- ===========================================================================
-- RPC: claim_research_rows (research-worker, service role only)
-- Claims pending rows, plus rows stuck in 'running' for 15+ minutes with
-- fewer than 3 attempts, using FOR UPDATE SKIP LOCKED.
-- ===========================================================================
create or replace function public.claim_research_rows(n int)
returns setof public.research_queue
language sql
security definer
set search_path = public
as $$
  update public.research_queue q
     set status = 'running',
         attempts = q.attempts + 1,
         updated_at = now()
   where q.id in (
     select r.id
     from public.research_queue r
     where r.status = 'pending'
        or (r.status = 'running' and r.updated_at < now() - interval '15 minutes' and r.attempts < 3)
     order by r.created_at
     limit greatest(coalesce(n, 3), 0)
     for update skip locked
   )
  returning q.*
$$;

-- ===========================================================================
-- Function privileges
-- ===========================================================================
revoke execute on function public.claim_research_rows(int) from public, anon, authenticated;
grant  execute on function public.claim_research_rows(int) to service_role;

revoke execute on function public.list_cron_jobs() from public, anon;
revoke execute on function public.set_cron_job_active(text, boolean) from public, anon;
revoke execute on function public.undo_call(uuid) from public, anon;
grant  execute on function public.list_cron_jobs() to authenticated, service_role;
grant  execute on function public.set_cron_job_active(text, boolean) to authenticated, service_role;
grant  execute on function public.undo_call(uuid) to authenticated, service_role;

revoke execute on function public.enforce_allowed_domain() from public, anon, authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.setting_text(text, text, text) from public, anon;
