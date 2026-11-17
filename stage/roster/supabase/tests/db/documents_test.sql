-- The document library: each workspace sees and changes its own documents and its own Storage folder only.
-- Run: supabase test db supabase/tests/db
begin;
select plan(11);

insert into public.workspaces (id, name) values
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'A Co'),
  ('bbbbbbbb-0000-4000-8000-00000000000b', 'B Co');
select public.seed_workspace(id) from public.workspaces where name in ('A Co', 'B Co');
insert into public.app_settings (workspace_id, key, value) values
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'owner_email', '{"email": "alice@a.example"}'),
  ('bbbbbbbb-0000-4000-8000-00000000000b', 'owner_email', '{"email": "bob@b.example"}');
insert into auth.users (id, email, instance_id, aud, role) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'alice@a.example', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
  ('bbbbbbbb-0000-4000-8000-000000000001', 'bob@b.example',   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated');

insert into public.workspace_documents (workspace_id, kind, name, url, status, extracted_text, created_by) values
  ('bbbbbbbb-0000-4000-8000-00000000000b', 'link', 'B pricing', 'https://b.example/pricing', 'ready', 'B secret price list', 'bbbbbbbb-0000-4000-8000-000000000001');
insert into storage.objects (bucket_id, name, owner) values
  ('workspace-docs', 'bbbbbbbb-0000-4000-8000-00000000000b/deck.pdf', 'bbbbbbbb-0000-4000-8000-000000000001');

select is((select public from storage.buckets where id = 'workspace-docs'), false, 'the bucket is private');

-- Act as Alice (Super Admin of A).
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "aaaaaaaa-0000-4000-8000-000000000001", "role": "authenticated", "email": "alice@a.example"}', true);

select is((select count(*)::int from public.workspace_documents), 0, 'Alice sees none of B''s documents');
select lives_ok(
  $$ insert into public.workspace_documents (kind, name, url, created_by) values ('link', 'Our site', 'https://a.example', 'aaaaaaaa-0000-4000-8000-000000000001') $$,
  'she can add a link to her own library');
select is((select workspace_id from public.workspace_documents where name = 'Our site'), 'aaaaaaaa-0000-4000-8000-00000000000a'::uuid,
          'it lands in her workspace');
select throws_ok(
  $$ insert into public.workspace_documents (kind, name, path, created_by) values ('file', 'Sneaky', 'bbbbbbbb-0000-4000-8000-00000000000b/x.pdf', 'aaaaaaaa-0000-4000-8000-000000000001') $$,
  '42501', null, 'a file row cannot point into B''s folder');
select throws_ok(
  $$ insert into public.workspace_documents (kind, name, url, status, extracted_text, created_by) values ('link', 'Forged', 'https://a.example/x', 'ready', 'made up', 'aaaaaaaa-0000-4000-8000-000000000001') $$,
  '42501', null, 'she cannot write extracted text herself');
select throws_ok(
  $$ update public.workspace_documents set extracted_text = 'edited' $$,
  '42501', null, 'extracted text is written by the server only');

select is((select count(*)::int from storage.objects where bucket_id = 'workspace-docs'), 0, 'she cannot list B''s files');
select lives_ok(
  $$ insert into storage.objects (bucket_id, name, owner) values ('workspace-docs', 'aaaaaaaa-0000-4000-8000-00000000000a/deck.pdf', 'aaaaaaaa-0000-4000-8000-000000000001') $$,
  'she can upload into her own folder');
select throws_ok(
  $$ insert into storage.objects (bucket_id, name, owner) values ('workspace-docs', 'bbbbbbbb-0000-4000-8000-00000000000b/planted.pdf', 'aaaaaaaa-0000-4000-8000-000000000001') $$,
  '42501', null, 'she cannot upload into B''s folder');

delete from public.workspace_documents where name = 'B pricing';
reset role;
select is((select count(*)::int from public.workspace_documents where workspace_id = 'bbbbbbbb-0000-4000-8000-00000000000b'), 1,
          'B''s document survived her delete');

select * from finish();
rollback;
