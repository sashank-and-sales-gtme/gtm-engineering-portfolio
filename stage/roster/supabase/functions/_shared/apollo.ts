import { fetchWithTimeout, sleep } from "./cors.ts";
import { requireSecret } from "./secrets.ts";

const BASE = "https://api.apollo.io/api/v1";

// Titles, seniorities and locations for people search come from the ICP personas (_shared/icp_config.ts).
export const EMPLOYEE_RANGES = ["251,500", "501,1000", "1001,2500"];
export const KEYWORD_VARIANTS: string[][] = [
  ["SaaS", "B2B"], ["software"], ["enterprise software"], ["computer software"],
  ["information technology & services"], ["cloud"], ["fintech"], ["cybersecurity"],
  ["martech"], ["hr tech"], ["logistics"],
];

export interface ApolloPerson {
  id: string;
  first_name?: string;
  last_name?: string;
  last_name_obfuscated?: string;
  name?: string;
  title?: string;
  linkedin_url?: string;
  email?: string;
  email_status?: string;
  city?: string;
  state?: string;
  country?: string;
  organization?: {
    id?: string;
    name?: string;
    website_url?: string;
    primary_domain?: string;
    estimated_num_employees?: number;
    industry?: string;
    annual_revenue?: number;
    organization_revenue?: number;
    city?: string;
    country?: string;
  };
  // deno-lint-ignore no-explicit-any
  [k: string]: any;
}

async function apollo<T>(path: string, body: unknown): Promise<T> {
  const key = await requireSecret("int_apollo_key");
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetchWithTimeout(`${BASE}${path}`, {
      method: "POST",
      headers: { "X-Api-Key": key, "Content-Type": "application/json", "Cache-Control": "no-cache" },
      body: JSON.stringify(body),
    }, 30000);
    if ((r.status === 429 || r.status >= 500) && attempt < 2) {
      await sleep(2000 * (attempt + 1));
      continue;
    }
    const text = await r.text();
    if (!r.ok) throw new Error(`Apollo ${r.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text) as T;
  }
  throw new Error("Apollo did not answer");
}

/** Free people search (no credits). */
export async function peopleSearch(params: {
  titles?: string[];
  seniorities?: string[];
  locations?: string[];
  employeeRanges?: string[];
  keywordTags?: string[];
  domains?: string[];
  organizationIds?: string[];
  revenueMin?: number | null;
  revenueMax?: number | null;
  page?: number;
  perPage?: number;
}): Promise<{ people: ApolloPerson[]; total: number }> {
  const body: Record<string, unknown> = {
    page: params.page ?? 1,
    per_page: params.perPage ?? 100,
    include_similar_titles: false,
  };
  if (params.titles?.length) body.person_titles = params.titles;
  if (params.seniorities?.length) body.person_seniorities = params.seniorities;
  if (params.locations?.length) body.person_locations = params.locations;
  if (params.employeeRanges?.length) body.organization_num_employees_ranges = params.employeeRanges;
  if (params.keywordTags?.length) body.q_organization_keyword_tags = params.keywordTags;
  if (params.domains?.length) body.q_organization_domains_list = params.domains;
  if (params.organizationIds?.length) body.organization_ids = params.organizationIds;
  const rev = range(params.revenueMin, params.revenueMax);
  if (rev) body.revenue_range = rev;
  const r = await apollo<{ people?: ApolloPerson[]; total_entries?: number; pagination?: { total_entries?: number } }>(
    "/mixed_people/api_search",
    body,
  );
  return { people: r.people ?? [], total: r.total_entries ?? r.pagination?.total_entries ?? 0 };
}

function range(min?: number | null, max?: number | null): Record<string, number> | null {
  const out: Record<string, number> = {};
  if (min != null && Number.isFinite(+min)) out.min = Math.round(+min);
  if (max != null && Number.isFinite(+max)) out.max = Math.round(+max);
  return Object.keys(out).length ? out : null;
}

export interface ApolloOrg {
  id: string;
  name?: string;
  primary_domain?: string;
  website_url?: string;
  estimated_num_employees?: number;
  annual_revenue?: number;
  total_funding?: number;
  // deno-lint-ignore no-explicit-any
  [k: string]: any;
}

/**
 * Organization search. Spends 1 Apollo credit per page (up to 100 companies). Used only when a rep's
 * segment filters on funding, which people search cannot filter on.
 */
export async function orgSearch(params: {
  employeeRanges?: string[];
  revenueMin?: number | null;
  revenueMax?: number | null;
  fundingMin?: number | null;
  fundingMax?: number | null;
  keywordTags?: string[];
  page?: number;
}): Promise<{ orgs: ApolloOrg[]; total: number }> {
  const body: Record<string, unknown> = { page: params.page ?? 1, per_page: 100 };
  if (params.employeeRanges?.length) body.organization_num_employees_ranges = params.employeeRanges;
  if (params.keywordTags?.length) body.q_organization_keyword_tags = params.keywordTags;
  const rev = range(params.revenueMin, params.revenueMax);
  if (rev) body.revenue_range = rev;
  const fund = range(params.fundingMin, params.fundingMax);
  if (fund) body.total_funding_range = fund;
  const r = await apollo<{ organizations?: ApolloOrg[]; accounts?: ApolloOrg[]; pagination?: { total_entries?: number } }>(
    "/mixed_companies/search",
    body,
  );
  return { orgs: [...(r.organizations ?? []), ...(r.accounts ?? [])], total: r.pagination?.total_entries ?? 0 };
}

export function orgDomain(o: ApolloOrg): string {
  const raw = o.primary_domain || o.website_url || "";
  return String(raw).replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "").toLowerCase();
}

/** Standard people/match (1 credit, work email only, no phone or waterfall). */
export async function peopleMatch(p: {
  id?: string;
  first_name?: string;
  last_name?: string;
  name?: string;
  domain?: string;
  organization_name?: string;
  linkedin_url?: string;
}): Promise<ApolloPerson | null> {
  const body: Record<string, unknown> = { reveal_personal_emails: false, reveal_phone_number: false };
  for (const [k, v] of Object.entries(p)) if (v) body[k] = v;
  const r = await apollo<{ person?: ApolloPerson | null }>("/people/match", body);
  return r.person ?? null;
}

/**
 * people/match asking Apollo for the phone too. Apollo answers the match now and sends phone numbers to the webhook
 * a few minutes later (8 credits, only when it finds a mobile). A phone Apollo already holds may come back at once.
 */
export async function peopleMatchPhone(p: {
  id?: string;
  first_name?: string;
  last_name?: string;
  name?: string;
  domain?: string;
  organization_name?: string;
  linkedin_url?: string;
}, webhookUrl: string): Promise<ApolloPerson | null> {
  const body: Record<string, unknown> = { reveal_personal_emails: false, reveal_phone_number: true, webhook_url: webhookUrl };
  for (const [k, v] of Object.entries(p)) if (v) body[k] = v;
  const r = await apollo<{ person?: ApolloPerson | null }>("/people/match", body);
  return r.person ?? null;
}

export function personName(p: ApolloPerson): string {
  if (p.name) return p.name;
  const last = p.last_name || p.last_name_obfuscated || "";
  return [p.first_name, last].filter(Boolean).join(" ").trim();
}

export function personDomain(p: ApolloPerson): string {
  const o = p.organization ?? {};
  const raw = o.primary_domain || o.website_url || "";
  return String(raw).replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "").toLowerCase();
}
