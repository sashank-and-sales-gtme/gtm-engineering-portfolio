-- The platform console: only the product owner can read every workspace or change platform settings.
-- Run: supabase test db supabase/tests/db
begin;
select plan(14);

-- The owner and a workspace admin (Alice), each signed up with a workspace of their own.
update public.platform_settings set value = '{"open": false, "allow": ["sashankandsales@gmail.com", "alice@a.example"]}'::jsonb where key = 'signup';
insert into auth.users (id, email, instance_id, aud, role, email_confirmed_at, raw_user_meta_data) values
  ('0000000a-0000-4000-8000-000000000001', 'sashankandsales@gmail.com', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', now(), '{"workspace_name": "Owner Co"}'),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'alice@a.example', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', now(), '{"workspace_name": "A Co"}');

select is(public.product_owner_email(), 'sashankandsales@gmail.com', 'the product owner is fixed in code');

-- Alice is the Super Admin of her own workspace, but not the product owner.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "aaaaaaaa-0000-4000-8000-000000000001", "role": "authenticated", "email": "alice@a.example"}', true);
select is(public.is_product_owner(), false, 'a workspace admin is not the product owner');
select throws_ok($$ select public.platform_overview() $$, '42501', null, 'she cannot read the console');
select throws_ok($$ select public.platform_create_workspace('Sneaky', 'x@y.example') $$, '42501', null, 'she cannot create workspaces');
select throws_ok($$ select public.platform_set_signup(true, '{}') $$, '42501', null, 'she cannot open sign-ups');
select throws_ok($$ select public.platform_set_admins(array['alice@a.example']) $$, '42501', null, 'she cannot make herself a platform admin');
select throws_ok($$ select count(*) from public.platform_audit $$, '42501', null, 'she cannot read the platform audit');

-- The product owner.
select set_config('request.jwt.claims', '{"sub": "0000000a-0000-4000-8000-000000000001", "role": "authenticated", "email": "sashankandsales@gmail.com"}', true);
select is(public.is_platform_admin(), true, 'the owner is always a platform admin');
select ok(jsonb_array_length(public.platform_overview() -> 'workspaces') >= 2, 'the owner sees every workspace');
select isnt(public.platform_create_workspace('Customer Co', 'Buyer@Customer.example'), null, 'the owner can create a workspace for a customer');
select throws_ok($$ select public.platform_set_signup(false, array['not an email']) $$, '22023', null, 'the allow list takes email addresses only');
select ok(public.platform_set_admins(array['ops@stage.example']) ? 'sashankandsales@gmail.com', 'the owner stays on the admin list');

reset role;
select is((select count(*)::int from public.roles r join public.workspaces w on w.id = r.workspace_id where w.name = 'Customer Co'), 4,
          'the new workspace gets the standard roles');
select is(public.signup_plan('buyer@customer.example') ->> 'kind', 'owner', 'the named owner can sign up and claim it');

select * from finish();
rollback;
