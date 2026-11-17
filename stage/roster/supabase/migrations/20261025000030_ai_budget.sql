-- AI spend budget (October 2026)
-- claude_usage records tokens and web searches per day, but nothing stopped work when spend grew. This adds a monthly
-- dollar budget (app_settings 'ai_budget') that claude-work checks before handing out tasks: at the limit the queue
-- waits until the next month or until an admin raises the limit. Prices are settings, defaulting to Claude Opus 5.5
-- list prices ($4 / $20 per million input / output tokens); web_search_usd is 0 until set to the provider's price.
-- monthly_usd null means no limit. Only the API worker reports usage, so this caps API-worker spend.

insert into public.app_settings (key, value) values
  ('ai_budget', '{"monthly_usd": 50, "warn_at": 0.8, "input_usd_per_mtok": 4, "output_usd_per_mtok": 20, "web_search_usd": 0}'::jsonb)
on conflict (key) do nothing;

-- Estimated spend for the current (IST) month and the configured limit. Readable by admins and the service role.
create or replace function public.ai_spend_this_month()
returns table (spent_usd numeric, limit_usd numeric, warn_at numeric)
language sql
stable
security definer
set search_path = public
as $$
  with b as (select coalesce((select value from public.app_settings where key = 'ai_budget'), '{}'::jsonb) as v),
       u as (
         select coalesce(sum(input_tokens), 0) as i, coalesce(sum(output_tokens), 0) as o, coalesce(sum(web_searches), 0) as w
         from public.claude_usage
         where day >= date_trunc('month', (now() at time zone 'Asia/Kolkata'))::date
       )
  select round(u.i / 1e6 * coalesce((b.v->>'input_usd_per_mtok')::numeric, 4)
             + u.o / 1e6 * coalesce((b.v->>'output_usd_per_mtok')::numeric, 20)
             + u.w * coalesce((b.v->>'web_search_usd')::numeric, 0), 4),
         (b.v->>'monthly_usd')::numeric,
         coalesce((b.v->>'warn_at')::numeric, 0.8)
  from u, b
$$;

revoke execute on function public.ai_spend_this_month() from public, anon;
grant  execute on function public.ai_spend_this_month() to authenticated, service_role;
