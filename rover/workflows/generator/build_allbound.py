"""Generate the Allbound n8n workflow (Exa research + Claude workers)."""
import json
import sys
import uuid

OUT = sys.argv[1]

HUBSPOT_CRED = {}
SLACK_CRED = {}

nodes = []
connections = {}


def nid():
    return str(uuid.uuid4())


def add(name, ntype, version, params, pos, **extra):
    node = {"parameters": params, "type": ntype, "typeVersion": version,
            "position": pos, "id": nid(), "name": name}
    node.update(extra)
    nodes.append(node)
    return name


def link(src, dst, out_index=0, kind="main"):
    outs = connections.setdefault(src, {}).setdefault(kind, [])
    while len(outs) <= out_index:
        outs.append([])
    outs[out_index].append({"node": dst, "type": kind, "index": 0})


def http(name, pos, method, url, *, auth=None, body=None, query=None, on_error=True, **extra):
    p = {"method": method, "url": url}
    if auth == "hubspot":
        p["authentication"] = "predefinedCredentialType"
        p["nodeCredentialType"] = "hubspotOAuth2Api"
    elif auth == "header":
        p["authentication"] = "genericCredentialType"
        p["genericAuthType"] = "httpHeaderAuth"
    if query:
        p["sendQuery"] = True
        p["queryParameters"] = {"parameters": [{"name": k, "value": v} for k, v in query]}
    if body is not None:
        p["sendBody"] = True
        p["specifyBody"] = "json"
        p["jsonBody"] = body
    p["options"] = {}
    kw = dict(extra)
    if auth == "hubspot":
        kw["credentials"] = HUBSPOT_CRED
    if on_error:
        kw["onError"] = "continueRegularOutput"
    return add(name, "n8n-nodes-base.httpRequest", 4.2, p, pos, **kw)


def if_node(name, pos, left, op_type, operation, right=None):
    cond = {"id": nid(), "leftValue": left, "operator": {"type": op_type, "operation": operation}}
    if right is None:
        cond["rightValue"] = ""
        cond["operator"]["singleValue"] = True
    else:
        cond["rightValue"] = right
    return add(name, "n8n-nodes-base.if", 2.2, {
        "conditions": {
            "options": {"caseSensitive": True, "leftValue": "", "typeValidation": "strict", "version": 2},
            "conditions": [cond], "combinator": "and"},
        "options": {}}, pos)


def code(name, pos, js, mode=None):
    p = {"jsCode": js}
    if mode:
        p["mode"] = mode
    return add(name, "n8n-nodes-base.code", 2, p, pos)


def claude_model(name, pos, max_tokens):
    return add(name, "@n8n/n8n-nodes-langchain.lmChatAnthropic", 1.3, {
        "model": {"__rl": True, "mode": "list", "value": "claude-sonnet-5-5",
                  "cachedResultName": "Claude Sonnet 5.5"},
        "options": {"maxTokensToSample": max_tokens, "temperature": 0.2}}, pos)


def extractor(name, pos, text, schema, system_prompt):
    return add(name, "@n8n/n8n-nodes-langchain.informationExtractor", 1, {
        "text": text, "schemaType": "manual", "inputSchema": json.dumps(schema, indent=2),
        "options": {"systemPromptTemplate": system_prompt}}, pos)


def slack(name, pos, text):
    return add(name, "n8n-nodes-base.slack", 2.3, {
        "authentication": "accessToken", "select": "channel",
        "channelId": {"__rl": True, "mode": "id",
                      "value": "={{ $('Seller & ICP Config').first().json.slack_channel_id }}"},
        "text": text, "otherOptions": {"includeLinkToWorkflow": False}},
        pos, webhookId=nid())


CFG = "$('Seller & ICP Config').first().json"
ACC = "$('Normalize Input').first().json"
FIT = "$('Claude Fit Check').first().json.output"
RC = "$('Claude Research Compiler').first().json.output"
BUNDLE = "$('Build Research Bundle').first().json"

# ---------------------------------------------------------------- intake
hook_path = nid()
add("Webhook", "n8n-nodes-base.webhook", 2,
    {"httpMethod": "POST", "path": hook_path, "options": {}}, [-1200, 0], webhookId=hook_path)

code("Normalize Input", [-980, 0], r"""
const body = $json.body || {};
const mp = body.MessageProperty;
const fromIntentAlert = mp ? (mp[0] ?? mp['0'])?.PropValue : undefined;
const raw = String(body.domain || body.website || fromIntentAlert || '').trim().toLowerCase();
const domain = raw
  .replace(/^[a-z]+:\/\//, '')
  .replace(/^www\./, '')
  .split(/[\/?#]/)[0]
  .replace(/:\d+$/, '');
if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(domain)) {
  throw new Error(`Webhook payload has no valid domain. Received: "${raw}"`);
}
const suppliedName = String(body.company_name || body.companyName || body.name || '').trim();
const root = domain.split('.')[0];
return [{
  json: {
    domain,
    company_name: suppliedName || root.charAt(0).toUpperCase() + root.slice(1),
    company_name_source: suppliedName ? 'webhook' : 'domain',
    data_source: fromIntentAlert ? 'intent_alert' : 'webhook',
    received_at: new Date().toISOString(),
  },
}];
""".strip())

add("Seller & ICP Config", "n8n-nodes-base.set", 3.4, {
    "assignments": {"assignments": [
        {"id": nid(), "name": "seller_company", "value": "", "type": "string"},
        {"id": nid(), "name": "seller_offering", "value": "", "type": "string"},
        {"id": nid(), "name": "icp_definition", "value": "", "type": "string"},
        {"id": nid(), "name": "tier_definitions", "value": "", "type": "string"},
        {"id": nid(), "name": "fit_threshold", "value": 60, "type": "number"},
        {"id": nid(), "name": "persona_titles", "value": "cmo, cro, vp sales, vp marketing, head of sales, head of marketing, demand generation, revops, chief of staff, founders office", "type": "string"},
        {"id": nid(), "name": "persona_seniorities", "value": "c_suite, founder, vp, head, director", "type": "string"},
        {"id": nid(), "name": "max_contacts", "value": 10, "type": "number"},
        {"id": nid(), "name": "news_lookback_days", "value": 90, "type": "number"},
        {"id": nid(), "name": "journey_api_url_template", "value": "", "type": "string"},
        {"id": nid(), "name": "slack_channel_id", "value": "", "type": "string"},
    ]},
    "includeOtherFields": True, "options": {}}, [-760, 0])

if_node("Config Complete?", [-540, 0], "={{ Boolean(" + CFG + ".icp_definition && " + CFG + ".seller_company && " + CFG + ".seller_offering && " + CFG + ".slack_channel_id) }}",
        "boolean", "true")
add("Stop: ICP Config Missing", "n8n-nodes-base.stopAndError", 1, {
    "errorMessage": "Seller & ICP Config is incomplete. Fill seller_company, seller_offering, icp_definition and slack_channel_id before running."},
    [-320, 200])

add("Search HubSpot by Domain", "n8n-nodes-base.hubspot", 2.1, {
    "authentication": "oAuth2", "resource": "company", "operation": "searchByDomain",
    "domain": "={{ " + ACC + ".domain }}", "returnAll": False, "limit": 1, "options": {}},
    [-320, 0], alwaysOutputData=True, credentials=HUBSPOT_CRED)

add("Account State", "n8n-nodes-base.set", 3.4, {
    "assignments": {"assignments": [
        {"id": nid(), "name": "hs_company_id", "value": "={{ $json.companyId ? String($json.companyId) : '' }}", "type": "string"},
        {"id": nid(), "name": "is_new", "value": "={{ !$json.companyId }}", "type": "boolean"},
    ]}, "options": {}}, [-100, 0])

# ---------------------------------------------------------------- Exa research
http("Exa: Company Profile", [120, 0], "POST", "https://api.exa.ai/search", auth="header", body=(
    "={{ JSON.stringify({ query: `" + "${" + ACC + ".company_name} (${" + ACC + ".domain}) company overview: products, customers, business model, headcount, funding`"
    ", type: 'auto', category: 'company', numResults: 3, contents: { text: { maxCharacters: 3000 }, summary: true } }) }}"))

http("Exa: Recent News", [340, 0], "POST", "https://api.exa.ai/search", auth="header", body=(
    "={{ JSON.stringify({ query: `" + "${" + ACC + ".company_name} ${" + ACC + ".domain} news: funding, hiring, leadership changes, product launches, partnerships, expansion`"
    ", type: 'auto', category: 'news', numResults: 8, startPublishedDate: $now.minus({ days: " + CFG + ".news_lookback_days }).toISODate()"
    ", contents: { highlights: true, summary: true } }) }}"))

http("Exa: Company Website", [560, 0], "POST", "https://api.exa.ai/search", auth="header", body=(
    "={{ JSON.stringify({ query: `" + "${" + ACC + ".company_name} products, pricing, customers, integrations, careers`"
    ", type: 'auto', includeDomains: [" + ACC + ".domain], numResults: 6, contents: { text: { maxCharacters: 2500 } } }) }}"))

code("Build Research Bundle", [780, 0], r"""
const sections = [
  ['Company profile', 'Exa: Company Profile'],
  ['Recent news', 'Exa: Recent News'],
  ['Company website', 'Exa: Company Website'],
];
const blocks = [];
const sources = [];
const errors = [];
for (const [label, node] of sections) {
  const out = $(node).first().json;
  if (out.error) {
    errors.push(`${label}: ${typeof out.error === 'string' ? out.error : JSON.stringify(out.error)}`);
    continue;
  }
  for (const r of out.results || []) {
    const id = `S${sources.length + 1}`;
    sources.push({ id, section: label, title: r.title || '', url: r.url || '', published: r.publishedDate || '' });
    const parts = [];
    if (r.summary) parts.push(`Summary: ${r.summary}`);
    if (Array.isArray(r.highlights) && r.highlights.length) parts.push(`Highlights: ${r.highlights.join(' | ')}`);
    if (r.text) parts.push(`Text: ${String(r.text).slice(0, 2500)}`);
    blocks.push(`[${id}] (${label}) ${r.title || 'Untitled'}\nURL: ${r.url}\nPublished: ${r.publishedDate || 'unknown'}\n${parts.join('\n')}`);
  }
}
const research_text = blocks.length
  ? blocks.join('\n\n').slice(0, 40000)
  : 'NO RESEARCH RETRIEVED. Exa returned no usable results for this account.';
return [{ json: { research_text, sources, source_count: sources.length, exa_errors: errors } }];
""".strip())

# ---------------------------------------------------------------- Claude fit check
FIT_SCHEMA = {
    "type": "object",
    "properties": {
        "icp_match": {"type": "string", "enum": ["Yes", "No"]},
        "company_tier": {"type": "string", "enum": ["Tier 1", "Tier 2", "Tier 3", "Not a fit"]},
        "fit_score": {"type": "integer", "minimum": 0, "maximum": 100},
        "confidence": {"type": "string", "enum": ["High", "Medium", "Low"]},
        "matched_criteria": {"type": "array", "items": {"type": "string"}},
        "disqualifiers": {"type": "array", "items": {"type": "string"}},
        "missing_data": {"type": "array", "items": {"type": "string"}},
        "evidence": {"type": "array", "items": {"type": "object", "properties": {
            "claim": {"type": "string"}, "source_id": {"type": "string"}},
            "required": ["claim", "source_id"]}},
        "rationale": {"type": "string"},
    },
    "required": ["icp_match", "company_tier", "fit_score", "confidence", "matched_criteria",
                 "disqualifiers", "missing_data", "evidence", "rationale"],
}
FIT_PROMPT = """You are a B2B qualification analyst. Decide whether one account fits the seller's ideal customer profile, using only the research supplied in the user message.

Rules:
1. Judge every ICP criterion against the research. A criterion with no supporting evidence counts as unmet and goes in missing_data. Never fill gaps from general knowledge about the company.
2. Every item in evidence must cite a source ID from the research, such as S3. Do not cite sources that are not listed.
3. fit_score runs from 0 to 100 and reflects how many ICP criteria are met with evidence, weighted by how central each criterion is to the ICP definition.
4. company_tier: apply the tier definitions when provided. Otherwise use score bands: Tier 1 at 80 and above, Tier 2 at 60 to 79, Tier 3 at 40 to 59, Not a fit below 40.
5. icp_match is Yes only when fit_score meets or exceeds the fit threshold and there are no hard disqualifiers. Otherwise it is No.
6. confidence is Low when fewer than three sources were retrieved or when key criteria are in missing_data.
7. rationale: two to four plain sentences. No em dashes."""

extractor("Claude Fit Check", [1000, 0], (
    "={{ `ACCOUNT\\nCompany: ${" + ACC + ".company_name}\\nDomain: ${" + ACC + ".domain}"
    "\\n\\nSELLER\\n${" + CFG + ".seller_company}: ${" + CFG + ".seller_offering}"
    "\\n\\nICP DEFINITION\\n${" + CFG + ".icp_definition}"
    "\\n\\nTIER DEFINITIONS\\n${" + CFG + ".tier_definitions || 'Not provided. Use the default score bands.'}"
    "\\n\\nFIT THRESHOLD\\n${" + CFG + ".fit_threshold}"
    "\\n\\nRESEARCH (${" + BUNDLE + ".source_count} sources)\\n${" + BUNDLE + ".research_text}` }}"),
    FIT_SCHEMA, FIT_PROMPT)
claude_model("Claude Model: Fit Check", [1000, 220], 2048)

if_node("ICP Match?", [1220, 0], "={{ $json.output.icp_match }}", "string", "equals", "Yes")
add("Not ICP: No Action", "n8n-nodes-base.noOp", 1, {}, [1440, 200])

# ---------------------------------------------------------------- journey + research compiler
http("Get Account Journey", [1440, 0], "GET",
     "={{ " + CFG + ".journey_api_url_template.replace('{domain}', encodeURIComponent(" + ACC + ".domain)) }}", auth="header")
add("Aggregate Journey", "n8n-nodes-base.aggregate", 1,
    {"aggregate": "aggregateAllItemData", "destinationFieldName": "journey", "options": {}}, [1660, 0])

RC_SCHEMA = {
    "type": "object",
    "properties": {
        "account_summary": {"type": "string"},
        "journey_description": {"type": "array", "items": {"type": "string"}},
        "journey_stage": {"type": "string", "enum": ["Marketing Nurture", "Sales Ready"]},
        "product_interest": {"type": "array", "items": {"type": "string"}},
        "in_market": {"type": "string", "enum": ["Yes", "No"]},
        "why_now": {"type": "string"},
        "signals_identified": {"type": "array", "items": {"type": "object", "properties": {
            "signal": {"type": "string"}, "date": {"type": "string"}, "source_id": {"type": "string"}},
            "required": ["signal", "date", "source_id"]}},
        "value_statements": {"type": "array", "items": {"type": "string"}},
        "prospecting_questions": {"type": "array", "items": {"type": "string"}},
        "cited_source_ids": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["account_summary", "journey_description", "journey_stage", "product_interest", "in_market",
                 "why_now", "signals_identified", "value_statements", "prospecting_questions", "cited_source_ids"],
}
RC_PROMPT = """You compile account research for a B2B sales team. Inputs: the seller, the fit check result, the website visit journey from the intent provider, and web research with source IDs.

Produce:
1. account_summary: three sentences on what the company does, who it sells to, and its scale. Facts from research only.
2. journey_description: three to five bullets on the most significant website behaviors, in plain sentences. If the journey data is empty or an error, return one bullet saying journey data was unavailable.
3. journey_stage: Sales Ready when the journey shows decision activity such as repeated pricing page visits, demo or contact form attempts, competitor or comparison pages, or integration and security pages. Otherwise Marketing Nurture. With no journey data, use Marketing Nurture.
4. product_interest: three to five short labels ordered by engagement strength, taken from the pages visited.
5. in_market: Yes only when journey_stage is Sales Ready or a dated research signal from the last 90 days shows active buying motion relevant to the seller. Otherwise No.
6. why_now: two sentences tying the strongest dated signal to the seller's offering. If no signal exists, say so plainly.
7. signals_identified: each with the date as written in the source and its source ID. Omit undated claims.
8. value_statements: two or three statements linking a researched fact about the account to the seller's offering.
9. prospecting_questions: exactly three open questions a seller could ask, each grounded in a cited fact.
10. cited_source_ids: every source ID you relied on.

Never invent facts, numbers, names or dates. No em dashes. No filler phrases."""

extractor("Claude Research Compiler", [1880, 0], (
    "={{ `SELLER\\n${" + CFG + ".seller_company}: ${" + CFG + ".seller_offering}"
    "\\n\\nACCOUNT\\n${" + ACC + ".company_name} (${" + ACC + ".domain})"
    "\\n\\nFIT CHECK\\n${JSON.stringify(" + FIT + ")}"
    "\\n\\nWEBSITE JOURNEY (intent provider)\\n${JSON.stringify($('Aggregate Journey').first().json.journey ?? []).slice(0, 15000)}"
    "\\n\\nWEB RESEARCH\\n${" + BUNDLE + ".research_text}` }}"),
    RC_SCHEMA, RC_PROMPT)
claude_model("Claude Model: Research Compiler", [1880, 220], 4096)

if_node("Sales Ready?", [2100, 0], "={{ $json.output.journey_stage }}", "string", "equals", "Sales Ready")
add("Nurture: No Action", "n8n-nodes-base.noOp", 1, {}, [2320, 200])
if_node("New Account?", [2320, 0], "={{ $('Account State').first().json.is_new }}", "boolean", "true")

# ---------------------------------------------------------------- new account branch
SOURCES_LINES = ("${" + BUNDLE + ".sources.filter(s => " + RC + ".cited_source_ids.includes(s.id)).slice(0, 5)"
                 ".map(s => `${s.id}: ${s.url}`).join('\\n') || 'None cited'}")

slack("Slack: Sales Ready Alert", [2540, -200], (
    "={{ `🔔 New Sales Ready Allbound Alert\\n\\n"
    "*Account:* ${" + ACC + ".company_name} (${" + ACC + ".domain})\\n"
    "*ICP Fit:* ${" + FIT + ".icp_match} | ${" + FIT + ".company_tier} | Score ${" + FIT + ".fit_score} | Confidence ${" + FIT + ".confidence}\\n"
    "*In Market:* ${" + RC + ".in_market}\\n\\n"
    "*Summary:* ${" + RC + ".account_summary}\\n\\n"
    "*Why Now:* ${" + RC + ".why_now}\\n\\n"
    "*Product Interest:* ${" + RC + ".product_interest.join(', ')}\\n\\n"
    "*Signals:*\\n${" + RC + ".signals_identified.map(s => `• ${s.signal} (${s.date}, ${s.source_id})`).join('\\n') || '• None found'}\\n\\n"
    "*Account Journey:*\\n${" + RC + ".journey_description.map(b => `• ${b}`).join('\\n')}\\n\\n"
    "*Icebreakers:*\\n${" + RC + ".prospecting_questions.map((q, i) => `${i + 1}. ${q}`).join('\\n')}\\n\\n"
    "*Sources:*\\n" + SOURCES_LINES + "` }}"))

add("Create Company in HubSpot", "n8n-nodes-base.hubspot", 2.1, {
    "authentication": "oAuth2", "resource": "company",
    "name": "={{ " + ACC + ".company_name }}",
    "additionalFields": {
        "customPropertiesUi": {"customPropertiesValues": [
            {"property": "allbound_journey_stage", "value": "={{ " + RC + ".journey_stage }}"},
            {"property": "allbound_in_market", "value": "={{ " + RC + ".in_market }}"},
            {"property": "allbound_first_intent_date", "value": "={{ $now.toUTC().startOf('day').toMillis() }}"},
            {"property": "allbound_icp_tier", "value": "={{ " + FIT + ".company_tier }}"},
            {"property": "allbound_icp_match", "value": "={{ " + FIT + ".icp_match }}"},
            {"property": "allbound_research_notes", "value": (
                "={{ `Account Summary:\\n${" + RC + ".account_summary}\\n\\nWhy Now:\\n${" + RC + ".why_now}"
                "\\n\\nFit Rationale (score ${" + FIT + ".fit_score}):\\n${" + FIT + ".rationale}"
                "\\n\\nJourney Summary:\\n${" + RC + ".journey_description.join('\\n')}"
                "\\n\\nSources:\\n" + SOURCES_LINES + "` }}")},
        ]},
        "websiteUrl": "={{ " + ACC + ".domain }}",
    }}, [2760, -200], credentials=HUBSPOT_CRED)

code("Build Apollo Query", [2980, -200], r"""
const cfg = $('Seller & ICP Config').first().json;
const domain = $('Normalize Input').first().json.domain;
const split = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
const qs = [`q_organization_domains_list%5B%5D=${encodeURIComponent(domain)}`];
for (const t of split(cfg.persona_titles)) qs.push(`person_titles%5B%5D=${encodeURIComponent(t)}`);
for (const s of split(cfg.persona_seniorities)) qs.push(`person_seniorities%5B%5D=${encodeURIComponent(s)}`);
qs.push('include_similar_titles=true', 'page=1', `per_page=${Number(cfg.max_contacts) || 10}`);
return [{ json: { apollo_url: `https://api.apollo.io/api/v1/mixed_people/api_search?${qs.join('&')}` } }];
""".strip())

http("Apollo: Find Buying Committee", [3200, -200], "POST", "={{ $json.apollo_url }}", auth="header", on_error=False)
add("Split Out People", "n8n-nodes-base.splitOut", 1,
    {"fieldToSplitOut": "people", "include": "noOtherFields", "options": {}}, [3420, -200])
http("Apollo: Enrich Person", [3640, -200], "POST", "https://api.apollo.io/api/v1/people/match", auth="header",
     query=[("id", "={{ $json.id }}"), ("reveal_personal_emails", "false")])

add("Verified Email?", "n8n-nodes-base.filter", 2.2, {
    "conditions": {
        "options": {"caseSensitive": True, "leftValue": "", "typeValidation": "strict", "version": 2},
        "conditions": [
            {"id": nid(), "leftValue": "={{ $json.person?.email_status ?? '' }}", "rightValue": "verified",
             "operator": {"type": "string", "operation": "equals"}},
            {"id": nid(), "leftValue": "={{ $json.person?.email ?? '' }}", "rightValue": "",
             "operator": {"type": "string", "operation": "notEmpty", "singleValue": True}},
        ], "combinator": "and"},
    "options": {}}, [3860, -200])

add("Contact Fields", "n8n-nodes-base.set", 3.4, {
    "assignments": {"assignments": [
        {"id": nid(), "name": "hs_contact_fname", "value": "={{ $json.person.first_name ?? '' }}", "type": "string"},
        {"id": nid(), "name": "hs_contact_lname", "value": "={{ $json.person.last_name ?? '' }}", "type": "string"},
        {"id": nid(), "name": "hs_contact_email", "value": "={{ $json.person.email ?? '' }}", "type": "string"},
        {"id": nid(), "name": "hs_contact_title", "value": "={{ $json.person.title ?? '' }}", "type": "string"},
        {"id": nid(), "name": "hs_contact_company_name", "value": "={{ $json.person.organization?.name ?? " + ACC + ".company_name }}", "type": "string"},
        {"id": nid(), "name": "hs_contact_city", "value": "={{ $json.person.city ?? '' }}", "type": "string"},
        {"id": nid(), "name": "hs_contact_country", "value": "={{ $json.person.country ?? '' }}", "type": "string"},
        {"id": nid(), "name": "hs_contact_linkedin", "value": "={{ $json.person.linkedin_url ?? '' }}", "type": "string"},
        {"id": nid(), "name": "hs_contact_headline", "value": "={{ $json.person.headline ?? '' }}", "type": "string"},
    ]}, "options": {}}, [4080, -200])

add("Upsert Contact in HubSpot", "n8n-nodes-base.hubspot", 2.1, {
    "authentication": "oAuth2", "email": "={{ $json.hs_contact_email }}",
    "additionalFields": {
        "city": "={{ $json.hs_contact_city }}", "companyName": "={{ $json.hs_contact_company_name }}",
        "country": "={{ $json.hs_contact_country }}", "firstName": "={{ $json.hs_contact_fname }}",
        "jobTitle": "={{ $json.hs_contact_title }}", "lastName": "={{ $json.hs_contact_lname }}"},
    "options": {}}, [4300, -200], credentials=HUBSPOT_CRED)

http("Associate Contact to Company", [4520, -200], "PUT",
     "=https://api.hubapi.com/crm/v4/objects/contacts/{{ $json.vid }}/associations/default/companies/{{ $('Create Company in HubSpot').first().json.companyId }}",
     auth="hubspot")

SEQ_SCHEMA = {
    "type": "object",
    "properties": {
        "email_1": {"type": "object", "properties": {"subject": {"type": "string"}, "body": {"type": "string"}}, "required": ["subject", "body"]},
        "email_2": {"type": "object", "properties": {"subject": {"type": "string"}, "body": {"type": "string"}}, "required": ["subject", "body"]},
        "email_3": {"type": "object", "properties": {"subject": {"type": "string"}, "body": {"type": "string"}}, "required": ["subject", "body"]},
        "linkedin_note": {"type": "string"},
        "personalization_sources": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["email_1", "email_2", "email_3", "linkedin_note", "personalization_sources"],
}
SEQ_PROMPT = """You write outbound sequences for a B2B seller. Write a three-email sequence and one LinkedIn connection note for a single prospect.

Rules:
1. Email 1 opens with a specific, cited fact about the account or the prospect's role, connects it to one problem the seller solves, and ends with one low-friction question. Under 110 words.
2. Email 2 is sent three days later. It adds one new piece of evidence or a value statement and does not repeat email 1. Under 90 words.
3. Email 3 is sent seven days after email 2. It is a short close-the-loop note. Under 60 words.
4. linkedin_note is under 280 characters and references one researched fact.
5. Subjects are under six words, lowercase, with no clickbait.
6. Use only facts from the research and prospect data. If a fact is not provided, do not use it. Never reference the prospect's website visits or browsing behavior directly.
7. personalization_sources lists the source IDs or prospect fields each email relied on.
8. Style: plain sentences, no em dashes, no rhetorical openers, no exclamation marks, no lists of three adjectives. Avoid these words: delve, leverage, seamless, robust, elevate, unlock, game-changing, revolutionary, transformative, cutting-edge.
9. End each body without a signature or sign-off line. The sending tool adds it."""

CF = "$('Contact Fields').item.json"
extractor("Claude Sequence Writer", [4740, -200], (
    "={{ `SELLER\\n${" + CFG + ".seller_company}: ${" + CFG + ".seller_offering}"
    "\\n\\nPROSPECT\\nName: ${" + CF + ".hs_contact_fname} ${" + CF + ".hs_contact_lname}"
    "\\nTitle: ${" + CF + ".hs_contact_title}\\nHeadline: ${" + CF + ".hs_contact_headline || 'Not provided'}"
    "\\nCompany: ${" + ACC + ".company_name}"
    "\\n\\nACCOUNT RESEARCH\\nSummary: ${" + RC + ".account_summary}\\nWhy now: ${" + RC + ".why_now}"
    "\\nValue statements:\\n${" + RC + ".value_statements.join('\\n')}"
    "\\nSignals:\\n${" + RC + ".signals_identified.map(s => `${s.signal} (${s.date}, ${s.source_id})`).join('\\n')}"
    "\\nProduct interest: ${" + RC + ".product_interest.join(', ')}"
    "\\n\\nSOURCES\\n${" + BUNDLE + ".sources.map(s => `${s.id}: ${s.title} ${s.url}`).join('\\n')}` }}"),
    SEQ_SCHEMA, SEQ_PROMPT)
claude_model("Claude Model: Sequence Writer", [4740, 20], 3072)

SEQ = "$('Claude Sequence Writer').item.json.output"
http("Log Sequence as HubSpot Note", [4960, -200], "POST", "https://api.hubapi.com/crm/v3/objects/notes", auth="hubspot", body=(
    "={{ JSON.stringify({ properties: { hs_timestamp: $now.toISO(), hs_note_body: ["
    "`<b>Allbound sequence draft</b>`,"
    "`<b>Email 1: ${" + SEQ + ".email_1.subject}</b><br>${" + SEQ + ".email_1.body.replace(/\\n/g, '<br>')}`,"
    "`<b>Email 2: ${" + SEQ + ".email_2.subject}</b><br>${" + SEQ + ".email_2.body.replace(/\\n/g, '<br>')}`,"
    "`<b>Email 3: ${" + SEQ + ".email_3.subject}</b><br>${" + SEQ + ".email_3.body.replace(/\\n/g, '<br>')}`,"
    "`<b>LinkedIn note</b><br>${" + SEQ + ".linkedin_note}`"
    "].join('<br><br>') } }) }}"))

http("Associate Note to Contact", [5180, -200], "PUT",
     "=https://api.hubapi.com/crm/v4/objects/notes/{{ $json.id }}/associations/default/contacts/{{ $('Upsert Contact in HubSpot').item.json.vid }}",
     auth="hubspot")

slack("Slack: Contact and Sequence", [5400, -200], (
    "={{ `👥 ${" + CF + ".hs_contact_fname} ${" + CF + ".hs_contact_lname} | ${" + CF + ".hs_contact_title} | ${" + CF + ".hs_contact_company_name}\\n"
    "${" + CF + ".hs_contact_email} | ${" + CF + ".hs_contact_linkedin || 'No LinkedIn URL'}\\n\\n"
    "*Email 1: ${" + SEQ + ".email_1.subject}*\\n${" + SEQ + ".email_1.body}\\n\\n"
    "*Email 2: ${" + SEQ + ".email_2.subject}*\\n${" + SEQ + ".email_2.body}\\n\\n"
    "*Email 3: ${" + SEQ + ".email_3.subject}*\\n${" + SEQ + ".email_3.body}\\n\\n"
    "*LinkedIn:* ${" + SEQ + ".linkedin_note}` }}"))

# ---------------------------------------------------------------- existing account branch
CID = "$('Account State').first().json.hs_company_id"
http("Get Company Owner", [2540, 200], "GET", "=https://api.hubapi.com/crm/v3/objects/companies/{{ " + CID + " }}",
     auth="hubspot", query=[("properties", "name,hubspot_owner_id")])

http("Update Company Research", [2760, 200], "PATCH", "=https://api.hubapi.com/crm/v3/objects/companies/{{ " + CID + " }}",
     auth="hubspot", body=(
        "={{ JSON.stringify({ properties: {"
        " allbound_journey_stage: " + RC + ".journey_stage,"
        " allbound_in_market: " + RC + ".in_market,"
        " allbound_icp_tier: " + FIT + ".company_tier,"
        " allbound_icp_match: " + FIT + ".icp_match,"
        " allbound_research_notes: `Account Summary:\\n${" + RC + ".account_summary}\\n\\nWhy Now:\\n${" + RC + ".why_now}"
        "\\n\\nFit Rationale (score ${" + FIT + ".fit_score}):\\n${" + FIT + ".rationale}"
        "\\n\\nJourney Summary:\\n${" + RC + ".journey_description.join('\\n')}`"
        " } }) }}"))

http("Get Company Tasks", [2980, 200], "GET", "=https://api.hubapi.com/crm/v4/objects/companies/{{ " + CID + " }}/associations/tasks",
     auth="hubspot", query=[("limit", "500")], on_error=False)

code("Collect Task IDs", [3200, 200], r"""
const ids = ($json.results || []).map((r) => String(r.toObjectId)).filter(Boolean).slice(0, 100);
return [{ json: { task_ids: ids, has_tasks: ids.length > 0 } }];
""".strip())

if_node("Has Tasks?", [3420, 200], "={{ $json.has_tasks }}", "boolean", "true")
http("Read Tasks", [3640, 100], "POST", "https://api.hubapi.com/crm/v3/objects/tasks/batch/read", auth="hubspot",
     on_error=False, body="={{ JSON.stringify({ properties: ['hs_task_subject', 'hs_task_status'], inputs: $json.task_ids.map(id => ({ id })) }) }}")

code("Evaluate BOFU Tasks", [3860, 200], r"""
const tasks = $json.results || [];
const active = tasks.filter((t) => {
  const p = t.properties || {};
  return String(p.hs_task_subject || '').includes('BOFU') && p.hs_task_status !== 'COMPLETED';
});
return [{ json: { has_active_bofu: active.length > 0, active_bofu_count: active.length } }];
""".strip())

if_node("No Active BOFU Task?", [4080, 200], "={{ $json.has_active_bofu }}", "boolean", "false")
add("Active BOFU Exists: No Action", "n8n-nodes-base.noOp", 1, {}, [4300, 400])

OWNER = "$('Get Company Owner').first().json.properties?.hubspot_owner_id"
http("Create BOFU Task", [4300, 200], "POST", "https://api.hubapi.com/crm/v3/objects/tasks", auth="hubspot", on_error=False, body=(
    "={{ JSON.stringify({ properties: Object.assign({"
    " hs_timestamp: $now.plus({ days: 1 }).toUTC().toISO(),"
    " hs_task_subject: `BOFU Outreach: ${" + ACC + ".company_name}`,"
    " hs_task_body: [`Why now: ${" + RC + ".why_now}`, `Value pointers:\\n${" + RC + ".value_statements.join('\\n')}`,"
    " `Openers:\\n${" + RC + ".prospecting_questions.join('\\n')}`, `Journey:\\n${" + RC + ".journey_description.join('\\n')}`].join('\\n\\n'),"
    " hs_task_status: 'NOT_STARTED', hs_task_priority: 'HIGH', hs_task_type: 'TODO' },"
    " " + OWNER + " ? { hubspot_owner_id: " + OWNER + " } : {}) }) }}"))

http("Associate Task to Company", [4520, 200], "PUT",
     "=https://api.hubapi.com/crm/v4/objects/tasks/{{ $json.id }}/associations/default/companies/{{ " + CID + " }}",
     auth="hubspot")

http("Get Owner Name", [4740, 200], "GET",
     "=https://api.hubapi.com/crm/v3/owners/{{ " + OWNER + " || 'unassigned' }}", auth="hubspot")

OWN = "$('Get Owner Name').first().json"
slack("Slack: BOFU Task Created", [4960, 200], (
    "={{ `🔔 BOFU task created for ${" + ACC + ".company_name} (${" + ACC + ".domain})\\n"
    "*Owner:* ${" + OWN + ".firstName ? `${" + OWN + ".firstName} ${" + OWN + ".lastName || ''}`.trim() : 'Unassigned in HubSpot'}\\n"
    "*ICP Fit:* ${" + FIT + ".company_tier} | Score ${" + FIT + ".fit_score}\\n\\n"
    "*Why Now:* ${" + RC + ".why_now}\\n\\n"
    "*Research Pointers:*\\n${" + RC + ".value_statements.map(v => `• ${v}`).join('\\n')}\\n\\n"
    "*Openers:*\\n${" + RC + ".prospecting_questions.map((q, i) => `${i + 1}. ${q}`).join('\\n')}\\n\\n"
    "*Sources:*\\n" + SOURCES_LINES + "` }}"))

# ---------------------------------------------------------------- wiring
for a, b in [
    ("Webhook", "Normalize Input"), ("Normalize Input", "Seller & ICP Config"),
    ("Seller & ICP Config", "Config Complete?"),
    ("Search HubSpot by Domain", "Account State"), ("Account State", "Exa: Company Profile"),
    ("Exa: Company Profile", "Exa: Recent News"), ("Exa: Recent News", "Exa: Company Website"),
    ("Exa: Company Website", "Build Research Bundle"), ("Build Research Bundle", "Claude Fit Check"),
    ("Claude Fit Check", "ICP Match?"), ("Get Account Journey", "Aggregate Journey"),
    ("Aggregate Journey", "Claude Research Compiler"), ("Claude Research Compiler", "Sales Ready?"),
    ("Slack: Sales Ready Alert", "Create Company in HubSpot"),
    ("Create Company in HubSpot", "Build Apollo Query"), ("Build Apollo Query", "Apollo: Find Buying Committee"),
    ("Apollo: Find Buying Committee", "Split Out People"), ("Split Out People", "Apollo: Enrich Person"),
    ("Apollo: Enrich Person", "Verified Email?"), ("Verified Email?", "Contact Fields"),
    ("Contact Fields", "Upsert Contact in HubSpot"), ("Upsert Contact in HubSpot", "Associate Contact to Company"),
    ("Associate Contact to Company", "Claude Sequence Writer"), ("Claude Sequence Writer", "Log Sequence as HubSpot Note"),
    ("Log Sequence as HubSpot Note", "Associate Note to Contact"), ("Associate Note to Contact", "Slack: Contact and Sequence"),
    ("Get Company Owner", "Update Company Research"), ("Update Company Research", "Get Company Tasks"),
    ("Get Company Tasks", "Collect Task IDs"), ("Collect Task IDs", "Has Tasks?"),
    ("Read Tasks", "Evaluate BOFU Tasks"), ("Create BOFU Task", "Associate Task to Company"),
    ("Associate Task to Company", "Get Owner Name"), ("Get Owner Name", "Slack: BOFU Task Created"),
]:
    link(a, b)

link("Config Complete?", "Search HubSpot by Domain", 0)
link("Config Complete?", "Stop: ICP Config Missing", 1)
link("ICP Match?", "Get Account Journey", 0)
link("ICP Match?", "Not ICP: No Action", 1)
link("Sales Ready?", "New Account?", 0)
link("Sales Ready?", "Nurture: No Action", 1)
link("New Account?", "Slack: Sales Ready Alert", 0)
link("New Account?", "Get Company Owner", 1)
link("Has Tasks?", "Read Tasks", 0)
link("Has Tasks?", "Evaluate BOFU Tasks", 1)
link("No Active BOFU Task?", "Create BOFU Task", 0)
link("No Active BOFU Task?", "Active BOFU Exists: No Action", 1)
link("Evaluate BOFU Tasks", "No Active BOFU Task?")
for model, root in [("Claude Model: Fit Check", "Claude Fit Check"),
                    ("Claude Model: Research Compiler", "Claude Research Compiler"),
                    ("Claude Model: Sequence Writer", "Claude Sequence Writer")]:
    link(model, root, kind="ai_languageModel")

for node in nodes:
    if node.get("credentials") == {}:
        del node["credentials"]

workflow = {
    "name": "Rover - Allbound Account Research",
    "nodes": nodes,
    "pinData": {},
    "connections": connections,
    "active": False,
    "settings": {"executionOrder": "v1"},
    "tags": [],
}
with open(OUT, "w") as f:
    json.dump(workflow, f, indent=2, ensure_ascii=False)
print(f"{len(nodes)} nodes written to {OUT}")
