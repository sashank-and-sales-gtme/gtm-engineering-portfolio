// Cron (daily 17:52 UTC = 23:22 IST). Read-only HubSpot -> roster sync. Never writes to HubSpot.
// Part 1 (this run): meetings. Part 2 ({part: "activity"}, started at the end of part 1 as its own run):
// calls, emails, notes and meetings logged in HubSpot on roster contacts are mirrored into the deal journey,
// so HubSpot and the roster read as one history.
// One meetings row per demo thread: 'hs-<dealId>' for Sales POC deals booked by an active SDR,
// 'hs-c<contactId>' for meetings of contacts/companies an active SDR owns that have no such deal.
import { errMsg, json, readJson, serve } from "../_shared/cors.ts";
import { adminClient, audit, coName, invokeInternal, nowISO, cronFanOut, requireCron, splitName } from "../_shared/supabase.ts";
import { type HsObject, hsAssoc, hsBatchRead, hsFindContact, hsSearchAll, hubspotConfigured } from "../_shared/hubspot.ts";
import { EMAIL_SIGNAL_PROPS, emailSignals } from "../_shared/email_signals.ts";

const STAGES: Record<string, string> = {
  appointmentscheduled: "Appointment scheduled",
  qualifiedtobuy: "Qualified to buy",
  "3509923573": "Demo no show",
  "3617201884": "Unfit",
  "4028542663": "Nurture",
  "3954172647": "Later stage",
  decisionmakerboughtin: "Decision maker bought in",
  "3385982692": "Later stage",
  contractsent: "Contract sent",
  closedwon: "Closed won",
  closedlost: "Closed lost",
};
const DEMO_HAPPENED = new Set(["qualifiedtobuy", "3954172647", "decisionmakerboughtin", "3385982692", "contractsent", "closedwon", "closedlost"]);
const PARKED = new Set(["3617201884", "4028542663"]);
const NO_SHOW_STAGE = "3509923573";

const DEAL_PROPS = ["dealname", "dealstage", "pipeline", "booked_by_sdr", "hs_lastmodifieddate", "createdate", "hubspot_owner_id"];
const MEETING_PROPS = [
  "hs_meeting_title", "hs_meeting_start_time", "hs_meeting_end_time", "hs_meeting_outcome", "hs_meeting_location",
  "hs_meeting_external_url", "hs_meeting_body", "hs_lastmodifieddate", "hs_createdate", "hubspot_owner_id",
];
const CONTACT_PROPS = ["firstname", "lastname", "jobtitle", "company", "email", "hubspot_owner_id"];
const COMPANY_PROPS = ["name", "domain", "hubspot_owner_id"];

const ms = (v: unknown) => {
  if (!v) return NaN;
  const s = String(v);
  return /^\d+$/.test(s) ? Number(s) : new Date(s).getTime();
};
const iso = (v: unknown) => {
  const t = ms(v);
  return isNaN(t) ? null : new Date(t).toISOString();
};
const owners = (v: unknown) => String(v ?? "").split(/[;,]/).map((s) => s.trim()).filter(Boolean);
const stripHtml = (s: unknown) => String(s ?? "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

interface Thread {
  id: string;
  ownerProfile: string;
  deal: HsObject | null;
  contactIds: string[];
  meetings: HsObject[];
}

serve(async (req) => {
  requireCron(req);
  const opts = await readJson<{ full?: boolean; days?: number; part?: string; since?: string } & { workspace_id?: string }>(req);
  return await cronFanOut("hubspot-sync", opts, () => run(opts));
});

async function run(opts: { full?: boolean; days?: number; part?: string; since?: string }): Promise<Response> {
  if (opts.part === "activity") return json(await mirrorActivity(opts.since ? Date.parse(opts.since) : Date.now() - (opts.days ?? 90) * 864e5));
  const started = Date.now();
  const db = adminClient();
  const errors: string[] = [];

  const { data: setting } = await db.from("app_settings").select("value").eq("key", "hubspot_sync").maybeSingle();
  const prev = (setting?.value ?? {}) as Record<string, unknown>;
  const firstRun = !prev.last_run || !!opts.full;
  const sinceMs = firstRun ? Date.now() - (opts.days ?? 90) * 864e5 : ms(prev.last_run) - 3600e3;

  const { data: profs } = await db.from("profiles").select("id,hubspot_owner_id").eq("status", "active").not("hubspot_owner_id", "is", null);
  const ownerToProfile = new Map<string, string>();
  for (const p of profs ?? []) if (p.hubspot_owner_id) ownerToProfile.set(String(p.hubspot_owner_id), p.id);
  if (!ownerToProfile.size) {
    const summary = { last_run: nowISO(), threads_synced: 0, note: "No active profile has a HubSpot owner id", errors: 0 };
    await db.from("app_settings").upsert({ key: "hubspot_sync", value: summary, updated_at: nowISO() });
    return json({ ok: true, ...summary });
  }
  const profileForDeal = (d: HsObject) => {
    for (const o of owners(d.properties.booked_by_sdr)) if (ownerToProfile.has(o)) return ownerToProfile.get(o)!;
    return null;
  };
  const inPipeline = (d: HsObject) => !!STAGES[String(d.properties.dealstage ?? "")];

  // 1. Deals booked by each active SDR, changed since the last run.
  const deals = new Map<string, HsObject>();
  for (const ownerId of ownerToProfile.keys()) {
    try {
      const rows = await hsSearchAll("deals", {
        filterGroups: [{
          filters: [
            { propertyName: "booked_by_sdr", operator: "IN", values: [ownerId] },
            { propertyName: "hs_lastmodifieddate", operator: "GTE", value: String(sinceMs) },
          ],
        }],
        properties: DEAL_PROPS,
      }, 2000);
      for (const d of rows) if (inPipeline(d) && profileForDeal(d)) deals.set(String(d.id), d);
    } catch (e) {
      errors.push(`deals for owner ${ownerId}: ${errMsg(e).slice(0, 150)}`);
    }
  }

  // 2. Meetings changed since the last run, mapped to deals (any SDR deal) or owned contacts/companies.
  const contactThreads = new Map<string, string>(); // contactId -> profile id
  try {
    const changed = await hsSearchAll("meetings", {
      filterGroups: [{ filters: [{ propertyName: "hs_lastmodifieddate", operator: "GTE", value: String(sinceMs) }] }],
      properties: ["hs_lastmodifieddate"],
    }, 3000);
    const mIds = changed.map((m) => String(m.id));
    const [m2d, m2c, m2co] = await Promise.all([
      hsAssoc("meetings", "deals", mIds),
      hsAssoc("meetings", "contacts", mIds),
      hsAssoc("meetings", "companies", mIds),
    ]);
    const unknownDeals = [...new Set([...m2d.values()].flat())].filter((id) => !deals.has(id));
    for (const d of await hsBatchRead("deals", unknownDeals, DEAL_PROPS)) {
      if (inPipeline(d) && profileForDeal(d)) deals.set(String(d.id), d);
    }
    const looseMeetings = mIds.filter((id) => !(m2d.get(id) ?? []).some((d) => deals.has(d)));
    const cIds = [...new Set(looseMeetings.flatMap((id) => m2c.get(id) ?? []))];
    const coIds = [...new Set(looseMeetings.flatMap((id) => m2co.get(id) ?? []))];
    const contacts = new Map((await hsBatchRead("contacts", cIds, CONTACT_PROPS)).map((c) => [String(c.id), c]));
    const companies = new Map((await hsBatchRead("companies", coIds, COMPANY_PROPS)).map((c) => [String(c.id), c]));
    for (const mid of looseMeetings) {
      const cs = m2c.get(mid) ?? [];
      if (!cs.length) continue;
      let prof: string | null = null;
      for (const c of cs) {
        const o = contacts.get(c)?.properties.hubspot_owner_id;
        if (o && ownerToProfile.has(String(o))) prof = ownerToProfile.get(String(o))!;
      }
      if (!prof) {
        for (const co of m2co.get(mid) ?? []) {
          const o = companies.get(co)?.properties.hubspot_owner_id;
          if (o && ownerToProfile.has(String(o))) prof = ownerToProfile.get(String(o))!;
        }
      }
      if (prof && !contactThreads.has(cs[0])) contactThreads.set(cs[0], prof);
    }
  } catch (e) {
    errors.push(`meetings scan: ${errMsg(e).slice(0, 150)}`);
  }

  // 3. Build full threads (all meetings of each deal / contact).
  const threads: Thread[] = [];
  const dealIds = [...deals.keys()];
  const [d2m, d2c] = await Promise.all([hsAssoc("deals", "meetings", dealIds), hsAssoc("deals", "contacts", dealIds)])
    .catch((e) => {
      errors.push(`deal associations: ${errMsg(e).slice(0, 150)}`);
      return [new Map<string, string[]>(), new Map<string, string[]>()];
    });
  const dealMeetingIds = new Set([...d2m.values()].flat());
  const cList = [...contactThreads.keys()];
  const c2m = await hsAssoc("contacts", "meetings", cList).catch(() => new Map<string, string[]>());
  const allMeetingIds = [...new Set([...dealMeetingIds, ...[...c2m.values()].flat()])];
  const meetingsById = new Map((await hsBatchRead("meetings", allMeetingIds, MEETING_PROPS).catch((e) => {
    errors.push(`meeting read: ${errMsg(e).slice(0, 150)}`);
    return [] as HsObject[];
  })).map((m) => [String(m.id), m]));

  for (const [id, d] of deals) {
    threads.push({
      id: `hs-${id}`,
      ownerProfile: profileForDeal(d)!,
      deal: d,
      contactIds: d2c.get(id) ?? [],
      meetings: (d2m.get(id) ?? []).map((m) => meetingsById.get(m)).filter(Boolean) as HsObject[],
    });
  }
  for (const [cid, prof] of contactThreads) {
    const ms_ = (c2m.get(cid) ?? []).filter((m) => !dealMeetingIds.has(m)).map((m) => meetingsById.get(m)).filter(Boolean) as HsObject[];
    if (ms_.length) threads.push({ id: `hs-c${cid}`, ownerProfile: prof, deal: null, contactIds: [cid], meetings: ms_ });
  }

  const allContactIds = [...new Set(threads.flatMap((t) => t.contactIds.slice(0, 1)))];
  const contactInfo = new Map((await hsBatchRead("contacts", allContactIds, CONTACT_PROPS).catch(() => [] as HsObject[])).map((c) => [String(c.id), c]));

  // 4. Write rows.
  let synced = 0, skippedNewer = 0;
  for (const t of threads) {
    try {
      const r = await writeThread(t, contactInfo);
      if (r === "skipped") skippedNewer++;
      else synced++;
    } catch (e) {
      errors.push(`${t.id}: ${errMsg(e).slice(0, 150)}`);
    }
  }

  const summary = {
    last_run: nowISO(),
    first_run: firstRun,
    since: new Date(sinceMs).toISOString(),
    deals: deals.size,
    threads: threads.length,
    threads_synced: synced,
    skipped_newer_on_page: skippedNewer,
    errors: errors.length ? errors.slice(0, 20) : 0,
    ms: Date.now() - started,
  };
  await db.from("app_settings").upsert({ key: "hubspot_sync", value: summary, updated_at: nowISO() });
  await audit(null, "hubspot_sync.run", "meetings", `${synced} synced, ${skippedNewer} kept roster edits, ${errors.length} errors`);
  await invokeInternal("hubspot-sync", { part: "activity", since: new Date(sinceMs).toISOString() }, 700);
  return json({ ok: true, ...summary });
}

async function writeThread(t: Thread, contactInfo: Map<string, HsObject>): Promise<"written" | "skipped"> {
  const db = adminClient();
  const sorted = t.meetings.slice().sort((a, b) => ms(a.properties.hs_meeting_start_time) - ms(b.properties.hs_meeting_start_time));
  const outcome = (m: HsObject) => String(m.properties.hs_meeting_outcome || "SCHEDULED").toUpperCase();
  const latest = sorted[sorted.length - 1] ?? null;
  const stage = String(t.deal?.properties.dealstage ?? "");
  const when = latest ? iso(latest.properties.hs_meeting_start_time) : null;

  // Status from the latest meeting outcome, then deal stage rules.
  let status = "scheduled";
  const lo = latest ? outcome(latest) : "";
  if (lo === "COMPLETED") status = "done";
  else if (lo === "NO_SHOW" || lo === "RESCHEDULED") status = "rescheduling";
  else if (lo === "CANCELED") status = "canceled";
  if (t.deal) {
    if (DEMO_HAPPENED.has(stage)) status = "done";
    else if (PARKED.has(stage)) status = sorted.some((m) => outcome(m) === "COMPLETED") ? "done" : (status === "scheduled" ? "canceled" : status);
    else if (stage === NO_SHOW_STAGE && status !== "done" && (!when || ms(when) < Date.now())) status = "rescheduling";
  }
  const noShows = sorted.filter((m) => outcome(m) === "NO_SHOW").length + (stage === NO_SHOW_STAGE && !sorted.some((m) => outcome(m) === "NO_SHOW") ? 1 : 0);
  const reschedules = sorted.slice(0, -1).filter((m) => ["RESCHEDULED", "NO_SHOW", "CANCELED"].includes(outcome(m))).length;

  // History events derived from HubSpot.
  const hsHistory: { at: string; event: string; when?: string }[] = [];
  sorted.forEach((m, i) => {
    const w = iso(m.properties.hs_meeting_start_time) ?? "";
    hsHistory.push({ at: iso(m.properties.hs_createdate) ?? w, event: i === 0 ? "booked" : "rebooked", when: w });
    const o = outcome(m);
    if (o === "NO_SHOW") hsHistory.push({ at: w, event: "no_show", when: w });
    if (o === "COMPLETED") hsHistory.push({ at: w, event: "done", when: w });
    if (o === "CANCELED") hsHistory.push({ at: iso(m.properties.hs_lastmodifieddate) ?? w, event: "canceled", when: w });
  });
  if (status === "done" && !hsHistory.some((h) => h.event === "done")) {
    hsHistory.push({ at: iso(t.deal?.properties.hs_lastmodifieddate) ?? when ?? nowISO(), event: "done", when: when ?? undefined });
  }
  const doneAt = status === "done" ? (hsHistory.filter((h) => h.event === "done").slice(-1)[0]?.at ?? null) : null;

  const modTimes = [ms(t.deal?.properties.hs_lastmodifieddate), ...sorted.map((m) => ms(m.properties.hs_lastmodifieddate))].filter((x) => !isNaN(x));
  const hsModified = modTimes.length ? new Date(Math.max(...modTimes)).toISOString() : nowISO();

  const contact = contactInfo.get(t.contactIds[0] ?? "");
  const cp = contact?.properties ?? {};
  const contactName = [cp.firstname, cp.lastname].filter(Boolean).join(" ");
  const dealName = String(t.deal?.properties.dealname ?? "");
  const companyName = String(cp.company || dealName.split(/\s*<>\s*/)[0] || "").trim();

  const loc = String(latest?.properties.hs_meeting_location ?? "");
  const hay = `${latest?.properties.hs_meeting_external_url ?? ""} ${loc} ${latest?.properties.hs_meeting_body ?? ""}`;
  const meetLink = (hay.match(/https:\/\/(?:meet\.google\.com|[\w.-]*zoom\.us|teams\.microsoft\.com)\/[^\s"'<]+/i) ?? [])[0] ?? "";
  const online = !!meetLink || !loc || /meet|zoom|teams|online|http|virtual/i.test(loc);
  const notes = [
    dealName && `Deal: ${dealName}${stage ? ` (${STAGES[stage] ?? stage})` : ""}`,
    latest?.properties.hs_meeting_title && `Meeting: ${latest.properties.hs_meeting_title}`,
    stripHtml(latest?.properties.hs_meeting_body).slice(0, 1200),
  ].filter(Boolean).join("\n");

  // Lead match: HubSpot ids first, then first name + company token.
  const dealId = t.deal ? String(t.deal.id) : null;
  let lead: { id: string; hubspot_deal_id: string | null; hubspot_contact_id: string | null; title: string | null; segment: string | null; title_scope: string | null } | null = null;
  const sel = "id,hubspot_deal_id,hubspot_contact_id,title,segment,title_scope";
  if (dealId) lead = (await db.from("leads").select(sel).eq("hubspot_deal_id", dealId).limit(1)).data?.[0] ?? null;
  if (!lead && t.contactIds.length) lead = (await db.from("leads").select(sel).in("hubspot_contact_id", t.contactIds).limit(1)).data?.[0] ?? null;
  if (!lead && cp.firstname && companyName) {
    const token = coName(companyName).split(/\s+/)[0];
    const { data } = await db.from("leads").select(`${sel},name`).ilike("company", `%${token}%`).limit(25);
    lead = (data ?? []).find((l) => splitName(l.name).first.toLowerCase() === String(cp.firstname).toLowerCase()) ?? null;
  }
  if (lead) {
    const upd: Record<string, string> = {};
    if (dealId && !lead.hubspot_deal_id) upd.hubspot_deal_id = dealId;
    if (t.contactIds[0] && !lead.hubspot_contact_id) upd.hubspot_contact_id = t.contactIds[0];
    if (Object.keys(upd).length) await db.from("leads").update(upd).eq("id", lead.id);
  }

  // Existing row: the hs- row, else a roster-booked meeting for the same lead not yet linked to HubSpot.
  // deno-lint-ignore no-explicit-any
  let existing: any = (await db.from("meetings").select("*").eq("id", t.id).maybeSingle()).data;
  if (!existing && dealId) existing = (await db.from("meetings").select("*").eq("hs_deal_id", dealId).limit(1)).data?.[0] ?? null;
  if (!existing && lead) {
    existing = (await db.from("meetings").select("*").eq("lead_id", lead.id).is("hs_deal_id", null).neq("status", "canceled")
      .order("created_at", { ascending: false }).limit(1)).data?.[0] ?? null;
  }

  const link = {
    hs_deal_id: dealId,
    hs_contact_id: t.contactIds[0] ?? null,
    hs_meeting_ids: sorted.map((m) => String(m.id)),
    hs_modified_at: hsModified,
    hs_synced_at: nowISO(),
    hs_notes: notes,
  };

  if (existing) {
    // Newest change wins: a roster edit after the latest HubSpot change keeps the roster's status fields.
    if (existing.page_updated_at && ms(existing.page_updated_at) > ms(hsModified)) {
      await db.from("meetings").update(link).eq("id", existing.id);
      return "skipped";
    }
    const seen = new Set((existing.history ?? []).map((h: { event: string; when?: string }) => `${h.event}|${String(h.when ?? "").slice(0, 16)}`));
    const history = [...(existing.history ?? []), ...hsHistory.filter((h) => !seen.has(`${h.event}|${String(h.when ?? "").slice(0, 16)}`))]
      .sort((a, b) => String(a.at).localeCompare(String(b.at)));
    const whenChanged = when && existing.when && ms(when) !== ms(existing.when);
    await db.from("meetings").update({
      ...link,
      when: when ?? existing.when,
      status,
      reschedules: Math.max(existing.reschedules ?? 0, reschedules),
      no_shows: Math.max(existing.no_shows ?? 0, noShows),
      history,
      done_at: status === "done" ? (existing.done_at ?? doneAt) : existing.done_at,
      ...(whenChanged ? { meet_link: meetLink || "", link_status: meetLink ? "found" : "looking" } : {}),
      ...(!existing.meet_link && meetLink ? { meet_link: meetLink, link_status: "found" } : {}),
      lead_id: existing.lead_id ?? lead?.id ?? null,
    }).eq("id", existing.id);
    return "written";
  }

  await db.from("meetings").insert({
    id: t.id,
    ...link,
    lead_id: lead?.id ?? null,
    company: companyName,
    contact: contactName,
    title: String(cp.jobtitle ?? lead?.title ?? ""),
    segment: lead?.segment ?? null,
    title_scope: lead?.title_scope ?? null,
    when,
    mode: online ? "online" : "offline",
    location: online ? "" : loc,
    meet_link: meetLink,
    link_status: meetLink ? "found" : "looking",
    status,
    reschedules,
    no_shows: noShows,
    history: hsHistory,
    done_at: doneAt,
    source: "hubspot",
    owner: t.ownerProfile,
    created_at: iso(t.deal?.properties.createdate) ?? iso(sorted[0]?.properties.hs_createdate) ?? nowISO(),
  });
  return "written";
}

// ---------------------------------------------------------------------------
// Part 2: HubSpot activity -> journeys
// ---------------------------------------------------------------------------

const ACTIVITY: Array<{ type: string; label: string; props: string[] }> = [
  { type: "calls", label: "call", props: ["hs_timestamp", "hs_call_title", "hs_call_body", "hs_call_disposition", "hs_call_direction", "hubspot_owner_id"] },
  { type: "emails", label: "email", props: ["hs_timestamp", "hs_email_subject", "hs_email_direction", "hs_email_status", "hubspot_owner_id"] },
  { type: "notes", label: "note", props: ["hs_timestamp", "hs_note_body", "hubspot_owner_id"] },
  { type: "meetings", label: "meeting", props: ["hs_timestamp", "hs_meeting_title", "hs_meeting_outcome", "hubspot_owner_id"] },
];
const ACTIVITY_BUDGET_MS = 120_000;

async function mirrorActivity(sinceMs: number) {
  const started = Date.now();
  if (!(await hubspotConfigured().catch(() => false))) return { ok: true, skipped: "HubSpot is not connected" };
  const db = adminClient();
  const errors: string[] = [];
  let linked = 0, mirrored = 0;

  const { data: profs } = await db.from("profiles").select("id,full_name,email,hubspot_owner_id,is_owner");
  const byOwner = new Map((profs ?? []).filter((p) => p.hubspot_owner_id).map((p) => [String(p.hubspot_owner_id), p]));
  const ownerProfile = (profs ?? []).find((p) => p.is_owner)?.id ?? null;

  // Approved, active leads. Fill missing HubSpot contact ids (a few per night; crm-guard fills them too).
  const leads: { id: string; name: string; company: string; assigned_to: string | null; hubspot_contact_id: string | null; enrichment: Record<string, string> | null; email_activity: Record<string, string> | null }[] = [];
  for (let from = 0;; from += 1000) {
    const { data } = await db.from("leads").select("id,name,company,assigned_to,hubspot_contact_id,enrichment,email_activity")
      .eq("approved", true).eq("archived", false).range(from, from + 999);
    leads.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  for (const l of leads.filter((x) => !x.hubspot_contact_id).slice(0, 60)) {
    if (Date.now() - started > ACTIVITY_BUDGET_MS / 3) break;
    try {
      const id = await hsFindContact(l);
      if (id) {
        await db.from("leads").update({ hubspot_contact_id: id }).eq("id", l.id);
        l.hubspot_contact_id = id;
        linked++;
      }
    } catch (e) {
      errors.push(`find ${l.name}: ${errMsg(e).slice(0, 100)}`);
    }
  }
  const byContact = new Map(leads.filter((l) => l.hubspot_contact_id).map((l) => [String(l.hubspot_contact_id), l]));
  const contactIds = [...byContact.keys()];

  // Notes the roster itself wrote to HubSpot are already journeys.
  const { data: own } = await db.from("journeys").select("hs_note_id").not("hs_note_id", "is", null);
  const ownNotes = new Set((own ?? []).map((j) => String(j.hs_note_id)));

  for (const a of ACTIVITY) {
    if (Date.now() - started > ACTIVITY_BUDGET_MS) break;
    try {
      const assoc = await hsAssoc("contacts", a.type, contactIds);
      const engToContact = new Map<string, string>();
      for (const [cid, eids] of assoc) for (const e of eids) if (!engToContact.has(e)) engToContact.set(e, cid);
      const candidates = [...engToContact.keys()].filter((id) => !(a.type === "notes" && ownNotes.has(id)));
      if (!candidates.length) continue;
      const keys = candidates.map((id) => `${a.type}:${id}`);
      const seen = new Set<string>();
      for (let i = 0; i < keys.length; i += 300) {
        const { data } = await db.from("journeys").select("hs_engagement_id").in("hs_engagement_id", keys.slice(i, i + 300));
        (data ?? []).forEach((j) => seen.add(String(j.hs_engagement_id)));
      }
      const fresh = candidates.filter((id) => !seen.has(`${a.type}:${id}`));
      const objs = await hsBatchRead(a.type, fresh, a.props);
      const rows = objs
        .filter((o) => ms(o.properties.hs_timestamp) >= sinceMs)
        .map((o) => {
          const l = byContact.get(engToContact.get(String(o.id)) ?? "")!;
          const who = byOwner.get(String(o.properties.hubspot_owner_id ?? ""));
          const reply = a.type === "emails" && String(o.properties.hs_email_direction ?? "") === "INCOMING_EMAIL";
          return {
            lead_id: l.id,
            company: l.company,
            contact: l.name,
            text: activityText(a.label, o, who ? who.full_name || who.email : null),
            at: iso(o.properties.hs_timestamp) ?? nowISO(),
            kind: "hubspot",
            stage: a.type === "emails" ? (reply ? "email_reply" : "email_sent") : "crm",
            hs_status: "synced",
            hs_engagement_id: `${a.type}:${o.id}`,
            owner: l.assigned_to ?? who?.id ?? ownerProfile,
          };
        })
        .filter((r) => r.owner);
      for (let i = 0; i < rows.length; i += 200) {
        const { error } = await db.from("journeys").insert(rows.slice(i, i + 200));
        if (error) errors.push(`${a.type} insert: ${error.message.slice(0, 120)}`);
        else mirrored += rows.slice(i, i + 200).length;
      }
    } catch (e) {
      errors.push(`${a.type}: ${errMsg(e).slice(0, 150)}`);
    }
  }

  // Email engagement: HubSpot keeps the latest open, click and reply of sales emails on the contact. New ones become
  // journey entries ("Opened your email") and the lead keeps the latest of each for badges and priority.
  let signals = 0;
  if (Date.now() - started < ACTIVITY_BUDGET_MS + 20_000 && contactIds.length) {
    try {
      const contacts = await hsBatchRead("contacts", contactIds, EMAIL_SIGNAL_PROPS);
      const rows: Record<string, unknown>[] = [];
      for (const c of contacts) {
        const l = byContact.get(String(c.id));
        if (!l) continue;
        const prev = l.email_activity ?? {};
        const next = emailSignals(c.properties);
        const owner = l.assigned_to ?? ownerProfile;
        for (const kind of ["opened", "clicked", "replied"] as const) {
          const t = next[kind];
          if (!t || (prev[kind] && Date.parse(prev[kind]) >= Date.parse(t))) continue;
          // Replies also arrive as incoming emails above; the contact-level reply only adds an entry when none did.
          if (kind === "replied") continue;
          if (owner && Date.parse(t) >= sinceMs) {
            rows.push({
              lead_id: l.id, company: l.company, contact: l.name, at: t, kind: "hubspot", stage: kind === "opened" ? "email_open" : "email_click",
              text: kind === "opened" ? "Opened your sales email (HubSpot tracking)." : "Clicked a link in your sales email (HubSpot tracking).",
              hs_status: "synced", hs_engagement_id: `${kind}:${c.id}:${Date.parse(t)}`, owner,
            });
          }
        }
        if (JSON.stringify(prev) !== JSON.stringify({ ...prev, ...next })) {
          await db.from("leads").update({ email_activity: { ...prev, ...next, checked_at: nowISO() } }).eq("id", l.id);
        }
      }
      if (rows.length) {
        const keys = rows.map((r) => String(r.hs_engagement_id));
        const { data: seen } = await db.from("journeys").select("hs_engagement_id").in("hs_engagement_id", keys);
        const have = new Set((seen ?? []).map((j) => String(j.hs_engagement_id)));
        const fresh = rows.filter((r) => !have.has(String(r.hs_engagement_id)));
        if (fresh.length) {
          const { error } = await db.from("journeys").insert(fresh);
          if (error) errors.push(`email signals insert: ${error.message.slice(0, 120)}`);
          else signals = fresh.length;
        }
      }
    } catch (e) {
      errors.push(`email signals: ${errMsg(e).slice(0, 150)}`);
    }
  }

  const { data: cur } = await db.from("app_settings").select("value").eq("key", "hubspot_sync").maybeSingle();
  await db.from("app_settings").upsert({
    key: "hubspot_sync",
    value: { ...(cur?.value ?? {}), activity: { last_run: nowISO(), contacts: contactIds.length, linked, mirrored, email_signals: signals, errors: errors.length ? errors.slice(0, 10) : 0 } },
    updated_at: nowISO(),
  });
  await audit(null, "hubspot_sync.activity", "journeys", `${mirrored} HubSpot activities mirrored, ${linked} contacts linked`);
  return { ok: true, contacts: contactIds.length, linked, mirrored, errors: errors.slice(0, 10), ms: Date.now() - started };
}

function activityText(label: string, o: HsObject, who: string | null): string {
  const p = o.properties;
  const by = who ? ` by ${who}` : "";
  if (label === "call") {
    const head = [p.hs_call_direction && String(p.hs_call_direction).toLowerCase(), "call"].filter(Boolean).join(" ");
    return `HubSpot ${head}${by}${p.hs_call_title ? `: ${p.hs_call_title}` : ""}. ${stripHtml(p.hs_call_body).slice(0, 600)}`.trim();
  }
  if (label === "email") {
    if (String(p.hs_email_direction ?? "") === "INCOMING_EMAIL") return `Replied by email: ${p.hs_email_subject ?? "(no subject)"}`.trim();
    const bounced = String(p.hs_email_status ?? "") === "BOUNCED" ? " It bounced." : "";
    return `Email sent${by}: ${p.hs_email_subject ?? "(no subject)"}.${bounced}`.trim();
  }
  if (label === "meeting") return `HubSpot meeting${by}: ${p.hs_meeting_title ?? ""}${p.hs_meeting_outcome ? ` (${String(p.hs_meeting_outcome).toLowerCase()})` : ""}`.trim();
  return `HubSpot note${by}: ${stripHtml(p.hs_note_body).slice(0, 800)}`.trim();
}
