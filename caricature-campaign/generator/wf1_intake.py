from n8nlib import WF, CFG


def build(out):
    w = WF("Caricature 1 - Prospect Intake")
    w.webhook("Intake Webhook", "caricature-intake", [0, 0], respond_node=True)
    w.load_config([220, 0])
    w.code("Normalize Prospects", [440, 0], r"""
const body = $('Intake Webhook').first().json.body || {};
const list = Array.isArray(body.prospects) ? body.prospects : [body];
const UNTRACKED = ['', 'doordash', 'dunzo', 'porter', 'swiggy genie', 'uber', 'other', 'hand delivery'];
const slugify = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
const problems = [];
const out = list.map((p, i) => {
  const email = String(p.email || '').trim().toLowerCase();
  const first = String(p.first_name || p.firstName || '').trim();
  const company = String(p.company_name || p.orgName || p.company || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) problems.push(`row ${i + 1}: invalid email "${p.email || ''}"`);
  if (!first) problems.push(`row ${i + 1}: first_name missing`);
  if (!company) problems.push(`row ${i + 1}: company_name missing`);
  const carrier = String(p.carrier || '').trim().toLowerCase();
  const tracking = String(p.tracking_number || '').trim();
  const domain = String(p.company_domain || email.split('@')[1] || '').toLowerCase().replace(/^www\./, '');
  return {
    email, first_name: first, last_name: String(p.last_name || p.lastName || '').trim(),
    title: String(p.title || '').trim(), company_name: company, company_slug: slugify(company),
    company_domain: domain, carrier, tracking_number: tracking,
    trackable: Boolean(tracking) && !UNTRACKED.includes(carrier),
  };
});
if (problems.length) throw new Error(`Intake rejected. ${problems.join('; ')}`);
return out.map((json) => ({ json }));
""")
    w.http("HubSpot: Upsert Contact", [660, 0], "POST", "https://api.hubapi.com/crm/v3/objects/contacts/batch/upsert",
           cred="hubspot", body=(
               "={{ JSON.stringify({ inputs: [{ idProperty: 'email', id: $json.email, properties: {"
               " email: $json.email, firstname: $json.first_name, lastname: $json.last_name, jobtitle: $json.title,"
               " company: $json.company_name, caricature_stage: 'Shipped' } }] }) }}"))
    w.code("Prospect Row", [880, 0], r"""
const p = $('Normalize Prospects').item.json;
const row = {
  email: p.email, first_name: p.first_name, last_name: p.last_name || null, title: p.title || null,
  company_name: p.company_name, company_slug: p.company_slug, company_domain: p.company_domain || null,
  hubspot_contact_id: String($json.results?.[0]?.id ?? ''),
  carrier: p.carrier || null,
  track: p.trackable ? 'shipped' : 'untracked',
};
if (p.tracking_number) row.tracking_number = p.tracking_number;
return { json: row };
""", per_item=True)
    w.sb_create("Create Prospect", [1100, 0], "prospects", on_error=True)
    w.if_bool("Prospect Created?", [1320, 0], "={{ Boolean($json.id) }}")
    w.code("Build Links", [1540, -100], r"""
const cfg = $('Load Config').first().json;
const base = String(cfg.website_base_url || 'https://interactlabs.ai').replace(/\/+$/, '');
const qs = new URLSearchParams({
  utm_source: 'direct_mail',
  utm_medium: 'caricature_doll',
  utm_campaign: `${$json.company_slug}_outreach`,
  utm_content: $json.token,
});
const lp_url = `${base}/?${qs.toString()}`;
const qr_png_url = `https://api.qrserver.com/v1/create-qr-code/?size=1000x1000&margin=20&data=${encodeURIComponent(lp_url)}`;
return { json: { id: $json.id, lp_url, qr_png_url } };
""", per_item=True)
    w.sb_update("Save Links", [1760, -100], "prospects")
    w.code("Shipped Event", [1980, -100], r"""
return { json: { prospect_id: $json.id, event_type: 'shipped', event_key: `${$json.id}:shipped`, source: 'intake' } };
""", per_item=True)
    w.sb_create("Log Shipped", [2200, -100], "events", on_error=True)
    w.http("HubSpot: Save LP URL", [2420, -100], "PATCH",
           "=https://api.hubapi.com/crm/v3/objects/contacts/{{ $('Create Prospect').item.json.hubspot_contact_id }}",
           cred="hubspot", on_error=True,
           body="={{ JSON.stringify({ properties: { caricature_lp_url: $('Build Links').item.json.lp_url } }) }}")
    w.if_bool("Trackable?", [2640, -100], "={{ $('Create Prospect').item.json.track === 'shipped' }}")
    w.http("Ship24: Create Tracker", [2860, -200], "POST", "https://api.ship24.com/public/v1/trackers", cred="header",
           on_error=True,
           body="={{ JSON.stringify({ trackingNumber: $('Create Prospect').item.json.tracking_number, clientTrackerId: $('Create Prospect').item.json.id }) }}")
    w.code("Tracker Row", [3080, -200], r"""
const id = $('Create Prospect').item.json.id;
const trackerId = $json.data?.tracker?.trackerId;
return { json: trackerId ? { id, ship24_tracker_id: trackerId } : { id } };
""", per_item=True)
    w.sb_update("Save Tracker", [3300, -200], "prospects")
    w.merge("Collect Results", [3540, 0], 3)
    w.code("Intake Summary", [3760, 0], r"""
const created = $('Build Links').all().map((i) => {
  const row = $('Create Prospect').all().find((r) => r.json.id === i.json.id)?.json || {};
  return { email: row.email, company: row.company_name, track: row.track, lp_url: i.json.lp_url, qr_png_url: i.json.qr_png_url };
});
let failed = [];
try {
  failed = $('Prospect Created?').all(1).map((i) => ({ error: i.json.error?.message || i.json.message || 'insert failed (duplicate email or tracking number?)' }));
} catch (e) { failed = []; }
const trackers = (() => { try { return $('Ship24: Create Tracker').all(); } catch (e) { return []; } })();
const trackerErrors = trackers.filter((t) => t.json.error).length;
return [{ json: { created, failed, tracker_errors: trackerErrors, created_count: created.length, failed_count: failed.length } }];
""")
    w.slack("Slack: Intake Summary", [3980, -100], (
        "={{ `📦 Caricature intake: ${$json.created_count} added, ${$json.failed_count} failed"
        "${$json.tracker_errors ? `, ${$json.tracker_errors} tracker errors (check Ship24)` : ''}\\n\\n`"
        " + $json.created.map(c => `• ${c.company} (${c.email}) | ${c.track === 'untracked' ? 'manual delivery confirmation needed' : 'tracked via Ship24'}\\n   QR: ${c.qr_png_url}`).join('\\n')"
        " + ($json.failed.length ? `\\n\\nFailed:\\n` + $json.failed.map(f => `• ${f.error}`).join('\\n') : '') }}"))
    w.respond_json("Respond", [3980, 100], "={{ JSON.stringify($('Intake Summary').first().json) }}")

    w.chain("Intake Webhook", "Load Config", "Normalize Prospects", "HubSpot: Upsert Contact", "Prospect Row",
            "Create Prospect", "Prospect Created?")
    w.link("Prospect Created?", "Build Links", 0)
    w.link("Prospect Created?", "Collect Results", 1, 2)
    w.chain("Build Links", "Save Links", "Shipped Event", "Log Shipped", "HubSpot: Save LP URL", "Trackable?")
    w.link("Trackable?", "Ship24: Create Tracker", 0)
    w.link("Trackable?", "Collect Results", 1, 1)
    w.chain("Ship24: Create Tracker", "Tracker Row", "Save Tracker")
    w.link("Save Tracker", "Collect Results", 0, 0)
    w.chain("Collect Results", "Intake Summary", "Slack: Intake Summary")
    w.link("Intake Summary", "Respond")
    w.setup_note("## Caricature 1: Prospect Intake\n\nBefore activating: run supabase/migration.sql and fill the campaign_config row.\n\nPOST prospects to this workflow's webhook (path caricature-intake):\n\n`{\"prospects\":[{\"email\":\"\",\"first_name\":\"\",\"last_name\":\"\",\"title\":\"\",\"company_name\":\"\",\"carrier\":\"fedex\",\"tracking_number\":\"\"}]}`\n\nReturns each prospect's tracked URL and a print-ready QR PNG.\n\nCredentials: Supabase API, HubSpot App Token, Header Auth `X-Intake-Secret` on the webhook, Header Auth `Authorization: Bearer <Ship24 key>`, Slack API.\n\nFull guide: caricature-campaign/docs/setup.md in github.com/sashank-and-sales-gtme/gtm-engineering-portfolio")
    return w.dump(out)
