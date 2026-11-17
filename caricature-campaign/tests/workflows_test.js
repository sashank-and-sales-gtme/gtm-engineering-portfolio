// Runtime harness for the caricature workflows: executes Code nodes and renders expressions with mocks.
const fs = require('fs');
const path = require('path');
const { DateTime } = require('luxon');
const dir = process.argv[2];
const load = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));

let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log('PASS', label);
  else { failures++; console.log('FAIL', label, detail); }
};

function ctx(outputs) {
  // outputs: { nodeName: [json, ...] | {branches: [[json..],[json..]]} }
  const get = (name) => {
    if (!(name in outputs)) throw new Error(`node not executed: ${name}`);
    return outputs[name];
  };
  return (name) => {
    const o = get(name);
    const list = Array.isArray(o) ? o : o.branches[0];
    return {
      first: () => ({ json: list[0] }),
      get item() { return { json: list[0] }; },
      all: (b = 0) => (Array.isArray(o) ? o : o.branches[b] || []).map((json) => ({ json })),
    };
  };
}

function runCode(wf, nodeName, input, outputs) {
  const node = wf.nodes.find((n) => n.name === nodeName);
  if (!node) throw new Error(`no node ${nodeName}`);
  const $ = ctx(outputs);
  const perItem = node.parameters.mode === 'runOnceForEachItem';
  const $input = { all: () => input.map((json) => ({ json })), first: () => ({ json: input[0] }) };
  if (perItem) {
    return input.map((json) => {
      const fn = new Function('$', '$json', '$input', node.parameters.jsCode);
      const r = fn($, json, $input);
      return Array.isArray(r) ? r[0].json : r.json;
    });
  }
  const fn = new Function('$', '$json', '$input', node.parameters.jsCode);
  return fn($, input[0], $input).map((i) => i.json);
}

function renderAll(wf, outputs, json) {
  const $ = ctx(outputs);
  const $now = DateTime.now();
  const rendered = {};
  const problems = [];
  const walk = (obj, p, node) => {
    if (obj && typeof obj === 'object') { for (const [k, v] of Object.entries(obj)) walk(v, `${p}.${k}`, node); return; }
    if (typeof obj !== 'string' || !obj.startsWith('=')) return;
    const tpl = obj.slice(1);
    let out = ''; let last = 0; let m;
    const re = /\{\{([\s\S]*?)\}\}(?!\})/g;
    while ((m = re.exec(tpl))) {
      out += tpl.slice(last, m.index);
      try { out += String(new Function('$', '$json', '$now', `return (${m[1]});`)($, json, $now)); }
      catch (e) { problems.push(`${node}${p}: ${e.message}`); }
      last = m.index + m[0].length;
    }
    rendered[`${node}${p}`] = out + tpl.slice(last);
  };
  for (const n of wf.nodes) if (n.type !== 'n8n-nodes-base.code') walk(n.parameters, '', n.name);
  for (const [k, v] of Object.entries(rendered)) {
    if (k.endsWith('.jsonBody')) { try { JSON.parse(v); } catch (e) { problems.push(`invalid JSON ${k}`); } }
    if (/undefined|\[object Object\]|NaN/.test(v)) problems.push(`suspicious render ${k}: ${v.slice(0, 160)}`);
  }
  return { rendered, problems };
}

const CONFIG = { id: 1, campaign_timezone: 'America/Los_Angeles', website_base_url: 'https://interactlabs.ai', contact_path: '/contact',
  n8n_base_url: 'https://n8n.example.com/', slack_channel_id: 'C1', hubspot_owner_id: '77', instantly_campaign_delivered: 'cd',
  instantly_campaign_not_delivered: 'cn', instantly_campaign_nurture_1: 'n1', instantly_campaign_nurture_2: 'n2',
  instantly_campaign_nurture_3: 'n3', sender_name: 'Sudhir', meet_location: 'Blue Bottle' };
const PROSPECT = { id: 'p-1', token: 'abc123def456', email: 'priya@acme.io', first_name: 'Priya', last_name: 'Rao', title: 'VP Marketing',
  company_name: 'Acme Labs', company_slug: 'acme_labs', company_domain: 'acme.io', hubspot_contact_id: '501', track: 'delivered_not_scanned',
  status: 'active', instantly_lead_id: 'lead-9', first_qr_at: null, tracking_number: '1Z999', day1_at: '2026-11-10T18:00:00Z' };

// ================= WF1
{
  const wf = load('1_Caricature_Prospect_Intake.json');
  const body = { prospects: [
    { email: 'Priya@Acme.io ', first_name: 'Priya', last_name: 'Rao', company_name: 'Acme Labs, Inc.', carrier: 'FedEx', tracking_number: '1Z999' },
    { email: 'sam@beta.co', first_name: 'Sam', company_name: 'Beta', carrier: 'DoorDash', tracking_number: 'DD1' },
  ] };
  const norm = runCode(wf, 'Normalize Prospects', [CONFIG], { 'Intake Webhook': [{ body }] });
  ok('wf1 normalize: lowercases email, slugifies company', norm[0].email === 'priya@acme.io' && norm[0].company_slug === 'acme_labs_inc', JSON.stringify(norm[0]));
  ok('wf1 normalize: fedex trackable, doordash untracked', norm[0].trackable === true && norm[1].trackable === false);
  ok('wf1 normalize: domain from email', norm[0].company_domain === 'acme.io');
  let threw = '';
  try { runCode(wf, 'Normalize Prospects', [CONFIG], { 'Intake Webhook': [{ body: { email: 'bad', company_name: '' } }] }); } catch (e) { threw = e.message; }
  ok('wf1 normalize: rejects bad rows with reasons', threw.includes('invalid email') && threw.includes('first_name missing') && threw.includes('company_name missing'), threw);
  const row = runCode(wf, 'Prospect Row', [{ results: [{ id: '501' }] }], { 'Normalize Prospects': [norm[1]] });
  ok('wf1 prospect row: untracked has track=untracked and keeps tracking no.', row[0].track === 'untracked' && row[0].hubspot_contact_id === '501');
  const row2 = runCode(wf, 'Prospect Row', [{ results: [{ id: '502' }] }], { 'Normalize Prospects': [{ ...norm[1], tracking_number: '' }] });
  ok('wf1 prospect row: omits empty tracking number (unique column)', !('tracking_number' in row2[0]));
  const links = runCode(wf, 'Build Links', [{ id: 'p-1', token: 'abc123def456', company_slug: 'acme_labs' }], { 'Load Config': [CONFIG] });
  const u = new URL(links[0].lp_url);
  ok('wf1 links: LP is website root with doc UTM structure + token',
    u.origin === 'https://interactlabs.ai' && u.pathname === '/' && u.searchParams.get('utm_source') === 'direct_mail'
    && u.searchParams.get('utm_medium') === 'caricature_doll' && u.searchParams.get('utm_campaign') === 'acme_labs_outreach'
    && u.searchParams.get('utm_content') === 'abc123def456', links[0].lp_url);
  ok('wf1 links: QR encodes the full LP URL', decodeURIComponent(links[0].qr_png_url.split('data=')[1]) === links[0].lp_url);
  const tr = runCode(wf, 'Tracker Row', [{ data: { tracker: { trackerId: 't-1' } } }], { 'Create Prospect': [PROSPECT] });
  ok('wf1 tracker row', tr[0].ship24_tracker_id === 't-1' && tr[0].id === 'p-1');
  const created = { ...PROSPECT, track: 'shipped' };
  const outputs = { 'Intake Webhook': [{ body }], 'Load Config': [CONFIG], 'Normalize Prospects': norm, 'Create Prospect': [created],
    'Build Links': links, 'Prospect Created?': { branches: [[created], [{ error: { message: 'duplicate key value' } }]] },
    'Ship24: Create Tracker': [{ data: { tracker: { trackerId: 't-1' } } }], 'Prospect Row': [row[0]] };
  const sum = runCode(wf, 'Intake Summary', [{}], outputs);
  ok('wf1 summary counts', sum[0].created_count === 1 && sum[0].failed_count === 1, JSON.stringify(sum[0]));
  outputs['Intake Summary'] = sum;
  const r = renderAll(wf, outputs, { ...norm[0], results: [{ id: '501' }], id: 'p-1', ...sum[0] });
  ok('wf1 expressions render cleanly', r.problems.length === 0, r.problems.join('\n'));
  console.log('\n  wf1 Slack:\n  ' + r.rendered['Slack: Intake Summary.text'].replace(/\n/g, '\n  ') + '\n');
}

// ================= WF2
{
  const wf = load('2_Caricature_Delivery_Tracker.json');
  const body = { trackings: [
    { tracker: { trackingNumber: '1Z999', clientTrackerId: 'p-1' }, shipment: { statusMilestone: 'delivered' },
      events: [{ occurrenceDatetime: '2026-11-17T18:30:00Z', statusCode: 'delivery_delivered' }, { occurrenceDatetime: '2026-11-16T10:00:00Z', statusCode: 'transit' }] },
    { tracker: { trackingNumber: 'X2' }, shipment: { statusMilestone: 'exception' }, events: [{ occurrenceDatetime: '2026-11-17T09:00:00Z', statusCode: 'exception_return' }] },
    { tracker: { trackingNumber: 'X3' }, shipment: { statusMilestone: 'failed_attempt' }, events: [{ occurrenceDatetime: '2026-11-17T09:00:00Z', statusCode: 'delivery_attempt_failed' }] },
    { tracker: { trackingNumber: 'X4' }, shipment: { statusMilestone: 'out_for_delivery' }, events: [{ occurrenceDatetime: '2026-11-17T09:00:00Z', statusCode: 'delivery_refused' }] },
  ] };
  const parsed = runCode(wf, 'Parse Ship24', [{}], { 'Ship24 Webhook': [{ body }] });
  ok('wf2 ship24: delivered / exception / failed attempt / refused mapping',
    parsed.map((p) => p.outcome).join() === 'delivered,not_delivered,update,not_delivered', parsed.map((p) => p.outcome).join());
  ok('wf2 ship24: uses latest event time', parsed[0].occurred_at === '2026-11-17T18:30:00Z');
  const form = runCode(wf, 'Parse Form', [{ 'Prospect email': 'Priya@Acme.io', Outcome: 'Returned or refused' }], {});
  ok('wf2 form parse', form[0].email === 'priya@acme.io' && form[0].outcome === 'not_delivered');
  const dec = runCode(wf, 'Decide Transition', [{ ...PROSPECT, track: 'shipped' }], { 'Delivery Signal': [parsed[0]] });
  ok('wf2 decide: delivered from shipped, enroll +4h', dec[0].action === 'delivered' && dec[0].new_track === 'delivered_not_scanned'
    && new Date(dec[0].enroll_at) - new Date(dec[0].day1_at) === 4 * 3600e3, JSON.stringify(dec[0]));
  const dup = runCode(wf, 'Decide Transition', [{ ...PROSPECT, track: 'qr_scanned' }], { 'Delivery Signal': [parsed[0]] });
  ok('wf2 decide: ignores late delivered event after QR scan', dup[0].action === 'ignore');
  const rej = runCode(wf, 'Decide Transition', [{ ...PROSPECT, track: 'untracked' }], { 'Delivery Signal': [form[0]] });
  ok('wf2 decide: manual rejection, enroll immediately', rej[0].action === 'not_delivered' && rej[0].enroll_at === rej[0].day1_at);
  const un = runCode(wf, 'Decide Transition', [{}], { 'Delivery Signal': [parsed[1]] });
  ok('wf2 decide: unmatched', un[0].action === 'unmatched');
  const r = renderAll(wf, { 'Delivery Signal': [parsed[0]], 'Decide Transition': dec, 'Load Config': [CONFIG] }, { ...dec[0], id: 'note-1', sig: parsed[1] });
  ok('wf2 expressions render cleanly', r.problems.length === 0, r.problems.join('\n'));
  console.log('\n  wf2 Find filter: ' + r.rendered['Find Prospect.filterString'] + '\n  wf2 Slack: ' + r.rendered['Slack: Stage Change.text'] + '\n');
}

// ================= WF3
{
  const wf = load('3_Caricature_Intent_Ingestor.json');
  const pix = runCode(wf, 'Normalize Pixel', [
    { query: { pid: 'abc123def456', ev: 'qr', sid: 's_1', path: '/', first: '1' } },
    { query: { pid: 'abc123def456', ev: 'pv', sid: 's_1', path: '/pricing' } },
    { query: { pid: "x'; drop", ev: 'nope', sid: 's' } },
  ], {});
  ok('wf3 pixel: qr + pv parsed, junk skipped', pix[0].event_type === 'qr_scan' && pix[1].event_type === 'page_view' && pix[2].skip === true);
  ok('wf3 pixel: token sanitised into lookup', pix[0].lookup === 'token=eq.abc123def456');
  const ins = runCode(wf, 'Normalize Instantly', [
    { body: { event_type: 'email_opened', lead_email: 'Priya@acme.io', campaign_id: 'cd', step: 1, timestamp: 't1' } },
    { body: { event_type: 'email_link_clicked', lead_email: 'priya@acme.io', campaign_id: 'cn', step: 2, link_url: 'https://dev.interactnow.ai', timestamp: 't2' } },
    { body: { event_type: 'reply_received', lead_email: 'priya@acme.io', campaign_id: 'cd', step: 1, reply_text_snippet: 'Sure, Thursday?', timestamp: 't3' } },
    { body: { event_type: 'campaign_completed' } },
  ], {});
  ok('wf3 instantly: open dedupes per step, clicks + replies mapped, unknown skipped',
    ins[0].key_suffix === 'open:cd:1' && ins[1].event_type === 'email_clicked' && ins[2].event_type === 'email_replied' && ins[3].skip === true);
  const fac = runCode(wf, 'Normalize Factors', [{ body: { MessageProperty: { 0: { PropValue: 'https://www.Acme.io/pricing' } } } }], {});
  ok('wf3 factors: domain lookup', fac[0].lookup === 'company_domain=eq.acme.io' && fac[0].event_type === 'account_visit');
  const maya = runCode(wf, 'Normalize Maya', [{ body: { email: 'priya@acme.io', detail: 'asked about pricing' } }], {});
  ok('wf3 maya', maya[0].event_type === 'maya_interaction');

  const plan = (sig, prospect = PROSPECT) => {
    const be = runCode(wf, 'Build Event', [prospect], { 'Intent Signal': [sig] });
    const evRow = { id: 99, event_type: sig.event_type, occurred_at: sig.occurred_at };
    return { be: be[0], p: runCode(wf, 'Plan Actions', [evRow], { 'Build Event': be, 'Load Config': [CONFIG] })[0] };
  };
  const q = plan(pix[0]);
  ok('wf3 plan qr: track switch, Instantly removal, Slack, note', q.p.patch?.track === 'qr_scanned' && q.p.remove_from_instantly && q.p.slack && q.p.note, JSON.stringify(q.p));
  ok('wf3 event key is prospect-scoped', q.be.row.event_key === 'p-1:qr_scan:s_1');
  const q2 = plan(pix[0], { ...PROSPECT, first_qr_at: '2026-11-12T00:00:00Z' });
  ok('wf3 plan repeat qr: no patch, no removal, no Slack', !q2.p.patch && !q2.p.remove_from_instantly && !q2.p.slack);
  const pv = plan(pix[1]);
  ok('wf3 plan page_view mid-session: silent', !pv.p.note && !pv.p.slack);
  const pvFirst = plan({ ...pix[1], first_in_session: true });
  ok('wf3 plan page_view first-in-session: note + Slack (brand recall)', pvFirst.p.note && pvFirst.p.slack);
  const click = plan(ins[1]);
  ok('wf3 plan Maya link click: call task', click.p.call_task && /Maya/.test(click.p.task_subject));
  const rep = plan(ins[2]);
  ok('wf3 plan reply: status replied + call task + reply text in note', rep.p.patch?.status === 'replied' && rep.p.call_task && rep.p.note.includes('Thursday'));
  const op = plan(ins[0]);
  ok('wf3 plan open: note only', op.p.note && !op.p.slack && !op.p.call_task);
  const lpc = plan({ ...pix[0], event_type: 'lp_contact_session', key_suffix: 'lpc' });
  ok('wf3 plan QR to contact page: call task', lpc.p.call_task && lpc.p.slack.includes('contact page'));
  const nd = plan(pix[0], { ...PROSPECT, track: 'not_delivered' });
  ok('wf3 plan qr on rejection track: keeps Instantly (rejection copy still relevant)', nd.p.remove_from_instantly === false);
  const r = renderAll(wf, { 'Intent Signal': [pix[0]], 'Plan Actions': [rep.p], 'Load Config': [CONFIG], 'Build Event': [rep.be] }, { ...rep.p, id: 'n1' });
  ok('wf3 expressions render cleanly', r.problems.length === 0, r.problems.join('\n'));
}

// ================= WF4
{
  const wf = load('4_Caricature_Intent_Scorer.json');
  const scores = [
    { id: 'a', score: 100, tier: 'Hot', previous_tier: null, sales_ready_at: null, hubspot_contact_id: '1', first_name: 'A', company_name: 'Alpha', qr_visit: true, demo: true, lp_to_contact: true, visits_14d: 1, visited: true },
    { id: 'b', score: 77, tier: 'Hot', previous_tier: 'Hot', sales_ready_at: '2026-11-15T00:00:00Z', hubspot_contact_id: '2', first_name: 'B', company_name: 'Beta', qr_visit: true, demo: true, visits_14d: 1, visited: true },
    { id: 'c', score: 0, tier: 'Ice', previous_tier: null, sales_ready_at: null, hubspot_contact_id: null, first_name: 'C', company_name: 'Gamma', visits_14d: 0 },
  ];
  const plan = runCode(wf, 'Plan Score Updates', scores, {});
  ok('wf4 plan: only first-time Hot/Warm flagged sales ready', plan.map((p) => p.newly_sales_ready).join() === 'true,false,false');
  ok('wf4 plan: score row shape', JSON.stringify(Object.keys(plan[0].row)) === JSON.stringify(['id', 'intent_score', 'intent_tier', 'score_updated_at']));
  ok('wf4 plan: signals listed', plan[0].signals.includes('QR session to contact page'));
  const cd = runCode(wf, 'Cooldown Row', [{ id: 'l' }], {});
  ok('wf4 cooldown: +90 days, counter reset', Math.round((new Date(cd[0].cooldown_until) - Date.now()) / 864e5) === 90 && cd[0].campaign_count === 0);
  const r = renderAll(wf, { 'Load Config': [CONFIG], 'Newly Sales Ready?': [plan[0]], 'Get Cooldown Due': [{ id: 'l', hubspot_contact_id: '9', intent_tier: 'Ice' }], 'Cooldown Row': cd }, { ...plan[0], id: 't1' });
  ok('wf4 expressions render cleanly', r.problems.length === 0, r.problems.join('\n'));
  console.log('\n  wf4 Slack: ' + r.rendered['Slack: Sales Ready.text'] + '\n');
}

// ================= WF5
{
  const wf = load('5_Caricature_Cadence_Runner.json');
  const words = (s) => s.split(/\s+/).filter(Boolean).length;
  const calls = [
    { id: 'p-1', first_name: 'Priya', last_name: 'Rao', company_name: 'Acme Labs', hubspot_contact_id: '501', track: 'delivered_not_scanned', call_day: 2, call_number: 1 },
    { id: 'p-1', first_name: 'Priya', last_name: 'Rao', company_name: 'Acme Labs', hubspot_contact_id: '501', track: 'delivered_not_scanned', call_day: 5, call_number: 2 },
    { id: 'p-2', first_name: 'Sam', company_name: 'Beta', hubspot_contact_id: '502', track: 'not_delivered', call_day: 10, call_number: 3 },
    { id: 'p-2', first_name: 'Sam', company_name: 'Beta', hubspot_contact_id: '502', track: 'not_delivered', call_day: 13, call_number: 4 },
  ];
  const tasks = runCode(wf, 'Build Call Task', calls, { 'Load Config': [CONFIG] });
  ok('wf5 call 1 has no voice note (doc: VN from call 2)', !tasks[0].body.includes('voice note'));
  const vn = tasks.slice(1).map((t) => t.body.split('(keep it under 15 seconds):\n')[1].split('\n')[0]);
  ok('wf5 voice notes ≤ 40 words (~15s)', vn.every((v) => words(v) <= 40), vn.map(words).join(','));
  ok('wf5 rejection track uses mailroom angle', tasks[2].body.includes('mailroom'));
  ok('wf5 day 13 close-out', tasks[3].body.includes('final touch') && vn[2].includes('stop reaching out'));
  ok('wf5 no em dashes in scripts', tasks.every((t) => !t.body.includes('—')));
  const enr = runCode(wf, 'Enrollment Row', [{ id: 'lead-1' }, { error: { message: '401' } }], { 'Get Due Enrollments': [{ id: 'p-1', email: 'priya@acme.io' }] });
  ok('wf5 enrollment row success + failure', enr[0].instantly_lead_id === 'lead-1' && enr[1].failed === true);
  const due = { id: 'p-1', email: 'priya@acme.io', first_name: 'Priya', last_name: 'Rao', company_name: 'Acme Labs', hubspot_contact_id: '501', track: 'delivered_not_scanned', campaign_id: 'cd', meet_day: 'Wednesday, Nov 25', lp_url: 'https://interactlabs.ai/?x' };
  const r = renderAll(wf, { 'Load Config': [CONFIG], 'Get Due Enrollments': [due], 'Build Call Task': [tasks[1]] }, { ...due, ...tasks[1], id: 't1', error: 'x', call_day: 5 });
  ok('wf5 expressions render cleanly', r.problems.length === 0, r.problems.join('\n'));
  const lead = JSON.parse(r.rendered['Instantly: Add Lead.jsonBody']);
  ok('wf5 Instantly payload: campaign + custom vars', lead.campaign === 'cd' && lead.custom_variables.orgName === 'Acme Labs' && lead.custom_variables.meetDay === 'Wednesday, Nov 25');
  console.log('\n  wf5 call 2 task body:\n  ' + tasks[1].body.replace(/\n/g, '\n  ') + '\n');
}

// ================= WF6
{
  const wf = load('6_Caricature_Nurture_Drafts.json');
  const dec = runCode(wf, 'Read Decision', [{ query: { d: '3f1c2d4e-0000-4000-8000-000000000001', t: 'abcdef0123', a: 'approve' } }, { query: { d: "1' or 1=1", t: '', a: 'x' } }], {});
  ok('wf6 decision: valid parsed, injection stripped', dec[0].valid_input && dec[0].action === 'approve' && !dec[1].valid_input);
  const cand = { id: 'p-2', first_name: 'Sam', last_name: '', title: 'CMO', company_name: 'Beta', track: 'not_delivered', intent_tier: 'Ice', intent_score: 0, campaign_number: 2 };
  const draftOut = { output: { subject: 'still holding your caricature', body: 'Sam,\nLine two.', rationale: 'Proof angle fits.' } };
  const row = runCode(wf, 'Draft Row', [draftOut], { 'Get Nurture Candidates': [cand] });
  ok('wf6 draft row', row[0].campaign_number === 2 && row[0].subject === 'still holding your caricature');
  const draft = { id: 'd-1', prospect_id: 'p-2', campaign_number: 2, subject: 'still holding your caricature', body: 'Sam,\nLine two.', rationale: 'Proof angle fits.', approval_token: 'abcdef0123' };
  const r = renderAll(wf, { 'Load Config': [CONFIG], 'Get Nurture Candidates': [cand], 'Save Draft': [draft], 'Read Decision': dec,
    'Find Draft': [draft], 'Config For Send': [CONFIG], 'Get Prospect': [{ ...PROSPECT, id: 'p-2', first_name: 'Sam' }] }, { ...cand, ...PROSPECT, id: 'x' });
  ok('wf6 expressions render cleanly', r.problems.length === 0, r.problems.join('\n'));
  const lead = JSON.parse(r.rendered['Instantly: Add To Nurture.jsonBody']);
  ok('wf6 nurture lead goes to campaign 2 with draft vars', lead.campaign === 'n2' && lead.custom_variables.nurtureBody === 'Sam,\nLine two.');
  ok('wf6 approve link well-formed', r.rendered['Slack: Approve Draft.text'].includes('https://n8n.example.com/webhook/caricature-nurture-decision?d=d-1&t=abcdef0123&a=approve'));
  console.log('\n  wf6 Slack:\n  ' + r.rendered['Slack: Approve Draft.text'].replace(/\n/g, '\n  ') + '\n');
}

console.log(`FAILURES: ${failures}`);
