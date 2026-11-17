-- Seller profile and onboarding (October 2026)
-- The researchers, email writers and validators read the seller's product, customers, proof points and house style
-- from app_settings 'profile', which the onboarding wizard (Admin > Setup) fills. A new workspace starts with no
-- profile and lands on Setup; the code's defaults are empty, so nothing is researched or written for an unknown seller.
-- app_settings RLS already limits writes to manage_integrations, which is who Setup is for.

-- Rosters that already have an owner were set up before Setup existed.
insert into public.app_settings (key, value)
select 'onboarding', jsonb_build_object('completed_at', now(), 'by', null, 'note', 'set up before the Setup wizard')
where exists (select 1 from public.profiles)
on conflict (key) do nothing;
