-- Invitations go out from a connected mailbox through the Gmail API. The mailbox is an org-level connection; an optional
-- app_settings.invite_sender names a team alias the mailbox sends as.
alter table public.integration_connections drop constraint if exists integration_connections_provider_check;
alter table public.integration_connections add constraint integration_connections_provider_check
  check (provider in ('hubspot', 'google_calendar', 'apollo', 'fullenrich', 'exa', 'gmail_sender', 'anthropic', 'hubspot_app', 'google_app'));
