// POST {request_id}: drives an add_requests row.
//   status 'searching' -> free Apollo people search on the domain -> candidates, status 'pick'
//   mode 'more' (Find more ICPs, from a Wrong ICP call) searches an account already on the roster: people already
//   there are left out of the candidates, and the account claim is not re-checked.
//   status 'enriching' -> one research_queue row for the account (CRM gate + enrichment in queue-gate, then the
//                         Claude worker researches it at top priority)
import { errMsg, HttpError, json, readJson, serve } from "../_shared/cors.ts";
import { adminClient, audit, getCaller, invokeInternal, requirePerm } from "../_shared/supabase.ts";
import { peopleSearch, personDomain, personName } from "../_shared/apollo.ts";
import { loadIcp, locationLabel, seniorEnoughWith, titlesFor } from "../_shared/icp_config.ts";
import { normDomain, reserveAccount } from "../_shared/roster.ts";

serve(async (req) => {
  if (req.method !== "POST") throw new HttpError(405, "Use POST");
  const caller = await getCaller(req);
  requirePerm(caller, "add_company");
  const { request_id } = await readJson<{ request_id?: string }>(req);
  if (!request_id) throw new HttpError(400, "request_id is required");

  const db = adminClient();
  const { data: r, error } = await db.from("add_requests").select("*").eq("id", request_id).maybeSingle();
  if (error) throw new HttpError(500, "Could not load the request");
  if (!r) throw new HttpError(404, "Request not found");
  // Super admins and admins can run anyone's request; the account and leads still go to the request's owner.
  const forOther = r.owner !== caller.id;
  if (forOther && !(caller.role === "super_admin" || caller.role === "admin" || caller.can("manage_users"))) {
    throw new HttpError(403, "You can only run your own add-company requests");
  }
  const onBehalf = forOther ? ` (for ${r.owner})` : "";
  // Contacts typed in by hand (no Apollo id) only need add_company: a fallback for when the Apollo search fails.
  const picked0: Record<string, unknown>[] = Array.isArray(r.picked) ? r.picked : [];
  const manualOnly = r.status === "enriching" && picked0.length > 0 && picked0.every((x) => !x?.id);
  if (r.status === "searching" || (r.status === "enriching" && !manualOnly)) requirePerm(caller, "enrich_now");

  if (r.status === "searching") {
    try {
      const icp = await loadIcp();
      const loc = locationLabel(icp);
      const { people } = await peopleSearch({
        domains: [r.domain],
        titles: titlesFor(icp, r.mode === "more" ? "find_more" : "add_company"),
        seniorities: icp.apollo_seniorities,
        locations: icp.locations,
        perPage: 25,
      });
      // For "Find more ICPs", leave out people already on the roster at this account (names may be masked).
      const onRoster: Array<{ first: string; last: string; li: string }> = [];
      if (r.mode === "more") {
        const [{ data: byDomain }, { data: byName }] = await Promise.all([
          db.from("leads").select("name,linkedin").eq("domain", normDomain(r.domain)),
          db.from("leads").select("name,linkedin").ilike("company", r.company),
        ]);
        for (const l of [...(byDomain ?? []), ...(byName ?? [])]) {
          const w = String(l.name || "").toLowerCase().split(/\s+/);
          onRoster.push({ first: w[0] || "", last: (w[w.length - 1] || "")[0] || "", li: String(l.linkedin || "").toLowerCase().replace(/\/+$/, "") });
        }
      }
      const known = (name: string, li: string) => {
        const w = name.toLowerCase().split(/\s+/);
        const l2 = li.toLowerCase().replace(/\/+$/, "");
        return onRoster.some((o) => (l2 && o.li && o.li === l2) || (o.first === w[0] && (!o.last || !w[1] || o.last === (w[w.length - 1] || "")[0])));
      };
      const candidates = people
        .filter((p) => seniorEnoughWith(icp, p.title ?? ""))
        .filter((p) => !known(personName(p), p.linkedin_url ?? ""))
        .map((p) => ({
          id: p.id,
          name: personName(p),
          title: p.title ?? "",
          linkedin: p.linkedin_url ?? "",
          location_hint: `${loc} (matched Apollo's location filter)`,
          company: p.organization?.name ?? r.company,
          domain: personDomain(p) || r.domain,
        }));
      const note = candidates.length
        ? `${candidates.length} ${r.mode === "more" ? "more " : ""}${loc} ICP contact${candidates.length > 1 ? "s" : ""} found in Apollo. Pick who to enrich.`
        : r.mode === "more"
        ? `Apollo has no other ${loc} contact matching the ICP personas at this domain. Add a contact by name instead.`
        : `Apollo has no ${loc} contact matching the ICP personas at this domain. Add a contact by name instead.`;
      await db.from("add_requests").update({ status: candidates.length ? "pick" : "failed", candidates, note }).eq("id", r.id);
      await audit(caller.id, "add_company.search", r.company, `${candidates.length} candidates${onBehalf}`);
      return json({ ok: true, status: candidates.length ? "pick" : "failed", candidates: candidates.length });
    } catch (e) {
      const note = `Apollo search failed: ${errMsg(e).slice(0, 200)}`;
      await db.from("add_requests").update({ status: "failed", note }).eq("id", r.id);
      return json({ ok: false, status: "failed", error: note }, 502);
    }
  }

  if (r.status === "enriching") {
    const picked: Record<string, string>[] = Array.isArray(r.picked) ? r.picked : [];
    if (!picked.length) throw new HttpError(400, "Pick at least one contact first");
    const domain = normDomain(r.domain);
    const { data: existing } = await db.from("research_queue").select("id").eq("kind", "add_request")
      .contains("payload", { request_id: r.id }).in("status", ["gating", "pending", "running"]);
    if (!existing?.length) {
      if (r.mode !== "more" && !(await reserveAccount(domain, r.company, r.owner, `manual-${r.id}`))) {
        const { data: c } = await db.from("account_claims").select("rep_id,status,batch").eq("domain", domain).maybeSingle();
        if (!(c?.rep_id === r.owner && c?.status !== "excluded")) {
          const { data: who } = c?.rep_id ? await db.from("profiles").select("full_name,email").eq("id", c.rep_id).maybeSingle() : { data: null };
          const note = c?.status === "excluded"
            ? "This account failed the ICP or CRM check recently, so it was not researched again."
            : `This account already belongs to ${who?.full_name || who?.email || "another rep"}.`;
          await db.from("add_requests").update({ status: "failed", note }).eq("id", r.id);
          return json({ ok: false, status: "failed", error: note }, 409);
        }
      }
      const people = picked.map((person, i) => ({ ...person, key: `p${i + 1}` }));
      const { error: qe } = await db.from("research_queue").insert({
        kind: "add_request",
        status: "gating",
        batch: null,
        rep_id: r.owner,
        priority: 1,
        domain,
        payload: { request_id: r.id, account_key: domain, domain, company: r.company, people, manual: true, enrich: true, owner: r.owner },
      });
      if (qe) throw new HttpError(500, "Could not queue the research");
    }
    await db.from("add_requests").update({
      note: `Checking HubSpot and enriching ${picked.length} contact${picked.length > 1 ? "s" : ""}. Research runs on the next Claude worker pass.`,
    }).eq("id", r.id);
    await audit(caller.id, "add_company.enrich", r.company, `${picked.length} contacts${onBehalf}`);
    await invokeInternal("queue-gate", { source: "add-company" }, 1500);
    return json({ ok: true, status: "enriching" });
  }

  return json({ ok: true, status: r.status, note: "Nothing to do for this status" });
});
