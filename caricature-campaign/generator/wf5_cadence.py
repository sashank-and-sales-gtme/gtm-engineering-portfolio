from n8nlib import WF, CFG

CALL_JS = r"""
const cfg = $('Load Config').first().json;
const c = $json;
const sender = cfg.sender_name || 'Sudhir';
const meet = cfg.meet_location || 'Blue Bottle';
const f = c.first_name;
const delivered = c.track === 'delivered_not_scanned';
const angle = delivered
  ? `Open with the caricature on their desk, then move to the value: a product-aware agent that runs interactive demos 24/7. Push for an in-person meeting at their office or ${meet}.`
  : `Open with the caricature that got stuck at ${c.company_name}'s mailroom and offer to hand-deliver it. Move to the value: a product-aware agent that runs interactive demos 24/7. Push for an in-person meeting at their office or ${meet}.`;
const voice = c.call_number === 4
  ? `Hi ${f}, ${sender} from InteractAI. Last call from me. If timing is off, no problem, I'll stop reaching out. If the mini-${f} deserves a proper handover, just reply to my email.`
  : delivered
    ? `Hi ${f}, ${sender} from InteractAI. Hope the mini-${f} found a spot on your desk. We turn site visitors into booked demos for teams like Sprinto. Coffee this week? I'll text a time.`
    : `Hi ${f}, ${sender} from InteractAI. Your caricature got stuck at ${c.company_name}'s mailroom, so I'd love to hand it over in person. We help teams like Sprinto book more demos. Coffee this week?`;
const lines = [`Day ${c.call_day} call (${c.call_number} of 4), ${delivered ? 'delivered, QR not scanned' : 'package not delivered'} track.`, '', `Angle: ${angle}`];
if (c.call_number >= 2) {
  lines.push('', `If DNP, leave this voice note (keep it under 15 seconds):`, voice);
}
if (c.call_number === 4) {
  lines.push('', 'If DNP, this is the final touch. Make the stop-communication intent clear.');
}
return { json: {
  id: c.id, hubspot_contact_id: c.hubspot_contact_id || '', call_day: c.call_day,
  subject: `Caricature call ${c.call_number}/4 (Day ${c.call_day}): ${c.first_name}${c.last_name ? ' ' + c.last_name : ''}, ${c.company_name}`,
  body: lines.join('\n'),
} };
"""


def build(out):
    w = WF("Caricature 5 - Cadence Runner")
    w.schedule("Every Hour", [0, 0], hours_interval=1)
    w.load_config([220, 0])
    w.if_bool("Campaigns Configured?", [440, 0], (
        "={{ Boolean(" + CFG + ".instantly_campaign_delivered && " + CFG + ".instantly_campaign_not_delivered) }}"))
    w.stop("Stop: Missing Campaign IDs", [660, 200],
           "campaign_config is missing instantly_campaign_delivered or instantly_campaign_not_delivered.")

    # enrollment branch
    w.sb_get("Get Due Enrollments", [660, -150], "v_due_enrollments")
    w.http("Instantly: Add Lead", [880, -150], "POST", "https://api.instantly.ai/api/v2/leads", cred="header", on_error=True,
           body=("={{ JSON.stringify({ campaign: $json.campaign_id, email: $json.email, first_name: $json.first_name,"
                 " last_name: $json.last_name || '', company_name: $json.company_name, skip_if_in_campaign: true,"
                 " custom_variables: { orgName: $json.company_name, meetDay: $json.meet_day, lpUrl: $json.lp_url || '' } }) }}"))
    w.code("Enrollment Row", [1100, -150], r"""
const d = $('Get Due Enrollments').item.json;
if ($json.error) return { json: { failed: true, id: d.id, email: d.email, error: $json.error.message || JSON.stringify($json.error) } };
const row = { id: d.id, enrolled_at: new Date().toISOString() };
if ($json.id) row.instantly_lead_id = $json.id;
return { json: row };
""", per_item=True)
    w.if_bool("Enrolled?", [1320, -150], "={{ !$json.failed }}")
    w.sb_update("Save Enrollment", [1540, -250], "prospects")
    w.code("Enrolled Event", [1760, -250], r"""
const d = $('Get Due Enrollments').item.json;
return { json: { prospect_id: d.id, event_type: 'enrolled', event_key: `${d.id}:enrolled:${d.track}`, source: 'cadence',
  payload: { campaign_id: d.campaign_id, track: d.track } } };
""", per_item=True)
    w.sb_create("Log Enrolled", [1980, -250], "events", on_error=True)
    E = "$('Get Due Enrollments').item.json"
    w.if_bool("Enrolled In HubSpot?", [2200, -250], "={{ Boolean(" + E + ".hubspot_contact_id) }}")
    w.hs_note("Enrolled", [2420, -250], E + ".hubspot_contact_id",
              "`Enrolled in the ${" + E + ".track === 'delivered_not_scanned' ? 'successful delivery' : 'package rejection'} email sequence (Instantly).`")
    w.slack("Slack: Enrollment Failed", [1540, -50], "={{ `⚠️ Instantly enrollment failed for ${$json.email}: ${$json.error}. It will retry next hour.` }}")

    # call task branch
    w.sb_get("Get Due Calls", [660, 150], "v_due_calls")
    w.code("Build Call Task", [880, 150], CALL_JS, per_item=True)
    w.if_bool("Call In HubSpot?", [1100, 150], "={{ Boolean($json.hubspot_contact_id) }}")
    B = "$('Build Call Task').item.json"
    w.hs_task("Cadence", [1320, 150], B + ".hubspot_contact_id", B + ".subject", B + ".body")
    w.code("Call Row", [1760, 150], "const b = $('Build Call Task').item.json; return { json: { id: b.id, last_call_day: b.call_day } };", per_item=True)
    w.sb_update("Save Call Day", [1980, 150], "prospects")
    w.code("Call Event", [2200, 150], r"""
const b = $('Build Call Task').item.json;
return { json: { prospect_id: b.id, event_type: 'call_task_created', event_key: `${b.id}:call:${b.call_day}`, source: 'cadence', payload: { day: b.call_day } } };
""", per_item=True)
    w.sb_create("Log Call Task", [2420, 150], "events", on_error=True)
    w.slack("Slack: Missing HubSpot ID", [1320, 350], "={{ `⚠️ Call ${$json.call_day} due for prospect ${$json.id} but it has no HubSpot contact ID. Task not created.` }}")

    w.chain("Every Hour", "Load Config", "Campaigns Configured?")
    w.link("Campaigns Configured?", "Get Due Enrollments", 0)
    w.link("Campaigns Configured?", "Get Due Calls", 0)
    w.link("Campaigns Configured?", "Stop: Missing Campaign IDs", 1)
    w.chain("Get Due Enrollments", "Instantly: Add Lead", "Enrollment Row", "Enrolled?")
    w.link("Enrolled?", "Save Enrollment", 0)
    w.link("Enrolled?", "Slack: Enrollment Failed", 1)
    w.chain("Save Enrollment", "Enrolled Event", "Log Enrolled", "Enrolled In HubSpot?")
    w.link("Enrolled In HubSpot?", "Enrolled: Create Note", 0)
    w.chain("Get Due Calls", "Build Call Task", "Call In HubSpot?")
    w.link("Call In HubSpot?", "Cadence: Create Task", 0)
    w.link("Call In HubSpot?", "Slack: Missing HubSpot ID", 1)
    w.chain("Cadence: Link Task", "Call Row", "Save Call Day", "Call Event", "Log Call Task")
    w.setup_note("## Caricature 5: Cadence Runner\n\nBefore activating: run supabase/migration.sql and fill the campaign_config row.\n\nRuns hourly. Needs instantly_campaign_delivered and instantly_campaign_not_delivered in campaign_config; the email copy for both campaigns is in docs/setup.md.\n\nCredentials: Supabase API, HubSpot App Token, Header Auth `Authorization: Bearer <Instantly key>`, Slack API.\n\nFull guide: caricature-campaign/docs/setup.md in github.com/sashank-and-sales-gtme/gtm-engineering-portfolio")
    return w.dump(out)
