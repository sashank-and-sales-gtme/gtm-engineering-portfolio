from n8nlib import WF, CFG

SCHEMA = {
    "type": "object",
    "properties": {
        "subject": {"type": "string"},
        "body": {"type": "string"},
        "rationale": {"type": "string"},
    },
    "required": ["subject", "body", "rationale"],
}

PROMPT = """You write one short personalised follow-up email for InteractAI's caricature direct-mail campaign. InteractAI is a product-aware agent that clones a company's best reps to deliver interactive demos on their website around the clock.

The prospect received (or was sent) a caricature of themselves with a card and QR code. They have not become sales ready, so this email re-opens the conversation.

Angle by campaign number:
1. Value: the delay between interest and a demo loses buyers; InteractAI answers that interest instantly.
2. Proof: name Sprinto and Yellow.ai as teams using InteractAI, and the 3x MQLs for Sprinto at zero CAC spend. Use no other numbers.
3. Soft close: one line on the caricature, one line of value, and an easy way to say not now.

Rules:
1. Under 90 words. First line is the prospect's first name followed by a comma.
2. Reference the caricature naturally. Reference the prospect's role or company where it helps.
3. Never mention website visits, emails they opened, links they clicked, or any tracking.
4. Use only the proof points listed above. Do not invent customers, numbers or features.
5. End with one low-friction question. Offer an in-person coffee at the meeting location when it fits.
6. Plain sentences. No em dashes, no exclamation marks, no rhetorical openers. Avoid: delve, leverage, seamless, robust, elevate, unlock, game-changing, revolutionary, transformative, cutting-edge.
7. Subject: under six words, lowercase.
8. No signature or sign-off. The sending tool adds it.
9. rationale: one sentence for the reviewer on why this angle fits this prospect."""


def build(out):
    w = WF("Caricature 6 - Nurture Drafts and Approvals")
    # ---------------- drafting
    w.schedule("Daily 9:13 PT", [0, 0], at_hour=9, at_minute=13)
    w.load_config([220, 0])
    w.if_bool("Ready To Draft?", [440, 0], (
        "={{ Boolean(" + CFG + ".n8n_base_url && " + CFG + ".instantly_campaign_nurture_1 && "
        + CFG + ".instantly_campaign_nurture_2 && " + CFG + ".instantly_campaign_nurture_3) }}"))
    w.stop("Stop: Nurture Config Missing", [660, 200],
           "campaign_config needs n8n_base_url and instantly_campaign_nurture_1, _2 and _3 before nurture drafts can run.")
    w.sb_get("Get Nurture Candidates", [660, 0], "v_nurture_candidates")
    w.claude_extractor("Claude Nurture Writer", [880, 0], (
        "={{ `PROSPECT\\nName: ${$json.first_name} ${$json.last_name || ''}\\nTitle: ${$json.title || 'Not provided'}"
        "\\nCompany: ${$json.company_name}\\nCaricature status: ${$json.track === 'not_delivered' ? 'package was returned, not delivered'"
        " : $json.track === 'qr_scanned' ? 'delivered and they scanned the QR code' : 'delivered'}"
        "\\nCampaign number: ${$json.campaign_number}\\nMeeting location: ${" + CFG + ".meet_location}` }}"),
        SCHEMA, PROMPT)
    w.code("Draft Row", [1100, 0], r"""
const c = $('Get Nurture Candidates').item.json;
const o = $json.output;
return { json: { prospect_id: c.id, campaign_number: c.campaign_number, subject: o.subject, body: o.body, rationale: o.rationale } };
""", per_item=True)
    w.sb_create("Save Draft", [1320, 0], "nurture_drafts", on_error=True)
    w.if_bool("Draft Saved?", [1540, 0], "={{ Boolean($json.id) }}")
    w.code("Drafted Event", [1760, -100], r"""
return { json: { prospect_id: $json.prospect_id, event_type: 'nurture_drafted', event_key: `${$json.prospect_id}:draft:${$json.id}`,
  source: 'nurture', payload: { draft_id: $json.id, campaign_number: $json.campaign_number } } };
""", per_item=True)
    w.sb_create("Log Drafted", [1980, -100], "events", on_error=True)
    D = "$('Save Draft').item.json"
    C = "$('Get Nurture Candidates').item.json"
    LINK = CFG + ".n8n_base_url.replace(/\\/+$/, '') + '/webhook/caricature-nurture-decision?d=' + " + D + ".id + '&t=' + " + D + ".approval_token"
    w.slack("Slack: Approve Draft", [2200, -100], (
        "={{ `✍️ Nurture email ${" + D + ".campaign_number}/3 for ${[" + C + ".first_name, " + C + ".last_name].filter(Boolean).join(' ')} at ${" + C + ".company_name}"
        " (${" + C + ".intent_tier}, ${" + C + ".intent_score}/100)\\n\\n*Subject:* ${" + D + ".subject}\\n\\n${" + D + ".body}\\n\\n_${" + D + ".rationale}_\\n\\n"
        "✅ Approve and send: ${" + LINK + " + '&a=approve'}\\n❌ Reject: ${" + LINK + " + '&a=reject'}` }}"))

    # ---------------- decision webhook
    w.webhook("Decision Link", "caricature-nurture-decision", [0, 500], method="GET", auth=False, respond_node=True)
    w.code("Read Decision", [220, 500], r"""
const q = $json.query || {};
const d = String(q.d || '').replace(/[^a-f0-9-]/gi, '');
const t = String(q.t || '').replace(/[^a-f0-9]/gi, '');
const a = q.a === 'approve' ? 'approve' : q.a === 'reject' ? 'reject' : '';
return { json: { draft_id: d, token: t, action: a, valid_input: Boolean(d && t && a) } };
""", per_item=True)
    w.sb_get("Find Draft", [440, 500], "nurture_drafts", always=True, filter_string=(
        "={{ $('Read Decision').first().json.valid_input"
        " ? 'id=eq.' + $('Read Decision').first().json.draft_id + '&approval_token=eq.' + $('Read Decision').first().json.token + '&status=eq.pending'"
        " : 'id=eq.00000000-0000-0000-0000-000000000000' }}"))
    w.if_bool("Draft Valid?", [660, 500], "={{ Boolean($json.id) }}")
    w.respond("Respond: Invalid", [880, 700], "<h3>This link has expired or was already used.</h3>")
    w.if_bool("Approve?", [880, 400], "={{ $('Read Decision').first().json.action === 'approve' }}")

    # approve path
    w.sb_get("Config For Send", [1100, 300], "campaign_config")
    w.sb_get("Get Prospect", [1320, 300], "prospects", filter_string="={{ 'id=eq.' + $('Find Draft').first().json.prospect_id }}")
    DR = "$('Find Draft').first().json"
    CF = "$('Config For Send').first().json"
    w.http("Instantly: Add To Nurture", [1540, 300], "POST", "https://api.instantly.ai/api/v2/leads", cred="header", body=(
        "={{ JSON.stringify({ campaign: " + CF + "['instantly_campaign_nurture_' + " + DR + ".campaign_number], email: $json.email,"
        " first_name: $json.first_name, last_name: $json.last_name || '', company_name: $json.company_name, skip_if_in_campaign: true,"
        " custom_variables: { orgName: $json.company_name, nurtureSubject: " + DR + ".subject, nurtureBody: " + DR + ".body } }) }}"))
    w.code("Approved Draft Row", [1980, 300], r"""
const dr = $('Find Draft').first().json;
return [{ json: { id: dr.id, status: 'approved', decided_at: new Date().toISOString() } }];
""")
    w.sb_update("Mark Draft Approved", [2200, 300], "nurture_drafts")
    w.code("Prospect Nurture Row", [2420, 300], r"""
const dr = $('Find Draft').first().json;
return { json: { id: dr.prospect_id, campaign_count: dr.campaign_number, last_nurture_at: new Date().toISOString() } };
""", per_item=True)
    w.sb_update("Update Prospect Count", [2640, 300], "prospects")
    w.code("Approved Event", [2860, 300], r"""
const dr = $('Find Draft').first().json;
return { json: { prospect_id: dr.prospect_id, event_type: 'nurture_approved', event_key: `${dr.prospect_id}:approved:${dr.id}`,
  source: 'nurture', payload: { draft_id: dr.id, campaign_number: dr.campaign_number } } };
""", per_item=True)
    w.sb_create("Log Approved", [3080, 300], "events", on_error=True)
    P = "$('Get Prospect').first().json"
    w.if_bool("Approved In HubSpot?", [3300, 300], "={{ Boolean(" + P + ".hubspot_contact_id) }}")
    w.hs_note("Nurture", [3520, 300], P + ".hubspot_contact_id",
              "`Nurture email ${" + DR + ".campaign_number}/3 approved and queued in Instantly.<br><b>${" + DR + ".subject}</b><br>${" + DR + ".body.replace(/\\n/g, '<br>')}`")
    w.respond("Respond: Approved", [3520, 500], "={{ `<h3>Approved. Nurture email ${" + DR + ".campaign_number}/3 for ${" + P + ".first_name} is queued in Instantly.</h3>` }}")

    # reject path
    w.code("Rejected Rows", [1100, 550], r"""
const dr = $('Find Draft').first().json;
return { json: { id: dr.id, status: 'rejected', decided_at: new Date().toISOString() } };
""", per_item=True)
    w.sb_update("Mark Draft Rejected", [1320, 550], "nurture_drafts")
    w.code("Prospect Skip Row", [1540, 550], r"""
const dr = $('Find Draft').first().json;
return { json: { id: dr.prospect_id, last_nurture_at: new Date().toISOString() } };
""", per_item=True)
    w.sb_update("Pause Prospect Nurture", [1760, 550], "prospects")
    w.respond("Respond: Rejected", [1980, 550], "<h3>Rejected. No email sent. This prospect gets a new draft in 14 days.</h3>")

    w.chain("Daily 9:13 PT", "Load Config", "Ready To Draft?")
    w.link("Ready To Draft?", "Get Nurture Candidates", 0)
    w.link("Ready To Draft?", "Stop: Nurture Config Missing", 1)
    w.chain("Get Nurture Candidates", "Claude Nurture Writer", "Draft Row", "Save Draft", "Draft Saved?")
    w.link("Draft Saved?", "Drafted Event", 0)
    w.chain("Drafted Event", "Log Drafted", "Slack: Approve Draft")

    w.chain("Decision Link", "Read Decision", "Find Draft", "Draft Valid?")
    w.link("Draft Valid?", "Approve?", 0)
    w.link("Draft Valid?", "Respond: Invalid", 1)
    w.link("Approve?", "Config For Send", 0)
    w.link("Approve?", "Rejected Rows", 1)
    w.chain("Config For Send", "Get Prospect", "Instantly: Add To Nurture", "Approved Draft Row",
            "Mark Draft Approved", "Prospect Nurture Row", "Update Prospect Count", "Approved Event", "Log Approved",
            "Approved In HubSpot?")
    w.link("Approved In HubSpot?", "Nurture: Create Note", 0)
    w.link("Approved In HubSpot?", "Respond: Approved", 1)
    w.link("Nurture: Link Note", "Respond: Approved")
    w.chain("Rejected Rows", "Mark Draft Rejected", "Prospect Skip Row", "Pause Prospect Nurture", "Respond: Rejected")
    return w.dump(out)
