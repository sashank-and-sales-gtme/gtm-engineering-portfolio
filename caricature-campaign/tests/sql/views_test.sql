update campaign_config set instantly_campaign_delivered='camp_del', instantly_campaign_not_delivered='camp_nd',
  instantly_campaign_nurture_1='n1', instantly_campaign_nurture_2='n2', instantly_campaign_nurture_3='n3';
insert into prospects (email, first_name, company_name, company_slug, track, status, day1_at, enroll_at, last_call_day, campaign_count, last_nurture_at, intent_tier)
values
 ('a@x.io','A','Alpha','alpha','qr_scanned','active', now()-interval '3 days', null, 0, 0, null, null),
 ('b@x.io','B','Beta','beta','qr_scanned','active', now()-interval '3 days', null, 0, 0, null, null),
 ('c@x.io','C','Gamma','gamma','qr_scanned','active', now()-interval '3 days', null, 0, 0, null, null),
 ('d@x.io','D','Delta','delta','delivered_not_scanned','active', now()-interval '3 days', null, 2, 0, null, null),
 ('e@x.io','E','Eps','eps','delivered_not_scanned','active', now()-interval '3 days', null, 2, 0, null, null),
 ('f@x.io','F','Phi','phi','delivered_not_scanned','active', now()-interval '3 days', null, 2, 0, null, null),
 ('g@x.io','G','Golf','golf','delivered_not_scanned','active', now()-interval '5 hours', now()-interval '1 hour', 0, 0, null, null),
 ('h@x.io','H','Hotel','hotel','not_delivered','active', now(), now(), 0, 0, null, null),
 ('i@x.io','I','India','india','delivered_not_scanned','active', now()-interval '6 days', null, 2, 0, null, null),
 ('j@x.io','J','Juliet','juliet','not_delivered','active', now()-interval '15 days', null, 0, 0, null, null),
 ('k@x.io','K','Kilo','kilo','qr_scanned','stopped', now()-interval '3 days', null, 0, 0, null, null),
 ('l@x.io','L','Lima','lima','delivered_not_scanned','active', now()-interval '60 days', null, 13, 3, now()-interval '20 days', 'Ice');
update prospects set enrolled_at = now() where email not in ('g@x.io','h@x.io');
update prospects set first_qr_at = now()-interval '3 days' where track='qr_scanned';
insert into events (prospect_id, event_type, occurred_at, session_id, event_key) select id,'qr_scan', now()-interval '2 days','s1','a1' from prospects where email='a@x.io';
insert into events (prospect_id, event_type, occurred_at, session_id, event_key) select id,'demo_engaged', now()-interval '2 days','s1','a2' from prospects where email='a@x.io';
insert into events (prospect_id, event_type, occurred_at, session_id, event_key) select id,'lp_contact_session', now()-interval '2 days','s1','a3' from prospects where email='a@x.io';
insert into events (prospect_id, event_type, occurred_at, session_id, event_key) select id,'qr_scan', now()-interval '2 days','s1','b1' from prospects where email='b@x.io';
insert into events (prospect_id, event_type, occurred_at, session_id, event_key) select id,'demo_engaged', now()-interval '2 days','s1','b2' from prospects where email='b@x.io';
insert into events (prospect_id, event_type, occurred_at, session_id, event_key) select id,'qr_scan', now()-interval '2 days','s1','c1' from prospects where email='c@x.io';
insert into events (prospect_id, event_type, occurred_at, session_id, event_key) select id,'page_view', now()-interval '1 days','sd1','d1' from prospects where email='d@x.io';
insert into events (prospect_id, event_type, occurred_at, session_id, event_key) select id,'page_view', now()-interval '1 days','sd1','d1b' from prospects where email='d@x.io';
insert into events (prospect_id, event_type, occurred_at, session_id, event_key) select id,'page_view', now()-interval '5 days','sd2','d2' from prospects where email='d@x.io';
insert into events (prospect_id, event_type, occurred_at, session_id, event_key) select id,'page_view', now()-interval '9 days','sd3','d3' from prospects where email='d@x.io';
insert into events (prospect_id, event_type, occurred_at, session_id, event_key) select id,'account_visit', now()-interval '1 days',null,'e1' from prospects where email='e@x.io';
insert into events (prospect_id, event_type, occurred_at, session_id, event_key) select id,'demo_engaged', now()-interval '40 days','old','f1' from prospects where email='f@x.io';
insert into events (prospect_id, event_type, occurred_at, session_id, event_key) select id,'qr_scan', now()-interval '1 days','k','k1' from prospects where email='k@x.io';

-- Assertions: the script raises an exception on the first failure.
do $$
declare r record;
begin
  -- scoring: capped at 100, 30-day window, sessions counted once, stopped prospects excluded
  select score, tier into r from v_prospect_scores where email = 'a@x.io';
  if r.score <> 100 or r.tier <> 'Hot' then raise exception 'a: expected 100/Hot, got %/%', r.score, r.tier; end if;
  select score, tier into r from v_prospect_scores where email = 'c@x.io';
  if r.score <> 37 or r.tier <> 'Warm' then raise exception 'c: expected 37/Warm, got %/%', r.score, r.tier; end if;
  select score into r from v_prospect_scores where email = 'd@x.io';
  if r.score <> 17 then raise exception 'd: three sessions in 14 days should score 17, got %', r.score; end if;
  select score into r from v_prospect_scores where email = 'f@x.io';
  if r.score <> 0 then raise exception 'f: 40-day-old event must be ignored, got %', r.score; end if;
  if exists (select 1 from v_prospect_scores where email = 'k@x.io') then raise exception 'k: stopped prospect scored'; end if;
  if exists (select 1 from v_prospect_scores where score = 0 and tier <> 'Ice') then raise exception 'zero scores must be Ice'; end if;
  -- scheduling
  if (select count(*) from v_due_enrollments) <> 2 then raise exception 'expected 2 due enrollments'; end if;
  select call_day into r from v_due_calls where email = 'j@x.io';
  if r.call_day <> 13 then raise exception 'j: expected only the latest due call (13), got %', r.call_day; end if;
  -- nurture and cooldown read the tiers the scorer writes
  update prospects p set intent_tier = s.tier, intent_score = s.score from v_prospect_scores s where s.id = p.id;
  if (select string_agg(email, ',') from v_nurture_candidates) <> 'j@x.io' then raise exception 'nurture candidates wrong'; end if;
  if (select string_agg(email, ',') from v_cooldown_due) <> 'l@x.io' then raise exception 'cooldown candidates wrong'; end if;
  raise notice 'all view assertions passed';
end $$;
