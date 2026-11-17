// Work items for the Claude worker: what a claimed task looks like, and how a submitted result is
// validated and written. The worker never touches the database; everything goes through here.
import { adminClient, coName, nowISO } from "./supabase.ts";
import { type LeadJson, normalizeLead, todayIST, validateLead } from "./icp.ts";
import { acceptsTitle, activePersonas, icpBrief, type IcpConfig, loadIcp, scopeKeys, seniorEnoughWith, titleScopeWith } from "./icp_config.ts";
import { normDomain, rosterSettings, setClaim } from "./roster.ts";
import { proofTexts, sellerBrief } from "./profile.ts";
import { loadProfile } from "./profile_store.ts";
import { loadDocuments } from "./documents.ts";

// deno-lint-ignore no-explicit-any
export type QueueRow = { id: string; kind: string; payload: Record<string, any>; batch: string | null; rep_id: string | null; submits: number; attempts: number };

export interface Person {
  key: string;
  id?: string;
  name: string;
  title: string;
  linkedin?: string;
  hubspot_flag?: string;
  location_hint?: string;
  suggested_by?: string;
  enrichment?: Record<string, string> | null;
}

/** Apollo's evidence about a person, as the contact researcher sees it (the email itself is not sent). */
function apolloEvidence(x: Person, domain: string) {
  const e = x.enrichment ?? {};
  const email = String(e.email ?? "").toLowerCase();
  const emailDomain = email.includes("@") ? email.split("@")[1] : "";
  const sameDomain = !!emailDomain && !!domain && (emailDomain === domain || emailDomain.endsWith("." + domain));
  return {
    title: e.title || x.title || "",
    location: e.location || x.location_hint || "",
    work_email_verified: e.status === "verified" && sameDomain,
    work_email_domain: emailDomain || null,
    suggested_by: x.suggested_by || null,
  };
}

const apolloVerified = (x: Person, domain: string) => apolloEvidence(x, domain).work_email_verified;

/** Compact task for an account (weekly or add-company). Only what Claude needs to research. */
export async function accountTask(row: QueueRow) {
  const p = row.payload ?? {};
  const db = adminClient();
  const domain = normDomain(p.domain);
  const [s, icp, profile, docs] = await Promise.all([rosterSettings(), loadIcp(), loadProfile(), loadDocuments(16_000)]);
  const { data: cached } = await db.from("company_research").select("data,excluded,researched_at").eq("domain", domain).maybeSingle();
  const fresh = cached && !cached.excluded && Date.now() - Date.parse(cached.researched_at) < s.company_cache_days * 864e5;
  const { data: siblings } = await db.from("leads").select("name,angle").ilike("company", coName(p.company) || "__none__").limit(10);
  const names = new Set((p.people ?? []).map((x: Person) => x.name));
  return {
    id: row.id,
    kind: "account",
    manual: !!p.manual,
    company: p.company,
    domain,
    apollo: { employees: p.employees ?? null, employee_range: p.employee_range ?? null, revenue_usd: p.revenue ?? null, total_funding_usd: p.funding ?? null },
    people: (p.people ?? []).map((x: Person) => ({
      key: x.key, name: x.name, title: x.title, linkedin: x.linkedin || "", title_scope_hint: titleScopeWith(icp, x.title),
      apollo: apolloEvidence(x, domain),
    })),
    cached_company: fresh ? cached!.data : null,
    other_angles_at_company: (siblings ?? []).filter((x) => x.angle && !names.has(x.name)).map((x) => `${x.name}: ${x.angle}`),
    icp: icpBrief(icp, proofTexts(profile)),
    seller: sellerBrief(profile),
    // Excerpts of the seller's own decks, case studies, notes and site pages (Admin > Setup > Documents).
    insider_context: docs,
    today: todayIST(),
  };
}


/** Facts for a prep brief, read fresh at claim time. */
export async function prepTask(row: QueueRow) {
  const db = adminClient();
  const id = String(row.payload?.meeting_id ?? "");
  const { data: m } = await db.from("meetings").select("*").eq("id", id).maybeSingle();
  if (!m) return null;
  const { data: lead } = m.lead_id ? await db.from("leads").select("*").eq("id", m.lead_id).maybeSingle() : { data: null };
  const { data: js } = m.lead_id
    ? await db.from("journeys").select("at,text,kind").eq("lead_id", m.lead_id).order("at", { ascending: false }).limit(15)
    : { data: [] };
  const l = lead ?? {};
  return {
    id: row.id,
    kind: "prep_brief",
    meeting_id: id,
    facts: {
      contact: l.name ?? m.contact, title: l.title ?? m.title, company: coName(l.company ?? m.company), segment: l.segment ?? m.segment,
      employees: l.employees ?? null, hq: l.hq ?? null, persona: l.persona ?? "",
      fit: l.fit_reason ?? (lead ? "" : "Booked outside the roster (from HubSpot); no roster research."),
      status: l.status_evidence ?? "", adjacency: l.adjacency ?? "", pain_points: l.pain_points ?? [], competitive: l.competitive ?? "",
      angle: l.angle ?? "", proof_point: l.proof_point ?? "", meeting_when: m.when, format: m.mode, history: m.history ?? [],
      hubspot_context: m.hs_notes || "",
      call_context: (js ?? []).map((j) => ({ at: j.at, source: j.kind === "hubspot" ? "HubSpot" : "rep note", text: String(j.text).slice(0, 800) })),
      seller: sellerBrief(await loadProfile()),
      insider_context: await loadDocuments(20_000),
    },
  };
}

async function manualId(name: string, domain: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(`${String(name).toLowerCase()}|${String(domain).toLowerCase()}`));
  return "m-" + [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 22);
}

const COMPANY_FIELDS = ["segment", "hq", "employees", "adjacency", "competitive"] as const;

const VERDICTS = ["fit", "partial", "no"];
const IN_INDIA = ["yes", "no", "unconfirmed"];
const FUNCTIONS = ["demand_gen", "growth", "digital", "general", "other"];
const SCOPES = ["india", "apac", "global", "unknown"];

/**
 * The person fit check every contact needs beyond Apollo's filters: in role now, in India, the right function
 * and seniority, scope. A failing check must end in an exclusion (or tier X for a manual add).
 */
// deno-lint-ignore no-explicit-any
function personProblems(c: any, manual: boolean): string[] {
  const p: string[] = [];
  const pc = c?.person_check;
  if (!pc || typeof pc !== "object") return ["person_check is required (in role, in India, function, seniority, scope, verdict)"];
  if (!VERDICTS.includes(pc.verdict)) p.push("person_check.verdict must be fit, partial or no");
  if (!IN_INDIA.includes(pc.in_india)) p.push("person_check.in_india must be yes, no or unconfirmed");
  if (!String(pc.location_evidence ?? "").trim()) p.push("person_check.location_evidence is required (what showed where they are based)");
  if (!FUNCTIONS.includes(pc.function)) p.push("person_check.function must be demand_gen, growth, digital, general or other");
  if (!String(pc.function_evidence ?? "").trim()) p.push("person_check.function_evidence is required (what the role actually covers)");
  if (typeof pc.seniority_ok !== "boolean") p.push("person_check.seniority_ok must be true or false");
  if (!SCOPES.includes(pc.scope)) p.push("person_check.scope must be india, apac, global or unknown");
  if (!String(c?.status_evidence ?? "").trim()) p.push("status_evidence is required (the URL or what the search showed)");
  if (p.length) return p;
  const fails = pc.verdict === "no" || pc.in_india === "no" || pc.function === "other" || pc.seniority_ok === false;
  if (fails && !manual) p.push("the person check fails; set exclude true with the reason");
  if (fails && manual && c.tier !== "X") p.push("a manual add that fails the person check gets tier X");
  if (!fails && pc.verdict === "no") p.push("verdict is no but every check passes; fix the verdict or the failing field");
  // Tiers rank company fit for reps to pick from; whether the role or the email is confirmed is shown separately.
  if ((c.tier === "A" || c.tier === "B") && !["fit", "partial"].includes(pc.verdict)) p.push(`tier ${c.tier} needs a person check of fit or partial`);
  return p;
}

/**
 * The tier shown on the roster. A company someone added by hand that passes research (A, B or C on company fit)
 * goes in the Tier S bucket; one that fails stays Tier X. The company-fit tier is kept in fit_tier.
 */
export function rosterTier(tier: string, manual: boolean): string {
  return manual && ["A", "B", "C"].includes(tier) ? "S" : tier;
}

export interface ApplyOutcome {
  status: "done" | "retry";
  problems?: Record<string, string[]>;
  leads?: string[];
  excluded?: string[];
  note?: string;
  suggested?: number;
}

/**
 * Validates and writes an account result. When some contacts fail validation and the worker still has a
 * resubmit left, nothing is written and the problems go back. On the last submit, valid contacts are kept.
 */
// deno-lint-ignore no-explicit-any
export async function applyAccountResult(row: QueueRow, result: any): Promise<ApplyOutcome> {
  const db = adminClient();
  const p = row.payload ?? {};
  const manual = !!p.manual;
  const claimKey = String(p.account_key || normDomain(p.domain));
  let domain = normDomain(p.domain);
  const people: Person[] = p.people ?? [];
  const [s, icp, profile] = await Promise.all([rosterSettings(), loadIcp(), loadProfile()]);
  const lastChance = (row.submits ?? 0) >= 2;
  const scopes = scopeKeys(icp);
  const proofPointsByScope = Object.fromEntries(activePersonas(icp).map((x) => [x.key, x.proof_points]));
  if (!result || typeof result !== "object") return { status: "retry", problems: { _: ["result must be a JSON object"] } };

  // Company block, or the cached one when the worker reused it.
  let company = result.company ?? {};
  if (!domain && company.domain) domain = normDomain(company.domain);
  if (company.use_cached) {
    const { data: cached } = await db.from("company_research").select("data").eq("domain", domain).maybeSingle();
    if (!cached) return { status: "retry", problems: { company: ["no cached company research exists; research the company"] } };
    company = { ...cached.data, ...Object.fromEntries(Object.entries(company).filter(([k]) => k !== "use_cached")) };
  }

  if (company.exclude === true && !manual) {
    const reason = String(company.exclude_reason || "fails ICP").slice(0, 300);
    // A quick-screen exclusion (one search) needs a source and locks the account out for 30 days, not the full
    // cache period, so a wrong call costs at most a month.
    if (company.screened === true && !/^https?:\/\//.test(String(company.exclude_source ?? ""))) {
      return { status: "retry", problems: { company: ["a screened exclusion needs exclude_source: the URL that shows why"] } };
    }
    if (domain) await db.from("company_research").upsert({ domain, company: p.company, data: company, excluded: true, researched_at: nowISO() });
    await setClaim(claimKey, "excluded", reason, company.screened === true ? Math.min(30, s.exclude_cache_days) : s.exclude_cache_days);
    return { status: "done", leads: [], excluded: people.map((x) => x.key), note: `account excluded: ${reason}` };
  }
  const companyProblems: string[] = [];
  if (company.exclude === true && manual) companyProblems.push("manual adds are never excluded; keep the company and give contacts tier X");
  if (!String(company.segment ?? "").trim()) companyProblems.push("company.segment is required");
  if (!Array.isArray(company.pain_points)) companyProblems.push("company.pain_points must be an array (can be empty)");

  const contacts: LeadJson[] = Array.isArray(result.contacts) ? result.contacts : [];
  // deno-lint-ignore no-explicit-any
  const strongCompany = (Array.isArray(company.pain_points) && company.pain_points.some((x: any) => x?.label === "confirmed")) ||
    (!!company.adjacency && company.adjacency !== "none") ||
    // deno-lint-ignore no-explicit-any
    (Array.isArray(company.gtm_signals) && company.gtm_signals.some((g: any) => /^https?:\/\//.test(String(g?.source ?? ""))));
  const byKey = new Map(contacts.map((c) => [String(c?.key ?? ""), c]));
  const problems: Record<string, string[]> = {};
  if (companyProblems.length) problems.company = companyProblems;
  const ready: { person: Person; lead: LeadJson }[] = [];
  const excluded: string[] = [];

  for (const person of people) {
    const c = byKey.get(person.key);
    if (!c) {
      problems[person.key] = ["missing from contacts"];
      continue;
    }
    if (c.exclude === true && !manual) {
      excluded.push(person.key);
      continue;
    }
    const pErrs = personProblems(c, manual);
    if (c.tier === "A" && !strongCompany) {
      pErrs.push("tier A needs a strong company fit: a confirmed pain point, an adjacency hook or a sourced GTM signal; otherwise use B");
    }
    if (pErrs.length) {
      problems[person.key] = pErrs;
      continue;
    }
    const pains = [...(company.pain_points ?? []), ...(Array.isArray(c.extra_pain_points) ? c.extra_pain_points : [])].slice(0, 3);
    const lead: LeadJson = {
      ...Object.fromEntries(COMPANY_FIELDS.map((k) => [k, company[k]])),
      company: company.name || p.company,
      domain: company.domain || domain,
      name: c.name || person.name,
      title: c.title || person.title,
      linkedin: c.linkedin || person.linkedin || "",
      person_location: c.person_location || "India",
      title_scope: c.title_scope,
      tier: c.tier,
      fit_reason: c.fit_reason,
      status_check: c.status_check,
      status_evidence: c.status_evidence,
      persona: c.persona,
      pain_points: pains,
      angle: c.angle,
      proof_point: c.proof_point,
      exclude: c.exclude === true,
    };
    const errs = validateLead(lead, manual, { apolloVerified: apolloVerified(person, domain), scopes, proofPointsByScope, profile });
    // On the last submit, a contact whose only problems are angle style misses is kept with the misses flagged
    // for the rep, instead of losing a researched lead over wording.
    const styleOnly = errs.length > 0 && errs.every((e) => e.startsWith("angle "));
    if (errs.length && !(lastChance && styleOnly)) problems[person.key] = errs;
    else {
      const flagged = errs.length ? { ...lead, fit_reason: `${lead.fit_reason} Style check: ${errs.join("; ")}. Edit the angle before calling.` } : lead;
      ready.push({ person, lead: { ...normalizeLead(flagged), person_check: c.person_check } });
    }
  }

  if (Object.keys(problems).length && !lastChance) return { status: "retry", problems };
  if (companyProblems.length && !ready.length) return { status: "retry", problems };

  // Write. Company research is cached for the next contacts and weeks.
  const companyData = { ...company };
  delete companyData.exclude;
  delete companyData.exclude_reason;
  delete companyData.suggested_contacts; // suggestions are queued once, never replayed from the cache
  if (domain) await db.from("company_research").upsert({ domain, company: company.name || p.company, data: companyData, excluded: false, researched_at: nowISO() });

  const isNow = row.kind === "add_request";
  const leadIds: string[] = [];
  for (const { person, lead } of ready) {
    const leadId = person.id ? String(person.id) : await manualId(lead.name, lead.domain || domain);
    const fit = [lead.fit_reason, person.hubspot_flag].filter(Boolean).join(" ");
    const research = {
      name: lead.name, title: lead.title, company: lead.company, domain: lead.domain, segment: lead.segment ?? "",
      employees: lead.employees ?? (p.employee_range ? `${p.employee_range} (Apollo)` : ""), hq: lead.hq ?? "",
      person_location: lead.person_location, linkedin: lead.linkedin, tier: rosterTier(lead.tier, manual), fit_tier: lead.tier, fit_reason: fit,
      status_check: lead.status_check, status_evidence: lead.status_evidence ?? "", persona: lead.persona ?? "",
      adjacency: lead.adjacency ?? "none", pain_points: lead.pain_points ?? [], competitive: lead.competitive ?? "",
      angle: lead.angle, proof_point: lead.proof_point, title_scope: lead.title_scope,
      person_check: lead.person_check ?? null,
    };
    const { data: existing } = await db.from("leads").select("id,archived").eq("id", leadId).maybeSingle();
    if (existing) {
      // Never overwrite approval, stage, HubSpot ids or enrichment on an existing lead. An archived lead that
      // comes back through a new claim moves to the rep who now owns the account.
      const revive = existing.archived && row.rep_id ? { assigned_to: row.rep_id, assigned_at: nowISO() } : {};
      const { error } = await db.from("leads").update({ ...research, ...revive, account_key: claimKey, archived: false, archived_at: null }).eq("id", leadId);
      if (error) throw new Error(`lead update failed: ${error.message}`);
    } else {
      const { error } = await db.from("leads").insert({
        id: leadId,
        ...research,
        batch: isNow ? `manual-${todayIST()}` : (row.batch ?? todayIST()),
        source: manual ? "manual" : p.followup ? "suggested" : "weekly",
        approved: isNow,
        approved_at: isNow ? nowISO() : null,
        assigned_to: row.rep_id,
        assigned_at: row.rep_id ? nowISO() : null,
        account_key: claimKey,
        enrichment: person.enrichment ?? null,
      });
      if (error) throw new Error(`lead insert failed: ${error.message}`);
    }
    leadIds.push(leadId);
  }

  if (leadIds.length) await setClaim(claimKey, "active", null);
  else await setClaim(claimKey, "excluded", "no contact passed research", s.exclude_cache_days);
  const suggested = p.followup ? 0 : await queueSuggestions(row, claimKey, domain, company, contacts, people, icp);
  const dropped = Object.keys(problems);
  const notes = [
    dropped.length ? `dropped after 3 submits: ${dropped.map((k) => `${k} (${problems[k].join("; ")})`).join(" | ").slice(0, 600)}` : "",
    suggested ? `${suggested} suggested contact${suggested > 1 ? "s" : ""} queued for research` : "",
  ].filter(Boolean);
  return { status: "done", leads: leadIds, excluded, suggested, note: notes.length ? notes.join(". ") : undefined };
}

const MAX_SUGGESTIONS = 2;

/**
 * Stronger ICP contacts a researcher found while working the account (for example the real India marketing head)
 * are queued as a follow-up on the same account and rep. They go through the CRM gate like anyone else, reuse the
 * cached company research, and never count against quota. A follow-up never suggests further contacts.
 */
async function queueSuggestions(
  row: QueueRow,
  claimKey: string,
  domain: string,
  // deno-lint-ignore no-explicit-any
  company: any,
  // deno-lint-ignore no-explicit-any
  contacts: any[],
  people: Person[],
  icp: IcpConfig,
): Promise<number> {
  const raw = [
    ...(Array.isArray(company?.suggested_contacts) ? company.suggested_contacts : []),
    ...contacts.flatMap((c) => (Array.isArray(c?.suggested_contacts) ? c.suggested_contacts : [])),
  ];
  const known = new Set(people.map((x) => x.name.trim().toLowerCase()));
  const picked: Person[] = [];
  for (const sc of raw) {
    const name = String(sc?.name ?? "").trim();
    const title = String(sc?.title ?? "").trim();
    const source = String(sc?.source ?? "");
    if (!name || !title || known.has(name.toLowerCase())) continue;
    if (!/^https?:\/\//.test(source) || !seniorEnoughWith(icp, title) || !acceptsTitle(icp, "suggestions", title)) continue;
    known.add(name.toLowerCase());
    picked.push({
      key: `p${picked.length + 1}`,
      name,
      title,
      linkedin: /linkedin\.com\/in\//i.test(String(sc?.linkedin ?? "")) ? String(sc.linkedin) : "",
      suggested_by: `${String(sc?.reason ?? "found during research").slice(0, 200)} (${source})`,
    });
    if (picked.length >= MAX_SUGGESTIONS) break;
  }
  if (!picked.length) return 0;
  const p = row.payload ?? {};
  const { error } = await adminClient().from("research_queue").insert({
    kind: "account",
    status: "gating",
    batch: row.batch ?? `manual-${todayIST()}`,
    rep_id: row.rep_id,
    priority: 3,
    domain: domain || null,
    payload: {
      account_key: claimKey, domain, company: company?.name || p.company, people: picked,
      manual: false, enrich: false, followup: true, parent_id: row.id,
      employee_range: p.employee_range ?? null, employees: p.employees ?? null, revenue: p.revenue ?? null, funding: p.funding ?? null,
    },
  });
  if (error) {
    console.error("could not queue suggested contacts:", error.message);
    return 0;
  }
  return picked.length;
}

/** House style for prep briefs: no em dashes, no markdown other than "-" bullets. */
export function cleanBrief(text: unknown): string {
  return String(text ?? "")
    .replace(/\s*—\s*/g, ", ")
    .replace(/\s–\s/g, ", ")
    .replace(/^#+\s*/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .trim();
}


/**
 * Finishes a queue row. Add-company rows also close their request with a readable note, and a failed or
 * skipped account gives its claim back so another week (or rep) can pick it up.
 */
export async function finishRow(
  row: QueueRow,
  status: "done" | "failed" | "skipped",
  fields: { error?: string | null; leads?: string[]; excluded?: string[]; note?: string },
): Promise<void> {
  const db = adminClient();
  const result = { leads: fields.leads?.length ?? 0, lead_ids: fields.leads ?? [], excluded: fields.excluded ?? [], note: fields.note ?? null };
  await db.from("research_queue").update({
    status, error: fields.error ?? null, result, lease_until: null, updated_at: nowISO(),
  }).eq("id", row.id);
  const p = row.payload ?? {};
  // A claim still only reserved for this row is given back (an exclusion set earlier stays in place).
  const claimKey = String(p.account_key || p.domain || "");
  if (status !== "done" && claimKey) {
    await db.from("account_claims").update({ status: "released", reason: String(fields.error ?? status).slice(0, 300) })
      .eq("domain", claimKey).eq("status", "reserved");
  }
  if (row.kind === "post_call_email" && status !== "done" && p.draft_id) {
    await db.from("email_drafts").update({
      status: "failed", error: String(fields.error ?? status).slice(0, 300), updated_at: nowISO(),
    }).eq("id", String(p.draft_id)).eq("status", "drafting");
  }
  if (row.kind === "prep_brief" && status !== "done" && p.meeting_id) {
    await db.from("meetings").update({ prep_status: "failed" }).eq("id", String(p.meeting_id)).eq("prep_status", "queued");
  }
  if (p.request_id) {
    const n = result.leads;
    const note = n
      ? `${n} lead${n > 1 ? "s" : ""} added.${fields.note ? " " + fields.note : ""}`
      : `No lead added. ${fields.error || fields.note || (fields.excluded?.length ? "Every contact failed the ICP." : "")}`.trim();
    await db.from("add_requests").update({
      status: n ? "done" : "failed",
      lead_ids: result.lead_ids,
      credits_used: p.credits ? String(p.credits) : null,
      note: note.slice(0, 1000),
    }).eq("id", String(p.request_id));
  }
}
