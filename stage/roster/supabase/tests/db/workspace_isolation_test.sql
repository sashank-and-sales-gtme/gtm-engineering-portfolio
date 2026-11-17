-- Workspace isolation: two workspaces hold the same lead id; each Super Admin sees, changes and calls functions on
-- their own workspace only.
-- Run: supabase test db supabase/tests/db
begin;
select plan(21);

insert into public.workspaces (id, name) values
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'A Co'),
  ('bbbbbbbb-0000-4000-8000-00000000000b', 'B Co');
select public.seed_workspace(id) from public.workspaces where name in ('A Co', 'B Co');
insert into public.app_settings (workspace_id, key, value) values
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'owner_email', '{"email": "alice@a.example"}'),
  ('bbbbbbbb-0000-4000-8000-00000000000b', 'owner_email', '{"email": "bob@b.example"}'),
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'profile', '{"company_name": "A Co"}'),
  ('bbbbbbbb-0000-4000-8000-00000000000b', 'profile', '{"company_name": "B Co"}');

insert into auth.users (id, email, instance_id, aud, role) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'alice@a.example', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
  ('bbbbbbbb-0000-4000-8000-000000000001', 'bob@b.example',   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated');

select is((select workspace_id || '/' || role || '/' || is_owner from public.profiles where email = 'bob@b.example'),
          'bbbbbbbb-0000-4000-8000-00000000000b/super_admin/true', 'each owner joins their own workspace as Super Admin');

-- The same Apollo person in both workspaces.
insert into public.leads (workspace_id, id, name, company, assigned_to) values
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'p1', 'Pat (A)', 'Shared Corp', 'aaaaaaaa-0000-4000-8000-000000000001'),
  ('bbbbbbbb-0000-4000-8000-00000000000b', 'p1', 'Pat (B)', 'Shared Corp', 'bbbbbbbb-0000-4000-8000-000000000001');
insert into public.calls (id, workspace_id, lead_id, owner, outcome, at) values
  ('cccccccc-0000-4000-8000-00000000000b', 'bbbbbbbb-0000-4000-8000-00000000000b', 'p1', 'bbbbbbbb-0000-4000-8000-000000000001', 'no', now());

select throws_ok(
  $$ insert into public.calls (workspace_id, lead_id, owner, outcome, at)
     values ('aaaaaaaa-0000-4000-8000-00000000000a', 'nobody', 'aaaaaaaa-0000-4000-8000-000000000001', 'no', now()) $$,
  '23503', null, 'a call must point at a lead in its own workspace');
select throws_ok(
  $$ update public.leads set assigned_to = 'bbbbbbbb-0000-4000-8000-000000000001' where workspace_id = 'aaaaaaaa-0000-4000-8000-00000000000a' $$,
  '42501', null, 'a lead cannot be assigned to someone in another workspace');

-- Act as Alice.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "aaaaaaaa-0000-4000-8000-000000000001", "role": "authenticated", "email": "alice@a.example"}', true);

select is(public.current_workspace_id(), 'aaaaaaaa-0000-4000-8000-00000000000a'::uuid, 'Alice''s workspace is A');
select is((select count(*)::int from public.leads), 1, 'Alice sees one lead');
select is((select name from public.leads), 'Pat (A)', 'and it is her own workspace''s copy');
select is((select value ->> 'company_name' from public.app_settings where key = 'profile'), 'A Co', 'settings are her workspace''s');
select is((select count(*)::int from public.app_settings where workspace_id = 'bbbbbbbb-0000-4000-8000-00000000000b'), 0, 'no settings from B');
select is((select count(*)::int from public.profiles), 1, 'she sees only her own workspace''s people');
select is((select count(*)::int from public.calls), 0, 'no calls from B');
select is((select count(*)::int from public.roles where workspace_id = 'bbbbbbbb-0000-4000-8000-00000000000b'), 0, 'no roles from B');
select is((select string_agg(name, ',') from public.workspaces), 'A Co', 'she sees only her workspace');

select throws_ok(
  $$ insert into public.invites (workspace_id, email, role) values ('bbbbbbbb-0000-4000-8000-00000000000b', 'mole@x.example', 'sdr') $$,
  '42501', null, 'she cannot invite people into B');
select lives_ok($$ insert into public.invites (email, role) values ('teammate@a.example', 'sdr') $$, 'she can invite into her own workspace');
select is((select workspace_id from public.invites where email = 'teammate@a.example'), 'aaaaaaaa-0000-4000-8000-00000000000a'::uuid,
          'new rows default to her workspace');

update public.leads set name = 'Hijacked' where workspace_id = 'bbbbbbbb-0000-4000-8000-00000000000b';
update public.app_settings set value = '{}' where workspace_id = 'bbbbbbbb-0000-4000-8000-00000000000b';

select throws_ok($$ select public.undo_call('cccccccc-0000-4000-8000-00000000000b') $$, 'P0002', null,
                 'she cannot undo a call in B');
select lives_ok($$ select public.set_lead_dq('p1', true, 'test') $$, 'disqualifying p1 works on her copy');
select throws_ok($$ select * from public.list_cron_jobs() $$, '42501', null, 'workspace admins cannot see the platform scheduler');
select is((select spent_usd from public.ai_spend_this_month('bbbbbbbb-0000-4000-8000-00000000000b')), 0.0000::numeric,
          'asking for B''s AI spend returns her own');

reset role;

select is((select name || '/' || coalesce(dq_reason, '-') from public.leads where workspace_id = 'bbbbbbbb-0000-4000-8000-00000000000b' and id = 'p1'),
          'Pat (B)/-', 'B''s lead was neither renamed nor disqualified');
select is((select value ->> 'company_name' from public.app_settings where workspace_id = 'bbbbbbbb-0000-4000-8000-00000000000b' and key = 'profile'),
          'B Co', 'B''s settings are untouched');

select * from finish();
rollback;
