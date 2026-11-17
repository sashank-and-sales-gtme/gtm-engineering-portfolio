-- Every contact should carry a LinkedIn profile. linkedin_source says where it came from (research, apollo, exa);
-- linkedin_checked_at stops the Exa backfill from searching the same contact more than once a fortnight.
alter table public.leads add column if not exists linkedin_source text;
alter table public.leads add column if not exists linkedin_checked_at timestamptz;
update public.leads set linkedin_source = 'research' where coalesce(linkedin, '') <> '' and linkedin_source is null;
