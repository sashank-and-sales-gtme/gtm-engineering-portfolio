// The seller's profile: who is selling, what they sell, the proof they may quote and the house style. Admins fill it
// in the onboarding wizard (app_settings key 'profile'); the defaults below are empty and fill any field left out.
// The researchers, the post-call and prep writers and the validators all read it from
// here, so nothing about the seller is hard-coded in prompts or checks. Pure (no I/O); profile_store.ts loads it.

export interface ProofPoint {
  /** Quoted verbatim by researchers and writers, so the validator can match it exactly. */
  text: string;
  /** Whose result it is ("Acme Corp"). */
  customer: string;
  /** When it fits: "pipeline or demo volume", "traffic that doesn't convert". */
  use_when: string;
  /** Case study to link in emails, if any. */
  link: string;
}

export interface Customer {
  name: string;
  url: string;
  /** Prospects can see the product live on this customer's site. */
  live_instance: boolean;
}

export interface Adjacency {
  /** Company or domain words that trigger the hook ("vanta", "drata"). */
  match: string[];
  hook: string;
}

export interface SellerProfile {
  company_name: string;
  website: string;
  /** One or two sentences: what the product does, in the seller's words. Researchers and writers read it. */
  product_summary: string;
  /** The locked paragraph the app adds to shared email briefs. */
  product_overview: string;
  /** The seller's pitch in their own words, pasted at setup (how they explain it on a call, the problems it solves). */
  pitch: string;
  customers: Customer[];
  proof_points: ProofPoint[];
  booking_link: string;
  /** Words the product must never be called ("chatbot", "widget"). */
  never_call_it: string[];
  /** Words the copy must never use ("leverage", "seamless"). */
  banned_words: string[];
  /** Company ICP the screener and company researcher apply. */
  company_icp: {
    description: string;
    min_employees: number | null;
    max_employees: number | null;
    exclude: string[];
    /** Extra rules, one per line, read by the researchers as written. */
    rules: string[];
  };
  /** Companies never researched: customers, the seller itself, direct competitors. */
  never_target: string[];
  /** Kinds of vendor that compete with the seller (excluded, and reported as competitive evidence). */
  competitor_categories: string[];
  adjacency: Adjacency[];
}

// Empty until the onboarding wizard (Admin > Setup) saves the seller's own brand context. Nothing here may name a real
// company: research, emails and screening all read the saved profile, never these defaults.
export const DEFAULT_PROFILE: SellerProfile = {
  company_name: "",
  website: "",
  product_summary: "",
  product_overview: "",
  pitch: "",
  customers: [],
  proof_points: [],
  booking_link: "",
  never_call_it: [],
  banned_words: ["leverage", "unlock", "seamless", "robust", "solution"],
  company_icp: {
    description: "",
    min_employees: null,
    max_employees: null,
    exclude: [],
    rules: [],
  },
  never_target: [],
  competitor_categories: [],
  adjacency: [],
};

// deno-lint-ignore no-explicit-any
type Any = any;
const str = (v: unknown, d = "") => (typeof v === "string" ? v.trim() : d);
const strs = (v: unknown, d: string[]) =>
  Array.isArray(v) ? [...new Set(v.map((x) => String(x ?? "").trim()).filter(Boolean))] : d;
const num = (v: unknown, d: number | null) => (v === null ? null : typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : d);
const httpUrl = (v: unknown) => (/^https?:\/\/\S+$/.test(str(v)) ? str(v) : "");

/** Fills gaps from the defaults and drops anything malformed. */
export function normalizeProfile(v: unknown): SellerProfile {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, Any>;
  const d = DEFAULT_PROFILE;
  const seen = new Set<string>();
  const proof = (Array.isArray(o.proof_points) ? o.proof_points : d.proof_points)
    .map((p: Any) => ({ text: str(p?.text), customer: str(p?.customer), use_when: str(p?.use_when), link: httpUrl(p?.link) }))
    .filter((p: ProofPoint) => p.text && !seen.has(p.text) && seen.add(p.text));
  const customers = (Array.isArray(o.customers) ? o.customers : d.customers)
    .map((c: Any) => ({ name: str(c?.name), url: httpUrl(c?.url), live_instance: c?.live_instance === true }))
    .filter((c: Customer) => c.name);
  const adjacency = (Array.isArray(o.adjacency) ? o.adjacency : d.adjacency)
    .map((a: Any) => ({ match: strs(a?.match, []).map((x) => x.toLowerCase()), hook: str(a?.hook) }))
    .filter((a: Adjacency) => a.match.length && a.hook);
  const ci = (o.company_icp && typeof o.company_icp === "object" ? o.company_icp : {}) as Record<string, Any>;
  const name = str(o.company_name) || d.company_name;
  return {
    company_name: name,
    website: httpUrl(o.website) || (o.website === undefined ? d.website : ""),
    product_summary: str(o.product_summary) || d.product_summary,
    product_overview: str(o.product_overview) || str(o.product_summary) || d.product_overview,
    pitch: str(o.pitch).slice(0, 20000),
    customers,
    proof_points: proof.length ? proof : d.proof_points,
    booking_link: o.booking_link === undefined ? d.booking_link : httpUrl(o.booking_link),
    never_call_it: strs(o.never_call_it, d.never_call_it),
    banned_words: strs(o.banned_words, d.banned_words),
    company_icp: {
      description: str(ci.description) || d.company_icp.description,
      min_employees: num(ci.min_employees, d.company_icp.min_employees),
      max_employees: num(ci.max_employees, d.company_icp.max_employees),
      exclude: strs(ci.exclude, d.company_icp.exclude),
      rules: strs(ci.rules, d.company_icp.rules),
    },
    never_target: strs(o.never_target, d.never_target),
    competitor_categories: strs(o.competitor_categories, d.competitor_categories),
    adjacency,
  };
}

export const proofTexts = (p: SellerProfile) => p.proof_points.map((x) => x.text);

/** True once Setup has saved enough to research and write for this seller: a name, what they sell and some proof. */
export const profileReady = (p: SellerProfile) => !!p.company_name && !!p.product_summary && p.proof_points.length > 0;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whole-word matcher for a list of words or phrases (plural "s" allowed). Null when the list is empty. */
export function wordsRe(list: string[]): RegExp | null {
  const parts = list.map((w) => esc(w.trim()).replace(/\s+/g, "\\s*")).filter(Boolean);
  return parts.length ? new RegExp(`\\b(?:${parts.join("|")})s?\\b`, "i") : null;
}

/** The seller itself, its customers and anything listed as never to target. */
export function isNeverTarget(p: SellerProfile, company: string): boolean {
  const names = [...p.never_target, p.company_name, ...p.customers.map((c) => c.name)];
  return !!wordsRe(names)?.test(String(company ?? ""));
}

/** The adjacency hook for a company (its name, domain and what it sells), or "none". */
export function adjacencyFor(p: SellerProfile, blob: string): string {
  const t = String(blob ?? "");
  return p.adjacency.find((a) => wordsRe(a.match)?.test(t))?.hook ?? "none";
}

/** The seller as the researchers and writers see it in every task. */
export function sellerBrief(p: SellerProfile) {
  return {
    company: p.company_name,
    website: p.website,
    product: p.product_summary,
    pitch: p.pitch,
    customers: p.customers.map((c) => ({ name: c.name, url: c.url, live_instance: c.live_instance })),
    proof_points: p.proof_points.map((x) => ({ text: x.text, customer: x.customer, use_when: x.use_when, link: x.link })),
    booking_link: p.booking_link,
    never_call_it: p.never_call_it,
    banned_words: p.banned_words,
    company_icp: {
      ...p.company_icp,
      size: p.company_icp.min_employees || p.company_icp.max_employees
        ? `roughly ${p.company_icp.min_employees ?? 1} to ${p.company_icp.max_employees ?? "any number of"} employees`
        : "any size",
    },
    never_target: [...new Set([...p.never_target, p.company_name, ...p.customers.map((c) => c.name)])],
    competitor_categories: p.competitor_categories,
    adjacency: p.adjacency,
  };
}
