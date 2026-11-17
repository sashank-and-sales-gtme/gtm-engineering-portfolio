// Roster settings, rep rotation and account claims shared by weekly-roster, queue-gate and claude-work.
import { adminClient, nowISO } from "./supabase.ts";

export interface RosterSettings {
  contacts_per_account: number;
  overprovision: number;
  max_accounts_per_run: number;
  crm_recent_days: number;
  archive_after_days: number;
  exclude_cache_days: number;
  company_cache_days: number;
}

const DEFAULTS: RosterSettings = {
  contacts_per_account: 2,
  overprovision: 1.5,
  max_accounts_per_run: 15,
  crm_recent_days: 90,
  archive_after_days: 35,
  exclude_cache_days: 120,
  company_cache_days: 90,
};

export async function rosterSettings(): Promise<RosterSettings> {
  const { data } = await adminClient().from("app_settings").select("value").eq("key", "roster").maybeSingle();
  const v = (data?.value ?? {}) as Partial<RosterSettings>;
  const num = (x: unknown, d: number, lo: number, hi: number) => {
    const n = Number(x);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
  };
  return {
    contacts_per_account: Math.round(num(v.contacts_per_account, DEFAULTS.contacts_per_account, 1, 5)),
    overprovision: num(v.overprovision, DEFAULTS.overprovision, 1, 3),
    max_accounts_per_run: Math.round(num(v.max_accounts_per_run, DEFAULTS.max_accounts_per_run, 1, 25)),
    crm_recent_days: Math.round(num(v.crm_recent_days, DEFAULTS.crm_recent_days, 7, 365)),
    archive_after_days: Math.round(num(v.archive_after_days, DEFAULTS.archive_after_days, 14, 365)),
    exclude_cache_days: Math.round(num(v.exclude_cache_days, DEFAULTS.exclude_cache_days, 7, 365)),
    company_cache_days: Math.round(num(v.company_cache_days, DEFAULTS.company_cache_days, 7, 365)),
  };
}

export interface Rep {
  user_id: string;
  email: string;
  full_name: string | null;
  hubspot_owner_id: string | null;
  weekly_accounts: number;
  employees_min: number | null;
  employees_max: number | null;
  revenue_min: number | null;
  revenue_max: number | null;
  funding_min: number | null;
  funding_max: number | null;
}

/** Active members in the weekly rotation with a quota above zero. */
export async function rotationReps(): Promise<Rep[]> {
  const db = adminClient();
  const { data: rs } = await db.from("rep_settings").select("*").eq("in_rotation", true).gt("weekly_accounts", 0);
  const ids = (rs ?? []).map((r) => r.user_id);
  if (!ids.length) return [];
  const { data: profs } = await db.from("profiles").select("id,email,full_name,hubspot_owner_id,status,role").in("id", ids);
  const ok = new Map((profs ?? []).filter((p) => p.status === "active" && p.role).map((p) => [p.id, p]));
  return (rs ?? []).filter((r) => ok.has(r.user_id)).map((r) => {
    const p = ok.get(r.user_id)!;
    return {
      user_id: r.user_id,
      email: p.email,
      full_name: p.full_name,
      hubspot_owner_id: p.hubspot_owner_id,
      weekly_accounts: r.weekly_accounts,
      employees_min: r.employees_min,
      employees_max: r.employees_max,
      revenue_min: r.revenue_min,
      revenue_max: r.revenue_max,
      funding_min: r.funding_min,
      funding_max: r.funding_max,
    };
  });
}

export const normDomain = (s: unknown) =>
  String(s ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[/?#].*$/, "");

/**
 * Reserve an account for a rep. Returns false when another rep (or an unexpired exclusion) holds it.
 * A released claim, or an expired exclusion, is taken over.
 */
export async function reserveAccount(domain: string, company: string, repId: string | null, batch: string): Promise<boolean> {
  const db = adminClient();
  const d = normDomain(domain);
  if (!d) return false;
  const { error } = await db.from("account_claims").insert({ domain: d, company, rep_id: repId, batch, status: "reserved" });
  if (!error) return true;
  if (error.code !== "23505") throw new Error(`Could not reserve ${d}: ${error.message}`);
  const { data: cur } = await db.from("account_claims").select("*").eq("domain", d).maybeSingle();
  if (!cur) return false;
  const free = cur.status === "released" || (cur.status === "excluded" && cur.expires_at && Date.parse(cur.expires_at) < Date.now());
  if (!free) return cur.rep_id === repId && cur.status === "reserved" && cur.batch === batch;
  const { data: taken } = await db.from("account_claims")
    .update({ company, rep_id: repId, batch, status: "reserved", reason: null, expires_at: null, claimed_at: nowISO() })
    .eq("domain", d).eq("status", cur.status).select("domain");
  return !!taken?.length;
}

export async function setClaim(domain: string, status: "active" | "excluded" | "released", reason: string | null, ttlDays?: number) {
  const d = normDomain(domain);
  if (!d) return;
  await adminClient().from("account_claims").update({
    status,
    reason: reason ? reason.slice(0, 300) : null,
    expires_at: ttlDays ? new Date(Date.now() + ttlDays * 864e5).toISOString() : null,
  }).eq("domain", d);
}
