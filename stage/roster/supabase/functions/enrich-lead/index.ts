// POST {lead_id, force?, phone?, poll?}: enrich one approved roster contact. Called when a contact is approved.
// A clean waterfall, Apollo first every time:
//   email  Apollo people/match (about 1 credit). FullEnrich (email only) runs only when Apollo returns no email or an
//          invalid one. An unverified or catch-all Apollo email is kept with its status.
//   phone  (phone: true) Apollo people/match with reveal_phone_number (8 credits, only when it finds a mobile), delivered
//          to the apollo-phone webhook. FullEnrich (phone only) runs only when Apollo reports no number or none arrives
//          within 15 minutes (queue-gate sweeps those).
//   poll: true   checks a FullEnrich job that was still running, or falls back once Apollo's phone wait has expired.
// Runs in the background; the lead row's `enrichment` goes enriching -> found / no email / failed, and Realtime updates the page.
import { background, errMsg, HttpError, json, readJson, serve } from "../_shared/cors.ts";
import { adminClient, audit, getCaller, nowISO, splitName } from "../_shared/supabase.ts";
import { peopleMatch, peopleMatchPhone } from "../_shared/apollo.ts";
import { extractPhones, PHONE_WAIT_MS, phoneWebhookUrl } from "../_shared/phone.ts";
import { pollPhoneFallback, startPhoneFallback } from "../_shared/phone_fallback.ts";
import { type FeField, type FePoll, fullEnrichPoll, fullEnrichStart, fullEnrichWait } from "../_shared/fullenrich.ts";
import { getSecret } from "../_shared/secrets.ts";
import { apolloEmpty, choosePrimary } from "../_shared/email_quality.ts";

type Enr = Record<string, string>;
const STALE_MS = 5 * 60_000;

/** Folds a finished (or failed) FullEnrich answer into the enrichment record. Never drops what is already found. */
function merge(cur: Enr, poll: FePoll, source = "FullEnrich"): Enr {
  const { fe_id: _id, fe_waiting: _w, fe_error: _e, ...rest } = cur;
  const out: Enr = { ...rest, at: nowISO() };
  if (poll.state === "failed") {
    out.fe_error = poll.error;
    out.status = out.email ? "found" : "no email";
    return out;
  }
  if (poll.state === "done") {
    out.fe_tried = "1";
    if (poll.result.email) {
      out.fe_email = poll.result.email;
      out.fe_email_status = poll.result.email_status;
    }
    const best = choosePrimary([
      { email: out.email, status: out.email_status, source: out.source || "Apollo" },
      { email: out.fe_email, status: out.fe_email_status, source },
    ]);
    if (best) {
      out.email = best.email;
      out.email_status = best.status;
      out.source = best.source;
    }
    if (poll.result.phone) {
      out.phone = poll.result.phone;
      out.phone_source = source;
    }
    // Say what happened instead of leaving a silent "No email found".
    if (!poll.result.email && !poll.result.phone) {
      out.fe_error = poll.result.seen ? `FullEnrich finished with nothing usable (${poll.result.seen})` : "FullEnrich found no email or phone";
    } else if (!out.email) out.fe_error = "FullEnrich found no email";
    else if (!out.phone) out.fe_error = "FullEnrich found no phone";
  }
  out.status = out.email ? "found" : "no email";
  return out;
}

serve(async (req) => {
  if (req.method !== "POST") throw new HttpError(405, "Use POST");
  const caller = await getCaller(req);
  const { lead_id, force, phone, poll } = await readJson<{ lead_id?: string; force?: boolean; phone?: boolean; poll?: boolean }>(req);
  if (!lead_id) throw new HttpError(400, "lead_id is required");

  const db = adminClient();
  const { data: l, error } = await db.from("leads").select("*").eq("id", lead_id).maybeSingle();
  if (error) throw new HttpError(500, "Could not load the contact");
  if (!l) throw new HttpError(404, "Contact not found");

  const canAct = caller.can("enrich_now") || caller.can("work_any_lead") || (caller.can("work_leads") && l.assigned_to === caller.id);
  if (!canAct) throw new HttpError(403, "Your role does not allow enriching this contact");
  if (!l.approved) throw new HttpError(409, "Approve the contact before enriching");

  const cur = (l.enrichment ?? {}) as Enr;
  const save = (enrichment: Enr, extra: Record<string, unknown> = {}) => db.from("leads").update({ ...extra, enrichment }).eq("id", lead_id);

  // Phone waterfall in flight: Apollo's webhook is late, or FullEnrich's phone job is running.
  if (poll && cur.phone_stage === "apollo") {
    if (Date.now() - Date.parse(cur.phone_requested_at ?? "") < PHONE_WAIT_MS) return json({ ok: true, status: "enriching", phone_stage: "apollo" });
    const next = await startPhoneFallback(lead_id, "Apollo sent no phone number within 15 minutes");
    return json({ ok: true, status: next?.status ?? "found", enrichment: next });
  }
  if (poll && cur.phone_fe_id) {
    const next = await pollPhoneFallback(lead_id);
    return json({ ok: true, status: next?.status ?? "found", enrichment: next });
  }

  // A FullEnrich job still running: look at it once, never start (and pay for) a second one.
  if (poll || cur.fe_id) {
    if (!cur.fe_id) return json({ ok: true, status: cur.status ?? "none" });
    const r = await fullEnrichPoll(cur.fe_id);
    if (r.state === "pending") {
      const old = Date.now() - Date.parse(cur.at ?? "") > 30 * 60_000;
      if (!old) return json({ ok: true, status: "enriching" });
      await save(merge(cur, { state: "failed", error: "FullEnrich took too long" }));
      return json({ ok: true, status: "no email" });
    }
    const next = merge(cur, r);
    await save(next);
    await audit(caller.id, "lead.enrich", l.company ?? "", `${l.name}: ${next.status} (FullEnrich)`);
    return json({ ok: true, status: next.status, enrichment: next });
  }

  // Never pay twice: a found email, or a run in progress, is kept unless the caller retries a failure.
  const stale = Date.now() - Date.parse(cur.at ?? "") > STALE_MS;
  if (cur.status === "enriching" && !stale) return json({ ok: true, status: "enriching" });
  if (phone) {
    if (cur.phone) return json({ ok: true, status: "found", enrichment: cur });
    if (cur.phone_stage === "apollo" && Date.now() - Date.parse(cur.phone_requested_at ?? "") < PHONE_WAIT_MS) {
      return json({ ok: true, status: "enriching", phone_stage: "apollo" });
    }
  } else if (cur.email && !force) return json({ ok: true, status: "found", enrichment: cur });

  const hasFe = !!(await getSecret("int_fullenrich_key"));
  const hasApollo = !!(await getSecret("int_apollo_key"));
  if (phone && !hasApollo && !hasFe) throw new HttpError(409, "Neither Apollo nor FullEnrich is connected. An admin connects them in Admin > Integrations.");
  if (!phone && !hasApollo) throw new HttpError(409, "Apollo isn't connected. An admin connects it in Admin > Integrations.");

  // Phone, step 1: ask Apollo. The number arrives at the apollo-phone webhook (or at once when Apollo already has it).
  if (phone && hasApollo) {
    const { first, last, masked } = splitName(l.name);
    const nonce = crypto.randomUUID().slice(0, 12);
    try {
      const person = await peopleMatchPhone({
        id: undefined,
        first_name: first,
        last_name: masked ? undefined : last,
        name: masked ? undefined : l.name,
        domain: l.domain || undefined,
        organization_name: l.company || undefined,
        linkedin_url: l.linkedin || undefined,
      }, await phoneWebhookUrl(lead_id, nonce));
      const now = extractPhones(person)[0];
      if (now) {
        const next = { ...cur, phone: now.number, phone_source: "Apollo", phone_type: now.type, phone_stage: "done", at: nowISO() };
        await save(next);
        await audit(caller.id, "lead.enrich", l.company ?? "", `${l.name}: phone found (Apollo)`);
        return json({ ok: true, status: "found", enrichment: next });
      }
      if (!person) {
        // Apollo doesn't know this person: straight to the second source.
        const next = await startPhoneFallback(lead_id, "Apollo couldn't match this person");
        await audit(caller.id, "lead.enrich", l.company ?? "", `${l.name}: phone, Apollo no match, FullEnrich started`);
        return json({ ok: true, status: "enriching", enrichment: next }, 202);
      }
      await save({ ...cur, phone_stage: "apollo", phone_nonce: nonce, phone_requested_at: nowISO() });
      await audit(caller.id, "lead.enrich", l.company ?? "", `${l.name}: phone requested from Apollo`);
      return json({ ok: true, status: "enriching", phone_stage: "apollo" }, 202);
    } catch (e) {
      const next = await startPhoneFallback(lead_id, `Apollo phone request failed (${errMsg(e).slice(0, 120)})`);
      return json({ ok: true, status: "enriching", enrichment: next }, 202);
    }
  }
  if (phone) {
    // Apollo isn't connected: FullEnrich is the only source.
    const next = await startPhoneFallback(lead_id, "Apollo isn't connected");
    return json({ ok: true, status: "enriching", enrichment: next }, 202);
  }

  await save({ ...cur, status: "enriching", at: nowISO() });

  /** Starts FullEnrich, records its job id (so a slow job can be picked up later), and waits for it. */
  const runFullEnrich = async (name: string, linkedin: string | undefined, base: Enr, fields: FeField[]): Promise<Enr> => {
    let id: string;
    try {
      id = await fullEnrichStart({ name, domain: l.domain || "", company: l.company || "", linkedin }, fields);
    } catch (e) {
      return merge(base, { state: "failed", error: errMsg(e).slice(0, 200) });
    }
    await save({ ...base, status: "enriching", fe_id: id, at: nowISO() });
    const r = await fullEnrichWait(id);
    // Still running: leave the job id in place. The card offers "Check FullEnrich" and picks the result up later.
    if (r.state === "pending") return { ...base, status: "enriching", fe_id: id, fe_waiting: "1", at: nowISO() };
    return merge(base, r);
  };

  background((async () => {
    try {
      const { first, last, masked } = splitName(l.name);
      const match = await peopleMatch({
        first_name: first,
        last_name: masked ? undefined : last,
        name: masked ? undefined : l.name,
        domain: l.domain || undefined,
        organization_name: l.company || undefined,
        linkedin_url: l.linkedin || undefined,
      }).catch(() => null);
      let enrichment: Enr = {
        ...(cur.phone ? { phone: cur.phone, phone_source: cur.phone_source ?? "" } : {}),
        email: match?.email ?? "",
        source: "Apollo",
        status: match?.email ? "found" : "no email",
        email_status: match?.email_status ?? "",
        apollo_email: match?.email ?? "",
        apollo_status: match?.email_status ?? "",
        at: nowISO(),
      };
      const update: Record<string, unknown> = {};
      // A masked surname ("Gu***a") is replaced by the full name Apollo returns, and Apollo's LinkedIn fills a gap.
      if (match?.name && /\*/.test(String(l.name))) update.name = match.name;
      if (match?.linkedin_url && !l.linkedin) Object.assign(update, { linkedin: match.linkedin_url, linkedin_source: "apollo" });
      // Email, step 2: FullEnrich only when Apollo came back empty (no email, or an invalid one). Email only.
      if (apolloEmpty(match?.email, match?.email_status) && hasFe) {
        enrichment = await runFullEnrich(match?.name || l.name, l.linkedin || match?.linkedin_url || undefined, enrichment, ["contact.emails"]);
      } else if (apolloEmpty(match?.email, match?.email_status)) {
        enrichment.fe_error = "Apollo found no usable email and FullEnrich isn't connected";
      }
      await save(enrichment, update);
      await audit(caller.id, "lead.enrich", l.company ?? "", `${l.name}: ${enrichment.status} (${enrichment.source})`);
    } catch (e) {
      await save({ status: "failed", error: errMsg(e).slice(0, 200), at: nowISO() });
    }
  })());

  return json({ ok: true, status: "enriching" }, 202);
});
