// Company research through Exa: one /answer call reads the company's site and recent coverage and returns a cited,
// structured profile (what they sell, an ICP check, website pain, GTM news). The result is shaped exactly like the
// Claude company-researcher's output so the worker reuses it as cached company research. When Exa's answer is thin,
// nothing is cached and the Claude worker researches the company as before.
import { fetchWithTimeout } from "./cors.ts";
import { getSecret } from "./secrets.ts";
import { adjacencyFor, DEFAULT_PROFILE, type SellerProfile } from "./profile.ts";

export interface ExaCompanyInput {
  company: string;
  domain: string;
  employee_range?: string | null;
  employees?: number | null;
  revenue_usd?: number | null;
  manual?: boolean;
}

export type ExaVerdict =
  | { kind: "research"; company: Record<string, unknown>; cost: number }
  | { kind: "exclude"; reason: string; source: string; company: Record<string, unknown>; cost: number }
  | { kind: "thin"; why: string; cost: number };

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["what_they_sell", "sells_to", "business_type", "segment", "hq", "icp_exclude", "exclude_reason", "exclude_source", "competitor_in_use", "competitor_source", "pain_points", "gtm_signals", "facts"],
  properties: {
    what_they_sell: { type: "string", description: "One sentence: the product and the buyer." },
    sells_to: { type: "string", enum: ["businesses", "consumers", "both", "unclear"] },
    business_type: {
      type: "string",
      enum: ["b2b_saas", "b2b_tech", "it_services", "agency", "dev_shop", "consumer", "education", "manufacturing", "hardware", "real_estate", "staffing", "market_research", "healthcare_saas", "dev_tools", "other", "unclear"],
    },
    segment: { type: "string", description: "Short label: what they sell and to whom, e.g. 'Spend management SaaS for mid-market finance teams'." },
    hq: { type: "string", description: "City, Country of headquarters, or empty if unknown." },
    icp_exclude: { type: "boolean", description: "True only when a source clearly shows the company fails the ICP rules." },
    exclude_reason: { type: "string" },
    exclude_source: { type: "string", description: "URL that shows why it fails; empty when not excluded." },
    competitor_in_use: { type: "string", description: "A named vendor the company uses that competes with the seller (see the system prompt), or empty." },
    competitor_source: { type: "string" },
    pain_points: {
      type: "array",
      description: "1 to 3 website conversion or demand generation problems.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["detail", "label", "source"],
        properties: {
          detail: { type: "string", description: "The specific finding, e.g. 'One Contact sales form serves four products and three regions'." },
          label: { type: "string", enum: ["confirmed", "inferred"] },
          source: { type: "string", description: "URL where it was seen for confirmed; empty for inferred." },
        },
      },
    },
    gtm_signals: {
      type: "array",
      description: "Up to 3 recent go-to-market events from the last 12 months: launches, funding, new regions, marketing leadership hires.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["detail", "source"],
        properties: { detail: { type: "string" }, source: { type: "string" } },
      },
    },
    facts: { type: "string", description: "Two or three sentences of confirmed facts a sales rep should know." },
  },
};

/** The research brief, built from the seller's profile. */
export function systemFor(p: SellerProfile): string {
  const ci = p.company_icp;
  const size = ci.min_employees || ci.max_employees ? `, roughly ${ci.min_employees ?? 1} to ${ci.max_employees ?? "any number of"} employees` : "";
  const never = [...new Set([...p.never_target, p.company_name])].join(", ");
  return `You research one company for ${p.company_name}'s outbound roster. ${p.product_summary}
Read the company's own website first (homepage, product, pricing, contact and demo pages), then recent news.
ICP: ${ci.description}${size}. Set icp_exclude true only with a source URL that clearly shows one of: ${ci.exclude.join(", ")}${
    p.competitor_categories.length ? `, or a vendor of ${p.competitor_categories.join(", ")}` : ""}. Also exclude ${never}. When unsure, do not exclude.
Pain points: problems on their website that hurt conversion, e.g. one generic Contact or Book a demo path for many
products, regions or buyer types; no product tour; long forms; gated content with no guidance. "confirmed" means you saw
it on a page and give that page URL. "inferred" must follow from a confirmed fact; source empty. Never invent numbers,
quotes or customers. Do not discuss website traffic. Write plainly, no em or en dashes.`;
}

const URL_RE = /^https?:\/\/\S+$/;
const clean = (v: unknown) => String(v ?? "").replace(/\s*[—–]\s*/g, ", ").replace(/\s+/g, " ").trim();
const url = (v: unknown) => {
  const s = String(v ?? "").trim();
  return URL_RE.test(s) ? s : "";
};


/** Shapes Exa's structured answer into the company block, and decides research / exclude / thin. */
// deno-lint-ignore no-explicit-any
export function toCompany(input: ExaCompanyInput, a: any, cites: string[], cost = 0, profile: SellerProfile = DEFAULT_PROFILE): ExaVerdict {
  if (!a || typeof a !== "object") return { kind: "thin", why: "no structured answer", cost };
  const seen = new Set(cites);
  // A confirmed pain point must cite a page; prefer pages Exa actually read, accept any URL it names.
  const pains = (Array.isArray(a.pain_points) ? a.pain_points : [])
    // deno-lint-ignore no-explicit-any
    .map((p: any) => {
      const detail = clean(p?.detail);
      const src = url(p?.source);
      const label = p?.label === "confirmed" && src ? "confirmed" : "inferred";
      return { detail, label, source: label === "confirmed" ? src : "" };
    })
    .filter((p: { detail: string }) => p.detail.length > 12)
    .slice(0, 3);
  const signals = (Array.isArray(a.gtm_signals) ? a.gtm_signals : [])
    // deno-lint-ignore no-explicit-any
    .map((g: any) => ({ detail: clean(g?.detail), source: url(g?.source) }))
    .filter((g: { detail: string; source: string }) => g.detail && g.source)
    .slice(0, 3);
  const segment = clean(a.segment);
  const name = clean(input.company);
  const blob = [name, input.domain, segment, a.what_they_sell].join(" ");
  const adjacency = adjacencyFor(profile, blob);
  const competitor = clean(a.competitor_in_use);
  const company = {
    name,
    domain: input.domain,
    segment,
    hq: clean(a.hq),
    employees: input.employee_range ? `${input.employee_range} (Apollo)` : input.employees ? `${input.employees} (Apollo)` : "",
    adjacency,
    competitive: competitor && url(a.competitor_source) ? `${competitor} (${url(a.competitor_source)})` : "No confirmed competitor evaluation",
    pain_points: pains,
    gtm_signals: signals,
    facts: clean(a.facts),
    source: "exa",
    exa_cited: [...seen].slice(0, 8),
  };

  const exSrc = url(a.exclude_source);
  if (a.icp_exclude === true && !input.manual) {
    if (!exSrc) return { kind: "thin", why: "exclusion without a source", cost };
    // IT services can still fit when revenue is $50M or more.
    if (a.business_type === "it_services" && Number(input.revenue_usd ?? 0) >= 50_000_000) {
      return { kind: "research", company, cost };
    }
    return { kind: "exclude", reason: clean(a.exclude_reason) || `fails ICP (${a.business_type})`, source: exSrc, company, cost };
  }
  const confirmed = pains.some((p: { label: string }) => p.label === "confirmed");
  if (!segment || a.sells_to === "unclear") return { kind: "thin", why: "could not tell what they sell", cost };
  if (!confirmed && !signals.length) return { kind: "thin", why: "no sourced pain point or GTM signal", cost };
  return { kind: "research", company, cost };
}

/** Researches one company with Exa. Throws only on transport or auth errors; a weak answer comes back as "thin". */
export async function exaCompany(input: ExaCompanyInput, profile: SellerProfile = DEFAULT_PROFILE): Promise<ExaVerdict> {
  const key = await getSecret("int_exa_key");
  if (!key) throw new Error("Exa isn't connected");
  const size = input.employee_range || (input.employees ? String(input.employees) : "unknown");
  const query =
    `Research ${input.company} (${input.domain}), about ${size} employees. What do they sell and to whom? Do they fit this ` +
    `ICP: ${profile.company_icp.description} What problems on their website make it hard for B2B buyers to find the right product or talk to sales? ` +
    `Any go-to-market news in the last 12 months?`;
  const r = await fetchWithTimeout("https://api.exa.ai/answer", {
    method: "POST",
    headers: { "x-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({ query, model: "exa", systemPrompt: systemFor(profile), outputSchema: SCHEMA, text: false }),
  }, 90_000);
  const t = await r.text();
  if (!r.ok) {
    const msg = r.status === 402 ? "Exa is out of credits" : r.status === 401 || r.status === 403 ? "Exa rejected the key" : `Exa ${r.status}: ${t.slice(0, 200)}`;
    throw new Error(msg);
  }
  // deno-lint-ignore no-explicit-any
  let d: any = {};
  try {
    d = JSON.parse(t);
  } catch {
    return { kind: "thin", why: "unreadable Exa response", cost: 0 };
  }
  // deno-lint-ignore no-explicit-any
  const cites = (Array.isArray(d.citations) ? d.citations : []).map((c: any) => String(c?.url ?? "")).filter(Boolean);
  const answer = typeof d.answer === "string" ? (() => { try { return JSON.parse(d.answer); } catch { return null; } })() : d.answer;
  return toCompany(input, answer, cites, Number(d.costDollars?.total ?? 0), profile);
}
