from n8nlib import WF, CFG


def build(out):
    w = WF("Caricature 4 - Intent Scorer")
    w.schedule("Daily 7:07 PT", [0, 0], at_hour=7, at_minute=7)
    w.load_config([220, 0])
    w.sb_get("Get Scores", [440, -150], "v_prospect_scores")
    w.code("Plan Score Updates", [660, -150], r"""
const now = new Date().toISOString();
return $input.all().map(({ json: s }) => ({ json: {
  row: { id: s.id, intent_score: s.score, intent_tier: s.tier, score_updated_at: now },
  hubspot_contact_id: s.hubspot_contact_id || '',
  score: s.score, tier: s.tier, previous_tier: s.previous_tier,
  newly_sales_ready: ['Hot', 'Warm'].includes(s.tier) && !s.sales_ready_at,
  first_name: s.first_name, last_name: s.last_name || '', company_name: s.company_name, email: s.email,
  signals: [s.qr_visit && 'QR landing', s.demo && 'demo engaged', s.lp_to_contact && 'QR session to contact page',
            s.visits_14d >= 3 && `${s.visits_14d} visits in 14 days`, s.visited && 'website visit'].filter(Boolean),
} }));
""")
    w.code("Score Row", [880, -300], "return { json: $json.row };", per_item=True)
    w.sb_update("Save Score", [1100, -300], "prospects")
    w.if_bool("In HubSpot?", [880, -150], "={{ Boolean($json.hubspot_contact_id) }}")
    w.http("HubSpot: Score Properties", [1100, -150], "PATCH",
           "=https://api.hubapi.com/crm/v3/objects/contacts/{{ $json.hubspot_contact_id }}", cred="hubspot", on_error=True,
           body="={{ JSON.stringify({ properties: { caricature_intent_score: String($json.score), caricature_intent_tier: $json.tier } }) }}")
    w.if_bool("Newly Sales Ready?", [880, 0], "={{ $json.newly_sales_ready }}")
    w.code("Sales Ready Row", [1100, 0], "return { json: { id: $json.row.id, sales_ready_at: new Date().toISOString() } };", per_item=True)
    w.sb_update("Mark Sales Ready", [1320, 0], "prospects")
    w.code("Sales Ready Event", [1540, 0], r"""
const s = $('Newly Sales Ready?').item.json;
return { json: { prospect_id: s.row.id, event_type: 'sales_ready', event_key: `${s.row.id}:sales_ready:${new Date().toISOString().slice(0, 10)}`,
  source: 'scorer', payload: { score: s.score, tier: s.tier } } };
""", per_item=True)
    w.sb_create("Log Sales Ready", [1760, 0], "events", on_error=True)
    S = "$('Newly Sales Ready?').item.json"
    w.hs_task("Sales Ready", [1980, 0], S + ".hubspot_contact_id",
              "`Sales ready (${" + S + ".tier}, ${" + S + ".score}/100): call ${" + S + ".first_name} at ${" + S + ".company_name}`",
              "`Signals in the last 30 days: ${" + S + ".signals.join(', ')}. Cold call and push for an office visit or "
              "${" + CFG + ".meet_location}. Use the caricature as the opener.`")
    w.slack("Slack: Sales Ready", [2420, 0], (
        "={{ `🔥 Sales ready: ${[" + S + ".first_name, " + S + ".last_name].filter(Boolean).join(' ')} at ${" + S + ".company_name} is ${" + S + ".tier}"
        " (${" + S + ".score}/100). Signals: ${" + S + ".signals.join(', ')}. Call task created in HubSpot.` }}"))

    # cooldown branch
    w.sb_get("Get Cooldown Due", [440, 250], "v_cooldown_due")
    w.code("Cooldown Row", [660, 250], r"""
const until = new Date(Date.now() + 90 * 86400 * 1000).toISOString();
return { json: { id: $json.id, cooldown_until: until, campaign_count: 0 } };
""", per_item=True)
    w.sb_update("Start Cooldown", [880, 250], "prospects")
    w.code("Cooldown Event", [1100, 250], r"""
return { json: { prospect_id: $json.id, event_type: 'cooldown', event_key: `${$json.id}:cooldown:${$json.cooldown_until.slice(0, 10)}`,
  source: 'scorer', payload: { until: $json.cooldown_until } } };
""", per_item=True)
    w.sb_create("Log Cooldown", [1320, 250], "events", on_error=True)
    C = "$('Get Cooldown Due').item.json"
    w.if_bool("Cooldown In HubSpot?", [1540, 250], "={{ Boolean(" + C + ".hubspot_contact_id) }}")
    w.hs_note("Cooldown", [1760, 250], C + ".hubspot_contact_id",
              "`Still ${" + C + ".intent_tier} after 3 nurture campaigns. 90-day cooldown until ${$('Cooldown Row').item.json.cooldown_until.slice(0, 10)}.`")

    w.chain("Daily 7:07 PT", "Load Config", "Get Scores", "Plan Score Updates")
    for gate in ["Score Row", "In HubSpot?", "Newly Sales Ready?"]:
        w.link("Plan Score Updates", gate)
    w.link("Score Row", "Save Score")
    w.link("In HubSpot?", "HubSpot: Score Properties", 0)
    w.link("Newly Sales Ready?", "Sales Ready Row", 0)
    w.chain("Sales Ready Row", "Mark Sales Ready", "Sales Ready Event", "Log Sales Ready", "Sales Ready: Create Task")
    w.link("Sales Ready: Link Task", "Slack: Sales Ready")
    w.link("Load Config", "Get Cooldown Due")
    w.chain("Get Cooldown Due", "Cooldown Row", "Start Cooldown", "Cooldown Event", "Log Cooldown", "Cooldown In HubSpot?")
    w.link("Cooldown In HubSpot?", "Cooldown: Create Note", 0)
    return w.dump(out)
