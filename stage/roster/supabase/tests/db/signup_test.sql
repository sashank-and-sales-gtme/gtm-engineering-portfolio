-- Sign-up: the owner claims the starting workspace, invited people join the workspace that invited them, and anyone
-- else is refused until platform sign-ups are opened, when they get a workspace of their own.
-- Run: supabase test db supabase/tests/db
begin;
select plan(12);

\set ws '''00000000-0000-4000-8000-000000000001'''

update public.app_settings set value = '{"email": "owner@example.com"}'::jsonb where workspace_id = :ws and key = 'owner_email';
insert into public.app_settings (workspace_id, key, value) values (:ws, 'owner_email', '{"email": "owner@example.com"}'::jsonb)
  on conflict (workspace_id, key) do nothing;
delete from public.app_settings where key = 'allowed_domain';
update public.platform_settings set value = '{"open": false, "allow": []}'::jsonb where key = 'signup';

create function pg_temp.sign_up(p_email text) returns void language sql as $$
  insert into auth.users (id, email, instance_id, aud, role, raw_user_meta_data)
  values (gen_random_uuid(), p_email, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          '{"workspace_name": "Stranger Co"}'::jsonb);
$$;

select throws_ok($$ select pg_temp.sign_up('stranger@gmail.com') $$, '42501', null, 'an uninvited address is refused');

select lives_ok($$ select pg_temp.sign_up('Owner@Example.com') $$, 'the owner can sign up (any case)');
select is((select role || '/' || status || '/' || is_owner || '/' || workspace_id from public.profiles where email = 'owner@example.com'),
          'super_admin/active/true/00000000-0000-4000-8000-000000000001', 'the owner becomes the active owner Super Admin of the starting workspace');

insert into public.invites (workspace_id, email, role) values (:ws, 'invited@gmail.com', 'sdr');
select lives_ok($$ select pg_temp.sign_up('invited@gmail.com') $$, 'an invited address can sign up');
select is((select role || '/' || status || '/' || workspace_id from public.profiles where email = 'invited@gmail.com'),
          'sdr/active/00000000-0000-4000-8000-000000000001', 'the invite''s role and workspace are applied');
select is((select count(*)::int from public.invites where email = 'invited@gmail.com'), 0, 'the invite is used up');

insert into public.app_settings (workspace_id, key, value) values (:ws, 'allowed_domain', '{"domain": "acme.example"}'::jsonb);
select lives_ok($$ select pg_temp.sign_up('new@acme.example') $$, 'an allowed domain may sign up and wait for a role');
select is((select status || '/' || coalesce(role, '-') from public.profiles where email = 'new@acme.example'),
          'pending/-', 'a domain sign-up waits for a role');

update public.platform_settings set value = '{"open": false, "allow": ["founder@startup.example"]}'::jsonb where key = 'signup';
select lives_ok($$ select pg_temp.sign_up('founder@startup.example') $$, 'an allow-listed address gets a workspace of its own');
select isnt((select workspace_id from public.profiles where email = 'founder@startup.example'), :ws::uuid,
            'the new workspace is separate');
select is((select count(*)::int from public.roles r join public.profiles p on p.workspace_id = r.workspace_id
            where p.email = 'founder@startup.example'), 4, 'the new workspace has the default roles');

update public.platform_settings set value = '{"open": true, "allow": []}'::jsonb where key = 'signup';
select lives_ok($$ select pg_temp.sign_up('stranger@gmail.com') $$, 'with sign-ups open, anyone gets a workspace');

select * from finish();
rollback;
