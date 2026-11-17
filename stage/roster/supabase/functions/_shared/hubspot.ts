import { fetchWithTimeout, HttpError, sleep } from "./cors.ts";
import { coName, splitName } from "./supabase.ts";
import { getSecretJson, markConnection, setSecret, vaultGet } from "./secrets.ts";
import { noteAssociations, type NoteTargets } from "./hubspot_assoc.ts";
import { currentWorkspace } from "./workspace.ts";

const BASE = "https://api.hubapi.com";

export const ASSOC = {
  CONTACT_TO_COMPANY: 279,
};

export interface HsObject {
  id: string;
  properties: Record<string, string | null>;
}

export class HubSpotError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const HUBSPOT_SCOPES = [
  "oauth",
  "crm.objects.contacts.read",
  "crm.objects.contacts.write",
  "crm.objects.companies.read",
  "crm.objects.deals.read",
  "crm.objects.owners.read",
  "crm.schemas.contacts.read",
  "sales-email-read",
];
/** Scopes we would like but that a portal or app may not grant; requested as optional_scope. */
export const HUBSPOT_OPTIONAL_SCOPES = ["crm.objects.deals.write", "crm.objects.meetings.read"];

export interface HubSpotTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number; // epoch ms
  hub_id?: number | string;
  user_email?: string;
}
export interface OAuthApp {
  client_id: string;
  client_secret: string;
}

/** One org-token refresh at a time per workspace. */
const refreshing = new Map<string, Promise<string>>();

/** POST https://api.hubapi.com/oauth/v1/token (form encoded). */
export async function hubspotTokenRequest(params: Record<string, string>): Promise<{
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}> {
  const r = await fetchWithTimeout(`${BASE}/oauth/v1/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" },
    body: new URLSearchParams(params).toString(),
  }, 20000);
  const text = await r.text();
  // deno-lint-ignore no-explicit-any
  let data: any = {};
  try {
    data = JSON.parse(text);
  } catch { /* keep empty */ }
  if (!r.ok || !data.access_token) {
    throw new HubSpotError(r.status || 500, `HubSpot token request failed: ${data.message ?? data.error ?? text.slice(0, 200)}`);
  }
  return data;
}

async function refreshHubspot(tokens: HubSpotTokens): Promise<string> {
  const app = await getSecretJson<OAuthApp>("int_hubspot_app");
  if (!app?.client_id || !app?.client_secret) {
    throw new HttpError(409, "The HubSpot app is not set up. Add it in Admin > Integrations.");
  }
  try {
    const t = await hubspotTokenRequest({
      grant_type: "refresh_token",
      client_id: app.client_id,
      client_secret: app.client_secret,
      refresh_token: tokens.refresh_token,
    });
    const next: HubSpotTokens = {
      ...tokens,
      access_token: t.access_token,
      refresh_token: t.refresh_token || tokens.refresh_token,
      expires_at: Date.now() + (t.expires_in ?? 1800) * 1000,
    };
    await setSecret("int_hubspot_tokens", JSON.stringify(next));
    return next.access_token;
  } catch (e) {
    if (e instanceof HubSpotError && e.status >= 400 && e.status < 500) {
      await markConnection("hubspot", null, "error", "HubSpot refused the token refresh. Reconnect HubSpot.");
    }
    throw e;
  }
}

/** Scopes a HubSpot private app needs for everything the roster does (dedupe, notes, deals, meetings, email activity). */
export const HUBSPOT_PAT_SCOPES = [
  "crm.objects.contacts.read",
  "crm.objects.contacts.write",
  "crm.objects.companies.read",
  "crm.objects.deals.read",
  "crm.objects.deals.write",
  "crm.objects.owners.read",
  "crm.schemas.contacts.read",
  "sales-email-read",
];

/** True when OAuth tokens or a private app token (Vault) are available. */
export async function hubspotConfigured(): Promise<boolean> {
  const t = await vaultGet("int_hubspot_tokens").catch(() => null);
  const pat = await vaultGet("int_hubspot_pat").catch(() => null);
  return !!t || !!pat;
}

/**
 * Checks a pasted private app token: it must be a private app token (pat-...), work, and carry the scopes the roster
 * uses. Returns the portal id and any missing scopes. Probes with harmless reads.
 */
export async function checkHubspotPat(token: string): Promise<{ ok: boolean; error?: string; hub?: string; missing: string[] }> {
  if (!/^pat-[a-z0-9]+-/i.test(token)) {
    return {
      ok: false,
      missing: [],
      error:
        "That isn't a private app access token. In HubSpot open Settings > Integrations > Private Apps (Development > Legacy apps in newer accounts), create an app with the scopes below, and copy the token that starts with pat-.",
    };
  }
  const get = (path: string) => fetchWithTimeout(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } }, 15000);
  const who = await fetchWithTimeout(`${BASE}/oauth/v2/private-apps/get/access-token-info`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tokenKey: token }),
  }, 15000).catch(() => null);
  // deno-lint-ignore no-explicit-any
  const info: any = who && who.ok ? await who.json().catch(() => ({})) : {};
  const probe = await get("/crm/v3/owners?limit=1");
  if (probe.status === 401) return { ok: false, missing: [], error: "HubSpot rejected the token. Copy it again from the private app's Auth tab." };
  let missing: string[] = [];
  if (Array.isArray(info.scopes)) missing = HUBSPOT_PAT_SCOPES.filter((s) => !info.scopes.includes(s));
  else {
    // Fall back to probing each area the roster reads.
    const checks: Array<[string, string]> = [
      ["/crm/v3/objects/contacts?limit=1", "crm.objects.contacts.read"],
      ["/crm/v3/objects/companies?limit=1", "crm.objects.companies.read"],
      ["/crm/v3/objects/deals?limit=1", "crm.objects.deals.read"],
      ["/crm/v3/objects/emails?limit=1", "sales-email-read"],
    ];
    for (const [path, scope] of checks) if ((await get(path)).status === 403) missing.push(scope);
  }
  return { ok: true, hub: info.hubId ? String(info.hubId) : undefined, missing };
}

/**
 * A valid HubSpot access token: the OAuth token from Vault (refreshed when it expires within 60s),
 * else the workspace's private-app token from Vault.
 */
export async function hubspotToken(force = false): Promise<string> {
  const raw = await vaultGet("int_hubspot_tokens").catch(() => null);
  if (raw) {
    let tokens: HubSpotTokens | null = null;
    try {
      tokens = JSON.parse(raw);
    } catch { /* corrupt; fall through */ }
    if (tokens?.refresh_token) {
      if (!force && tokens.access_token && Number(tokens.expires_at ?? 0) > Date.now() + 60_000) return tokens.access_token;
      const ws = currentWorkspace();
      let p = refreshing.get(ws);
      if (!p) {
        p = refreshHubspot(tokens).finally(() => refreshing.delete(ws));
        refreshing.set(ws, p);
      }
      return await p;
    }
  }
  const pat = await vaultGet("int_hubspot_pat").catch(() => null);
  if (pat) return pat;
  throw new HttpError(409, "HubSpot is not connected. Connect it in Admin > Integrations.");
}

export const hubspotUserTokensName = (uid: string) => `int_hubspot_tokens_${uid}` as const;
const userRefreshing = new Map<string, Promise<string | null>>();

/** A rep's own HubSpot access token (refreshed when needed), or null when they haven't linked HubSpot. */
export async function hubspotUserToken(uid: string): Promise<string | null> {
  const raw = await vaultGet(hubspotUserTokensName(uid)).catch(() => null);
  if (!raw) return null;
  let tokens: HubSpotTokens;
  try {
    tokens = JSON.parse(raw);
  } catch {
    return null;
  }
  if (tokens.access_token && Number(tokens.expires_at ?? 0) > Date.now() + 60_000) return tokens.access_token;
  if (!tokens.refresh_token) return null;
  const pending = userRefreshing.get(uid);
  if (pending) return await pending;
  const p = (async () => {
    const app = await getSecretJson<OAuthApp>("int_hubspot_app");
    if (!app?.client_id || !app?.client_secret) return null;
    try {
      const t = await hubspotTokenRequest({
        grant_type: "refresh_token",
        client_id: app.client_id,
        client_secret: app.client_secret,
        refresh_token: tokens.refresh_token,
      });
      const next: HubSpotTokens = {
        ...tokens,
        access_token: t.access_token,
        refresh_token: t.refresh_token || tokens.refresh_token,
        expires_at: Date.now() + (t.expires_in ?? 1800) * 1000,
      };
      await setSecret(hubspotUserTokensName(uid), JSON.stringify(next));
      return next.access_token;
    } catch (e) {
      if (e instanceof HubSpotError && e.status >= 400 && e.status < 500) {
        await markConnection("hubspot", uid, "error", "HubSpot refused your login. Link HubSpot again.");
      }
      return null;
    }
  })().finally(() => userRefreshing.delete(uid));
  userRefreshing.set(uid, p);
  return await p;
}

/** The HubSpot owner record for a HubSpot user id (owners and users have different ids). */
export async function hsOwnerByUserId(userId: string | number): Promise<{ id: string; email?: string; firstName?: string; lastName?: string } | null> {
  try {
    const o = await hs<{ id?: string; email?: string; firstName?: string; lastName?: string }>(
      `/crm/v3/owners/${encodeURIComponent(String(userId))}?idProperty=userId`,
    );
    return o?.id ? { ...o, id: String(o.id) } : null;
  } catch (e) {
    if (e instanceof HubSpotError && e.status === 404) return null;
    throw e;
  }
}

export interface HsOwner { id: string; email: string; firstName?: string; lastName?: string; userId?: number }

export const ownerLabel = (o: HsOwner) => [[o.firstName, o.lastName].filter(Boolean).join(" "), o.email].filter(Boolean).join(" · ");

/** Every active HubSpot owner (users who can own records), through the team connection. */
export async function hsListOwners(): Promise<HsOwner[]> {
  const out: HsOwner[] = [];
  let after = "";
  for (let i = 0; i < 20; i++) {
    const r = await hs<{ results?: HsOwner[]; paging?: { next?: { after?: string } } }>(
      `/crm/v3/owners?limit=100&archived=false${after ? `&after=${encodeURIComponent(after)}` : ""}`,
    );
    for (const o of r.results ?? []) if (o?.id) out.push({ ...o, id: String(o.id), email: String(o.email ?? "") });
    after = r.paging?.next?.after ?? "";
    if (!after) break;
  }
  return out;
}

/** One owner by owner id, or null when HubSpot has no such active owner. */
export async function hsOwnerById(id: string): Promise<HsOwner | null> {
  try {
    const o = await hs<HsOwner>(`/crm/v3/owners/${encodeURIComponent(id)}`);
    return o?.id ? { ...o, id: String(o.id), email: String(o.email ?? "") } : null;
  } catch (e) {
    if (e instanceof HubSpotError && e.status === 404) return null;
    throw e;
  }
}

/** The portal id of the team connection, or null when HubSpot doesn't say. */
export async function hsPortalId(): Promise<string | null> {
  try {
    const r = await hs<{ portalId?: number }>("/account-info/v3/details");
    return r?.portalId ? String(r.portalId) : null;
  } catch {
    return null;
  }
}

async function usingOAuth(): Promise<boolean> {
  return !!(await vaultGet("int_hubspot_tokens").catch(() => null));
}

/** Authenticated HubSpot call with timeout and retries on 429/5xx; one forced token refresh on 401. */
export async function hs<T = unknown>(path: string, init: { method?: string; body?: unknown; asUser?: string | null } = {}): Promise<T> {
  // With asUser, the call is made with that rep's own HubSpot login (so HubSpot shows them as the author),
  // falling back to the team connection when they haven't linked HubSpot or their login stopped working.
  const userTok = init.asUser ? await hubspotUserToken(init.asUser).catch(() => null) : null;
  let asRep = !!userTok;
  let token = userTok ?? await hubspotToken();
  let refreshed = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetchWithTimeout(`${BASE}${path}`, {
      method: init.method ?? "GET",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }, 25000);
    if ((r.status === 429 || r.status >= 500) && attempt < 2) {
      await sleep(1200 * (attempt + 1));
      continue;
    }
    const text = await r.text();
    if ((r.status === 401 || r.status === 403) && asRep) {
      await markConnection("hubspot", init.asUser!, "error", "HubSpot refused your login. Link HubSpot again.");
      asRep = false;
      token = await hubspotToken();
      attempt--;
      continue;
    }
    if (r.status === 401 && !refreshed && (await usingOAuth())) {
      refreshed = true;
      token = await hubspotToken(true);
      attempt--;
      continue;
    }
    if (!r.ok) {
      let msg = text.slice(0, 300);
      try {
        msg = JSON.parse(text).message ?? msg;
      } catch { /* keep raw */ }
      if (r.status === 401) await markConnection("hubspot", null, "error", `HubSpot rejected the token: ${msg}`.slice(0, 300));
      throw new HubSpotError(r.status, `HubSpot ${r.status}: ${msg}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }
  throw new HubSpotError(500, "HubSpot did not answer");
}

/** Maps every active profile without a hubspot_owner_id to the HubSpot owner with the same email. */
export async function mapHubspotOwners(
  // deno-lint-ignore no-explicit-any
  db: any,
): Promise<{ checked: number; mapped: number; unmatched: string[] }> {
  const { data: profs } = await db.from("profiles").select("id,email").eq("status", "active").is("hubspot_owner_id", null);
  let mapped = 0;
  const unmatched: string[] = [];
  for (const p of (profs ?? []) as { id: string; email: string }[]) {
    try {
      const r = await hs<{ results?: { id: string; email?: string }[] }>(
        `/crm/v3/owners?email=${encodeURIComponent(p.email)}&limit=1`,
      );
      const o = (r.results ?? []).find((x) => String(x.email ?? "").toLowerCase() === p.email.toLowerCase()) ?? r.results?.[0];
      if (o?.id) {
        const { error } = await db.from("profiles").update({ hubspot_owner_id: String(o.id) }).eq("id", p.id);
        if (!error) mapped++;
      } else unmatched.push(p.email);
    } catch {
      unmatched.push(p.email);
    }
  }
  return { checked: (profs ?? []).length, mapped, unmatched };
}

export interface Filter {
  propertyName: string;
  operator: string;
  value?: string;
  values?: string[];
}

export async function hsSearch(
  objectType: string,
  body: { filterGroups?: { filters: Filter[] }[]; query?: string; properties?: string[]; limit?: number; after?: string; sorts?: unknown[] },
): Promise<{ results: HsObject[]; paging?: { next?: { after: string } } }> {
  return await hs(`/crm/v3/objects/${objectType}/search`, { method: "POST", body: { limit: 10, ...body } });
}

/** Pages through a search (HubSpot caps search at 10k results; we stop at maxItems). */
export async function hsSearchAll(
  objectType: string,
  body: { filterGroups?: { filters: Filter[] }[]; properties?: string[]; sorts?: unknown[] },
  maxItems = 1000,
): Promise<HsObject[]> {
  const out: HsObject[] = [];
  let after: string | undefined;
  do {
    const r = await hsSearch(objectType, { ...body, limit: 100, after });
    out.push(...r.results);
    after = r.paging?.next?.after;
  } while (after && out.length < maxItems);
  return out;
}

export async function hsBatchRead(objectType: string, ids: string[], properties: string[]): Promise<HsObject[]> {
  const out: HsObject[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    if (!chunk.length) continue;
    const r = await hs<{ results: HsObject[] }>(`/crm/v3/objects/${objectType}/batch/read`, {
      method: "POST",
      body: { properties, inputs: chunk.map((id) => ({ id })) },
    });
    out.push(...(r.results ?? []));
  }
  return out;
}

/** v4 batch association read: returns map fromId -> [toIds]. */
export async function hsAssoc(from: string, to: string, ids: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    if (!chunk.length) continue;
    const r = await hs<{ results: { from: { id: string }; to: { toObjectId: number | string }[] }[] }>(
      `/crm/v4/associations/${from}/${to}/batch/read`,
      { method: "POST", body: { inputs: chunk.map((id) => ({ id })) } },
    );
    for (const row of r.results ?? []) {
      map.set(String(row.from.id), (row.to ?? []).map((t) => String(t.toObjectId)));
    }
  }
  return map;
}

// deno-lint-ignore no-explicit-any
type LeadLike = Record<string, any>;

export async function hsCompanyByDomain(domain: string | null | undefined): Promise<HsObject | null> {
  if (!domain) return null;
  const r = await hsSearch("companies", {
    filterGroups: [{ filters: [{ propertyName: "domain", operator: "EQ", value: domain }] }],
    properties: ["name", "domain", "num_associated_deals", "hubspot_owner_id"],
  });
  return r.results[0] ?? null;
}

export async function hsFindContact(l: LeadLike): Promise<string | null> {
  const { first } = splitName(l.name);
  const email = l.enrichment?.email;
  if (email) {
    const r = await hsSearch("contacts", {
      filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }],
      properties: ["firstname", "lastname", "company"],
    });
    if (r.results[0]) return String(r.results[0].id);
  }
  const token = coName(l.company).split(/\s+/)[0];
  if (!first || !token) return null;
  const r = await hsSearch("contacts", {
    filterGroups: [{
      filters: [
        { propertyName: "firstname", operator: "EQ", value: first },
        { propertyName: "company", operator: "CONTAINS_TOKEN", value: token },
      ],
    }],
    properties: ["firstname", "lastname", "company"],
  });
  return r.results[0] ? String(r.results[0].id) : null;
}

/** Port of the reference hsEnsureContact. Returns the contact id (creating one when needed). */
export async function hsEnsureContact(l: LeadLike, ownerId: string | null, asUser: string | null = null): Promise<string> {
  if (l.hubspot_contact_id) return String(l.hubspot_contact_id);
  const found = await hsFindContact(l);
  if (found) return found;
  const { first, last } = splitName(l.name);
  const props: Record<string, string> = { firstname: first, jobtitle: l.title || "", company: coName(l.company) };
  if (last) props.lastname = last;
  if (l.enrichment?.email) props.email = l.enrichment.email;
  if (l.enrichment?.phone) props.phone = l.enrichment.phone;
  if (l.domain) props.website = l.domain;
  if (ownerId) props.hubspot_owner_id = ownerId;
  const co = await hsCompanyByDomain(l.domain).catch(() => null);
  const created = await hs<HsObject>("/crm/v3/objects/contacts", {
    method: "POST",
    asUser,
    body: {
      properties: props,
      associations: co
        ? [{ to: { id: co.id }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: ASSOC.CONTACT_TO_COMPANY }] }]
        : [],
    },
  });
  if (!created?.id) throw new Error("HubSpot did not return the new contact id");
  return String(created.id);
}

/** Port of the reference hsDeal: finds the "<Company> <> <Seller> POC" deal (any "POC" deal when no seller is set). */
export async function hsFindPocDeal(l: LeadLike, seller = ""): Promise<string | null> {
  if (l.hubspot_deal_id) return String(l.hubspot_deal_id);
  const word = coName(l.company).split(/\s+/)[0];
  if (!word) return null;
  const r = await hsSearch("deals", { query: word, properties: ["dealname", "dealstage"] });
  const d = r.results.find((x) => {
    const n = String(x.properties?.dealname ?? "").toLowerCase();
    return n.includes(`${seller.trim().toLowerCase()} poc`.trim()) && n.includes(word.toLowerCase());
  });
  return d ? String(d.id) : null;
}

/** Creates the note linked to every given record (deal, contact, company), so it shows on each timeline. */
export async function hsCreateNote(body: string, timestamp: string, targets: NoteTargets, asUser: string | null = null): Promise<string> {
  const r = await hs<HsObject>("/crm/v3/objects/notes", {
    method: "POST",
    asUser,
    body: { properties: { hs_note_body: body, hs_timestamp: timestamp }, associations: noteAssociations(targets) },
  });
  return String(r?.id ?? "");
}

/** HubSpot dedupe used by research: company with deals, or a matching contact, means "already in HubSpot". */
export async function hsDedupe(l: LeadLike): Promise<{ hit: boolean; reason: string; contactId?: string; companyId?: string }> {
  const co = await hsCompanyByDomain(l.domain);
  if (co && Number(co.properties?.num_associated_deals ?? 0) > 0) {
    return { hit: true, reason: `HubSpot company ${co.properties?.name ?? l.domain} already has deals`, companyId: co.id };
  }
  const contact = await hsFindContact(l);
  if (contact) return { hit: true, reason: "matching contact already in HubSpot", contactId: contact, companyId: co?.id };
  return { hit: false, reason: "", companyId: co?.id };
}

export const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
