-- Automatic distribution of unassigned leads.
--
-- Every active contact (not archived, not disqualified, not lost) with no owner goes to a rep:
--   1. If someone already owns another contact at the same company, the company stays with them.
--   2. Otherwise it goes to an in-rotation rep whose segment (rep_settings) matches the company,
--      picking the rep with the fewest open contacts so the load stays even.
--   3. A company that matches no rep stays unassigned.
-- Leads that already have an owner are never touched.
--
-- It runs when a rep's segment is saved or they are put in rotation, when someone becomes an active
-- member (invite accepted), every day at 03:10 UTC as a backstop, and from Admin > Reps and segments
-- ("Distribute unassigned", which previews the plan first).

-- ---------------------------------------------------------------------------
-- Pure helpers (no table access) so the matching rules can be tested on their own.
-- ---------------------------------------------------------------------------

-- Headcount as stored on a lead, e.g. "251-1000 (Apollo filter)", "501-1000", "1,001+", "234".
-- Returns null when there is no number to read.
create or replace function public.employee_range(p text)
returns int8range
language plpgsql
immutable
set search_path = public
as $$
declare
  m text[];
  t text := replace(coalesce(p, ''), ',', '');
begin
  m := regexp_match(t, '(\d+)\s*(?:-|–|—|to)\s*(\d+)');
  if m is not null then
    return int8range(least(m[1]::bigint, m[2]::bigint), greatest(m[1]::bigint, m[2]::bigint), '[]');
  end if;
  m := regexp_match(t, '(\d+)\s*\+');
  if m is not null then
    return int8range(m[1]::bigint, null, '[)');
  end if;
  m := regexp_match(t, '(\d+)');
  if m is not null then
    return int8range(m[1]::bigint, m[1]::bigint, '[]');
  end if;
  return null;
end;
$$;

-- Does a company fall inside a rep's segment? A value the lead doesn't record (null) never rules a rep
-- out: the contact was sourced from a segment search in the first place. Employees default to 250–2500,
-- the same default the Reps panel shows.
create or replace function public.segment_matches(
  p_emp_min int, p_emp_max int,
  p_rev_min bigint, p_rev_max bigint,
  p_fund_min bigint, p_fund_max bigint,
  p_employees int8range, p_revenue bigint, p_funding bigint)
returns boolean
language sql
immutable
set search_path = public
as $$
  select (p_employees is null
          or p_employees && int8range(coalesce(p_emp_min, 250), coalesce(p_emp_max, 2500), '[]'))
     and (p_revenue is null
          or (p_revenue >= coalesce(p_rev_min, 0) and (p_rev_max is null or p_revenue <= p_rev_max)))
     and (p_funding is null
          or (p_funding >= coalesce(p_fund_min, 0) and (p_fund_max is null or p_funding <= p_fund_max)));
$$;

-- One key per company: the domain, else the company name. Matches how the Accounts tab groups contacts.
create or replace function public.lead_company_key(p_domain text, p_company text)
returns text
language sql
immutable
set search_path = public
as $$
  select coalesce(nullif(lower(trim(p_domain)), ''), lower(trim(coalesce(p_company, ''))));
$$;

-- ---------------------------------------------------------------------------
-- The plan: which unassigned contact goes to whom, and why. Reads only; nothing is written.
-- ---------------------------------------------------------------------------
create or replace function public.lead_distribution_plan()
returns table (lead_id text, rep_id uuid, company_key text, company text, reason text)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  g record;
  v_rep uuid;
  v_load jsonb := '{}'::jsonb;  -- rep id -> open contacts, including what this plan hands out
begin
  -- Current open load of every in-rotation rep.
  select coalesce(jsonb_object_agg(r.user_id::text, (
           select count(*) from public.leads l
           where l.assigned_to = r.user_id and not coalesce(l.archived, false)
             and l.dq_at is null and l.lost_at is null)), '{}'::jsonb)
    into v_load
    from public.rep_settings r
    join public.profiles p on p.id = r.user_id and p.status = 'active' and p.role is not null
   where r.in_rotation;

  -- Biggest companies first so the greedy balance comes out even.
  for g in
    with pool as (
      select l.id, l.company, l.employees,
             public.lead_company_key(l.domain, l.company) as k
        from public.leads l
       where l.assigned_to is null and not coalesce(l.archived, false)
         and l.dq_at is null and l.lost_at is null
    )
    select k, min(company) as company, array_agg(id order by id) as ids,
           (array_agg(public.employee_range(employees)) filter (where public.employee_range(employees) is not null))[1] as emp,
           (select o.assigned_to
              from public.leads o
              join public.profiles op on op.id = o.assigned_to and op.status = 'active' and op.role is not null
             where public.lead_company_key(o.domain, o.company) = pool.k
               and not coalesce(o.archived, false)
             group by o.assigned_to
             order by count(*) desc, min(o.assigned_at) nulls last, o.assigned_to
             limit 1) as owner
      from pool
     group by k
     order by count(*) desc, k
  loop
    if g.owner is not null then
      v_rep := g.owner;
      reason := 'company_owner';
    else
      select r.user_id into v_rep
        from public.rep_settings r
        join public.profiles p on p.id = r.user_id and p.status = 'active' and p.role is not null
       where r.in_rotation
         and public.segment_matches(r.employees_min, r.employees_max, r.revenue_min, r.revenue_max,
                                    r.funding_min, r.funding_max, g.emp, null, null)
       order by coalesce((v_load ->> r.user_id::text)::int, 0), r.user_id
       limit 1;
      reason := case when v_rep is null then 'no_match' else 'segment' end;
    end if;
    if v_rep is not null and v_load ? v_rep::text then
      v_load := jsonb_set(v_load, array[v_rep::text], to_jsonb((v_load ->> v_rep::text)::int + cardinality(g.ids)));
    end if;
    rep_id := v_rep;
    company_key := g.k;
    company := g.company;
    foreach lead_id in array g.ids loop
      return next;
    end loop;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Run the plan. Internal: triggers and cron call this directly; people go through the RPC below.
-- ---------------------------------------------------------------------------
create or replace function public.run_lead_distribution(p_apply boolean, p_source text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_plan jsonb;
  v_done int := 0;
  n int;
  c record;
begin
  -- One distribution at a time, so two saves can't hand the same contact out twice.
  perform pg_advisory_xact_lock(hashtext('lead_distribution'));

  create temp table if not exists _ld_plan (lead_id text, rep_id uuid, company_key text, company text, reason text) on commit drop;
  truncate _ld_plan;
  insert into _ld_plan select * from public.lead_distribution_plan();

  if p_apply then
    for c in
      select rep_id, company_key, min(company) as company, min(reason) as reason, array_agg(lead_id) as ids
        from _ld_plan where rep_id is not null
       group by rep_id, company_key
    loop
      update public.leads
         set assigned_to = c.rep_id, assigned_at = now(), assigned_by = auth.uid()
       where id = any(c.ids) and assigned_to is null;
      get diagnostics n = row_count;
      if n > 0 then
        v_done := v_done + n;
        insert into public.audit_log (actor, action, target, detail)
        select auth.uid(), 'leads.auto_assigned', c.company,
               n || case when n = 1 then ' contact' else ' contacts' end || ' → '
               || coalesce(p.full_name, p.email, c.rep_id::text)
               || case c.reason when 'company_owner' then ' (already owns this company)' else ' (segment match)' end
               || ' · ' || p_source
          from public.profiles p where p.id = c.rep_id;
      end if;
    end loop;
    if v_done > 0 then
      insert into public.audit_log (actor, action, target, detail)
      values (auth.uid(), 'leads.distributed', '', v_done || ' unassigned contacts distributed · ' || p_source);
    end if;
  end if;

  select jsonb_build_object(
           'applied', p_apply,
           'assigned', case when p_apply then v_done else (select count(*) from _ld_plan where rep_id is not null) end,
           'unmatched', (select count(*) from _ld_plan where rep_id is null),
           'by_reason', coalesce((select jsonb_object_agg(z.reason, z.cnt)
                                    from (select reason, count(*) as cnt from _ld_plan group by reason) z), '{}'::jsonb),
           'reps', coalesce((
             select jsonb_agg(jsonb_build_object('rep_id', x.rep_id, 'name', coalesce(p.full_name, p.email),
                                                 'contacts', x.contacts, 'accounts', x.accounts)
                              order by x.contacts desc, coalesce(p.full_name, p.email))
               from (select rep_id, count(*) as contacts, count(distinct company_key) as accounts
                       from _ld_plan where rep_id is not null group by rep_id) x
               join public.profiles p on p.id = x.rep_id), '[]'::jsonb),
           'unmatched_companies', coalesce((
             select jsonb_agg(distinct company) from _ld_plan where rep_id is null), '[]'::jsonb))
    into v_plan;
  return v_plan;
end;
$$;

revoke execute on function public.lead_distribution_plan() from public, anon, authenticated;
revoke execute on function public.run_lead_distribution(boolean, text) from public, anon, authenticated;
grant execute on function public.run_lead_distribution(boolean, text) to service_role;

-- What the admin button calls: p_apply = false previews, true assigns.
create or replace function public.distribute_unassigned_leads(p_apply boolean default false)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  if not (public.is_active_member() and (public.has_perm('assign_leads') or public.has_perm('manage_users'))) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  return public.run_lead_distribution(p_apply, 'admin');
end;
$$;
revoke execute on function public.distribute_unassigned_leads(boolean) from public, anon;
grant execute on function public.distribute_unassigned_leads(boolean) to authenticated, service_role;

-- Bulk assign from the Accounts table: hand the chosen contacts to one person (or unassign with null).
create or replace function public.assign_leads_bulk(p_ids text[], p_rep uuid)
returns int
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  n int;
  v_name text;
begin
  if not (public.is_active_member() and public.has_perm('assign_leads')) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  if p_rep is not null then
    select coalesce(full_name, email) into v_name from public.profiles
     where id = p_rep and status = 'active' and role is not null;
    if not found then raise exception 'That person is not an active member' using errcode = 'P0002'; end if;
  end if;
  update public.leads
     set assigned_to = p_rep, assigned_at = now(), assigned_by = auth.uid()
   where id = any(p_ids) and assigned_to is distinct from p_rep;
  get diagnostics n = row_count;
  if n > 0 then
    insert into public.audit_log (actor, action, target, detail)
    values (auth.uid(), 'leads.bulk_assigned', coalesce(v_name, 'Unassigned'),
            n || case when n = 1 then ' contact' else ' contacts' end || ' across '
            || (select count(distinct public.lead_company_key(domain, company)) from public.leads where id = any(p_ids))
            || ' accounts');
  end if;
  return n;
end;
$$;
revoke execute on function public.assign_leads_bulk(text[], uuid) from public, anon;
grant execute on function public.assign_leads_bulk(text[], uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Triggers: a rep joins the rotation or their segment changes; someone becomes an active member.
-- ---------------------------------------------------------------------------
create or replace function public.distribute_on_rep_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.in_rotation and (
       tg_op = 'INSERT'
       or not old.in_rotation
       or (old.employees_min, old.employees_max, old.revenue_min, old.revenue_max, old.funding_min, old.funding_max)
          is distinct from
          (new.employees_min, new.employees_max, new.revenue_min, new.revenue_max, new.funding_min, new.funding_max)) then
    perform public.run_lead_distribution(true, 'segment saved');
  end if;
  return null;
end;
$$;
revoke execute on function public.distribute_on_rep_change() from public, anon, authenticated;

drop trigger if exists rep_settings_distribute on public.rep_settings;
create trigger rep_settings_distribute
  after insert or update on public.rep_settings
  for each row execute function public.distribute_on_rep_change();

create or replace function public.distribute_on_member_active()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'active' and new.role is not null
     and (tg_op = 'INSERT' or old.status is distinct from 'active' or old.role is null)
     and exists (select 1 from public.rep_settings where user_id = new.id and in_rotation) then
    perform public.run_lead_distribution(true, 'member activated');
  end if;
  return null;
end;
$$;
revoke execute on function public.distribute_on_member_active() from public, anon, authenticated;

drop trigger if exists profiles_distribute on public.profiles;
create trigger profiles_distribute
  after insert or update of status, role on public.profiles
  for each row execute function public.distribute_on_member_active();

-- ---------------------------------------------------------------------------
-- Daily backstop: 03:10 UTC = 08:40 IST, before the reps' day starts.
-- ---------------------------------------------------------------------------
select cron.unschedule('distribute-leads') where exists (select 1 from cron.job where jobname = 'distribute-leads');
select cron.schedule('distribute-leads', '10 3 * * *', $cmd$ select public.run_lead_distribution(true, 'daily'); $cmd$);
