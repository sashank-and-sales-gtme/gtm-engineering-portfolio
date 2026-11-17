-- Minimal stand-ins for the Supabase pieces the lead distribution migration touches, so its SQL can run on a
-- plain Postgres in CI. Only the columns and functions that migration uses are here.
create schema if not exists auth;
create schema if not exists cron;
create or replace function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
create table cron.job (jobid serial primary key, jobname text unique, schedule text, command text);
create or replace function cron.schedule(n text, s text, c text) returns bigint language sql as
  $$ insert into cron.job (jobname, schedule, command) values (n, s, c) returning jobid $$;
create or replace function cron.unschedule(n text) returns boolean language sql as
  $$ delete from cron.job where jobname = n returning true $$;
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
end $$;

create table public.profiles (
  id uuid primary key, email text not null unique, full_name text, role text,
  status text not null default 'pending'
);
create table public.roles (id text primary key, perms text[] not null default '{}');
create or replace function public.has_perm(p text) returns boolean language sql stable as $$
  select exists (select 1 from public.profiles pr left join public.roles r on r.id = pr.role
                 where pr.id = auth.uid() and (pr.role = 'super_admin' or p = any(r.perms)))
$$;
create or replace function public.is_active_member() returns boolean language sql stable as $$
  select exists (select 1 from public.profiles where id = auth.uid() and status = 'active' and role is not null)
$$;
create table public.rep_settings (
  user_id uuid primary key references public.profiles(id), in_rotation boolean not null default false,
  weekly_accounts int not null default 100,
  employees_min int, employees_max int, revenue_min bigint, revenue_max bigint, funding_min bigint, funding_max bigint
);
create table public.leads (
  id text primary key, name text, company text, domain text, employees text,
  assigned_to uuid references public.profiles(id), assigned_at timestamptz, assigned_by uuid,
  archived boolean default false, dq_at timestamptz, lost_at timestamptz
);
create table public.audit_log (
  id serial primary key, at timestamptz default now(), actor uuid, action text, target text, detail text
);
