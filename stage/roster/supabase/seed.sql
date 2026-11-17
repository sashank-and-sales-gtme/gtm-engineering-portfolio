-- Seed data for the starting workspace (created by the workspaces migration): its owner, default settings and
-- roles. No leads: the roster fills itself once the onboarding wizard (Admin > Setup) has the seller's profile and
-- the weekly batch runs.
-- Sign-up: owner_email claims this workspace as its first Super Admin; invited people join the workspace that
-- invited them. Anyone else gets a new workspace of their own only while platform_settings 'signup' is open, or
-- when their address is on its allow list.

select public.seed_workspace(id) from public.workspaces;

insert into public.app_settings (workspace_id, key, value) values
  ('00000000-0000-4000-8000-000000000001', 'owner_email', '{"email": "sashankandsales@gmail.com"}'::jsonb)
on conflict (workspace_id, key) do nothing;

-- The platform's admins (they run the shared scheduler).
update public.platform_settings set value = '{"emails": ["sashankandsales@gmail.com"]}'::jsonb
 where key = 'admins' and value -> 'emails' = '[]'::jsonb;
