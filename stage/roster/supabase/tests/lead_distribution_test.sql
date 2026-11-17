-- Tests for 20261021000023_lead_distribution.sql. Run after tests/stubs.sql and the migration:
--   psql -v ON_ERROR_STOP=1 -f tests/stubs.sql -f migrations/20261021000023_lead_distribution.sql -f tests/lead_distribution_test.sql
\set QUIET on

-- Headcount parsing ---------------------------------------------------------
do $$ begin
  assert public.employee_range('251-1000 (Apollo filter; per-record bucket not returned)') = int8range(251, 1000, '[]'), 'range with note';
  assert public.employee_range('251-500 (Apollo); Tracxn says 234') = int8range(251, 500, '[]'), 'first range wins';
  assert public.employee_range('1,001+') = int8range(1001, null), 'open-ended';
  assert public.employee_range('about 300') = int8range(300, 300, '[]'), 'single number';
  assert public.employee_range('1000 – 250') = int8range(250, 1000, '[]'), 'reversed, en dash';
  assert public.employee_range('') is null and public.employee_range(null) is null, 'nothing to read';
  raise notice 'ok employee_range';
end $$;

-- Segment matching ----------------------------------------------------------
do $$ begin
  assert public.segment_matches(250, 1500, 10000000, null, null, null, int8range(251, 1000, '[]'), null, null), 'overlap, revenue unknown';
  assert not public.segment_matches(1501, 5000, null, null, null, null, int8range(251, 1000, '[]'), null, null), 'below segment';
  assert public.segment_matches(250, 1500, null, null, null, null, null, null, null), 'unknown headcount never rules out';
  assert not public.segment_matches(null, null, null, null, null, null, int8range(10, 50, '[]'), null, null), 'default floor is 250';
  assert not public.segment_matches(null, null, null, null, null, null, int8range(3000, null), null, null), 'default ceiling is 2500';
  assert not public.segment_matches(null, null, 10000000, null, null, null, null, 5000000, null), 'revenue under the minimum';
  assert public.segment_matches(null, null, 10000000, 50000000, null, null, null, 20000000, null), 'revenue inside';
  assert not public.segment_matches(null, null, null, null, null, 1000000, null, null, 2000000), 'funding over the maximum';
  raise notice 'ok segment_matches';
end $$;

-- Fixtures ------------------------------------------------------------------
-- a and b share a segment; c covers big companies; d owns a company but is out of rotation; e is suspended.
insert into public.roles values ('sdr', '{work_leads}'), ('manager', '{assign_leads}');
insert into public.profiles (id, email, full_name, role, status) values
  ('00000000-0000-0000-0000-00000000000a', 'a@x', 'Asha',  'sdr', 'active'),
  ('00000000-0000-0000-0000-00000000000b', 'b@x', 'Bilal', 'sdr', 'active'),
  ('00000000-0000-0000-0000-00000000000c', 'c@x', 'Chen',  'sdr', 'active'),
  ('00000000-0000-0000-0000-00000000000d', 'd@x', 'Dev',   'sdr', 'active'),
  ('00000000-0000-0000-0000-00000000000e', 'e@x', 'Esme',  'sdr', 'suspended'),
  ('00000000-0000-0000-0000-0000000000ad', 'm@x', 'Mo',    'manager', 'active');

-- Existing load, set before anyone is in rotation so no trigger fires yet.
insert into public.leads (id, company, domain, employees, assigned_to, archived, dq_at) values
  ('a1', 'Alpha', 'alpha.com', '300', '00000000-0000-0000-0000-00000000000a', false, null),
  ('a2', 'Alpha', 'alpha.com', '300', '00000000-0000-0000-0000-00000000000a', false, null),
  ('a3', 'Beta',  'beta.com',  '300', '00000000-0000-0000-0000-00000000000a', false, null),
  ('b1', 'Gone',  'gone.com',  '300', '00000000-0000-0000-0000-00000000000b', true,  null),
  ('b2', 'Dq',    'dq.com',    '300', '00000000-0000-0000-0000-00000000000b', false, now()),
  ('d1', 'Own',   'own.com',   '300', '00000000-0000-0000-0000-00000000000d', false, null),
  -- unassigned pool
  ('x1', 'X', 'x.com', '251-500', null, false, null),
  ('x2', 'X', 'x.com', '251-500', null, false, null),
  ('x3', 'X', 'X.com ', null,     null, false, null),
  ('y1', 'Y', 'y.com', '501-1000 (Apollo)', null, false, null),
  ('y2', 'Y', 'y.com', '501-1000 (Apollo)', null, false, null),
  ('z1', 'Z', 'z.com', '300', null, false, null),
  ('g1', 'Big', 'big.com', '5,000+', null, false, null),
  ('t1', 'Tiny', 'tiny.com', '10-50', null, false, null),
  ('o1', 'Own', 'own.com', '300', null, false, null),
  ('n1', 'Archived', 'arch.com', '300', null, true, null),
  ('n2', 'Disqualified', 'dis.com', '300', null, false, now()),
  ('n3', 'Lost', 'lost.com', '300', null, false, null);
update public.leads set lost_at = now() where id = 'n3';

-- Out of rotation first, so saving them doesn't distribute yet; then put them in with one statement each
-- and check the trigger only after the dry run.
alter table public.rep_settings disable trigger rep_settings_distribute;
insert into public.rep_settings (user_id, in_rotation, employees_min, employees_max) values
  ('00000000-0000-0000-0000-00000000000a', true,  250, 1000),
  ('00000000-0000-0000-0000-00000000000b', true,  250, 1000),
  ('00000000-0000-0000-0000-00000000000c', true,  2000, 10000),
  ('00000000-0000-0000-0000-00000000000d', false, 250, 1000),
  ('00000000-0000-0000-0000-00000000000e', true,  250, 1000);
alter table public.rep_settings enable trigger rep_settings_distribute;

-- Dry run: plan only -------------------------------------------------------
do $$
declare r jsonb;
begin
  r := public.run_lead_distribution(false, 'test');
  assert (r->>'assigned')::int = 8, 'planned 8, got ' || r::text;
  assert (r->>'unmatched')::int = 1, 'one contact matches no rep: ' || r::text;
  assert r->'unmatched_companies' = '["Tiny"]'::jsonb, 'Tiny is unmatched: ' || r::text;
  assert not exists (select 1 from public.leads where id in ('x1','y1','z1','g1','o1') and assigned_to is not null), 'dry run wrote';
  assert not exists (select 1 from public.audit_log), 'dry run audited';
  raise notice 'ok dry run';
end $$;

-- Apply -----------------------------------------------------------------------
do $$
declare
  r jsonb;
  A uuid := '00000000-0000-0000-0000-00000000000a';
  B uuid := '00000000-0000-0000-0000-00000000000b';
  C uuid := '00000000-0000-0000-0000-00000000000c';
  D uuid := '00000000-0000-0000-0000-00000000000d';
begin
  r := public.run_lead_distribution(true, 'test');
  assert (r->>'assigned')::int = 8, 'assigned ' || r::text;
  -- Biggest company first: B has the lightest load (archived and disqualified don't count), takes X.
  assert (select count(*) from public.leads where id in ('x1','x2','x3') and assigned_to = B) = 3, 'X (incl. domain in other case) to B';
  -- A and B now both hold 3 open contacts; the tie goes to A, so Y lands there.
  assert (select count(*) from public.leads where id in ('y1','y2') and assigned_to = A) = 2, 'Y to A';
  assert (select assigned_to from public.leads where id = 'g1') = C, 'Big to the big-company rep';
  assert (select assigned_to from public.leads where id = 'o1') = D, 'company stays with its owner even out of rotation';
  assert (select assigned_to from public.leads where id = 'z1') = B, 'Z to the lighter of A(5) and B(3)';
  assert (select assigned_to from public.leads where id = 't1') is null, 'no-match stays unassigned';
  assert (select count(*) from public.leads where id in ('n1','n2','n3') and assigned_to is null) = 3, 'archived/dq/lost untouched';
  assert (select count(*) from public.leads where assigned_to = '00000000-0000-0000-0000-00000000000e') = 0, 'suspended rep gets nothing';
  assert (select assigned_to from public.leads where id = 'a3') = A, 'owned lead untouched';
  assert (select count(*) from public.audit_log where action = 'leads.auto_assigned') = 5, 'one audit row per company';
  assert (select count(*) from public.audit_log where action = 'leads.distributed') = 1, 'one summary row';
  r := public.run_lead_distribution(true, 'test');
  assert (r->>'assigned')::int = 0, 'second run is a no-op: ' || r::text;
  raise notice 'ok apply';
end $$;

-- Trigger: a new rep joins the rotation and picks up what now matches ---------
insert into public.profiles (id, email, full_name, role, status) values
  ('00000000-0000-0000-0000-00000000000f', 'f@x', 'Fay', 'sdr', 'active');
insert into public.leads (id, company, domain, employees) values ('s1', 'Small', 'small.com', '20-40');
insert into public.rep_settings (user_id, in_rotation, employees_min, employees_max)
  values ('00000000-0000-0000-0000-00000000000f', false, 1, 100);
do $$ begin
  assert (select assigned_to from public.leads where id = 's1') is null, 'out of rotation: nothing yet';
end $$;
update public.rep_settings set in_rotation = true where user_id = '00000000-0000-0000-0000-00000000000f';
do $$ begin
  assert (select assigned_to from public.leads where id = 's1') = '00000000-0000-0000-0000-00000000000f', 'joined rotation: Small assigned';
  assert (select assigned_to from public.leads where id = 't1') = '00000000-0000-0000-0000-00000000000f', 'joined rotation: Tiny now matches';
  raise notice 'ok rotation trigger';
end $$;

-- Trigger: segment widened ---------------------------------------------------
insert into public.leads (id, company, domain, employees) values ('h1', 'Huge', 'huge.com', '20000');
update public.rep_settings set employees_max = 50000 where user_id = '00000000-0000-0000-0000-00000000000c';
do $$ begin
  assert (select assigned_to from public.leads where id = 'h1') = '00000000-0000-0000-0000-00000000000c', 'segment saved: Huge assigned';
  raise notice 'ok segment trigger';
end $$;

-- Permissions and bulk assign --------------------------------------------------
do $$
declare ok boolean := false; n int;
begin
  perform set_config('test.uid', '00000000-0000-0000-0000-00000000000b', true);
  begin
    perform public.distribute_unassigned_leads(false);
  exception when insufficient_privilege then ok := true;
  end;
  assert ok, 'a rep without assign_leads cannot distribute';

  perform set_config('test.uid', '00000000-0000-0000-0000-0000000000ad', true);
  assert (public.distribute_unassigned_leads(false)->>'assigned')::int = 0, 'manager can preview';
  n := public.assign_leads_bulk(array['x1','x2','y1'], '00000000-0000-0000-0000-00000000000d');
  assert n = 3, 'bulk assigned 3, got ' || n;
  assert (select count(*) from public.leads where id in ('x1','x2','y1') and assigned_to = '00000000-0000-0000-0000-00000000000d') = 3, 'bulk assign wrote';
  assert (select assigned_by from public.leads where id = 'x1') = '00000000-0000-0000-0000-0000000000ad', 'assigned_by recorded';
  assert exists (select 1 from public.audit_log where action = 'leads.bulk_assigned' and target = 'Dev'), 'bulk audited';
  ok := false;
  begin
    perform public.assign_leads_bulk(array['x1'], '00000000-0000-0000-0000-00000000000e');
  exception when no_data_found then ok := true;
  end;
  assert ok, 'cannot bulk assign to a suspended member';
  raise notice 'ok permissions and bulk assign';
end $$;

-- Cron backstop is scheduled ---------------------------------------------------
do $$ begin
  assert exists (select 1 from cron.job where jobname = 'distribute-leads' and schedule = '10 3 * * *'), 'daily job';
  raise notice 'ok cron';
end $$;
