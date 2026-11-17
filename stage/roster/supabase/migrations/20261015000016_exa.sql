-- Exa company research. exa_status records whether Exa researched a queued account (ok, excluded, thin, cached,
-- failed, skipped); null means not tried yet. Exa is a team connection like Apollo and FullEnrich.
alter table public.research_queue add column if not exists exa_status text;
alter table public.integration_connections drop constraint if exists integration_connections_provider_check;
alter table public.integration_connections add constraint integration_connections_provider_check
  check (provider in ('hubspot', 'google_calendar', 'apollo', 'fullenrich', 'exa', 'anthropic', 'hubspot_app', 'google_app'));
