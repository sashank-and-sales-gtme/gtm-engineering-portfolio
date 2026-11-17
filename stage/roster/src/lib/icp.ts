// Contact ICP personas (app_settings key 'icp'). Mirrors supabase/functions/_shared/icp_config.ts, which is what the
// roster build and the researcher actually read; keep the defaults in step with it.

import { DEFAULT_PROFILE, proofTexts } from "./profile";

/** The default seller's proof points. The ICP panel offers the saved profile's list. */
export const PROOF_POINTS = proofTexts(DEFAULT_PROFILE);

export const APOLLO_SENIORITIES = ["owner", "founder", "c_suite", "partner", "vp", "head", "director", "manager", "senior", "entry"];

export const TRIGGERS = ["weekly", "add_company", "find_more", "suggestions"] as const;
export type Trigger = (typeof TRIGGERS)[number];
export const TRIGGER_LABEL: Record<Trigger, [string, string]> = {
  weekly: ["Weekly build", "Weekly roster build (Friday)"],
  add_company: ["Add company", "A rep adds a company"],
  find_more: ["Find more", "Find more ICPs on an account"],
  suggestions: ["Suggestions", "Researcher suggests other contacts it finds"],
};

export type Persona = {
  key: string;
  name: string;
  active: boolean;
  match: string[];
  apollo_titles: string[];
  triggers: Trigger[];
  fallback: boolean;
  proof_points: string[];
  description: string;
  /** Problems this persona has: how to spot them at a company, and the proof point that answers each. */
  pains: Pain[];
};

export type Pain = {
  pain: string;
  /** Signs a company has this problem, one per entry. */
  signs: string[];
  /** A proof point from the seller's library that answers it ("" = any that fits). */
  proof: string;
};

export type Icp = {
  locations: string[];
  apollo_seniorities: string[];
  senior_keywords: string[];
  junior_keywords: string[];
  excluded_functions: string[];
  personas: Persona[];
};

const DG = PROOF_POINTS.slice(0, 2);

export const DEFAULT_ICP: Icp = {
  locations: ["India"],
  apollo_seniorities: ["head", "director", "vp", "c_suite"],
  senior_keywords: ["cmo", "chief marketing", "chief growth", "head", "director", "vp", "vice president", "avp"],
  junior_keywords: ["manager"],
  excluded_functions: ["brand", "PR", "content only", "product marketing only", "events only", "partnerships"],
  personas: [
    {
      key: "demand_gen", name: "Demand Gen", active: true, match: ["demand"], triggers: [...TRIGGERS], fallback: false, proof_points: DG,
      apollo_titles: ["head of demand generation", "director of demand generation", "vp of demand generation"],
      description: "Runs demand generation: pipeline, inbound, paid acquisition and website conversion.",
      pains: [],
    },
    {
      key: "growth", name: "Growth", active: true, match: ["growth"], triggers: [...TRIGGERS], fallback: false, proof_points: DG,
      apollo_titles: [
        "head of growth", "director of growth", "vp of growth",
        "head of growth marketing", "director of growth marketing", "vp of growth marketing",
      ],
      description: "Owns growth or growth marketing: acquisition, funnel and conversion targets.",
      pains: [],
    },
    {
      key: "digital", name: "Digital", active: true, match: ["digital", "performance"], triggers: [...TRIGGERS], fallback: false, proof_points: DG,
      apollo_titles: ["head of digital marketing", "director of digital marketing", "vp of digital marketing"],
      description: "Runs digital or performance marketing: web, paid media and conversion.",
      pains: [],
    },
    {
      key: "general", name: "Marketing head", active: true, match: [], triggers: ["add_company", "find_more", "suggestions"], fallback: true, proof_points: DG,
      apollo_titles: ["head of marketing", "director marketing", "vp marketing", "cmo"],
      description: "General marketing head (Head, Director or VP Marketing, CMO) who owns demand gen, growth, digital or the India marketing function.",
      pains: [],
    },
  ],
};

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);

const strs = (v: unknown, d: string[]) =>
  Array.isArray(v) ? [...new Set(v.map((x) => String(x ?? "").trim()).filter(Boolean))] : d;

/** A persona's pains, without blanks; a proof point outside the library is cleared. */
function readPains(v: unknown, proofs: readonly string[]): Pain[] {
  if (!Array.isArray(v)) return [];
  return v
    // deno-lint-ignore no-explicit-any
    .map((x: any) => ({
      pain: String(x?.pain ?? "").trim(),
      signs: strs(x?.signs, []),
      proof: proofs.includes(String(x?.proof ?? "").trim()) ? String(x.proof).trim() : "",
    }))
    .filter((x) => x.pain)
    .slice(0, 12);
}

/** The saved config with defaults filled in (same rules as the server). */
export function readIcp(v: unknown, proofs: readonly string[] = PROOF_POINTS): Icp {
  const o: any = v && typeof v === "object" ? v : {};
  const seen = new Set<string>();
  const personas: Persona[] = [];
  for (const p of Array.isArray(o.personas) ? o.personas : DEFAULT_ICP.personas) {
    const name = String(p?.name ?? "").trim();
    const key = slug(String(p?.key ?? "") || name);
    if (!name || !key || seen.has(key)) continue;
    seen.add(key);
    personas.push({
      key,
      name,
      active: p?.active !== false,
      match: strs(p?.match, []).map((x) => x.toLowerCase()),
      apollo_titles: strs(p?.apollo_titles, []).map((x) => x.toLowerCase()),
      triggers: Array.isArray(p?.triggers)
        ? TRIGGERS.filter((t) => p.triggers.includes(t))
        : p?.weekly === false ? TRIGGERS.filter((t) => t !== "weekly") : [...TRIGGERS],
      fallback: p?.fallback === true || (p?.fallback === undefined && !strs(p?.match, []).length),
      proof_points: strs(p?.proof_points, []).filter((x) => proofs.includes(x)),
      description: String(p?.description ?? "").trim(),
      pains: readPains(p?.pains, proofs),
    });
  }
  let fb = false;
  for (const p of personas) {
    if (p.fallback && p.active && !fb) fb = true;
    else p.fallback = false;
  }
  return {
    locations: strs(o.locations, DEFAULT_ICP.locations),
    apollo_seniorities: strs(o.apollo_seniorities, DEFAULT_ICP.apollo_seniorities),
    senior_keywords: strs(o.senior_keywords, DEFAULT_ICP.senior_keywords).map((x) => x.toLowerCase()),
    junior_keywords: strs(o.junior_keywords, DEFAULT_ICP.junior_keywords).map((x) => x.toLowerCase()),
    excluded_functions: strs(o.excluded_functions, DEFAULT_ICP.excluded_functions),
    personas: personas.some((p) => p.active) ? personas : DEFAULT_ICP.personas,
  };
}

/** Persona name for a lead's title_scope (falls back to the key). */
export function personaName(settings: any, key: string | null | undefined): string {
  if (!key) return "";
  const p = readIcp(settings && settings.icp).personas.find((x) => x.key === key);
  return p ? p.name : key.replace(/_/g, " ");
}
