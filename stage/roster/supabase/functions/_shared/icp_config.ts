// Contact-level ICP: the personas a roster targets and the seniority and location rules. Admins edit it in
// Admin > ICP personas (app_settings key 'icp'); these defaults apply until they save, and fill any field left out.
// Apollo searches, the seniority check, title scopes and the researcher's task brief all read it from here.
import { adminClient } from "./supabase.ts";
import { PROOF_POINTS } from "./icp.ts";
import { proofTexts } from "./profile.ts";
import { loadProfile } from "./profile_store.ts";

/** Events that search for or accept a persona. */
export const TRIGGERS = ["weekly", "add_company", "find_more", "suggestions"] as const;
export type Trigger = typeof TRIGGERS[number];

export interface Persona {
  key: string; // stored on leads.title_scope
  name: string;
  active: boolean;
  /** Words in a title that put a contact in this persona ("demand" matches "Head of Demand Generation"). Empty = the fallback persona. */
  match: string[];
  /** Apollo person_titles searched for this persona. */
  apollo_titles: string[];
  /** weekly: the Friday roster build. add_company: a rep adds a company. find_more: "Find more ICPs" on an account.
      suggestions: the researcher proposes better contacts it comes across. */
  triggers: Trigger[];
  /** Catches titles no other persona's words match. At most one. */
  fallback: boolean;
  /** Proof points the angle may use for this persona (empty = any). */
  proof_points: string[];
  /** What the role owns, for the researcher. */
  description: string;
  /** Problems this persona has: how to spot them at a company, and the proof point that answers each. */
  pains: Pain[];
}

export interface Pain {
  pain: string;
  /** Signs a company has this problem, one per entry ("demo form buried three clicks deep"). */
  signs: string[];
  /** A proof point from the seller's library that answers it ("" = any that fits). */
  proof: string;
}

export interface IcpConfig {
  locations: string[];
  apollo_seniorities: string[];
  senior_keywords: string[];
  junior_keywords: string[];
  excluded_functions: string[];
  personas: Persona[];
}

const DG = PROOF_POINTS.slice(0, 2);

export const DEFAULT_ICP: IcpConfig = {
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

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);

/** Fills gaps from the defaults and drops anything malformed. Never returns zero active personas. */
/** `proofs` is the seller's proof library; persona proof points outside it are dropped. */
export function normalizeIcp(v: unknown, proofs: readonly string[] = PROOF_POINTS): IcpConfig {
  // deno-lint-ignore no-explicit-any
  const o = (v && typeof v === "object" ? v : {}) as Record<string, any>;
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
  // One fallback at most: the first active one flagged.
  let fb = false;
  for (const p of personas) {
    if (p.fallback && p.active && !fb) fb = true;
    else p.fallback = false;
  }
  const out: IcpConfig = {
    locations: strs(o.locations, DEFAULT_ICP.locations),
    apollo_seniorities: strs(o.apollo_seniorities, DEFAULT_ICP.apollo_seniorities),
    senior_keywords: strs(o.senior_keywords, DEFAULT_ICP.senior_keywords).map((x) => x.toLowerCase()),
    junior_keywords: strs(o.junior_keywords, DEFAULT_ICP.junior_keywords).map((x) => x.toLowerCase()),
    excluded_functions: strs(o.excluded_functions, DEFAULT_ICP.excluded_functions),
    personas: personas.some((p) => p.active) ? personas : DEFAULT_ICP.personas,
  };
  if (!out.locations.length) out.locations = DEFAULT_ICP.locations;
  if (!out.senior_keywords.length) out.senior_keywords = DEFAULT_ICP.senior_keywords;
  return out;
}

export async function loadIcp(): Promise<IcpConfig> {
  const [{ data }, profile] = await Promise.all([
    adminClient().from("app_settings").select("value").eq("key", "icp").maybeSingle(),
    loadProfile(),
  ]);
  return normalizeIcp(data?.value ?? null, proofTexts(profile));
}

const word = (k: string) => new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+")}\\b`, "i");
const OVERRIDES_JUNIOR = ["head", "director", "chief", "cmo"];

/** Senior enough when the title has a senior keyword; a junior keyword ("Manager") rules it out unless the
    title also says Head, Director, Chief or CMO. */
export function seniorEnoughWith(cfg: IcpConfig, title: string): boolean {
  const t = String(title ?? "");
  if (!cfg.senior_keywords.some((k) => word(k).test(t))) return false;
  if (!cfg.junior_keywords.some((k) => word(k).test(t))) return true;
  return OVERRIDES_JUNIOR.some((k) => word(k).test(t));
}

export const activePersonas = (cfg: IcpConfig) => cfg.personas.filter((p) => p.active);

/** The persona key for a title: the first active persona whose words appear, else the fallback persona. */
export function titleScopeWith(cfg: IcpConfig, title: string): string {
  const t = String(title ?? "").toLowerCase();
  const act = activePersonas(cfg);
  const hit = act.find((p) => !p.fallback && p.match.some((m) => t.includes(m)));
  if (hit) return hit.key;
  return act.find((p) => p.fallback)?.key ?? "general";
}

/** title_scope values a researched lead may carry. */
export const scopeKeys = (cfg: IcpConfig) => [...new Set([...activePersonas(cfg).map((p) => p.key), "general"])];

/** Apollo titles searched for an event. */
export const titlesFor = (cfg: IcpConfig, t: Trigger) =>
  [...new Set(activePersonas(cfg).filter((p) => p.triggers.includes(t)).flatMap((p) => p.apollo_titles))];
export const weeklyTitles = (cfg: IcpConfig) => titlesFor(cfg, "weekly");

/** Whether a title belongs to a persona that takes part in an event. */
export function acceptsTitle(cfg: IcpConfig, t: Trigger, title: string): boolean {
  const key = titleScopeWith(cfg, title);
  const p = activePersonas(cfg).find((x) => x.key === key);
  return !!p && p.triggers.includes(t);
}

export const locationLabel = (cfg: IcpConfig) => cfg.locations.join(" / ");

/** The persona rules as the researcher sees them in its task. */
export function icpBrief(cfg: IcpConfig, proofs: readonly string[] = PROOF_POINTS) {
  return {
    locations: cfg.locations,
    seniority: `Title must include one of: ${cfg.senior_keywords.join(", ")}.` +
      (cfg.junior_keywords.length ? ` ${cfg.junior_keywords.join(", ")} titles do not count unless they also say Head, Director, Chief or CMO.` : ""),
    excluded_functions: cfg.excluded_functions,
    personas: activePersonas(cfg).map((p) => ({
      title_scope: p.key, name: p.name, owns: p.description, fallback: p.fallback,
      suggest_others_like_this: p.triggers.includes("suggestions"),
      proof_points: p.proof_points.length ? p.proof_points : [...proofs],
      // Problems this persona has, the signs a company has each one, and the proof point that answers it.
      pains: p.pains.map((x) => ({ pain: x.pain, signs: x.signs, answer_with: x.proof || "any proof point above that fits" })),
    })),
  };
}
