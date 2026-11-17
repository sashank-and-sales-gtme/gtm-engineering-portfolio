// FullEnrich as the second step of the phone waterfall: only after Apollo reported no number, or none arrived in time.
import { adminClient, nowISO } from "./supabase.ts";
import { fullEnrichPoll, fullEnrichStart } from "./fullenrich.ts";
import { getSecret } from "./secrets.ts";

type Enr = Record<string, string>;

/** Starts a phone-only FullEnrich job for the lead (no waiting) and records it; the poll step finishes it. */
export async function startPhoneFallback(leadId: string, why: string): Promise<Enr | null> {
  const db = adminClient();
  const { data: l } = await db.from("leads").select("id,name,company,domain,linkedin,enrichment").eq("id", leadId).maybeSingle();
  if (!l) return null;
  const cur = (l.enrichment ?? {}) as Enr;
  if (cur.phone) return cur;
  if (!(await getSecret("int_fullenrich_key"))) {
    const next = { ...cur, phone_stage: "none", phone_error: `${why}. FullEnrich isn't connected, so no second source was tried.`, at: nowISO() };
    await db.from("leads").update({ enrichment: next }).eq("id", leadId);
    return next;
  }
  try {
    const id = await fullEnrichStart({ name: l.name, domain: l.domain || "", company: l.company || "", linkedin: l.linkedin || undefined }, ["contact.phones"]);
    const next = { ...cur, phone_stage: "fullenrich", phone_fe_id: id, phone_note: why, at: nowISO() };
    await db.from("leads").update({ enrichment: next }).eq("id", leadId);
    return next;
  } catch (e) {
    const next = { ...cur, phone_stage: "none", phone_error: `${why}. FullEnrich couldn't start: ${e instanceof Error ? e.message : e}`.slice(0, 300), at: nowISO() };
    await db.from("leads").update({ enrichment: next }).eq("id", leadId);
    return next;
  }
}

/** Checks a running phone-only FullEnrich job once and saves the result. */
export async function pollPhoneFallback(leadId: string): Promise<Enr | null> {
  const db = adminClient();
  const { data: l } = await db.from("leads").select("id,enrichment").eq("id", leadId).maybeSingle();
  const cur = (l?.enrichment ?? {}) as Enr;
  if (!cur.phone_fe_id) return cur;
  const r = await fullEnrichPoll(cur.phone_fe_id);
  if (r.state === "pending") {
    if (Date.now() - Date.parse(cur.at ?? "") < 30 * 60_000) return cur;
    const next = { ...cur, phone_stage: "none", phone_error: "FullEnrich took too long", at: nowISO() };
    delete (next as Enr).phone_fe_id;
    await db.from("leads").update({ enrichment: next }).eq("id", leadId);
    return next;
  }
  const next: Enr = { ...cur, at: nowISO() };
  delete next.phone_fe_id;
  if (r.state === "done" && r.result.phone) Object.assign(next, { phone: r.result.phone, phone_source: "FullEnrich", phone_stage: "done" });
  else Object.assign(next, { phone_stage: "none", phone_error: r.state === "failed" ? r.error : "Neither Apollo nor FullEnrich found a phone number" });
  await db.from("leads").update({ enrichment: next }).eq("id", leadId);
  return next;
}
