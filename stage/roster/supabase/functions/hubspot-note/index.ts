// POST {journey_id}: pushes a connected-call note to HubSpot, linked to the POC deal (when a meeting exists), the
// contact (created if missing) and the company, whichever exist.
import { errMsg, HttpError, json, readJson, serve } from "../_shared/cors.ts";
import { adminClient, coName, getCaller, requirePerm } from "../_shared/supabase.ts";
import { esc, hsCompanyByDomain, hsCreateNote, hsEnsureContact, hsFindPocDeal } from "../_shared/hubspot.ts";
import { targetSummary } from "../_shared/hubspot_assoc.ts";
import { loadProfile } from "../_shared/profile_store.ts";

serve(async (req) => {
  if (req.method !== "POST") throw new HttpError(405, "Use POST");
  const caller = await getCaller(req);
  requirePerm(caller, "hubspot_notes");
  const { journey_id } = await readJson<{ journey_id?: string }>(req);
  if (!journey_id) throw new HttpError(400, "journey_id is required");

  // Visibility check through RLS as the caller.
  const { data: visible, error: ve } = await caller.client.from("journeys").select("id").eq("id", journey_id).maybeSingle();
  if (ve) throw new HttpError(500, "Could not load the journey entry");
  if (!visible) throw new HttpError(404, "Journey entry not found or not visible to you");

  const db = adminClient();
  const { data: j } = await db.from("journeys").select("*").eq("id", journey_id).single();
  const { data: l } = await db.from("leads").select("*").eq("id", j.lead_id).maybeSingle();
  if (!l) throw new HttpError(404, "Lead for this journey entry was not found");

  try {
    const { data: mtgs } = await db.from("meetings").select("id,hs_deal_id,hs_contact_id,created_at")
      .eq("lead_id", l.id).order("created_at", { ascending: false }).limit(1);
    const meeting = mtgs?.[0];
    let flag = "";
    const leadUpdate: Record<string, string> = {};

    // The note goes on the POC deal (when there is a meeting), the contact and the company, whichever exist.
    let deal: string | null = null;
    if (meeting) {
      deal = meeting.hs_deal_id || await hsFindPocDeal(l, (await loadProfile()).company_name);
      if (deal) {
        if (!l.hubspot_deal_id) leadUpdate.hubspot_deal_id = deal;
      } else {
        flag = "No POC deal found yet, so the note went to the contact and company.";
      }
    }
    const contact = await hsEnsureContact(l, caller.hubspot_owner_id, caller.id);
    if (!l.hubspot_contact_id) leadUpdate.hubspot_contact_id = contact;
    const company = (await hsCompanyByDomain(l.domain).catch(() => null))?.id ?? null;
    const targets = { deal, contact, company };

    const body = `<p>${esc(j.text).replace(/\n/g, "<br>")}</p><p><em>Connected call with ${esc(l.name)}, ${
      esc(l.title)
    } (${esc(coName(l.company))}). Logged from the outreach roster.</em></p>`;
    const noteId = await hsCreateNote(body, new Date(j.at ?? Date.now()).toISOString(), targets, caller.id);
    const sum = targetSummary(targets);

    if (Object.keys(leadUpdate).length) await db.from("leads").update(leadUpdate).eq("id", l.id);
    await db.from("journeys").update({
      hs_status: "synced",
      hs_target: sum.kinds,
      hs_target_id: sum.ids,
      hs_note_id: noteId,
      hs_error: flag,
    }).eq("id", journey_id);
    return json({ ok: true, targets, note_id: noteId, flag });
  } catch (e) {
    const msg = errMsg(e).slice(0, 300);
    await db.from("journeys").update({ hs_status: "failed", hs_error: msg }).eq("id", journey_id);
    return json({ ok: false, error: msg }, 502);
  }
});
