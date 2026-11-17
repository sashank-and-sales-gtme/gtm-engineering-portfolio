// Run: deno test roster/supabase/functions/_shared/exa_test.ts
import { toCompany } from "./exa.ts";
import { SAMPLE_PROFILE } from "./sample_profile.ts";

function assertEquals(a: unknown, b: unknown) {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error(`${x} !== ${y}`);
}
const base = {
  what_they_sell: "Spend management software for finance teams", sells_to: "businesses", business_type: "b2b_saas",
  segment: "Spend management SaaS for mid-market finance teams", hq: "Bengaluru, India", icp_exclude: false, exclude_reason: "",
  exclude_source: "", competitor_in_use: "", competitor_source: "",
  pain_points: [{ detail: "One Book a demo form serves three products and four regions", label: "confirmed", source: "https://acme.com/demo" }],
  gtm_signals: [], facts: "Raised a Series C in 2026 — expanding to the US.",
};
const input = { company: "Acme", domain: "acme.com", employee_range: "501-1000" };

Deno.test("a sourced profile becomes cached company research in the worker's shape", () => {
  const v = toCompany(input, base, ["https://acme.com/demo"]);
  assertEquals(v.kind, "research");
  if (v.kind !== "research") return;
  assertEquals(v.company.employees, "501-1000 (Apollo)");
  assertEquals(v.company.adjacency, "none");
  assertEquals((v.company.facts as string).includes("—"), false);
});
Deno.test("a confirmed pain point without a URL is downgraded, and nothing sourced means thin", () => {
  const v = toCompany(input, { ...base, pain_points: [{ detail: "Long contact form with eleven fields", label: "confirmed", source: "" }] }, []);
  assertEquals(v.kind, "thin");
});
Deno.test("exclusions need a source and never apply to manual adds", () => {
  const ex = { ...base, icp_exclude: true, business_type: "consumer", exclude_reason: "Consumer app", exclude_source: "https://acme.com" };
  assertEquals(toCompany(input, ex, []).kind, "exclude");
  assertEquals(toCompany(input, { ...ex, exclude_source: "" }, []).kind, "thin");
  assertEquals(toCompany({ ...input, manual: true }, ex, []).kind, "research");
});
Deno.test("IT services with $50M+ revenue stay in research", () => {
  const ex = { ...base, icp_exclude: true, business_type: "it_services", exclude_reason: "IT services", exclude_source: "https://acme.com" };
  assertEquals(toCompany({ ...input, revenue_usd: 80_000_000 }, ex, []).kind, "research");
});
Deno.test("adjacency hooks follow the customer competitor list", () => {
  const v = toCompany({ ...input, company: "Fabrikam" }, base, [], 0, SAMPLE_PROFILE);
  assertEquals(v.kind === "research" && v.company.adjacency, "Northwind already runs Acme Ledger");
});
