-- Self-serve HubSpot owner linking with the private app token: a rep picks their HubSpot user. An email match
-- links at once; anything else waits here for an admin. The label keeps the owner's name for display.
alter table public.profiles add column if not exists hubspot_owner_label text;
alter table public.profiles add column if not exists hubspot_owner_pending text;
alter table public.profiles add column if not exists hubspot_owner_pending_label text;
alter table public.profiles add column if not exists hubspot_owner_pending_at timestamptz;
