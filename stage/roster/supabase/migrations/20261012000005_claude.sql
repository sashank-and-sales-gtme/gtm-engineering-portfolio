-- Stage Prospect: Claude connector settings and daily usage accounting.

-- Model and web search settings, editable from Admin > Integrations through the `integrations` function.
-- model null = CLAUDE_MODEL env, then the built-in default. research_tier_model null = same as model.
insert into public.app_settings (key, value) values
  ('claude', '{"model": null, "max_web_searches": 6, "research_tier_model": null}'::jsonb)
on conflict (key) do nothing;

-- ===========================================================================
-- claude_usage: per IST day and feature ('research', 'prep_brief', 'add_company')
-- ===========================================================================

create table if not exists public.claude_usage (
  day           date   not null,
  feature       text   not null,
  input_tokens  bigint not null default 0,
  output_tokens bigint not null default 0,
  web_searches  int    not null default 0,
  calls         int    not null default 0,
  primary key (day, feature)
);

alter table public.claude_usage enable row level security;

revoke insert, update, delete, truncate on public.claude_usage from anon, authenticated;
grant select on public.claude_usage to authenticated;

drop policy if exists claude_usage_select on public.claude_usage;
create policy claude_usage_select on public.claude_usage
  for select to authenticated
  using (public.is_active_member() and public.has_perm('manage_integrations'));

-- Adds one Claude call's usage to today's (IST) row for the feature. Service role only.
create or replace function public.claude_usage_add(p_feature text, p_in bigint, p_out bigint, p_ws int)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null then
    raise exception 'claude_usage_add is service role only' using errcode = '42501';
  end if;
  if p_feature is null or p_feature !~ '^[a-z_]{1,40}$' then
    raise exception 'Invalid feature' using errcode = '22023';
  end if;
  insert into public.claude_usage as u (day, feature, input_tokens, output_tokens, web_searches, calls)
  values ((now() at time zone 'Asia/Kolkata')::date, p_feature,
          greatest(coalesce(p_in, 0), 0), greatest(coalesce(p_out, 0), 0), greatest(coalesce(p_ws, 0), 0), 1)
  on conflict (day, feature) do update set
    input_tokens  = u.input_tokens  + excluded.input_tokens,
    output_tokens = u.output_tokens + excluded.output_tokens,
    web_searches  = u.web_searches  + excluded.web_searches,
    calls         = u.calls + 1;
end;
$$;

revoke execute on function public.claude_usage_add(text, bigint, bigint, int) from public, anon, authenticated;
grant  execute on function public.claude_usage_add(text, bigint, bigint, int) to service_role;
