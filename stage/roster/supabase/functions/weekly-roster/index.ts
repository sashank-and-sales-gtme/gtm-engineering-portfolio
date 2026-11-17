// Cron (Fri 14:30 UTC = Fri 20:00 IST). Builds next Monday's batch: for every rep in the rotation, a set of
// accounts inside that rep's segment, each reserved to that rep alone, queued for the CRM gate and then the
// Claude worker. Apollo people search is free; organization search (1 credit per 100 companies) runs only
// for reps whose segment filters on funding.
//
// POST {}                      fan out: archive stale leads, queue "next batch" add-company requests, one run per rep
// POST {rep_id, batch?}        build one rep's batch (called by the fan-out, or from Admin to top a rep up)
import { errMsg, HttpError, json, readJson, serve } from "../_shared/cors.ts";
import { adminClient, audit, coName, invokeInternal, cronFanOut, requireCron } from "../_shared/supabase.ts";
import {
  type ApolloPerson,
  KEYWORD_VARIANTS,
  orgDomain,
  orgSearch,
  peopleSearch,
  personDomain,
  personName,
} from "../_shared/apollo.ts";
import { isAlwaysExcluded, nextMondayIST } from "../_shared/icp.ts";
import { loadProfile, setupDone } from "../_shared/profile_store.ts";
import { loadIcp, locationLabel, seniorEnoughWith, titlesFor, titleScopeWith, weeklyTitles } from "../_shared/icp_config.ts";
import { normDomain, type Rep, reserveAccount, rosterSettings, rotationReps } from "../_shared/roster.ts";

const TIME_BUDGET_MS = 120_000;
const MAX_PAGES_PER_VARIANT = 5;
const MAX_ORG_PAGES = 6;

serve(async (req) => {
  requireCron(req);
  const opts = await readJson<{ rep_id?: string; batch?: string } & { workspace_id?: string }>(req);
  return await cronFanOut("weekly-roster", opts, () => run(opts));
});

async function run(opts: { rep_id?: string; batch?: string }): Promise<Response> {
  const batch = opts.batch || nextMondayIST();
  if (!(await setupDone())) {
    await audit(null, "weekly_roster.run", batch, "skipped: Admin > Setup isn't finished yet");
    return json({ ok: true, batch, skipped: "setup" });
  }
  if (opts.rep_id) return json(await buildForRep(String(opts.rep_id), batch));

  const db = adminClient();
  const s = await rosterSettings();
  const { data: archived, error: ae } = await db.rpc("archive_stale_leads", { p_days: s.archive_after_days });
  const reps = await rotationReps();
  const adds = await queueAddRequests(batch);
  for (const rep of reps) await invokeInternal("weekly-roster", { rep_id: rep.user_id, batch }, 700);
  await audit(null, "weekly_roster.run", batch, `${reps.length} reps, ${adds} add requests, ${ae ? "archive failed" : `${archived ?? 0} leads archived`}`);
  return json({ ok: true, batch, reps: reps.map((r) => r.email), add_requests: adds, archived: archived ?? 0 });
}

interface Account {
  key: string;
  domain: string;
  company: string;
  people: { key: string; id: string; name: string; title: string; linkedin: string; location_hint?: string }[];
  employees: number | null;
  revenue: number | null;
  funding: number | null;
}

async function buildForRep(repId: string, batch: string) {
  const started = Date.now();
  const db = adminClient();
  const [s, icp, profile] = await Promise.all([rosterSettings(), loadIcp(), loadProfile()]);
  const rep = (await rotationReps()).find((r) => r.user_id === repId);
  if (!rep) throw new HttpError(404, "That person is not in the weekly rotation");

  // Only accounts still in play count against the target: in the CRM check, held in reserve, with the worker,
  // or researched with at least one lead. Excluded and failed accounts don't, so Build now can top a short batch up.
  const { data: rows } = await db.from("research_queue").select("status,result,payload")
    .eq("rep_id", repId).eq("batch", batch).eq("kind", "account");
  const already = (rows ?? []).filter((r) =>
    !r.payload?.manual && !r.payload?.followup &&
    (["gating", "held", "pending", "running"].includes(r.status) || (r.status === "done" && Number(r.result?.leads ?? 0) > 0))
  ).length;
  const target = Math.ceil(rep.weekly_accounts * s.overprovision) - already;
  const summary = { rep: rep.email, batch, target, searches: 0, org_pages: 0, accounts: 0, skipped_taken: 0, skipped_known: 0, errors: [] as string[] };
  if (target <= 0) return { ok: true, ...summary, note: "batch already full" };

  const known = await knownCompanies();
  const range = employeeRange(rep);
  const perAccount = s.contacts_per_account + 1; // one spare for contacts the CRM gate drops
  const accounts = new Map<string, Account>();
  const outOfTime = () => Date.now() - started > TIME_BUDGET_MS;

  const take = async (p: ApolloPerson, domainHint = "", orgHint: { employees?: number; revenue?: number; funding?: number } = {}) => {
    const company = p.organization?.name ?? "";
    const name = personName(p);
    if (!p.id || !company || !name || !seniorEnoughWith(icp, p.title ?? "") || isAlwaysExcluded(company, profile)) return;
    const domain = normDomain(domainHint || personDomain(p));
    const orgId = String(p.organization_id ?? p.organization?.id ?? "");
    const key = domain || (orgId ? `apollo-org:${orgId}` : `name:${coName(company).toLowerCase()}`);
    let a = accounts.get(key);
    if (!a) {
      if (accounts.size >= target) return;
      const co = coName(company).toLowerCase();
      if (known.has(co) || known.has(key)) {
        summary.skipped_known++;
        return;
      }
      if (!(await reserveAccount(key, company, repId, batch))) {
        summary.skipped_taken++;
        known.add(co);
        return;
      }
      a = { key, domain, company, people: [], employees: orgHint.employees ?? p.organization?.estimated_num_employees ?? null, revenue: orgHint.revenue ?? null, funding: orgHint.funding ?? null };
      accounts.set(key, a);
    }
    if (a.people.length < perAccount && !a.people.some((x) => x.id === p.id)) {
      a.people.push({ key: `p${a.people.length + 1}`, id: p.id, name, title: p.title ?? "", linkedin: p.linkedin_url ?? "", location_hint: `${locationLabel(icp)} (matched Apollo's location filter)` });
    }
  };

  try {
    if (rep.funding_min != null || rep.funding_max != null) {
      // Funding filter: find companies first (credits), then their people (free).
      for (let page = 1; page <= MAX_ORG_PAGES && accounts.size < target && !outOfTime(); page++) {
        const { orgs } = await orgSearch({
          employeeRanges: [range], revenueMin: rep.revenue_min, revenueMax: rep.revenue_max,
          fundingMin: rep.funding_min, fundingMax: rep.funding_max, page,
        });
        summary.org_pages++;
        const fresh = orgs.filter((o) => o.id && o.name && !known.has(coName(o.name).toLowerCase()) && !known.has(orgDomain(o)));
        for (let i = 0; i < fresh.length && accounts.size < target && !outOfTime(); i += 25) {
          const chunk = fresh.slice(i, i + 25);
          const byId = new Map(chunk.map((o) => [o.id, o]));
          const res = await peopleSearch({ organizationIds: chunk.map((o) => o.id), titles: weeklyTitles(icp), seniorities: icp.apollo_seniorities, locations: icp.locations, perPage: 100 });
          summary.searches++;
          for (const p of res.people) {
            const o = byId.get(String(p.organization_id ?? p.organization?.id ?? ""));
            await take(p, o ? orgDomain(o) : "", o ? { employees: o.estimated_num_employees, revenue: o.annual_revenue, funding: o.total_funding } : {});
          }
        }
        if (orgs.length < 100) break;
      }
    } else {
      outer:
      for (const tags of KEYWORD_VARIANTS) {
        for (let page = 1; page <= MAX_PAGES_PER_VARIANT; page++) {
          if (accounts.size >= target || outOfTime()) break outer;
          const res = await peopleSearch({
            titles: weeklyTitles(icp), seniorities: icp.apollo_seniorities, locations: icp.locations, employeeRanges: [range],
            revenueMin: rep.revenue_min, revenueMax: rep.revenue_max, keywordTags: tags, page, perPage: 100,
          });
          summary.searches++;
          for (const p of res.people) await take(p);
          if (res.people.length < 100) break;
        }
      }
    }
  } catch (e) {
    summary.errors.push(errMsg(e).slice(0, 200));
  }

  const queue = [...accounts.values()].filter((a) => a.people.length).map((a) => ({
    kind: "account",
    status: "gating",
    batch,
    rep_id: repId,
    priority: 5,
    domain: a.domain || null,
    payload: {
      account_key: a.key, domain: a.domain, company: a.company, people: a.people, manual: false, enrich: false,
      employee_range: range.replace(",", "-"), employees: a.employees, revenue: a.revenue, funding: a.funding,
      title_scope: titleScopeWith(icp, a.people[0]?.title ?? ""),
    },
  }));
  for (let i = 0; i < queue.length; i += 200) {
    const { error } = await db.from("research_queue").insert(queue.slice(i, i + 200));
    if (error) summary.errors.push(`queue insert: ${error.message.slice(0, 150)}`);
  }
  summary.accounts = queue.length;
  await audit(null, "weekly_roster.rep", rep.email, `${queue.length} accounts queued for ${batch} (target ${target})`);
  if (queue.length) await invokeInternal("queue-gate", { source: "weekly-roster" }, 500);
  return { ok: true, ...summary, ms: Date.now() - started };
}

/** Apollo employee range for the rep's segment, defaulting to the ICP band. */
function employeeRange(rep: Rep): string {
  const min = rep.employees_min ?? 250;
  const max = rep.employees_max ?? 2500;
  return `${min},${max}`;
}

/** Company names and domains already on the roster or held by any claim that is not free. */
async function knownCompanies(): Promise<Set<string>> {
  const db = adminClient();
  const out = new Set<string>();
  for (let from = 0;; from += 1000) {
    // Archived leads don't block their account (its claim was released); the CRM gate still drops the same people.
    const { data, error } = await db.from("leads").select("company,domain").eq("archived", false).range(from, from + 999);
    if (error) throw new Error("Could not read leads");
    for (const l of data ?? []) {
      const co = coName(l.company).toLowerCase();
      if (co) out.add(co);
      if (l.domain) out.add(normDomain(l.domain));
    }
    if (!data || data.length < 1000) break;
  }
  const now = Date.now();
  for (let from = 0;; from += 1000) {
    const { data } = await db.from("account_claims").select("domain,company,status,expires_at").neq("status", "released").range(from, from + 999);
    for (const c of data ?? []) {
      if (c.status === "excluded" && c.expires_at && Date.parse(c.expires_at) < now) continue;
      out.add(c.domain);
      if (c.company) out.add(coName(c.company).toLowerCase());
    }
    if (!data || data.length < 1000) break;
  }
  return out;
}

/** "Next batch" add-company requests join their owner's batch with top priority. */
async function queueAddRequests(batch: string): Promise<number> {
  const icp = await loadIcp();
  const db = adminClient();
  const { data: reqs } = await db.from("add_requests").select("*").eq("status", "queued").order("created_at");
  let n = 0;
  for (const r of reqs ?? []) {
    try {
      const domain = normDomain(r.domain);
      let people: { key: string; id?: string; name: string; title: string; linkedin: string; location_hint?: string }[] = [];
      if (r.contact?.name) {
        people = [{ key: "p1", name: r.contact.name, title: r.contact.title ?? "", linkedin: r.contact.linkedin ?? "" }];
      } else {
        const res = await peopleSearch({ domains: [domain], titles: titlesFor(icp, "add_company"), seniorities: icp.apollo_seniorities, locations: icp.locations, perPage: 25 });
        people = res.people.filter((p) => seniorEnoughWith(icp, p.title ?? "")).slice(0, 3)
          .map((p, i) => ({ key: `p${i + 1}`, id: p.id, name: personName(p), title: p.title ?? "", linkedin: p.linkedin_url ?? "", location_hint: `${locationLabel(icp)} (matched Apollo's location filter)` }));
      }
      if (!people.length) {
        await db.from("add_requests").update({ status: "failed", note: `No ${locationLabel(icp)} contact matching the ICP personas found in Apollo for this domain.` }).eq("id", r.id);
        continue;
      }
      if (!(await reserveAccount(domain, r.company, r.owner, batch))) {
        const { data: c } = await db.from("account_claims").select("rep_id,status").eq("domain", domain).maybeSingle();
        const { data: who } = c?.rep_id ? await db.from("profiles").select("full_name,email").eq("id", c.rep_id).maybeSingle() : { data: null };
        await db.from("add_requests").update({
          status: "failed",
          note: c?.status === "excluded" ? "This account failed the ICP or CRM check recently." : `This account already belongs to ${who?.full_name || who?.email || "another rep"}.`,
        }).eq("id", r.id);
        continue;
      }
      const { error } = await db.from("research_queue").insert({
        kind: "account", status: "gating", batch, rep_id: r.owner, priority: 1, domain,
        payload: { request_id: r.id, account_key: domain, domain, company: r.company, people, manual: true, enrich: false, owner: r.owner },
      });
      if (error) throw new Error(error.message);
      await db.from("add_requests").update({ status: "enriching", picked: people, note: `In the ${batch} batch. Waiting for the Claude worker.` }).eq("id", r.id);
      n++;
    } catch (e) {
      await db.from("add_requests").update({ note: `Could not queue: ${errMsg(e).slice(0, 200)}` }).eq("id", r.id);
    }
  }
  return n;
}
