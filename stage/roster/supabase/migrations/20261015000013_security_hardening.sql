-- Security hardening.
--   1. Private by default: signed-out callers (the anon role, which is all the public publishable key grants)
--      get no table access at all, so a future RLS slip cannot expose data. Signed-in users lose TRUNCATE,
--      REFERENCES and TRIGGER, which RLS does not govern and the app never uses.
--   2. Owner protection: nobody can remove, suspend or re-role the product owner. The owner can leave, and
--      ownership then passes to the longest-standing active Super Admin.
--   3. Dashboard access: Viewer, Admin and Super Admin keep view_dashboard; SDR loses it by default. The
--      permission stays editable per role in Admin > Roles and permissions.

-- 1 ---------------------------------------------------------------------------------------------------------
revoke all on all tables    in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke truncate, references, trigger on all tables in schema public from authenticated;

alter default privileges for role postgres in schema public revoke all on tables    from anon;
alter default privileges for role postgres in schema public revoke all on sequences from anon;
alter default privileges for role postgres in schema public revoke all on functions from anon, public;
alter default privileges for role postgres in schema public revoke truncate, references, trigger on tables from authenticated;

-- 2 ---------------------------------------------------------------------------------------------------------
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
     where role = 'super_admin' and status = 'active' and id <> new.id;
    if v_count >= v_limit then
      raise exception 'Super admin limit of % reached', v_limit using errcode = '42501';
    end if;
  end if;

  new.updated_at := now();
  return new;
end;
$$;
revoke execute on function public.guard_profiles() from public, anon, authenticated;

-- The owner leaves the roster. Ownership passes to the longest-standing other active Super Admin; with none,
-- the owner is told to make one first, so the roster is never left without an owner.
create or replace function public.owner_leave()
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_next uuid;
begin
  if v_uid is null or not exists (select 1 from public.profiles where id = v_uid and is_owner) then
    raise exception 'Only the owner can leave this way' using errcode = '42501';
  end if;
  select id into v_next from public.profiles
   where role = 'super_admin' and status = 'active' and id <> v_uid
   order by created_at
   limit 1;
  if v_next is null then
    raise exception 'Make someone else an active Super Admin first. They become the owner when you leave.' using errcode = 'P0001';
  end if;
  perform set_config('roster.owner_handover', v_uid::text, true);
  update public.profiles set is_owner = false where id = v_uid;
  update public.profiles set is_owner = true  where id = v_next;
  insert into public.audit_log (actor, action, target, detail)
  values (v_uid, 'owner left', v_next::text, 'ownership passed on');
  delete from public.profiles where id = v_uid;
  perform set_config('roster.owner_handover', '', true);
  return v_next;
end;
$$;
revoke execute on function public.owner_leave() from public, anon;
grant  execute on function public.owner_leave() to authenticated, service_role;

-- 3 ---------------------------------------------------------------------------------------------------------
update public.roles set perms = array_remove(perms, 'view_dashboard') where id = 'sdr';
update public.roles set perms = perms || array['view_dashboard'] where id in ('viewer', 'admin') and not ('view_dashboard' = any(perms));

-- Removing a user (or the owner leaving) unassigns their contacts instead of failing on the foreign key.
alter table public.leads drop constraint if exists leads_assigned_to_fkey;
alter table public.leads add constraint leads_assigned_to_fkey
  foreign key (assigned_to) references public.profiles(id) on delete set null;
