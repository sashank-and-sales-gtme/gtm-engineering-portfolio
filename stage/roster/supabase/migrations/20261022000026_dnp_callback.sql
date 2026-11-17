-- Every DNP must leave a callback. The app sets one when the DNP is logged; this sweep catches any DNP whose save
-- stopped halfway: after 10 minutes without a callback (and with no open callback or later call on the contact) it
-- creates the retry for the next working day at 11:00 IST, owned by whoever logged the DNP.
create or replace function public.ensure_dnp_callbacks()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  c record;
  v_cb uuid;
  v_when timestamptz;
  v_day date;
  n int := 0;
begin
  for c in
    select k.* from public.calls k
    where k.outcome = 'dnp'
      and k.new_callback_id is null
      and k.at > now() - interval '7 days'
      and k.at < now() - interval '10 minutes'
      and not exists (select 1 from public.callbacks b where b.lead_id = k.lead_id and b.status = 'open')
      and not exists (select 1 from public.calls x where x.lead_id = k.lead_id and x.at > k.at)
  loop
    v_day := (now() at time zone 'Asia/Kolkata')::date + 1;
    while extract(isodow from v_day) in (6, 7) loop
      v_day := v_day + 1;
    end loop;
    v_when := (v_day + time '11:00') at time zone 'Asia/Kolkata';
    insert into public.callbacks (lead_id, company, contact, title, segment, title_scope, "when", agenda, status, cal_status, cal_error, call_id, owner)
    values (c.lead_id, c.company, c.contact, c.title, c.segment, c.title_scope, v_when,
            'Retry after DNP (set automatically).', 'open', 'failed', 'Set automatically. Add it to Google Tasks from here.', c.id, c.owner)
    returning id into v_cb;
    update public.calls set new_callback_id = v_cb where id = c.id;
    update public.leads set stage = 'callback' where id = c.lead_id and coalesce(stage, '') not in ('meeting');
    insert into public.audit_log (actor, action, target, detail)
    values (null, 'callback.auto_dnp', c.lead_id, 'DNP had no callback; set ' || to_char(v_when at time zone 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') || ' IST');
    n := n + 1;
  end loop;
  return n;
end;
$$;
revoke all on function public.ensure_dnp_callbacks() from public, anon, authenticated;

select cron.unschedule('ensure-dnp-callbacks') where exists (select 1 from cron.job where jobname = 'ensure-dnp-callbacks');
select cron.schedule('ensure-dnp-callbacks', '*/10 * * * *', $$select public.ensure_dnp_callbacks()$$);
