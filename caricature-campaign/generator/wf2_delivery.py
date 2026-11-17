from n8nlib import WF, CFG


def build(out):
    w = WF("Caricature 2 - Delivery Tracker")
    w.webhook("Ship24 Webhook", "caricature-ship24", [0, -100])
    w.add("Manual Delivery Form", "n8n-nodes-base.formTrigger", 2.2, {
        "formTitle": "Caricature delivery confirmation",
        "formDescription": "Use this for couriers without API tracking. Pick the prospect email and the outcome.",
        "formFields": {"values": [
            {"fieldLabel": "Prospect email", "fieldType": "email", "requiredField": True},
            {"fieldLabel": "Outcome", "fieldType": "dropdown", "requiredField": True,
             "fieldOptions": {"values": [{"option": "Delivered"}, {"option": "Returned or refused"}]}},
        ]},
        "options": {"path": "caricature-delivery-confirm"}}, [0, 100], webhookId="caricature-delivery-confirm")

    w.code("Parse Ship24", [220, -100], r"""
const body = $('Ship24 Webhook').first().json.body || {};
const trackings = Array.isArray(body.trackings) ? body.trackings : [];
const out = [];
for (const t of trackings) {
  const tracker = t.tracker || {};
  const shipment = t.shipment || {};
  const events = Array.isArray(t.events) ? t.events : [];
  const latest = events
    .slice()
    .sort((a, b) => String(b.occurrenceDatetime || b.datetime || '').localeCompare(String(a.occurrenceDatetime || a.datetime || '')))[0] || {};
  const milestone = shipment.statusMilestone || latest.statusMilestone || '';
  const code = latest.statusCode || shipment.statusCode || '';
  let outcome = 'update';
  if (milestone === 'delivered') outcome = 'delivered';
  else if (milestone === 'exception' || code === 'delivery_refused') outcome = 'not_delivered';
  out.push({
    tracking_number: tracker.trackingNumber || '',
    email: '',
    outcome,
    status_label: `${milestone || 'unknown'}${code ? ` (${code})` : ''}`,
    occurred_at: latest.occurrenceDatetime || latest.datetime || new Date().toISOString(),
    source: 'ship24',
  });
}
return out.filter((o) => o.tracking_number).map((json) => ({ json }));
""")
    w.code("Parse Form", [220, 100], r"""
const f = $json;
return {
  json: {
    tracking_number: '',
    email: String(f['Prospect email'] || '').trim().toLowerCase(),
    outcome: f['Outcome'] === 'Delivered' ? 'delivered' : 'not_delivered',
    status_label: `manual: ${f['Outcome']}`,
    occurred_at: new Date().toISOString(),
    source: 'manual_form',
  },
};
""", per_item=True)
    w.add("Delivery Signal", "n8n-nodes-base.noOp", 1, {}, [440, 0])
    w.load_config([660, 0])
    w.sb_get("Find Prospect", [880, 0], "prospects", always=True, filter_string=(
        "={{ $('Delivery Signal').item.json.tracking_number"
        " ? 'tracking_number=eq.' + encodeURIComponent($('Delivery Signal').item.json.tracking_number)"
        " : 'email=eq.' + encodeURIComponent($('Delivery Signal').item.json.email) }}"))
    w.code("Decide Transition", [1100, 0], r"""
const sig = $('Delivery Signal').item.json;
const row = $json;
if (!row.id) return { json: { action: 'unmatched', sig } };
const open = ['shipped', 'untracked'].includes(row.track);
let action = 'ignore';
if (open && sig.outcome === 'delivered') action = 'delivered';
else if (open && sig.outcome === 'not_delivered') action = 'not_delivered';
else if (sig.outcome === 'update') action = 'update';
const day1 = new Date(sig.occurred_at);
const day1Iso = isNaN(day1) ? new Date().toISOString() : day1.toISOString();
const enroll = new Date(new Date(day1Iso).getTime() + (action === 'delivered' ? 4 * 3600 * 1000 : 0)).toISOString();
return {
  json: {
    action,
    id: row.id,
    hubspot_contact_id: row.hubspot_contact_id,
    first_name: row.first_name,
    company_name: row.company_name,
    email: row.email,
    status_label: sig.status_label,
    source: sig.source,
    day1_at: day1Iso,
    enroll_at: enroll,
    new_track: action === 'delivered' ? 'delivered_not_scanned' : action === 'not_delivered' ? 'not_delivered' : row.track,
  },
};
""", per_item=True)
    w.switch_expr("Route", [1320, 0], 3,
                  "={{ ['delivered', 'not_delivered'].includes($json.action) ? 0 : $json.action === 'update' ? 1 : $json.action === 'unmatched' ? 2 : 3 }}")
    # stage change
    w.code("Stage Row", [1540, -200], r"""
return { json: { id: $json.id, track: $json.new_track, day1_at: $json.day1_at, enroll_at: $json.enroll_at } };
""", per_item=True)
    w.sb_update("Update Stage", [1760, -200], "prospects")
    w.code("Stage Event", [1980, -200], r"""
const d = $('Decide Transition').item.json;
return { json: { prospect_id: d.id, event_type: d.action, occurred_at: d.day1_at, event_key: `${d.id}:${d.action}`, source: d.source } };
""", per_item=True)
    w.sb_create("Log Stage Event", [2200, -200], "events", on_error=True)
    D = "$('Decide Transition').item.json"
    w.http("HubSpot: Stage Properties", [2420, -200], "PATCH",
           "=https://api.hubapi.com/crm/v3/objects/contacts/{{ " + D + ".hubspot_contact_id }}", cred="hubspot", on_error=True,
           body=("={{ JSON.stringify({ properties: { caricature_stage: " + D + ".action === 'delivered' ? 'Delivered' : 'Not delivered',"
                 " caricature_day1_date: " + D + ".day1_at.slice(0, 10) } }) }}"))
    first, last = w.hs_note("Stage", [2640, -200], D + ".hubspot_contact_id",
                            "`Caricature ${" + D + ".action === 'delivered' ? 'delivered' : 'not delivered (returned or refused)'}. Day 1 = ${" + D + ".day1_at.slice(0, 10)}. Source: ${" + D + ".source} (${" + D + ".status_label}).`")
    w.slack("Slack: Stage Change", [3080, -200], (
        "={{ " + D + ".action === 'delivered'"
        " ? `📬 Caricature delivered to ${" + D + ".first_name} at ${" + D + ".company_name}. Delivery email goes out in 4 hours; first call on Day 2.`"
        " : `↩️ Caricature for ${" + D + ".first_name} at ${" + D + ".company_name} was not delivered (${" + D + ".status_label}). Rejection sequence starts now.` }}"))
    # in-transit update
    w.code("Update Event", [1540, 0], r"""
return { json: { prospect_id: $json.id, event_type: 'delivery_update', occurred_at: $json.day1_at,
  event_key: `${$json.id}:update:${$json.status_label}:${$json.day1_at}`, source: $json.source, payload: { status: $json.status_label } } };
""", per_item=True)
    w.sb_create("Log Delivery Update", [1760, 0], "events", on_error=True)
    # unmatched
    w.slack("Slack: Unmatched Update", [1540, 200], (
        "={{ `⚠️ Delivery update with no matching prospect: ${$json.sig.tracking_number || $json.sig.email} (${$json.sig.status_label}). Check the tracking number in Supabase.` }}"))
    w.noop("Already Past Delivery", [1540, 400])

    w.chain("Ship24 Webhook", "Parse Ship24", "Delivery Signal")
    w.chain("Manual Delivery Form", "Parse Form", "Delivery Signal")
    w.chain("Delivery Signal", "Load Config", "Find Prospect", "Decide Transition", "Route")
    w.link("Route", "Stage Row", 0)
    w.link("Route", "Update Event", 1)
    w.link("Route", "Slack: Unmatched Update", 2)
    w.link("Route", "Already Past Delivery", 3)
    w.chain("Stage Row", "Update Stage", "Stage Event", "Log Stage Event", "HubSpot: Stage Properties", first)
    w.link(last, "Slack: Stage Change")
    w.chain("Update Event", "Log Delivery Update")
    return w.dump(out)
