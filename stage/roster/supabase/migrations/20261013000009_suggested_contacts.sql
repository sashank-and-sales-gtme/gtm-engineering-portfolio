-- Suggested contacts (follow-up rows on an account a researcher already worked) don't count as extra accounts
-- in Admin > Reps and segments.
create or replace function public.roster_progress(p_batch text)
returns table (rep_id uuid, qualified bigint, in_research bigint, in_reserve bigint, excluded bigint)
language sql stable security definer set search_path = public
as $$
  with q as (
    select r.rep_id, r.status, r.result
      from public.research_queue r
     where r.batch = p_batch and r.kind in ('account', 'add_request') and r.rep_id is not null
       and coalesce(r.payload ->> 'followup', 'false') <> 'true'
  )
  select rep_id,
         count(*) filter (where status = 'done' and coalesce((result ->> 'leads')::int, 0) > 0),
         count(*) filter (where status in ('gating', 'pending', 'running')),
         count(*) filter (where status = 'held'),
         count(*) filter (where status in ('skipped') or (status = 'done' and coalesce((result ->> 'leads')::int, 0) = 0))
    from q
   where public.is_active_member() and public.has_perm('manage_users')
   group by rep_id
$$;
