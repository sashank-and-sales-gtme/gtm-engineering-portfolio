// Cron (every 5 minutes) or internal invoke. Prepares work for the Claude worker:
//   1. CRM gate: every queued account is checked against HubSpot and the roster before any research is spent.
//      HubSpot errors keep the row waiting (fail closed); nothing reaches Claude unchecked.
//   2. Add-company "now" contacts are enriched (Apollo, then FullEnrich) here, in the cloud.
//   3. Quota release: held accounts are handed to Claude only while a rep is short of their weekly quota.
//   4. Exa company research: accounts about to reach Claude get their company profile (fit, pain points, GTM news)
//      from Exa, cached so the worker skips its own company research. Thin answers are left for Claude.
//   5. Housekeeping: expired worker leases, stale held rows from past batches.
import { errMsg, json, readJson, serve } from "../_shared/cors.ts";
import { adminClient, coName, nowISO, cronFanOut, requireCron, splitName } from "../_shared/supabase.ts";
import { type HsObject, hsSearch, hubspotConfigured } from "../_shared/hubspot.ts";
import { peopleMatch } from "../_shared/apollo.ts";
import { fullEnrich } from "../_shared/fullenrich.ts";
import { apolloEmpty, choosePrimary } from "../_shared/email_quality.ts";
import { PHONE_WAIT_MS } from "../_shared/phone.ts";
import { pollPhoneFallback, startPhoneFallback } from "../_shared/phone_fallback.ts";
import { getSecret } from "../_shared/secrets.ts";
import { isAlwaysExcluded, todayIST } from "../_shared/icp.ts";
import { normDomain, rosterSettings, setClaim } from "../_shared/roster.ts";
import { finishRow, type Person, type QueueRow } from "../_shared/research.ts";
import { exaCompany } from "../_shared/exa.ts";
import type { SellerProfile } from "../_shared/profile.ts";
import { loadProfile } from "../_shared/profile_store.ts";
import { ownersWithOpenTasks, syncCompleted } from "../_shared/gtasks.ts";
import { findLinkedIn } from "../_shared/linkedin.ts";
import { wakeResearch } from "../_shared/wake.ts";

const GATE_BATCH = 30;
const TIME_BUDGET_MS = 110_000;
const MAX_GATE_ATTEMPTS = 8;
const CLOSED_STAGES = new Set(["opportunity", "customer", "evangelist"]);

serve(async (req) => {
  requireCron(req);
  const opts = await readJson<{ workspace_id?: string }>(req);
  return await cronFanOut("queue-gate", opts, run);
});

async function run(): Promise<Response> {
  const started = Date.now();
  const db = adminClient();
  const [s, profile] = await Promise.all([rosterSettings(), loadProfile()]);
  const summary = { gated: 0, passed: 0, skipped: 0, waiting_on_crm: 0, released: 0, expired_leases: 0, stale: 0, exa: { researched: 0, excluded: 0, thin: 0, cached: 0, failed: 0 }, linkedin: 0 as number, errors: [] as string[] };

  // Expired worker leases go back to the queue (or fail after 3 attempts).
  const { data: expired } = await db.from("research_queue").select("id,kind,payload,batch,rep_id,submits,attempts")
    .eq("status", "running").lt("lease_until", nowISO());
  for (const r of (expired ?? []) as QueueRow[]) {
    if (r.attempts >= 3) await finishRow(r, "failed", { error: "worker lease expired 3 times" });
    else await db.from("research_queue").update({ status: "pending", lease_until: null, worker: null }).eq("id", r.id);
    summary.expired_leases++;
  }

  // Owners in HubSpot that belong to roster people.
  const { data: profs } = await db.from("profiles").select("id,hubspot_owner_id,full_name,email").eq("status", "active");
  const ownerToProfile = new Map<string, { id: string; name: string }>();
  for (const p of profs ?? []) if (p.hubspot_owner_id) ownerToProfile.set(String(p.hubspot_owner_id), { id: p.id, name: p.full_name || p.email });

  const hsOn = await hubspotConfigured().catch(() => false);
  // Lease the rows (FOR UPDATE SKIP LOCKED) so overlapping runs never check or enrich the same account twice.
  const { data: gating, error: ge } = await db.rpc("claim_gate_rows", { p_n: GATE_BATCH });
  if (ge) summary.errors.push(`claim: ${ge.message.slice(0, 150)}`);

  for (const row of (gating ?? []) as (QueueRow & { gate_attempts: number })[]) {
    if (Date.now() - started > TIME_BUDGET_MS) break;
    summary.gated++;
    try {
      const r = await gate(row, { hsOn, ownerToProfile, recentDays: s.crm_recent_days, perAccount: s.contacts_per_account, profile });
      if (r === "passed") summary.passed++;
      else if (r === "skipped") summary.skipped++;
    } catch (e) {
      // Fail closed: HubSpot (or Apollo enrichment) trouble keeps the row out of research until it clears.
      const attempts = (row.gate_attempts ?? 0) + 1;
      const msg = errMsg(e).slice(0, 300);
      if (attempts >= MAX_GATE_ATTEMPTS) {
        await finishRow(row, "failed", { error: `CRM check failed ${attempts} times: ${msg}` });
      } else {
        await db.from("research_queue").update({
          gate_attempts: attempts, error: `waiting on CRM check: ${msg}`,
          next_gate_at: new Date(Date.now() + attempts * 15 * 60e3).toISOString(),
        }).eq("id", row.id);
        summary.waiting_on_crm++;
      }
      summary.errors.push(`${row.payload?.domain}: ${msg.slice(0, 120)}`);
    }
  }

  // Quota release per rep and batch.
  try {
    summary.released = await releaseByQuota();
  } catch (e) {
    summary.errors.push(`release: ${errMsg(e).slice(0, 150)}`);
  }

  // Exa company research for accounts that are about to be claimed.
  if (Date.now() - started < TIME_BUDGET_MS - 40_000) {
    try {
      await exaPrefetch(started, s.company_cache_days, s.exclude_cache_days, summary.exa);
    } catch (e) {
      summary.errors.push(`exa: ${errMsg(e).slice(0, 150)}`);
    }
  }

  // Phone waterfall: Apollo's number didn't arrive in time, so FullEnrich gets its turn; running phone jobs are checked.
  if (Date.now() - started < TIME_BUDGET_MS - 20_000) {
    try {
      const { data: waiting } = await db.from("leads").select("id,enrichment")
        .or("enrichment->>phone_stage.eq.apollo,enrichment->>phone_stage.eq.fullenrich").limit(40);
      for (const l of waiting ?? []) {
        if (Date.now() - started > TIME_BUDGET_MS - 10_000) break;
        const e = (l.enrichment ?? {}) as Record<string, string>;
        if (e.phone_stage === "apollo" && Date.now() - Date.parse(e.phone_requested_at ?? "") > PHONE_WAIT_MS) {
          await startPhoneFallback(l.id, "Apollo sent no phone number within 15 minutes");
        } else if (e.phone_stage === "fullenrich" && e.phone_fe_id) {
          await pollPhoneFallback(l.id);
        }
      }
    } catch (e) {
      summary.errors.push(`phones: ${errMsg(e).slice(0, 150)}`);
    }
  }

  // Every contact gets a LinkedIn profile: Apollo's search hides it for masked names, so Exa looks it up (strict name
  // and role match), and a masked surname is filled in from the profile. Each contact is tried once a fortnight.
  if (Date.now() - started < TIME_BUDGET_MS - 25_000 && (await getSecret("int_exa_key").catch(() => null))) {
    try {
      const since = new Date(Date.now() - 14 * 864e5).toISOString();
      const { data: noLi } = await db.from("leads").select("id,name,title,company,domain,linkedin_checked_at")
        .eq("archived", false).or("linkedin.is.null,linkedin.eq.").order("linkedin_checked_at", { ascending: true, nullsFirst: true }).limit(60);
      const due = (noLi ?? []).filter((l) => !l.linkedin_checked_at || l.linkedin_checked_at < since).slice(0, 12);
      for (const l of due) {
        if (Date.now() - started > TIME_BUDGET_MS - 10_000) break;
        const patch: Record<string, unknown> = { linkedin_checked_at: nowISO() };
        try {
          const hit = await findLinkedIn({ name: l.name, title: l.title || "", company: coName(l.company), domain: l.domain || "" });
          if (hit) {
            patch.linkedin = hit.url;
            patch.linkedin_source = "exa";
            // A masked or first-name-only contact takes the full name from the matched profile (FullEnrich needs it).
            const partial = /\*/.test(String(l.name)) || String(l.name).trim().split(/\s+/).length < 2;
            if (partial && hit.fullName && !/\*/.test(hit.fullName) && hit.fullName.split(/\s+/).length >= 2) patch.name = hit.fullName;
            summary.linkedin = (summary.linkedin ?? 0) + 1;
          }
        } catch (e) {
          summary.errors.push(`linkedin ${l.name}: ${errMsg(e).slice(0, 80)}`);
        }
        await db.from("leads").update(patch).eq("id", l.id);
      }
    } catch (e) {
      summary.errors.push(`linkedin: ${errMsg(e).slice(0, 150)}`);
    }
  }

  // Callbacks and to-dos ticked off in Google Tasks close in the roster, so reps never have to open the app for them.
  if (Date.now() - started < TIME_BUDGET_MS - 20_000) {
    try {
      for (const uid of await ownersWithOpenTasks()) {
        if (Date.now() - started > TIME_BUDGET_MS - 10_000) break;
        await syncCompleted(uid).catch((e) => summary.errors.push(`tasks ${uid.slice(0, 8)}: ${errMsg(e).slice(0, 100)}`));
      }
    } catch (e) {
      summary.errors.push(`tasks: ${errMsg(e).slice(0, 150)}`);
    }
  }

  // Held rows from batches more than a week old will never be needed.
  const cutoff = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  const { data: stale } = await db.from("research_queue").select("id,kind,payload,batch,rep_id,submits,attempts")
    .eq("status", "held").lt("batch", cutoff).limit(500);
  for (const r of (stale ?? []) as QueueRow[]) {
    await finishRow(r, "skipped", { error: "batch closed with quota met" });
    summary.stale++;
  }

  // Accounts that just passed the gate (and prep briefs) shouldn't wait for the hourly research run.
  const wake = await wakeResearch();

  return json({ ok: true, ...summary, wake, errors: summary.errors.slice(0, 20), ms: Date.now() - started });
}

interface GateCtx {
  hsOn: boolean;
  ownerToProfile: Map<string, { id: string; name: string }>;
  recentDays: number;
  perAccount: number;
  profile: SellerProfile;
}

async function gate(row: QueueRow, ctx: GateCtx): Promise<"passed" | "skipped"> {
  const db = adminClient();
  const p = { ...(row.payload ?? {}) };
  const manual = !!p.manual;
  const domain = normDomain(p.domain);
  const claimKey = String(p.account_key || domain);
  const company = String(p.company ?? "");
  let people: Person[] = (p.people ?? []).map((x: Person, i: number) => ({ ...x, key: x.key || `p${i + 1}` }));
  const flags: string[] = [];

  if (!manual && isAlwaysExcluded(company, ctx.profile)) {
    await finishRow(row, "skipped", { error: "excluded: the seller, a customer or a company on the never-target list" });
    return "skipped";
  }

  // Roster dedupe: the same person already on the roster (any rep, archived or not).
  const kept: Person[] = [];
  for (const person of people) {
    const dupe = await rosterDupe(person, domain, company);
    if (dupe && !manual) continue;
    if (dupe) person.hubspot_flag = [person.hubspot_flag, `Flag: already on the roster (${dupe}).`].filter(Boolean).join(" ");
    kept.push(person);
  }
  people = kept;

  // HubSpot dedupe. Throws on HubSpot errors, which keeps the row waiting.
  if (ctx.hsOn) {
    const since = Date.now() - ctx.recentDays * 864e5;
    const co = domain ? await hsCompany(domain) : null;
    if (co) {
      const reason = companyBlock(co, row.rep_id, since, ctx.ownerToProfile);
      if (reason && !manual) {
        await setClaim(claimKey, "excluded", `HubSpot: ${reason}`, ctx.recentDays);
        await finishRow(row, "skipped", { error: `HubSpot: ${reason}` });
        return "skipped";
      }
      if (reason) flags.push(`Flag: HubSpot ${reason}.`);
    }
    const out: Person[] = [];
    for (const person of people) {
      const c = await hsContact(person, company);
      if (c) {
        const reason = contactBlock(c, row.rep_id, since, ctx.ownerToProfile);
        if (reason && !manual) continue;
        person.hubspot_flag = [person.hubspot_flag, `Flag: HubSpot contact ${reason || "exists, no recent activity"}.`].filter(Boolean).join(" ");
      }
      out.push(person);
    }
    people = out;
  } else {
    flags.push("Flag: HubSpot not connected, CRM check skipped.");
  }

  if (!people.length) {
    await setClaim(claimKey, "excluded", "every contact is already in HubSpot or on the roster", ctx.recentDays);
    await finishRow(row, "skipped", { error: "every contact is already in HubSpot or on the roster" });
    return "skipped";
  }
  if (!manual) people = people.slice(0, ctx.perAccount);
  if (flags.length) people = people.map((x) => ({ ...x, hubspot_flag: [x.hubspot_flag, ...flags].filter(Boolean).join(" ") }));

  // Paid enrichment for add-company "now" requests, persisted so a retry never pays twice.
  if (p.enrich) {
    let credits = Number(p.credits ?? 0);
    for (const person of people) {
      if (person.enrichment?.status) continue;
      const { first, last, masked } = splitName(person.name);
      const match = await peopleMatch({
        id: person.id, first_name: first, last_name: masked ? undefined : last, name: masked ? undefined : person.name,
        domain, organization_name: company, linkedin_url: person.linkedin,
      }).catch(() => null);
      credits++;
      if (match) {
        person.id = person.id || match.id;
        person.title = person.title || match.title || "";
        person.linkedin = person.linkedin || match.linkedin_url || "";
        if (match.name && /\*/.test(person.name)) person.name = match.name;
        p.employees = p.employees ?? match.organization?.estimated_num_employees ?? null;
        p.revenue = p.revenue ?? match.organization?.annual_revenue ?? null;
      }
      const enr: Record<string, string> = {
        email: match?.email ?? "", source: "Apollo", status: match?.email ? "found" : "no email",
        email_status: match?.email_status ?? "", apollo_email: match?.email ?? "", apollo_status: match?.email_status ?? "", at: nowISO(),
        title: match?.title ?? "", location: [match?.city, match?.state, match?.country].filter(Boolean).join(", "),
      };
      // Waterfall: FullEnrich (email only) only when Apollo came back empty or invalid.
      if (apolloEmpty(match?.email, match?.email_status)) {
        if (await getSecret("int_fullenrich_key")) {
          const fe = await fullEnrich({ name: person.name, domain, company, linkedin: person.linkedin }, ["contact.emails"]);
          if (fe) {
            enr.fe_tried = "1";
            if (fe.email) Object.assign(enr, { fe_email: fe.email, fe_email_status: fe.email_status });
            if (fe.phone) Object.assign(enr, { phone: fe.phone, phone_source: "FullEnrich" });
            const best = choosePrimary([
              { email: enr.apollo_email, status: enr.apollo_status, source: "Apollo" },
              { email: enr.fe_email, status: enr.fe_email_status, source: "FullEnrich" },
            ]);
            if (best) Object.assign(enr, { email: best.email, email_status: best.status, source: best.source, status: "found" });
          }
        } else enr.fe_error = "Apollo found no usable email and FullEnrich isn't connected";
      }
      person.enrichment = enr;
    }
    p.credits = credits;
    p.enrich = false;
  }

  p.people = people;
  // Weekly accounts wait in reserve for quota release; manual adds and suggested contacts go straight to Claude.
  const next = row.kind === "account" && !manual && !p.followup ? "held" : "pending";
  await db.from("research_queue").update({ status: next, payload: p, error: null, next_gate_at: null }).eq("id", row.id);
  return "passed";
}

/** A matching roster lead, described for the flag, or null. */
async function rosterDupe(person: Person, domain: string, company: string): Promise<string | null> {
  const db = adminClient();
  if (person.id) {
    const { data } = await db.from("leads").select("id,assigned_to").eq("id", String(person.id)).maybeSingle();
    if (data) return "same Apollo person";
  }
  if (person.linkedin) {
    const li = person.linkedin.toLowerCase().replace(/\/+$/, "");
    const { data } = await db.from("leads").select("id").ilike("linkedin", `${li}%`).limit(1);
    if (data?.length) return "same LinkedIn profile";
  }
  const first = splitName(person.name).first.toLowerCase();
  if (first) {
    const q = domain ? db.from("leads").select("name").eq("domain", domain) : db.from("leads").select("name").ilike("company", coName(company));
    const { data } = await q.limit(50);
    if ((data ?? []).some((l) => splitName(l.name).first.toLowerCase() === first)) return "same name at this company";
  }
  return null;
}

const COMPANY_PROPS = ["name", "domain", "num_associated_deals", "hubspot_owner_id", "notes_last_contacted", "hs_last_sales_activity_timestamp", "lifecyclestage"];
const CONTACT_PROPS = ["firstname", "lastname", "email", "company", "hubspot_owner_id", "notes_last_contacted", "hs_last_sales_activity_timestamp", "lifecyclestage", "hs_lead_status"];

async function hsCompany(domain: string): Promise<HsObject | null> {
  const r = await hsSearch("companies", {
    filterGroups: [{ filters: [{ propertyName: "domain", operator: "EQ", value: domain }] }],
    properties: COMPANY_PROPS,
  });
  return r.results[0] ?? null;
}

async function hsContact(person: Person, company: string): Promise<HsObject | null> {
  const email = person.enrichment?.email;
  if (email) {
    const r = await hsSearch("contacts", { filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }], properties: CONTACT_PROPS });
    if (r.results[0]) return r.results[0];
  }
  const { first, last } = splitName(person.name);
  const token = coName(company).split(/\s+/)[0];
  if (!first || !token) return null;
  const filters = [
    { propertyName: "firstname", operator: "EQ", value: first },
    { propertyName: "company", operator: "CONTAINS_TOKEN", value: token },
  ];
  if (last) filters.push({ propertyName: "lastname", operator: "EQ", value: last });
  const r = await hsSearch("contacts", { filterGroups: [{ filters }], properties: CONTACT_PROPS });
  return r.results[0] ?? null;
}

const ts = (v: unknown) => {
  if (!v) return NaN;
  const s = String(v);
  return /^\d+$/.test(s) ? Number(s) : Date.parse(s);
};
const lastTouch = (o: HsObject) => Math.max(...[ts(o.properties.notes_last_contacted), ts(o.properties.hs_last_sales_activity_timestamp)].filter((x) => !isNaN(x)), 0);
const day = (t: number) => new Date(t).toISOString().slice(0, 10);

function companyBlock(co: HsObject, repId: string | null, since: number, owners: Map<string, { id: string; name: string }>): string {
  if (Number(co.properties.num_associated_deals ?? 0) > 0) return `company ${co.properties.name ?? ""} already has deals`.replace("  ", " ");
  if (CLOSED_STAGES.has(String(co.properties.lifecyclestage ?? ""))) return `company is a ${co.properties.lifecyclestage}`;
  const owner = owners.get(String(co.properties.hubspot_owner_id ?? ""));
  if (owner && owner.id !== repId) return `company is owned by ${owner.name}`;
  const t = lastTouch(co);
  if (t && t >= since) return `company was contacted on ${day(t)}`;
  return "";
}

function contactBlock(c: HsObject, repId: string | null, since: number, owners: Map<string, { id: string; name: string }>): string {
  if (CLOSED_STAGES.has(String(c.properties.lifecyclestage ?? ""))) return `is a ${c.properties.lifecyclestage}`;
  const owner = owners.get(String(c.properties.hubspot_owner_id ?? ""));
  if (owner && owner.id !== repId) return `is owned by ${owner.name}`;
  const t = lastTouch(c);
  if (t && t >= since) return `was contacted on ${day(t)}`;
  return "";
}

/** Moves held accounts to pending only while a rep is short of their quota for the batch. */
async function releaseByQuota(): Promise<number> {
  const db = adminClient();
  const oldest = new Date(Date.parse(todayIST()) - 6 * 864e5).toISOString().slice(0, 10);
  const { data: held } = await db.from("research_queue").select("rep_id,batch").eq("status", "held").gte("batch", oldest).limit(5000);
  const pairs = new Map<string, { rep: string; batch: string }>();
  for (const h of held ?? []) if (h.rep_id && h.batch) pairs.set(`${h.rep_id}|${h.batch}`, { rep: h.rep_id, batch: h.batch });
  let released = 0;
  for (const { rep, batch } of pairs.values()) {
    const { data: rs } = await db.from("rep_settings").select("weekly_accounts,in_rotation").eq("user_id", rep).maybeSingle();
    const quota = rs?.in_rotation ? Number(rs.weekly_accounts ?? 0) : 0;
    const { data: rows } = await db.from("research_queue").select("status,result,payload").eq("rep_id", rep).eq("batch", batch).eq("kind", "account");
    let qualified = 0, inFlight = 0;
    for (const r of rows ?? []) {
      if (r.payload?.manual || r.payload?.followup) continue; // manual adds and suggested contacts don't use quota
      if (r.status === "done" && Number(r.result?.leads ?? 0) > 0) qualified++;
      if (r.status === "gating" || r.status === "pending" || r.status === "running") inFlight++;
    }
    const need = quota - qualified - inFlight;
    if (need <= 0) continue;
    const { data: next } = await db.from("research_queue").select("id").eq("rep_id", rep).eq("batch", batch).eq("status", "held")
      .order("priority").order("created_at").limit(need);
    const ids = (next ?? []).map((x) => x.id);
    if (ids.length) {
      await db.from("research_queue").update({ status: "pending" }).in("id", ids).eq("status", "held");
      released += ids.length;
    }
  }
  return released;
}

const EXA_BATCH = 8;
const EXA_PARALLEL = 4;

/**
 * Researches the companies behind pending accounts with Exa and caches the result as company research, so the
 * Claude worker goes straight to the contacts. Clear ICP failures (with a source) are excluded here like a screened
 * exclusion (30-day lock). Thin answers are marked and left for Claude. Each row is tried once.
 */
async function exaPrefetch(
  started: number,
  cacheDays: number,
  excludeDays: number,
  out: { researched: number; excluded: number; thin: number; cached: number; failed: number },
) {
  if (!(await getSecret("int_exa_key").catch(() => null))) return;
  const db = adminClient();
  const { data: rows } = await db.from("research_queue").select("id,kind,payload,batch,rep_id,submits,attempts")
    .eq("status", "pending").in("kind", ["account", "add_request"]).is("exa_status", null)
    .order("created_at", { ascending: true }).limit(EXA_BATCH);
  const list = (rows ?? []) as QueueRow[];
  const profile = await loadProfile();
  let spent = 0;
  const one = async (row: QueueRow) => {
    const p = row.payload ?? {};
    const domain = normDomain(p.domain);
    const mark = (exa_status: string, extra: Record<string, unknown> = {}) =>
      db.from("research_queue").update({ exa_status, ...extra }).eq("id", row.id);
    if (!domain || p.followup) return void (await mark("skipped"));
    const { data: cached } = await db.from("company_research").select("excluded,researched_at").eq("domain", domain).maybeSingle();
    if (cached && !cached.excluded && Date.now() - Date.parse(cached.researched_at) < cacheDays * 864e5) {
      out.cached++;
      return void (await mark("cached"));
    }
    try {
      const v = await exaCompany({
        company: coName(p.company), domain, employee_range: p.employee_range ?? null, employees: p.employees ?? null,
        revenue_usd: p.revenue ?? null, manual: !!p.manual,
      }, profile);
      spent += v.cost;
      if (v.kind === "research") {
        await db.from("company_research").upsert({ domain, company: coName(p.company), data: v.company, excluded: false, researched_at: nowISO() });
        out.researched++;
        await mark("ok");
      } else if (v.kind === "exclude") {
        const reason = `Exa: ${v.reason}`.slice(0, 300);
        await db.from("company_research").upsert({
          domain, company: coName(p.company), data: { ...v.company, exclude_reason: v.reason, exclude_source: v.source, screened: true }, excluded: true, researched_at: nowISO(),
        });
        await setClaim(String(p.account_key || domain), "excluded", reason, Math.min(30, excludeDays));
        await finishRow(row, "skipped", { error: `excluded by Exa: ${v.reason} (${v.source})` });
        await mark("excluded");
        out.excluded++;
      } else {
        out.thin++;
        await mark("thin", { error: `Exa: ${v.why}; Claude researches the company` });
      }
    } catch (e) {
      out.failed++;
      await mark("failed", { error: `Exa: ${errMsg(e).slice(0, 200)}; Claude researches the company` });
    }
  };
  for (let i = 0; i < list.length; i += EXA_PARALLEL) {
    if (Date.now() - started > TIME_BUDGET_MS) break;
    await Promise.all(list.slice(i, i + EXA_PARALLEL).map(one));
  }
  if (spent > 0) {
    const { data } = await db.from("app_settings").select("value").eq("key", "exa_usage").maybeSingle();
    const v = (data?.value ?? {}) as { dollars?: number; companies?: number };
    await db.from("app_settings").upsert({
      key: "exa_usage",
      value: { dollars: Math.round(((v.dollars ?? 0) + spent) * 1000) / 1000, companies: (v.companies ?? 0) + out.researched + out.excluded + out.thin, last_run: nowISO() },
      updated_at: nowISO(),
    });
  }
}
