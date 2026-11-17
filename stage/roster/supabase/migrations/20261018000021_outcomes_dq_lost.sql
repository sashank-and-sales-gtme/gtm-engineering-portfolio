-- Call outcomes (DNP, Wrong ICP), backdated call logs, manual disqualification and Closed lost / Cold.
--
-- calls.at and journeys.at are when the call happened; logged_at is when it was entered. A call entered more than
-- 30 minutes after it happened is flagged to admins in the audit log (admins see it in Admin > Review; reps don't).
-- Disqualifying a contact or a company and closing an account as lost go through the RPCs below, which check the
-- caller may work those contacts and write one audit row each.

alter table public.calls    add column if not exists logged_at timestamptz not null default now();
alter table public.journeys add column if not exists logged_at timestamptz not null default now();

alter table public.leads
  add column if not exists dq_at       timestamptz,
  add column if not exists dq_reason   text,
  add column if not exists dq_by       uuid references auth.users(id) on delete set null,
  add column if not exists dq_scope    text,
  add column if not exists lost_at     timestamptz,
  add column if not exists lost_reason text,
  add column if not exists lost_by     uuid references auth.users(id) on delete set null;

-- ---------------------------------------------------------------------------
-- Backdated logs -> audit
-- ---------------------------------------------------------------------------
create or replace function public.flag_backdated()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_gap interval := coalesce(new.logged_at, now()) - new.at;
  v_kind text := case when tg_table_name = 'calls' then 'call' else 'note' end;
  v_what text;
begin
  if new.at is null or v_gap < interval '30 minutes' then
    return new;
  end if;
  v_what := case when tg_table_name = 'calls' then 'Call outcome "' || coalesce(to_jsonb(new) ->> 'outcome', '') || '"' else 'Connected-call note' end;
  insert into public.audit_log (actor, action, target, detail)
  values (
    new.owner,
    v_kind || '.backdated',
    coalesce(new.company, ''),
    v_what || ' with ' || coalesce(new.contact, 'a contact')
      || ' logged for ' || to_char(new.at at time zone 'Asia/Kolkata', 'DD Mon YYYY HH24:MI')
      || ' IST, entered ' || to_char(coalesce(new.logged_at, now()) at time zone 'Asia/Kolkata', 'DD Mon YYYY HH24:MI')
      || ' IST (' || case when v_gap >= interval '1 day' then extract(day from v_gap)::int || 'd ' else '' end
      || extract(hour from v_gap)::int || 'h ' || extract(minute from v_gap)::int || 'm later). id:' || new.id
  );
  return new;
end;
$$;

drop trigger if exists calls_backdated on public.calls;
create trigger calls_backdated after insert or update of at on public.calls
  for each row execute function public.flag_backdated();
drop trigger if exists journeys_backdated on public.journeys;
create trigger journeys_backdated after insert or update of at on public.journeys
  for each row when (new.kind = 'context') execute function public.flag_backdated();

revoke execute on function public.flag_backdated() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Who may change a set of leads: anyone who works any lead or assigns, or a rep working their own.
-- ---------------------------------------------------------------------------
create or replace function public.can_work_leads(p_ids text[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_active_member() and (
    public.has_perm('work_any_lead') or public.has_perm('assign_leads')
    or (public.has_perm('work_leads') and exists (
      select 1 from public.leads where id = any(p_ids) and assigned_to = (select auth.uid())))
  );
$$;

-- Disqualify (p_on) or requalify a contact.
create or replace function public.set_lead_dq(p_lead_id text, p_on boolean, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v public.leads%rowtype;
begin
  select * into v from public.leads where id = p_lead_id;
  if not found then raise exception 'Contact not found' using errcode = 'P0002'; end if;
  if not public.can_work_leads(array[p_lead_id]) then raise exception 'Not allowed' using errcode = '42501'; end if;
  if p_on then
    update public.leads set dq_at = now(), dq_reason = coalesce(nullif(trim(p_reason), ''), 'Not a fit'),
      dq_by = auth.uid(), dq_scope = 'contact' where id = p_lead_id;
  else
    update public.leads set dq_at = null, dq_reason = null, dq_by = null, dq_scope = null where id = p_lead_id;
  end if;
  insert into public.audit_log (actor, action, target, detail)
  values (auth.uid(), case when p_on then 'contact.disqualified' else 'contact.requalified' end, v.company,
          v.name || coalesce(' · ' || nullif(v.title, ''), '') || case when p_on then ' · ' || coalesce(nullif(trim(p_reason), ''), 'Not a fit') else '' end);
end;
$$;

-- Disqualify or requalify every contact at a company.
create or replace function public.set_account_dq(p_company text, p_on boolean, p_reason text default null)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids text[];
begin
  select array_agg(id) into v_ids from public.leads where lower(company) = lower(p_company);
  if v_ids is null then raise exception 'Company not found' using errcode = 'P0002'; end if;
  if not public.can_work_leads(v_ids) then raise exception 'Not allowed' using errcode = '42501'; end if;
  if p_on then
    update public.leads set dq_at = now(), dq_reason = coalesce(nullif(trim(p_reason), ''), 'Not a fit'),
      dq_by = auth.uid(), dq_scope = 'company' where id = any(v_ids);
  else
    update public.leads set dq_at = null, dq_reason = null, dq_by = null, dq_scope = null where id = any(v_ids);
  end if;
  insert into public.audit_log (actor, action, target, detail)
  values (auth.uid(), case when p_on then 'company.disqualified' else 'company.requalified' end, p_company,
          array_length(v_ids, 1) || ' contacts' || case when p_on then ' · ' || coalesce(nullif(trim(p_reason), ''), 'Not a fit') else '' end);
  return array_length(v_ids, 1);
end;
$$;

-- Close an account as lost / cold, or reopen it.
create or replace function public.set_account_lost(p_company text, p_on boolean, p_reason text default null)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids text[];
begin
  select array_agg(id) into v_ids from public.leads where lower(company) = lower(p_company);
  if v_ids is null then raise exception 'Company not found' using errcode = 'P0002'; end if;
  if not public.can_work_leads(v_ids) then raise exception 'Not allowed' using errcode = '42501'; end if;
  if p_on then
    update public.leads set lost_at = now(), lost_reason = coalesce(nullif(trim(p_reason), ''), 'Went cold'),
      lost_by = auth.uid() where id = any(v_ids);
  else
    update public.leads set lost_at = null, lost_reason = null, lost_by = null where id = any(v_ids);
  end if;
  insert into public.audit_log (actor, action, target, detail)
  values (auth.uid(), case when p_on then 'account.lost' else 'account.reopened' end, p_company,
          case when p_on then coalesce(nullif(trim(p_reason), ''), 'Went cold') else 'Back in the pipeline' end);
  return array_length(v_ids, 1);
end;
$$;

revoke execute on function public.can_work_leads(text[]) from public, anon;
revoke execute on function public.set_lead_dq(text, boolean, text) from public, anon;
revoke execute on function public.set_account_dq(text, boolean, text) from public, anon;
revoke execute on function public.set_account_lost(text, boolean, text) from public, anon;
grant execute on function public.can_work_leads(text[]) to authenticated, service_role;
grant execute on function public.set_lead_dq(text, boolean, text) to authenticated, service_role;
grant execute on function public.set_account_dq(text, boolean, text) to authenticated, service_role;
grant execute on function public.set_account_lost(text, boolean, text) to authenticated, service_role;

create index if not exists leads_lost_at_idx on public.leads (lost_at) where lost_at is not null;
create index if not exists leads_dq_at_idx on public.leads (dq_at) where dq_at is not null;

-- New outcomes, and "Find more ICPs" requests on an account already on the roster.
alter table public.calls drop constraint if exists calls_outcome_check;
alter table public.calls add constraint calls_outcome_check
  check (outcome = any (array['yes', 'no', 'callback', 'dnp', 'wrong_icp']));
alter table public.add_requests drop constraint if exists add_requests_mode_check;
alter table public.add_requests add constraint add_requests_mode_check
  check (mode = any (array['next', 'now', 'more']));
