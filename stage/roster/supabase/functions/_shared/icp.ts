// ICP rules, validators and house-style scans. The research instructions themselves live with the Claude worker
// (.claude/skills/roster-research and .claude/agents/*-researcher.md); Supabase validates what it submits.
// Everything about the seller (proof points, banned words, companies never to target) comes from the profile.
import { DEFAULT_PROFILE, isNeverTarget, proofTexts, type SellerProfile, wordsRe } from "./profile.ts";

/** The default seller's proof points. Validation uses the saved profile's list. */
export const PROOF_POINTS = proofTexts(DEFAULT_PROFILE);

// deno-lint-ignore no-explicit-any
export type LeadJson = Record<string, any>;

/** Returns house-style violations found in a piece of copy. */
export function scanCopy(text: string, profile: SellerProfile = DEFAULT_PROFILE): string[] {
  const issues: string[] = [];
  const t = String(text ?? "");
  if (/[\u2014\u2013]/.test(t)) issues.push("contains an em or en dash");
  for (const w of [...profile.never_call_it, ...profile.banned_words]) {
    if (wordsRe([w])?.test(t)) issues.push(`uses banned word "${w}"`);
  }
  if (/\b(isn't|is not|wasn't|aren't)\b[^.]{0,80}[,;]\s*(it's|it is|they're|but)\b/i.test(t)) {
    issues.push('uses an "isn\'t A, it\'s B" pivot');
  }
  // A list of three short items ("pipeline, conversion and CPA"). Items are one or two words; a clause before a
  // comma ("In 5 weeks, Northwind moved conversion and pipeline") is not a list.
  if (/\b[\w$%~.+-]+(?:\s[\w$%~.+-]+)?,\s[\w$%~.+-]+(?:\s[\w$%~.+-]+)?,?\s(?:and|or)\s[\w$%~.+-]+/i.test(t)) {
    issues.push("reads like a rule-of-three list");
  }
  const sentences = t.split(/(?<=[.!?])\s+/).filter((s) => s.trim());
  if (sentences.length > 2) issues.push("angle is longer than two sentences");
  return issues;
}

/** Validates the research JSON. Returns a list of problems (empty when valid). */
export function validateLead(
  j: LeadJson,
  manual: boolean,
  opts: { apolloVerified?: boolean; scopes?: string[]; proofPointsByScope?: Record<string, string[]>; profile?: SellerProfile } = {},
): string[] {
  const p: string[] = [];
  if (!j || typeof j !== "object") return ["reply is not a JSON object"];
  if (j.exclude === true) {
    if (manual) p.push("manual adds are never excluded; use tier X");
    return p;
  }
  for (const k of ["name", "title", "company", "tier", "fit_reason", "status_check", "persona", "angle", "proof_point"]) {
    if (!String(j[k] ?? "").trim()) p.push(`missing ${k}`);
  }
  if (!["A", "B", "C", "X"].includes(j.tier)) p.push("tier must be A, B, C or X");
  if (j.tier === "X" && !manual) p.push("tier X is only for manual adds");
  if (!["current", "unconfirmed"].includes(j.status_check)) p.push("status_check must be current or unconfirmed");
  const ev = String(j.status_evidence ?? "");
  const apolloOk = !!opts.apolloVerified && /apollo/i.test(ev);
  if (j.status_check === "current" && !/https?:\/\//.test(ev) && !apolloOk) {
    p.push("status_check current needs a URL in status_evidence (or, when the task shows apollo.work_email_verified, cite the Apollo verified work email)");
  }
  const scopes = opts.scopes?.length ? opts.scopes : ["demand_gen", "growth", "digital", "general"];
  if (!scopes.includes(j.title_scope)) p.push(`title_scope must be one of: ${scopes.join(", ")}`);
  if (!Array.isArray(j.pain_points)) p.push("pain_points must be an array");
  else {
    j.pain_points.forEach((x: LeadJson, i: number) => {
      if (!x || !String(x.detail ?? "").trim()) p.push(`pain_points[${i}] needs detail`);
      if (!["confirmed", "inferred"].includes(x?.label)) p.push(`pain_points[${i}] label must be confirmed or inferred`);
      if (x?.label === "confirmed" && !/^https?:\/\//.test(String(x.source ?? ""))) p.push(`pain_points[${i}] confirmed needs a source URL`);
    });
  }
  const profile = opts.profile ?? DEFAULT_PROFILE;
  const proof = proofTexts(profile);
  if (!proof.includes(j.proof_point)) p.push(`proof_point must be one of: ${proof.join(" | ")}`);
  else {
    const allowed = opts.proofPointsByScope?.[j.title_scope];
    if (allowed?.length && !allowed.includes(j.proof_point)) p.push(`proof_point for ${j.title_scope} must be one of: ${allowed.join(" | ")}`);
  }
  for (const issue of scanCopy(j.angle, profile)) p.push(`angle ${issue}`);
  for (const k of ["fit_reason", "persona", "status_evidence", "competitive", "adjacency", "segment"]) {
    if (/[\u2014]/.test(String(j[k] ?? ""))) p.push(`${k} contains an em dash`);
  }
  return p;
}

/** Light normalisation that never changes meaning. */
export function normalizeLead(j: LeadJson): LeadJson {
  const fixDash = (s: unknown) => String(s ?? "").replace(/\s*\u2014\s*/g, ", ").replace(/\s\u2013\s/g, ", ");
  const out: LeadJson = { ...j };
  for (const k of ["fit_reason", "persona", "status_evidence", "competitive", "adjacency", "segment", "hq", "employees"]) {
    if (out[k] != null) out[k] = fixDash(out[k]);
  }
  if (out.domain) out.domain = String(out.domain).replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "").toLowerCase();
  if (!out.adjacency) out.adjacency = "none";
  if (!out.competitive) out.competitive = "No confirmed competitor evaluation";
  if (Array.isArray(out.pain_points)) {
    out.pain_points = out.pain_points.map((x: LeadJson) => ({
      detail: fixDash(x?.detail),
      label: x?.label === "confirmed" ? "confirmed" : "inferred",
      source: String(x?.source ?? ""),
    }));
  }
  return out;
}

export function isAlwaysExcluded(company: string, profile: SellerProfile = DEFAULT_PROFILE): boolean {
  return isNeverTarget(profile, company);
}

export function companyCap(employees: number | null | undefined): number {
  return (employees ?? 0) > 1000 ? 5 : 3;
}

/** Parses "1001-2500 (Apollo)" or 1200 into a representative headcount. */
export function parseEmployees(v: unknown): number | null {
  if (typeof v === "number") return v;
  const nums = String(v ?? "").replace(/,/g, "").match(/\d+/g);
  if (!nums) return null;
  return Math.max(...nums.map(Number));
}

/** Next Monday's date (YYYY-MM-DD) in IST. */
export function nextMondayIST(from = new Date()): string {
  const ist = new Date(from.getTime() + 5.5 * 3600 * 1000);
  const dow = ist.getUTCDay();
  const add = ((8 - dow) % 7) || 7;
  ist.setUTCDate(ist.getUTCDate() + add);
  return ist.toISOString().slice(0, 10);
}

export function todayIST(from = new Date()): string {
  return new Date(from.getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}
