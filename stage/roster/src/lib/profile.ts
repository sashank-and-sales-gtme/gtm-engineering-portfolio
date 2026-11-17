// The seller's profile (app_settings key 'profile'). Mirrors supabase/functions/_shared/profile.ts, which is what
// the researchers, writers and validators actually read; keep the defaults in step with it.

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

/** The saved profile, filled from the defaults. */
export const readProfile = (v: unknown) => normalizeProfile(v ?? null);
