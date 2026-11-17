// Run: deno test roster/supabase/functions/_shared/profile_test.ts
import { adjacencyFor, DEFAULT_PROFILE, isNeverTarget, normalizeProfile, profileReady, proofTexts, sellerBrief } from "./profile.ts";
import { scanCopy, validateLead } from "./icp.ts";
import { normalizeIcp } from "./icp_config.ts";
import { assemble, checkDraft } from "./postcall_lib.ts";
import { toCompany } from "./exa.ts";
import { SAMPLE_PROFILE } from "./sample_profile.ts";

function assertEquals(a: unknown, b: unknown) {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error(`${x} !== ${y}`);
}
function assert(ok: unknown, msg = "assertion failed") {
  if (!ok) throw new Error(msg);
}

const acme = normalizeProfile({ ...SAMPLE_PROFILE, proof_points: SAMPLE_PROFILE.proof_points.slice(0, 1) });

Deno.test("an empty profile is the default seller", () => {
  assertEquals(normalizeProfile(null), DEFAULT_PROFILE);
  assertEquals(normalizeProfile({ proof_points: [] }).proof_points, DEFAULT_PROFILE.proof_points);
});

Deno.test("nothing is researched until Setup saves a profile", () => {
  assert(!profileReady(DEFAULT_PROFILE));
  assert(!profileReady(normalizeProfile({ company_name: "Acme Ledger" })));
  assert(profileReady(acme));
});

Deno.test("normalizeProfile keeps what was saved and drops malformed entries", () => {
  const p = normalizeProfile({ ...acme, customers: [{ name: "" }, { name: "Ok", url: "not a url" }], booking_link: "javascript:alert(1)" });
  assertEquals(p.customers, [{ name: "Ok", url: "", live_instance: false }]);
  assertEquals(p.booking_link, "");
  assertEquals(proofTexts(acme), ["close in 3 days instead of 9"]);
});

Deno.test("validateLead checks the proof point against the saved library", () => {
  const lead = {
    name: "A", title: "CFO", company: "Globex", tier: "B", fit_reason: "x", status_check: "unconfirmed", persona: "p",
    angle: "Globex closes in nine days today.", proof_point: "close in 3 days instead of 9", title_scope: "general", pain_points: [],
  };
  assertEquals(validateLead(lead, false, { profile: acme }), []);
  assert(validateLead(lead, false).some((e) => e.startsWith("proof_point must be one of")));
});

Deno.test("scanCopy uses the seller's banned words", () => {
  assertEquals(scanCopy("More synergy for Globex.", acme), ['uses banned word "synergy"']);
  assertEquals(scanCopy("A seamless close for Globex.", acme), []);
  assert(scanCopy("A seamless close for Globex.").includes('uses banned word "seamless"'));
});

Deno.test("never-target covers the seller, its customers and the list", () => {
  for (const c of ["Acme Ledger", "Northwind Traders", "Initech"]) assert(isNeverTarget(acme, c), c);
  assert(!isNeverTarget(acme, "Globex"));
  assert(!isNeverTarget(DEFAULT_PROFILE, "Globex"));
});

Deno.test("adjacency hooks come from the profile", () => {
  assertEquals(adjacencyFor(acme, "Fabrikam fabrikam.com"), "Northwind already runs Acme Ledger");
  assertEquals(adjacencyFor(acme, "Drata"), "none");
  const v = toCompany({ company: "Fabrikam", domain: "fabrikam.com" }, {
    segment: "ERP for retailers", sells_to: "businesses", business_type: "b2b_saas", hq: "", icp_exclude: false, facts: "",
    pain_points: [{ detail: "One demo form for every product line", label: "confirmed", source: "https://fabrikam.com" }], gtm_signals: [],
  }, [], 0, acme);
  assertEquals(v.kind === "research" && v.company.adjacency, "Northwind already runs Acme Ledger");
});

Deno.test("persona proof points are kept when they are in the seller's library", () => {
  const icp = normalizeIcp({ personas: [{ name: "Finance", match: ["finance"], apollo_titles: ["cfo"], proof_points: ["close in 3 days instead of 9"] }] }, proofTexts(acme));
  assertEquals(icp.personas[0].proof_points, ["close in 3 days instead of 9"]);
  assertEquals(normalizeIcp(icp).personas[0].proof_points, []);
});

Deno.test("email briefs carry the seller's overview and live instances", () => {
  const r = assemble({ format: "brief", greeting: "Hi", opening: "o", company: "c", ask: "a", signoff: "s" }, "Globex", acme);
  assert(r.body.includes("Acme Ledger automates the month-end close."));
  assert(r.body.includes("**How Acme Ledger can help Globex:**"));
  assert(r.body.includes("Northwind - [Here](https://northwind.example)") && !r.body.includes("Contoso"));
  const c = checkDraft({ format: "note", subject: "your close", greeting: "Hi", core: "Our spreadsheet fixes it.", ask: "a", signoff: "s" }, "Globex", undefined, acme);
  assert(c.style.some((s) => s.includes('"spreadsheet"')));
});

Deno.test("sellerBrief lists everything never to target once", () => {
  const b = sellerBrief(acme);
  assertEquals(b.never_target, ["Initech", "Acme Ledger", "Northwind", "Contoso"]);
  assertEquals(b.company_icp.size, "any size");
});
