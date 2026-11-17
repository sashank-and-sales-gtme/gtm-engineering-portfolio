-- Tier S: companies added by hand that pass research. The company-fit tier (A/B/C/X) is kept in fit_tier.
alter table public.leads add column if not exists fit_tier text;
update public.leads set fit_tier = tier where fit_tier is null;
update public.leads set tier = 'S' where source = 'manual' and tier in ('A', 'B', 'C');
