// POST {lead_id}: "is it safe to call this person?" Checks the roster (every rep, archived leads included) and
// HubSpot live, saves the verdict on the lead (leads.guard) so every viewer sees it, and returns it.
//   block: another rep called them recently, or HubSpot shows a customer/opportunity or recent activity by someone else
//   warn:  softer signals (same person on another rep's roster, HubSpot owner differs, HubSpot unreachable)
//   clear: nothing found
import { errMsg, HttpError, json, readJson, serve } from "../_shared/cors.ts";
import { adminClient, coName, getCaller, nowISO, splitName } from "../_shared/supabase.ts";
import { type HsObject, hs, hsSearch, hubspotConfigured } from "../_shared/hubspot.ts";
import { normDomain, rosterSettings } from "../_shared/roster.ts";

const BLOCK_DAYS = 14;
const CLOSED_STAGES = new Set(["opportunity", "customer", "evangelist"]);
const CONTACT_PROPS = ["firstname", "lastname", "email", "company", "hubspot_owner_id", "notes_last_contacted", "hs_last_sales_activity_timestamp", "lifecyclestage", "hs_lead_status"];

const ts = (v: unknown) => {
  if (!v) return NaN;
  const s = String(v);
  return /^\d+$/.test(s) ? Number(s) : Date.parse(s);
};
const day = (t: number) => new Date(t).toISOString().slice(0, 10);

serve(async (req) => {
  if (req.method !== "POST") throw new HttpError(405, "Use POST");
  const caller = await getCaller(req);
  const { lead_id } = await readJson<{ lead_id?: string }>(req);
  if (!lead_id) throw new HttpError(400, "lead_id is required");

  // Visibility check as the caller, then work with the service role.
  const { data: visible } = await caller.client.from("leads").select("id").eq("id", lead_id).maybeSingle();
  if (!visible) throw new HttpError(404, "Contact not found or not visible to you");
  const db = adminClient();
  const { data: l } = await db.from("leads").select("*").eq("id", lead_id).maybeSingle();
  if (!l) throw new HttpError(404, "Contact not found");

  const s = await rosterSettings();
  const owner = l.assigned_to || caller.id;
  const block: string[] = [];
  const warn: string[] = [];
  const { data: profs } = await db.from("profiles").select("id,full_name,email,hubspot_owner_id");
  const nameOf = (id: string | null | undefined) => {
    const p = (profs ?? []).find((x) => x.id === id);
    return p ? p.full_name || p.email : "someone";
  };

  // 1. Roster: the same person under any lead id, and calls by anyone other than the owner.
  const first = splitName(l.name).first.toLowerCase();
  const domain = normDomain(l.domain);
  const email = String(l.enrichment?.email ?? "").toLowerCase();
  const twins = new Map<string, { id: string; assigned_to: string | null; name: string }>();
  const add = (rows: { id: string; assigned_to: string | null; name: string }[] | null) => (rows ?? []).forEach((r) => r.id !== l.id && twins.set(r.id, r));
  if (l.linkedin) add((await db.from("leads").select("id,assigned_to,name").ilike("linkedin", String(l.linkedin).replace(/\/+$/, "") + "%").limit(10)).data);
  if (email) add((await db.from("leads").select("id,assigned_to,name").eq("enrichment->>email", email).limit(10)).data);
  if (first && domain) {
    const { data } = await db.from("leads").select("id,assigned_to,name").eq("domain", domain).limit(50);
    add((data ?? []).filter((r) => splitName(r.name).first.toLowerCase() === first));
  }
  const ids = [l.id, ...twins.keys()];
  const since = new Date(Date.now() - s.crm_recent_days * 864e5).toISOString();
  const { data: calls } = await db.from("calls").select("owner,at,outcome,lead_id").in("lead_id", ids).gte("at", since).order("at", { ascending: false }).limit(50);
  for (const c of calls ?? []) {
    if (c.owner === owner) continue;
    const msg = `${nameOf(c.owner)} called them on ${day(Date.parse(c.at))} (${c.outcome})`;
    if (Date.now() - Date.parse(c.at) < BLOCK_DAYS * 864e5) block.push(msg);
    else warn.push(msg);
    break;
  }
  for (const t of twins.values()) {
    if (t.assigned_to && t.assigned_to !== owner) {
      warn.push(`also on ${nameOf(t.assigned_to)}'s roster`);
      break;
    }
  }

  // 2. HubSpot, live.
  let hubspotContactId: string | null = l.hubspot_contact_id ?? null;
  if (await hubspotConfigured().catch(() => false)) {
    try {
      const ownerProfile = new Map((profs ?? []).filter((p) => p.hubspot_owner_id).map((p) => [String(p.hubspot_owner_id), p.id]));
      let c: HsObject | null = null;
      if (hubspotContactId) {
        c = await hs<HsObject>(`/crm/v3/objects/contacts/${hubspotContactId}?properties=${CONTACT_PROPS.join(",")}`).catch(() => null);
      }
      if (!c && email) {
        c = (await hsSearch("contacts", { filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }], properties: CONTACT_PROPS })).results[0] ?? null;
      }
      if (!c && first) {
        const token = coName(l.company).split(/\s+/)[0];
        if (token) {
          c = (await hsSearch("contacts", {
            filterGroups: [{ filters: [{ propertyName: "firstname", operator: "EQ", value: splitName(l.name).first }, { propertyName: "company", operator: "CONTAINS_TOKEN", value: token }] }],
            properties: CONTACT_PROPS,
          })).results[0] ?? null;
        }
      }
      if (c) {
        hubspotContactId = String(c.id);
        const stage = String(c.properties.lifecyclestage ?? "");
        const hsOwner = ownerProfile.get(String(c.properties.hubspot_owner_id ?? ""));
        const touched = Math.max(...[ts(c.properties.notes_last_contacted), ts(c.properties.hs_last_sales_activity_timestamp)].filter((x) => !isNaN(x)), 0);
        if (CLOSED_STAGES.has(stage)) block.push(`HubSpot lists them as ${stage}`);
        if (hsOwner && hsOwner !== owner) {
          if (touched && Date.now() - touched < s.crm_recent_days * 864e5) block.push(`owned in HubSpot by ${nameOf(hsOwner)}, last touched ${day(touched)}`);
          else warn.push(`owned in HubSpot by ${nameOf(hsOwner)}`);
        } else if (touched && Date.now() - touched < BLOCK_DAYS * 864e5 && !(calls ?? []).some((x) => x.owner === owner)) {
          warn.push(`HubSpot shows activity on ${day(touched)}`);
        }
        if (c.properties.hs_lead_status) warn.push(`HubSpot lead status: ${c.properties.hs_lead_status}`);
      }
    } catch (e) {
      warn.push(`HubSpot could not be checked (${errMsg(e).slice(0, 80)}). Check HubSpot before calling.`);
    }
  } else {
    warn.push("HubSpot is not connected, so only the roster was checked");
  }

  const guard = {
    level: block.length ? "block" : warn.length ? "warn" : "clear",
    reasons: [...block, ...warn].slice(0, 6),
    at: nowISO(),
    by: caller.id,
  };
  const patch: Record<string, unknown> = { guard };
  if (hubspotContactId && !l.hubspot_contact_id) patch.hubspot_contact_id = hubspotContactId;
  await db.from("leads").update(patch).eq("id", l.id);
  return json({ ok: true, guard });
});
