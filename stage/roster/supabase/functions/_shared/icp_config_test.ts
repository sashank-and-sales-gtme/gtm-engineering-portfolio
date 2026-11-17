import { acceptsTitle, DEFAULT_ICP, icpBrief, normalizeIcp, scopeKeys, seniorEnoughWith, titleScopeWith, titlesFor, weeklyTitles } from "./icp_config.ts";
import { validateLead } from "./icp.ts";
import { proofTexts } from "./profile.ts";
import { SAMPLE_PROFILE } from "./sample_profile.ts";

function eq(a: unknown, b: unknown) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

Deno.test("defaults keep the original seniority rule", () => {
  const c = normalizeIcp(null);
  eq(seniorEnoughWith(c, "Head of Demand Generation"), true);
  eq(seniorEnoughWith(c, "AVP Marketing"), true);
  eq(seniorEnoughWith(c, "CMO"), true);
  eq(seniorEnoughWith(c, "Marketing Manager"), false);
  eq(seniorEnoughWith(c, "VP, Product Manager"), false);
  eq(seniorEnoughWith(c, "Senior Manager and Head of Growth"), true);
  eq(seniorEnoughWith(c, "Senior Associate"), false);
});

Deno.test("defaults keep the original title scopes and Apollo titles", () => {
  const c = normalizeIcp(undefined);
  eq(titleScopeWith(c, "Director, Demand Gen"), "demand_gen");
  eq(titleScopeWith(c, "VP Growth Marketing"), "growth");
  eq(titleScopeWith(c, "Head of Performance Marketing"), "digital");
  eq(titleScopeWith(c, "CMO"), "general");
  eq(weeklyTitles(c).length, 12);
  eq(titlesFor(c, "add_company").length, 16);
  eq(c.personas.filter((p) => p.fallback).map((p) => p.key), ["general"]);
  eq(scopeKeys(c), ["demand_gen", "growth", "digital", "general"]);
});

Deno.test("admin personas drive scopes, titles and validation", () => {
  const c = normalizeIcp({
    locations: ["India", "Singapore"],
    personas: [
      { name: "Sales leader", match: ["sales", "revenue"], apollo_titles: ["VP Sales"], proof_points: ["audit prep cut from 6 weeks to 2"] },
      { name: "Demand Gen", key: "demand_gen", match: ["demand"], apollo_titles: ["head of demand generation"], active: false },
      { name: "Sales leader", match: ["dupe"] },
      { name: "" },
    ],
  }, proofTexts(SAMPLE_PROFILE));
  eq(c.personas.map((p) => p.key), ["sales_leader", "demand_gen"]);
  eq(titleScopeWith(c, "Chief Revenue Officer"), "sales_leader");
  eq(titleScopeWith(c, "Head of Demand Gen"), "general"); // inactive persona, no fallback persona
  eq(weeklyTitles(c), ["vp sales"]);
  eq(scopeKeys(c), ["sales_leader", "general"]);
  eq(icpBrief(c).personas[0].proof_points, ["audit prep cut from 6 weeks to 2"]);
  const pp = { sales_leader: ["audit prep cut from 6 weeks to 2"] };
  const lead = {
    name: "A", title: "VP Sales", company: "X", tier: "B", fit_reason: "f", status_check: "unconfirmed", persona: "Sales",
    angle: "Short angle.", proof_point: "close in 3 days instead of 9", title_scope: "sales_leader", pain_points: [],
  };
  const errs = validateLead(lead, false, { scopes: scopeKeys(c), proofPointsByScope: pp, profile: SAMPLE_PROFILE });
  eq(errs.some((e) => e.startsWith("proof_point for sales_leader")), true);
  eq(validateLead({ ...lead, proof_point: "audit prep cut from 6 weeks to 2" }, false, { scopes: scopeKeys(c), proofPointsByScope: pp, profile: SAMPLE_PROFILE }), []);
  eq(validateLead({ ...lead, title_scope: "growth" }, false, { scopes: scopeKeys(c) }).some((e) => e.startsWith("title_scope")), true);
});

Deno.test("all personas inactive falls back to defaults", () => {
  const c = normalizeIcp({ personas: [{ name: "X", active: false }] });
  eq(c.personas, DEFAULT_ICP.personas);
});

Deno.test("fallback and triggers are explicit settings", () => {
  const c = normalizeIcp({
    personas: [
      { name: "Growth", match: ["growth"], apollo_titles: ["head of growth"], triggers: ["weekly"] },
      { name: "Marketing head", match: ["marketing"], apollo_titles: ["cmo"], fallback: true, triggers: ["find_more", "suggestions"] },
      { name: "Other", match: [], apollo_titles: ["x"], fallback: true, triggers: ["add_company", "find_more"] },
    ],
  });
  eq(c.personas.map((p) => p.fallback), [false, true, false]); // one fallback, first flagged wins
  eq(titleScopeWith(c, "Head of Sales"), "marketing_head");
  eq(titleScopeWith(c, "VP Growth"), "growth");
  eq(titlesFor(c, "weekly"), ["head of growth"]);
  eq(titlesFor(c, "add_company"), ["x"]);
  eq(titlesFor(c, "find_more"), ["cmo", "x"]);
  eq(acceptsTitle(c, "suggestions", "VP Growth"), false);
  eq(acceptsTitle(c, "suggestions", "CMO"), true);
  // Old saved configs: weekly false means every event but the weekly build; no title words means fallback.
  const old = normalizeIcp({ personas: [{ name: "A", match: ["a"], apollo_titles: ["a"], weekly: false }, { name: "B", apollo_titles: ["b"] }] });
  eq(old.personas[0].triggers, ["add_company", "find_more", "suggestions"]);
  eq(old.personas[1].fallback, true);
});
