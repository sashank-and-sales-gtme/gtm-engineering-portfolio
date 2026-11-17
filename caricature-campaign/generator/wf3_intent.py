from n8nlib import WF, CFG

PLAN_JS = r"""
// Runs once per inserted (new) event. Decides HubSpot, Slack, call-task and state changes.
const ev = $json;                                   // row returned by Supabase insert
const ctx = $('Build Event').item.json;             // prospect + signal context
const p = ctx.prospect;
const cfg = $('Load Config').first().json;
const who = `${p.first_name}${p.last_name ? ' ' + p.last_name : ''} at ${p.company_name}`;
const plan = {
  event_id: ev.id, event_type: ev.event_type, prospect_id: p.id, hubspot_contact_id: p.hubspot_contact_id,
  instantly_lead_id: p.instantly_lead_id || '', note: '', slack: '', call_task: false,
  task_subject: '', task_body: '', patch: null, remove_from_instantly: false,
};
const meet = cfg.meet_location || 'Blue Bottle';
switch (ev.event_type) {
  case 'qr_scan': {
    if (!p.first_qr_at) {
      plan.patch = { id: p.id, track: 'qr_scanned', first_qr_at: ev.occurred_at };
      plan.remove_from_instantly = Boolean(p.instantly_lead_id) && p.track === 'delivered_not_scanned';
      plan.slack = `🔥 QR scanned: ${who} landed on the site from the caricature card. Journey monitoring is on.`;
    }
    plan.note = `Caricature QR code scanned. Landed on ${ctx.path || '/'} (session ${ctx.session_id}).`;
    break;
  }
  case 'demo_engaged':
    plan.note = `Engaged with the interactive demo on ${ctx.path || 'the site'}.`;
    plan.slack = `🎯 ${who} engaged with the interactive demo.`;
    break;
  case 'lp_contact_session':
    plan.note = `Session that started from the caricature QR landing ended on the contact page.`;
    plan.slack = `🚨 ${who} went from the QR landing straight to the contact page. Call now.`;
    plan.call_task = true;
    plan.task_subject = `Call now: ${who} reached the contact page from the QR`;
    plan.task_body = `High intent: the QR session ended on the contact page. Use the caricature as the opener and push for an in-person meeting at their office or ${meet}.`;
    break;
  case 'page_view':
    if (ctx.first_in_session) {
      plan.note = `Website visit started on ${ctx.path || '/'}.`;
      plan.slack = `👀 ${who} is on the website (${ctx.path || '/'}). Brand recall window is open.`;
    }
    break;
  case 'account_visit':
    plan.note = `Account-level website visit detected via ${ctx.source}.`;
    plan.slack = `👀 Someone from ${p.company_name} is on the website (${ctx.source}). Prospect: ${who}.`;
    break;
  case 'email_opened':
    plan.note = `Opened caricature email (step ${ctx.payload?.step ?? '?'}).`;
    break;
  case 'email_clicked': {
    const url = String(ctx.payload?.link_url || '');
    plan.note = `Clicked a link in the caricature email: ${url || 'unknown link'}.`;
    if (/interactnow\.ai/i.test(url)) {
      plan.slack = `🤖 ${who} opened the Maya demo link from the email.`;
      plan.call_task = true;
      plan.task_subject = `Call: ${who} opened the Maya demo link`;
      plan.task_body = `They interacted with the Maya link. Use the caricature as the opener and push for an office visit or ${meet}.`;
    }
    break;
  }
  case 'maya_interaction':
    plan.note = `Interacted with Maya${ctx.payload?.detail ? `: ${ctx.payload.detail}` : ''}.`;
    plan.slack = `🤖 ${who} interacted with Maya.`;
    plan.call_task = true;
    plan.task_subject = `Call: ${who} interacted with Maya`;
    plan.task_body = `They interacted with Maya. Use the caricature as the opener and push for an office visit or ${meet}.`;
    break;
  case 'email_replied':
    plan.patch = { id: p.id, status: 'replied' };
    plan.note = `Replied to the caricature email: "${String(ctx.payload?.reply_text || '').slice(0, 500)}"`;
    plan.slack = `💬 ${who} replied to the caricature email. Sequences stopped. Call and push for an office visit.`;
    plan.call_task = true;
    plan.task_subject = `Reply received: call ${who} and push for an office visit`;
    plan.task_body = `Reply: ${String(ctx.payload?.reply_text || '').slice(0, 1000)}`;
    break;
  case 'email_bounced':
  case 'unsubscribed':
    plan.patch = { id: p.id, status: 'stopped' };
    plan.note = ev.event_type === 'email_bounced' ? 'Caricature email bounced. Campaign stopped.' : 'Unsubscribed. Campaign stopped.';
    plan.slack = `⛔ ${who}: ${ev.event_type === 'email_bounced' ? 'email bounced' : 'unsubscribed'}. Campaign stopped.`;
    break;
  default:
    break;
}
return { json: plan };
"""


def build(out):
    w = WF("Caricature 3 - Intent Ingestor")
    # ---------------- triggers and normalizers
    w.webhook("Website Pixel", "ia-track", [0, -300], method="GET", auth=False)
    w.webhook("Instantly Webhook", "caricature-instantly", [0, -100])
    w.webhook("Factors Webhook", "caricature-factors", [0, 100])
    w.webhook("Maya Webhook", "caricature-maya", [0, 300])

    w.code("Normalize Pixel", [220, -300], r"""
const q = $json.query || {};
const allowed = { qr: 'qr_scan', pv: 'page_view', demo: 'demo_engaged', lpc: 'lp_contact_session' };
const event_type = allowed[q.ev];
const pid = String(q.pid || '').replace(/[^a-z0-9]/gi, '').slice(0, 32);
const sid = String(q.sid || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 64);
if (!event_type || !pid || !sid) return { json: { skip: true } };
const path = String(q.path || '/').slice(0, 300);
return { json: {
  lookup: `token=eq.${pid}`, event_type, session_id: sid, path, source: 'website_pixel',
  first_in_session: q.first === '1', occurred_at: new Date().toISOString(),
  key_suffix: event_type === 'page_view' ? `pv:${sid}:${path}` : `${event_type}:${sid}`, payload: {},
} };
""", per_item=True)
    w.code("Normalize Instantly", [220, -100], r"""
const b = $json.body || {};
const map = { email_sent: 'email_sent', email_opened: 'email_opened', link_clicked: 'email_clicked',
  email_link_clicked: 'email_clicked', reply_received: 'email_replied', email_bounced: 'email_bounced',
  lead_unsubscribed: 'unsubscribed' };
const event_type = map[b.event_type];
const email = String(b.lead_email || b.email || '').trim().toLowerCase();
if (!event_type || !email) return { json: { skip: true } };
const step = b.step ?? '';
const ts = b.timestamp || new Date().toISOString();
const once = { email_opened: `open:${b.campaign_id}:${step}`, email_sent: `sent:${b.campaign_id}:${step}` };
return { json: {
  lookup: `email=eq.${encodeURIComponent(email)}`, event_type, session_id: null, path: null, source: 'instantly',
  first_in_session: false, occurred_at: ts,
  key_suffix: once[event_type] || `${event_type}:${b.campaign_id}:${step}:${ts}`,
  payload: { campaign_id: b.campaign_id, step, link_url: b.link_url || b.url || '', reply_text: b.reply_text_snippet || b.reply_text || '' },
} };
""", per_item=True)
    w.code("Normalize Factors", [220, 100], r"""
const b = $json.body || {};
const mp = b.MessageProperty;
const raw = String(b.domain || b.website || (mp ? (mp[0] ?? mp['0'])?.PropValue : '') || '').toLowerCase();
const domain = raw.replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').split(/[\/?#]/)[0];
if (!/\.[a-z]{2,}$/.test(domain)) return { json: { skip: true } };
const hour = new Date().toISOString().slice(0, 13);
return { json: {
  lookup: `company_domain=eq.${encodeURIComponent(domain)}`, event_type: 'account_visit', session_id: null, path: null,
  source: 'factors', first_in_session: false, occurred_at: new Date().toISOString(), key_suffix: `acct:${hour}`, payload: { domain },
} };
""", per_item=True)
    w.code("Normalize Maya", [220, 300], r"""
const b = $json.body || {};
const email = String(b.email || '').trim().toLowerCase();
const pid = String(b.pid || '').replace(/[^a-z0-9]/gi, '');
if (!email && !pid) return { json: { skip: true } };
const ts = b.timestamp || new Date().toISOString();
return { json: {
  lookup: pid ? `token=eq.${pid}` : `email=eq.${encodeURIComponent(email)}`, event_type: 'maya_interaction',
  session_id: null, path: null, source: 'maya', first_in_session: false, occurred_at: ts,
  key_suffix: `maya:${ts}`, payload: { detail: String(b.detail || b.event || '').slice(0, 300) },
} };
""", per_item=True)

    w.add("Intent Signal", "n8n-nodes-base.filter", 2.2, {
        "conditions": {"options": {"caseSensitive": True, "leftValue": "", "typeValidation": "loose", "version": 2},
                       "conditions": [{"id": "skipcheck", "leftValue": "={{ $json.skip === true }}", "rightValue": "",
                                       "operator": {"type": "boolean", "operation": "false", "singleValue": True}}],
                       "combinator": "and"}, "options": {}}, [440, 0])
    w.load_config([660, 0])
    w.sb_get("Find Prospects", [880, 0], "prospects", filter_string="={{ $('Intent Signal').item.json.lookup + '&status=neq.stopped' }}")
    w.code("Build Event", [1100, 0], r"""
const sig = $('Intent Signal').item.json;
const p = $json;
return { json: {
  prospect: p, session_id: sig.session_id, path: sig.path, source: sig.source,
  first_in_session: sig.first_in_session, payload: sig.payload,
  row: { prospect_id: p.id, event_type: sig.event_type, occurred_at: sig.occurred_at, session_id: sig.session_id,
         path: sig.path, source: sig.source, event_key: `${p.id}:${sig.key_suffix}`, payload: sig.payload },
} };
""", per_item=True)
    w.code("Event Row", [1320, 0], "return { json: $json.row };", per_item=True)
    w.sb_create("Insert Event", [1540, 0], "events", on_error=True)
    w.if_bool("New Event?", [1760, 0], "={{ Boolean($json.id) }}")
    w.noop("Duplicate: Skip", [1980, 200])
    w.code("Plan Actions", [1980, -100], PLAN_JS, per_item=True)

    # fan-out
    w.if_bool("Has Patch?", [2200, -400], "={{ Boolean($json.patch) }}")
    w.code("Patch Row", [2420, -400], "return { json: $json.patch };", per_item=True)
    w.sb_update("Update Prospect", [2640, -400], "prospects")

    w.if_bool("Remove From Instantly?", [2200, -250], "={{ $json.remove_from_instantly }}")
    w.http("Instantly: Delete Lead", [2420, -250], "DELETE", "=https://api.instantly.ai/api/v2/leads/{{ $json.instantly_lead_id }}",
           cred="header", on_error=True)

    w.if_bool("Has Note?", [2200, -100], "={{ Boolean($json.note && $json.hubspot_contact_id) }}")
    w.hs_note("Intent", [2420, -100], "$('Plan Actions').item.json.hubspot_contact_id", "$('Plan Actions').item.json.note")

    w.if_bool("Has Slack?", [2200, 50], "={{ Boolean($json.slack) }}")
    w.slack("Slack: Intent Alert", [2420, 50], "={{ $json.slack }}")

    w.if_bool("Needs Call Task?", [2200, 200], "={{ $json.call_task && Boolean($json.hubspot_contact_id) }}")
    w.hs_task("Intent", [2420, 200], "$('Plan Actions').item.json.hubspot_contact_id",
              "$('Plan Actions').item.json.task_subject", "$('Plan Actions').item.json.task_body")

    for trig, norm in [("Website Pixel", "Normalize Pixel"), ("Instantly Webhook", "Normalize Instantly"),
                       ("Factors Webhook", "Normalize Factors"), ("Maya Webhook", "Normalize Maya")]:
        w.chain(trig, norm, "Intent Signal")
    w.chain("Intent Signal", "Load Config", "Find Prospects", "Build Event", "Event Row", "Insert Event", "New Event?")
    w.link("New Event?", "Plan Actions", 0)
    w.link("New Event?", "Duplicate: Skip", 1)
    for gate in ["Has Patch?", "Remove From Instantly?", "Has Note?", "Has Slack?", "Needs Call Task?"]:
        w.link("Plan Actions", gate)
    w.link("Has Patch?", "Patch Row", 0)
    w.link("Patch Row", "Update Prospect")
    w.link("Remove From Instantly?", "Instantly: Delete Lead", 0)
    w.link("Has Note?", "Intent: Create Note", 0)
    w.link("Has Slack?", "Slack: Intent Alert", 0)
    w.link("Needs Call Task?", "Intent: Create Task", 0)
    return w.dump(out)
