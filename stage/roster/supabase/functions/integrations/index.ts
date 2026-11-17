// POST {action, ...}: connect and manage integrations from Admin > Integrations.
// Actions: status, save_key, save_app, test, disconnect, oauth_start, map_owners, worker_token,
//          hubspot_owners, hubspot_link_owner, hubspot_unlink_owner, hubspot_review_owner.
// Keys and tokens never leave the server; responses carry labels and booleans only.
import { errMsg, fetchWithTimeout, HttpError, json, readJson, serve } from "../_shared/cors.ts";
import { adminClient, audit, type Caller, getCaller, nowISO, platformClient, requirePerm } from "../_shared/supabase.ts";
import { currentWorkspace } from "../_shared/workspace.ts";
import { validWakeUrl, wakeConfig } from "../_shared/wake.ts";
import {
  type ConnectionRow,
  deleteSecret,
  getConnection,
  getSecret,
  getSecretJson,
  last4,
  type Provider,
  type SecretName,
  secretSource,
  setSecret,
  upsertConnection,
  vaultGet,
} from "../_shared/secrets.ts";
import { checkHubspotPat, HUBSPOT_OPTIONAL_SCOPES, HUBSPOT_PAT_SCOPES, HUBSPOT_SCOPES, hs, hsListOwners, hsOwnerById, hubspotConfigured, hubspotUserTokensName, mapHubspotOwners, ownerLabel } from "../_shared/hubspot.ts";
import { allowedDomain, gcal, hdParam, GOOGLE_SCOPES, googleApp, GoogleAuthError, type GoogleTokens, googleTokensName, revokeGoogleToken } from "../_shared/google.ts";
import { callbackUrl, safeReturnTo, signState } from "../_shared/oauth.ts";
import { SENDER_SCOPES, senderAccessToken, senderTokens } from "../_shared/gmail.ts";

type KeyProvider = "apollo" | "fullenrich" | "exa";
type AppProvider = "hubspot_app" | "google_app";
const KEY_PROVIDERS: KeyProvider[] = ["apollo", "fullenrich", "exa"];
const APP_PROVIDERS: AppProvider[] = ["hubspot_app", "google_app"];
const ORG_PROVIDERS: Provider[] = ["hubspot", "apollo", "fullenrich", "exa", "gmail_sender", "hubspot_app", "google_app"];

const SECRET_OF: Record<Exclude<Provider, "google_calendar">, SecretName> = {
  hubspot: "int_hubspot_tokens",
  apollo: "int_apollo_key",
  fullenrich: "int_fullenrich_key",
  exa: "int_exa_key",
  gmail_sender: "int_gmail_sender_tokens",
  anthropic: "int_anthropic_key",
  hubspot_app: "int_hubspot_app",
  google_app: "int_google_app",
};
const NAME: Record<Provider, string> = {
  hubspot: "HubSpot",
  google_calendar: "Google Calendar",
  apollo: "Apollo",
  fullenrich: "FullEnrich",
  exa: "Exa",
  gmail_sender: "Invite mailbox",
  anthropic: "Anthropic",
  hubspot_app: "HubSpot app",
  google_app: "Google OAuth client",
};

// deno-lint-ignore no-explicit-any
type Body = Record<string, any>;

serve(async (req) => {
  if (req.method !== "POST") throw new HttpError(405, "Use POST");
  const caller = await getCaller(req);
  const body = await readJson<Body>(req);
  const action = String(body.action ?? "status");

  switch (action) {
    case "status":
      return json(await status(caller));
    case "save_key":
      return json(await saveKey(caller, body));
    case "save_app":
      return json(await saveApp(caller, body));
    case "save_hubspot_token":
      return json(await saveHubspotToken(caller, body));
    case "test":
      return json(await test(caller, body));
    case "disconnect":
      return json(await disconnect(caller, body));
    case "oauth_start":
      return json(await oauthStart(caller, body));
    case "worker_token":
      return json(await workerToken(caller));
    case "save_wake":
      return json(await saveWake(caller, body));
    case "map_owners": {
      requirePerm(caller, "manage_integrations");
      if (!(await hubspotConfigured())) throw new HttpError(409, "HubSpot is not connected");
      const r = await mapHubspotOwners(adminClient());
      await audit(caller.id, "integrations.map_owners", "hubspot", `mapped ${r.mapped} of ${r.checked}`);
      return json({ ok: true, ...r });
    }
    case "hubspot_owners":
      return json(await hubspotOwners(caller));
    case "hubspot_link_owner":
      return json(await linkOwner(caller, body));
    case "hubspot_unlink_owner":
      return json(await unlinkOwner(caller));
    case "hubspot_review_owner":
      return json(await reviewOwner(caller, body));
    default:
      throw new HttpError(400, "Unknown action");
  }
});

// ---------------------------------------------------------------------------
// HubSpot owner picker (works with the private app token; no per-rep sign-in needed)
// ---------------------------------------------------------------------------

/** Active HubSpot owners and which roster user each is linked to. Any member, so reps can find themselves. */
async function hubspotOwners(caller: Caller) {
  if (!(await hubspotConfigured())) throw new HttpError(409, "HubSpot is not connected yet. Ask an admin to connect it.");
  const db = adminClient();
  const [owners, { data: profs }] = await Promise.all([
    hsListOwners(),
    db.from("profiles").select("id,full_name,email,hubspot_owner_id").not("hubspot_owner_id", "is", null),
  ]);
  const by = new Map((profs ?? []).map((p) => [String(p.hubspot_owner_id), p]));
  const mine = String(caller.email || "").toLowerCase();
  return {
    ok: true,
    owners: owners
      .map((o) => {
        const p = by.get(o.id);
        return {
          id: o.id,
          name: [o.firstName, o.lastName].filter(Boolean).join(" ") || o.email,
          email: o.email,
          email_match: !!o.email && o.email.toLowerCase() === mine,
          linked_to: p ? { id: p.id, name: p.full_name || p.email, me: p.id === caller.id } : null,
        };
      })
      .sort((a, b) => Number(b.email_match) - Number(a.email_match) || a.name.localeCompare(b.name)),
  };
}

/** Links an owner to one profile and takes it off anyone else who had it. */
async function setOwner(db: ReturnType<typeof adminClient>, actor: string, uid: string, ownerId: string, label: string, how: string) {
  const { data: others } = await db.from("profiles").select("id").eq("hubspot_owner_id", ownerId).neq("id", uid);
  for (const o of others ?? []) {
    await db.from("profiles").update({ hubspot_owner_id: null, hubspot_owner_label: null, updated_at: nowISO() }).eq("id", o.id);
    await audit(actor, "hubspot.owner_unlinked", o.id, `owner ${ownerId} moved to ${uid}`);
  }
  const { error } = await db.from("profiles").update({
    hubspot_owner_id: ownerId, hubspot_owner_label: label,
    hubspot_owner_pending: null, hubspot_owner_pending_label: null, hubspot_owner_pending_at: null, updated_at: nowISO(),
  }).eq("id", uid);
  if (error) throw new HttpError(500, "Could not save the HubSpot owner");
  await audit(actor, "hubspot.owner_linked", uid, `${label} (${ownerId}) ${how}`);
}

/** A rep picks their HubSpot user. Same email (or an admin linking themselves) links now; anything else is a
    request an admin approves. */
async function linkOwner(caller: Caller, body: Body) {
  const ownerId = String(body.owner_id ?? "").trim();
  if (!/^\d+$/.test(ownerId)) throw new HttpError(400, "owner_id is required");
  if (!(await hubspotConfigured())) throw new HttpError(409, "HubSpot is not connected yet. Ask an admin to connect it.");
  const o = await hsOwnerById(ownerId);
  if (!o) throw new HttpError(404, "That HubSpot user isn't an active owner any more. Refresh the list.");
  const label = ownerLabel(o);
  const db = adminClient();
  const emailMatch = !!o.email && o.email.toLowerCase() === String(caller.email || "").toLowerCase();
  if (emailMatch || caller.can("manage_users")) {
    await setOwner(db, caller.id, caller.id, ownerId, label, emailMatch ? "by the rep (email match)" : "by an admin for themselves");
    return { ok: true, status: "linked", owner_id: ownerId, owner_label: label };
  }
  const { error } = await db.from("profiles").update({
    hubspot_owner_pending: ownerId, hubspot_owner_pending_label: label, hubspot_owner_pending_at: nowISO(), updated_at: nowISO(),
  }).eq("id", caller.id);
  if (error) throw new HttpError(500, "Could not save the request");
  await audit(caller.id, "hubspot.owner_requested", caller.id, `${label} (${ownerId})`);
  return { ok: true, status: "pending", owner_id: ownerId, owner_label: label };
}

/** Clears the caller's own link and any open request. */
async function unlinkOwner(caller: Caller) {
  const db = adminClient();
  await db.from("profiles").update({
    hubspot_owner_id: null, hubspot_owner_label: null,
    hubspot_owner_pending: null, hubspot_owner_pending_label: null, hubspot_owner_pending_at: null, updated_at: nowISO(),
  }).eq("id", caller.id);
  await audit(caller.id, "hubspot.owner_unlinked", caller.id, "by the rep");
  return { ok: true };
}

/** Admin approves or rejects a rep's request. */
async function reviewOwner(caller: Caller, body: Body) {
  requirePerm(caller, "manage_users");
  const uid = String(body.user_id ?? "");
  const approve = body.approve === true;
  const db = adminClient();
  const { data: p } = await db.from("profiles").select("id,hubspot_owner_pending,hubspot_owner_pending_label").eq("id", uid).maybeSingle();
  if (!p?.hubspot_owner_pending) throw new HttpError(404, "No open HubSpot request for that user");
  if (!approve) {
    await db.from("profiles").update({ hubspot_owner_pending: null, hubspot_owner_pending_label: null, hubspot_owner_pending_at: null, updated_at: nowISO() }).eq("id", uid);
    await audit(caller.id, "hubspot.owner_rejected", uid, `${p.hubspot_owner_pending_label} (${p.hubspot_owner_pending})`);
    return { ok: true, status: "rejected" };
  }
  const o = await hsOwnerById(String(p.hubspot_owner_pending));
  if (!o) throw new HttpError(404, "That HubSpot user isn't an active owner any more");
  await setOwner(db, caller.id, uid, o.id, ownerLabel(o), "approved by an admin");
  return { ok: true, status: "linked" };
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

async function sourceOf(p: Exclude<Provider, "google_calendar">): Promise<"app" | "env" | null> {
  if (p === "hubspot") {
    const t = await vaultGet("int_hubspot_tokens").catch(() => null);
    if (t) return "app";
    if (await vaultGet("int_hubspot_pat").catch(() => null)) return "app";
    return null;
  }
  return await secretSource(SECRET_OF[p]);
}

async function status(caller: Caller) {
  const admin = caller.can("manage_integrations");
  const db = adminClient();
  const { data: rows } = await db.from("integration_connections").select("*").eq("scope", "org");
  const byProvider = new Map<string, ConnectionRow>(((rows ?? []) as ConnectionRow[]).map((r) => [r.provider, r]));

  const providers: Record<string, unknown> = {};
  await Promise.all(ORG_PROVIDERS.map(async (p) => {
    const via = await sourceOf(p as Exclude<Provider, "google_calendar">);
    const row = byProvider.get(p);
    let st: "connected" | "error" | "disconnected" = "disconnected";
    let label: string | null = null;
    if (via === "app") {
      st = row?.status === "error" ? "error" : "connected";
      label = row?.account_label ?? null;
    } else if (via === "env") {
      st = "connected";
      label = "From server settings";
    }
    const connected = st === "connected";
    providers[p] = admin
      ? {
        connected,
        scope: "org",
        account_label: label,
        status: st,
        error: via === "app" ? row?.error ?? null : null,
        last_checked_at: row?.last_checked_at ?? null,
        connected_at: via === "app" ? row?.connected_at ?? null : null,
        configured_via: via,
        meta: via === "app" ? row?.meta ?? null : null,
      }
      : { connected };
  }));

  const myRow = await getConnection("google_calendar", caller.id);
  const myTokens = await vaultGet(googleTokensName(caller.id)).catch(() => null);
  const myStatus = myTokens ? (myRow?.status === "error" ? "error" : "connected") : "disconnected";
  const hubspotApp = await getSecretJson<{ client_id?: string }>("int_hubspot_app");
  const gApp = await googleApp();
  const hsRow = await getConnection("hubspot", caller.id);
  const hsTokens = await vaultGet(hubspotUserTokensName(caller.id)).catch(() => null);
  const hsStatus = hsTokens ? (hsRow?.status === "error" ? "error" : "connected") : "disconnected";
  const { data: me } = await db.from("profiles").select("hubspot_owner_label,hubspot_owner_pending,hubspot_owner_pending_label").eq("id", caller.id).maybeSingle();
  const reviewer = caller.can("manage_users");
  const { data: pend } = reviewer
    ? await db.from("profiles").select("id,full_name,email,hubspot_owner_id,hubspot_owner_pending,hubspot_owner_pending_label,hubspot_owner_pending_at")
      .not("hubspot_owner_pending", "is", null).order("hubspot_owner_pending_at")
    : { data: [] };
  const pendingOwners = (pend ?? []).map((r) => ({
    user_id: r.id, name: r.full_name || r.email, email: r.email, current: r.hubspot_owner_id,
    owner_id: r.hubspot_owner_pending, owner_label: r.hubspot_owner_pending_label, requested_at: r.hubspot_owner_pending_at,
  }));

  return {
    ok: true,
    is_admin: admin,
    providers,
    me: {
      google_calendar: {
        connected: myStatus === "connected",
        scope: "user",
        status: myStatus,
        account_label: myTokens ? myRow?.account_label ?? null : null,
        error: myStatus === "error" ? myRow?.error ?? null : null,
        last_checked_at: myRow?.last_checked_at ?? null,
        configured_via: myTokens ? "app" : null,
      },
      hubspot: {
        connected: hsStatus === "connected",
        scope: "user",
        status: hsStatus,
        account_label: hsTokens ? hsRow?.account_label ?? null : null,
        error: hsStatus === "error" ? hsRow?.error ?? null : null,
        last_checked_at: hsRow?.last_checked_at ?? null,
        configured_via: hsTokens ? "app" : null,
        owner_id: caller.hubspot_owner_id ?? null,
        owner_label: me?.hubspot_owner_label ?? null,
        owner_pending: me?.hubspot_owner_pending ?? null,
        owner_pending_label: me?.hubspot_owner_pending_label ?? null,
      },
    },
    hubspot_pending: pendingOwners,
    can_review_owners: reviewer,
    // A client ID that isn't HubSpot's UUID (e.g. a pasted URL) makes HubSpot answer "invalid app_id".
    hubspot_app_configured: HS_CLIENT_ID.test(String(hubspotApp?.client_id ?? "")),
    hubspot_app_invalid: !!hubspotApp?.client_id && !HS_CLIENT_ID.test(String(hubspotApp.client_id)),
    google_app_configured: !!gApp,
    callback_url: callbackUrl(),
    redirect_urls: { hubspot: callbackUrl(), google: callbackUrl() },
    hubspot_scopes: HUBSPOT_SCOPES,
    hubspot_pat_scopes: HUBSPOT_PAT_SCOPES,
    hubspot_optional_scopes: HUBSPOT_OPTIONAL_SCOPES,
    google_scopes: GOOGLE_SCOPES,
    worker: await workerStatus(admin),
    wake: admin
      ? {
        research: !!(await wakeConfig("research").catch(() => null)),
        post_call: !!(await wakeConfig("post_call").catch(() => null)),
      }
      : null,
    platform_admin: (await caller.client.rpc("is_platform_admin")).data === true,
  };
}

// ---------------------------------------------------------------------------
// Key validation (live)
// ---------------------------------------------------------------------------

interface Check {
  valid: boolean;
  label: string | null;
  error: string | null;
  meta?: Record<string, unknown>;
}

async function validateKey(p: KeyProvider, key: string): Promise<Check> {
  try {
    if (p === "apollo") return await validateApollo(key);
    if (p === "exa") return await validateExa(key);
    return await validateFullEnrich(key);
  } catch (e) {
    return { valid: false, label: null, error: `Could not reach ${NAME[p]}: ${errMsg(e)}`.slice(0, 300) };
  }
}

async function validateApollo(key: string): Promise<Check> {
  const label = `Apollo key …${last4(key)}`;
  try {
    const r = await fetchWithTimeout("https://api.apollo.io/v1/auth/health", {
      headers: { "X-Api-Key": key, "Cache-Control": "no-cache" },
    }, 15000);
    if (r.ok) {
      const d = await r.json().catch(() => ({}));
      if (d?.is_logged_in === true) return { valid: true, label, error: null };
    }
  } catch { /* fall back to a 1-row search */ }
  const r = await fetchWithTimeout("https://api.apollo.io/api/v1/mixed_people/api_search", {
    method: "POST",
    headers: { "X-Api-Key": key, "Content-Type": "application/json", "Cache-Control": "no-cache" },
    body: JSON.stringify({ page: 1, per_page: 1 }),
  }, 20000);
  if (r.ok) return { valid: true, label, error: null };
  const t = await r.text();
  if (r.status === 401 || r.status === 403) {
    return { valid: false, label: null, error: `Apollo rejected the key (${r.status}). Use a master API key.` };
  }
  return { valid: false, label: null, error: `Apollo ${r.status}: ${t.slice(0, 200)}` };
}

/** A one-result search costs a fraction of a cent and proves the key works. */
async function validateExa(key: string): Promise<Check> {
  const r = await fetchWithTimeout("https://api.exa.ai/search", {
    method: "POST",
    headers: { "x-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({ query: "B2B software company", numResults: 1, type: "fast" }),
  }, 20000);
  if (r.ok) return { valid: true, label: `Exa key …${last4(key)}`, error: null };
  const t = await r.text();
  if (r.status === 401 || r.status === 403) return { valid: false, label: null, error: "Exa rejected the key" };
  if (r.status === 402) return { valid: false, label: null, error: "Exa says the account is out of credits" };
  return { valid: false, label: null, error: `Exa ${r.status}: ${t.slice(0, 200)}` };
}

async function validateFullEnrich(key: string): Promise<Check> {
  const r = await fetchWithTimeout("https://app.fullenrich.com/api/v1/account/credits", {
    headers: { Authorization: `Bearer ${key}` },
  }, 15000);
  const t = await r.text();
  if (!r.ok) {
    return { valid: false, label: null, error: r.status === 401 || r.status === 403 ? "FullEnrich rejected the key" : `FullEnrich ${r.status}: ${t.slice(0, 200)}` };
  }
  // deno-lint-ignore no-explicit-any
  let d: any = {};
  try {
    d = JSON.parse(t);
  } catch { /* keep empty */ }
  const bal = d.balance ?? d.credits ?? d.credits_left ?? d.data?.balance;
  const credits = typeof bal === "number" || (typeof bal === "string" && bal !== "") ? Number(bal) : null;
  const label = credits !== null && !Number.isNaN(credits)
    ? `${credits.toLocaleString("en-IN")} credits · key …${last4(key)}`
    : `FullEnrich key …${last4(key)}`;
  return { valid: true, label, error: null, meta: { credits } };
}

// ---------------------------------------------------------------------------
// save_hubspot_token: a HubSpot private app token instead of the OAuth app
// ---------------------------------------------------------------------------

async function saveHubspotToken(caller: Caller, body: Body) {
  requirePerm(caller, "manage_integrations");
  const token = String(body.token ?? "").trim();
  if (token.length < 20 || /\s/.test(token)) throw new HttpError(400, "Paste the full private app token");
  const c = await checkHubspotPat(token);
  if (!c.ok) throw new HttpError(400, c.error ?? "HubSpot rejected the token");
  await setSecret("int_hubspot_pat", token);
  const now = nowISO();
  await upsertConnection("hubspot", null, {
    status: c.missing.length ? "error" : "connected",
    account_label: `Private app${c.hub ? ` · portal ${c.hub}` : ""} · token …${last4(token)}`,
    error: c.missing.length ? `Add these scopes to the private app, then save the token again: ${c.missing.join(", ")}` : null,
    meta: { kind: "private_app", hub_id: c.hub ?? null, missing_scopes: c.missing },
    connected_by: caller.id,
    connected_at: now,
    last_checked_at: now,
  });
  await audit(caller.id, "integrations.save_key", "hubspot", `private app token ending ${last4(token)}`);
  let mapped = 0;
  try {
    mapped = (await mapHubspotOwners(adminClient())).mapped;
  } catch { /* owners map later */ }
  return { ok: true, missing_scopes: c.missing, mapped };
}

// ---------------------------------------------------------------------------
// save_key / save_app
// ---------------------------------------------------------------------------

async function saveKey(caller: Caller, body: Body) {
  requirePerm(caller, "manage_integrations");
  const p = String(body.provider ?? "") as KeyProvider;
  if (!KEY_PROVIDERS.includes(p)) throw new HttpError(400, "provider must be apollo, fullenrich or exa");
  if (p === "exa") await requirePlatformAdmin(caller, "Exa is run by the platform for every workspace, so only platform admins change its key");
  const key = String(body.api_key ?? "").trim();
  if (key.length < 8 || /\s/.test(key)) throw new HttpError(400, "Paste the full API key");

  const check = await validateKey(p, key);
  if (!check.valid) throw new HttpError(400, check.error ?? `${NAME[p]} rejected the key`);

  await setSecret(SECRET_OF[p], key);
  const now = nowISO();
  await upsertConnection(p, null, {
    status: "connected",
    account_label: check.label,
    meta: check.meta ?? {},
    connected_by: caller.id,
    connected_at: now,
    last_checked_at: now,
    error: null,
  });
  await audit(caller.id, "integrations.save_key", p, `saved ${NAME[p]} key ending ${last4(key)}`);
  return { ok: true, provider: p, status: "connected", account_label: check.label, last_checked_at: now };
}

const HS_CLIENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The OAuth apps are shared by every workspace, so only platform admins may change them. */
async function requirePlatformAdmin(caller: Caller, why = "Only platform admins can change the shared OAuth apps") {
  const { data, error } = await caller.client.rpc("is_platform_admin");
  if (error || data !== true) throw new HttpError(403, why);
}

async function saveApp(caller: Caller, body: Body) {
  requirePerm(caller, "manage_integrations");
  await requirePlatformAdmin(caller);
  const p = String(body.provider ?? "") as AppProvider;
  if (!APP_PROVIDERS.includes(p)) throw new HttpError(400, "provider must be hubspot_app or google_app");
  const client_id = String(body.client_id ?? "").trim();
  const client_secret = String(body.client_secret ?? "").trim();
  if (!client_id || !client_secret) throw new HttpError(400, "client_id and client_secret are required");
  if (/\s/.test(client_id) || /\s/.test(client_secret)) throw new HttpError(400, "Client ID and secret cannot contain spaces");
  if (p === "google_app" && !/\.apps\.googleusercontent\.com$/.test(client_id)) {
    throw new HttpError(400, "A Google client ID ends with .apps.googleusercontent.com");
  }
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (p === "hubspot_app" && (!UUID.test(client_id) || !UUID.test(client_secret))) {
    throw new HttpError(
      400,
      "HubSpot's Client ID and Client secret both look like 8-4-4-4-12 codes (e.g. 1a2b3c4d-…). Copy them from your HubSpot app's Auth tab, not the redirect URL or app URL.",
    );
  }

  await setSecret(SECRET_OF[p], JSON.stringify({ client_id, client_secret }));
  const now = nowISO();
  const label = `Client …${last4(client_id)}`;
  await upsertConnection(p, null, {
    status: "connected",
    account_label: label,
    meta: {},
    connected_by: caller.id,
    connected_at: now,
    last_checked_at: now,
    error: null,
  });
  await audit(caller.id, "integrations.save_app", p, `saved ${NAME[p]} ${label}`);
  return { ok: true, provider: p, status: "connected", account_label: label, callback_url: callbackUrl() };
}

// ---------------------------------------------------------------------------
// test
// ---------------------------------------------------------------------------

async function test(caller: Caller, body: Body) {
  const p = String(body.provider ?? "") as Provider;
  if (p === "google_calendar") {
    const now = nowISO();
    try {
      await gcal(caller.id, "/calendars/primary/events", { query: { maxResults: "1", timeMin: now } });
      await upsertConnection("google_calendar", caller.id, { status: "connected", error: null, last_checked_at: now });
      return { ok: true, provider: p, status: "connected", error: null, last_checked_at: now };
    } catch (e) {
      if (e instanceof GoogleAuthError) {
        return { ok: true, provider: p, status: e.code === "not_connected" ? "disconnected" : "error", error: e.code, last_checked_at: now };
      }
      const msg = errMsg(e).slice(0, 300);
      await upsertConnection("google_calendar", caller.id, { status: "error", error: msg, last_checked_at: now }).catch(() => {});
      return { ok: true, provider: p, status: "error", error: msg, last_checked_at: now };
    }
  }

  requirePerm(caller, "manage_integrations");
  if (!ORG_PROVIDERS.includes(p)) throw new HttpError(400, "Unknown provider");
  if (p === "exa") await requirePlatformAdmin(caller, "Exa is run by the platform for every workspace, so only platform admins change its key");
  if ((APP_PROVIDERS as string[]).includes(p)) await requirePlatformAdmin(caller);
  const via = await sourceOf(p as Exclude<Provider, "google_calendar">);
  const now = nowISO();
  if (!via) return { ok: true, provider: p, status: "disconnected", error: "not_connected", configured_via: null, last_checked_at: now };

  let check: Check;
  if ((KEY_PROVIDERS as string[]).includes(p)) {
    const key = (await getSecret(SECRET_OF[p as KeyProvider])) ?? "";
    check = await validateKey(p as KeyProvider, key);
  } else if (p === "gmail_sender") {
    try {
      const { email } = await senderAccessToken(true);
      check = { valid: true, label: email || null, error: null };
    } catch (e) {
      check = { valid: false, label: null, error: errMsg(e).slice(0, 300) };
    }
  } else if (p === "hubspot") {
    try {
      await hs("/crm/v3/owners?limit=1");
      check = { valid: true, label: null, error: null };
    } catch (e) {
      check = { valid: false, label: null, error: errMsg(e).slice(0, 300) };
    }
  } else {
    const app = await getSecretJson<{ client_id?: string; client_secret?: string }>(SECRET_OF[p as AppProvider]);
    check = app?.client_id && app?.client_secret
      ? { valid: true, label: null, error: null }
      : { valid: false, label: null, error: "Stored client details are incomplete" };
  }

  if (via === "app") {
    const fields: Partial<ConnectionRow> = { status: check.valid ? "connected" : "error", error: check.error, last_checked_at: now };
    if (check.valid && check.label) fields.account_label = check.label;
    if (check.meta) fields.meta = check.meta;
    await upsertConnection(p, null, fields);
  }
  return {
    ok: true,
    provider: p,
    status: check.valid ? "connected" : "error",
    error: check.error,
    account_label: check.label,
    configured_via: via,
    last_checked_at: now,
  };
}

// ---------------------------------------------------------------------------
// save_wake: this workspace's routine API triggers ({kind, url, token}; an empty url turns the wake-up off)
// ---------------------------------------------------------------------------

async function saveWake(caller: Caller, body: Body) {
  requirePerm(caller, "manage_integrations");
  const kind = String(body.kind ?? "");
  if (kind !== "research" && kind !== "post_call") throw new HttpError(400, "kind must be research or post_call");
  const name = kind === "research" ? "int_research_wake" : "int_post_call_wake";
  const url = String(body.url ?? "").trim();
  if (!url) {
    await deleteSecret(name).catch(() => {});
    await audit(caller.id, "integrations.save_wake", kind, "turned off");
    return { ok: true, kind, configured: false };
  }
  const token = String(body.token ?? "").trim();
  if (!validWakeUrl(url)) throw new HttpError(400, "Paste the routine's API trigger URL (https://api.anthropic.com/v1/claude_code/routines/…/fire)");
  if (token.length < 8 || /\s/.test(token)) throw new HttpError(400, "Paste the full trigger token");
  await setSecret(name, JSON.stringify({ url, token }));
  await audit(caller.id, "integrations.save_wake", kind, `token ending ${last4(token)}`);
  return { ok: true, kind, configured: true };
}

// ---------------------------------------------------------------------------
// disconnect
// ---------------------------------------------------------------------------

async function disconnect(caller: Caller, body: Body) {
  const p = String(body.provider ?? "") as Provider;

  if ((p as string) === "hubspot_user") {
    let uid = caller.id;
    if (body.user_id && body.user_id !== caller.id) {
      requirePerm(caller, "manage_integrations");
      uid = String(body.user_id);
    }
    await deleteSecret(hubspotUserTokensName(uid)).catch(() => {});
    if (await getConnection("hubspot", uid)) {
      await upsertConnection("hubspot", uid, { status: "disconnected", error: null, last_checked_at: nowISO() });
    }
    // The owner mapping stays: unlinking only stops notes being written as this person.
    await audit(caller.id, "integrations.disconnect", "hubspot_user", uid === caller.id ? "own HubSpot login" : `user ${uid}`);
    return { ok: true, provider: p, status: "disconnected" };
  }

  if (p === "google_calendar") {
    let uid = caller.id;
    if (body.user_id && body.user_id !== caller.id) {
      requirePerm(caller, "manage_integrations");
      uid = String(body.user_id);
    }
    const raw = await vaultGet(googleTokensName(uid)).catch(() => null);
    if (raw) {
      try {
        const t = JSON.parse(raw) as GoogleTokens;
        await revokeGoogleToken(t.refresh_token || t.access_token || "");
      } catch { /* ignore */ }
      await deleteSecret(googleTokensName(uid));
    }
    if (await getConnection("google_calendar", uid)) {
      await upsertConnection("google_calendar", uid, { status: "disconnected", error: null, last_checked_at: nowISO() });
    }
    await audit(caller.id, "integrations.disconnect", "google_calendar", uid === caller.id ? "own calendar" : `user ${uid}`);
    return { ok: true, provider: p, status: "disconnected" };
  }

  requirePerm(caller, "manage_integrations");
  if (!ORG_PROVIDERS.includes(p)) throw new HttpError(400, "Unknown provider");
  if (p === "exa") await requirePlatformAdmin(caller, "Exa is run by the platform for every workspace, so only platform admins change its key");
  if (p === "hubspot") await deleteSecret("int_hubspot_pat").catch(() => {});
  if (p === "gmail_sender") {
    const t = await senderTokens();
    if (t) await revokeGoogleToken(t.refresh_token || t.access_token || "").catch(() => {});
  }
  await deleteSecret(SECRET_OF[p as Exclude<Provider, "google_calendar">]);
  if (await getConnection(p, null)) {
    await upsertConnection(p, null, { status: "disconnected", error: null, last_checked_at: nowISO() });
  }
  await audit(caller.id, "integrations.disconnect", p, `disconnected ${NAME[p]}`);
  const via = await sourceOf(p as Exclude<Provider, "google_calendar">);
  // When an env fallback exists the integration keeps working from server settings.
  return { ok: true, provider: p, status: via ? "connected" : "disconnected", configured_via: via };
}

// ---------------------------------------------------------------------------
// oauth_start
// ---------------------------------------------------------------------------

async function oauthStart(caller: Caller, body: Body) {
  const p = String(body.provider ?? "");
  const rt = await safeReturnTo(body.return_to ? String(body.return_to) : null);
  if (!rt) throw new HttpError(400, "return_to is not an allowed origin and the APP_URL secret is not set");

  if (p === "hubspot") {
    requirePerm(caller, "manage_integrations");
    const app = await getSecretJson<{ client_id?: string }>("int_hubspot_app");
    if (!app?.client_id) throw new HttpError(409, "Set up the HubSpot app first");
    const state = await signState("hubspot", caller.id, rt);
    const q = new URLSearchParams({
      client_id: app.client_id,
      redirect_uri: callbackUrl(),
      scope: HUBSPOT_SCOPES.join(" "),
      optional_scope: HUBSPOT_OPTIONAL_SCOPES.join(" "),
      state,
    });
    return { ok: true, url: `https://app.hubspot.com/oauth/authorize?${q.toString()}` };
  }

  if (p === "hubspot_user") {
    // Any member links their own HubSpot login; it maps them to their HubSpot owner.
    const app = await getSecretJson<{ client_id?: string }>("int_hubspot_app");
    if (!app?.client_id) throw new HttpError(409, "An admin needs to set up the HubSpot app first (Admin > Integrations > HubSpot).");
    const state = await signState("hubspot_user", caller.id, rt);
    const q = new URLSearchParams({
      client_id: app.client_id,
      redirect_uri: callbackUrl(),
      scope: HUBSPOT_SCOPES.join(" "),
      optional_scope: HUBSPOT_OPTIONAL_SCOPES.join(" "),
      state,
    });
    return { ok: true, url: `https://app.hubspot.com/oauth/authorize?${q.toString()}` };
  }

  if (p === "google_calendar") {
    const app = await googleApp();
    if (!app) throw new HttpError(409, "An admin needs to set up the Google OAuth client first");
    const state = await signState("google_calendar", caller.id, rt);
    const q = new URLSearchParams({
      client_id: app.client_id,
      redirect_uri: callbackUrl(),
      response_type: "code",
      scope: GOOGLE_SCOPES.join(" "),
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      ...hdParam(await allowedDomain()),
      login_hint: caller.email,
      state,
    });
    return { ok: true, url: `https://accounts.google.com/o/oauth2/v2/auth?${q.toString()}` };
  }

  if (p === "gmail_sender") {
    // Whoever manages users or integrations connects the team mailbox that sends invitations.
    if (!caller.can("manage_integrations") && !caller.can("manage_users")) throw new HttpError(403, "Your role can't connect the invite mailbox");
    const app = await googleApp();
    if (!app) throw new HttpError(409, "An admin needs to set up the Google OAuth client first");
    const state = await signState("gmail_sender", caller.id, rt);
    const q = new URLSearchParams({
      client_id: app.client_id,
      redirect_uri: callbackUrl(),
      response_type: "code",
      scope: SENDER_SCOPES.join(" "),
      access_type: "offline",
      prompt: "consent select_account",
      ...hdParam(await allowedDomain()),
      login_hint: caller.email,
      state,
    });
    return { ok: true, url: `https://accounts.google.com/o/oauth2/v2/auth?${q.toString()}` };
  }

  throw new HttpError(400, "provider must be hubspot, google_calendar or gmail_sender");
}

// ---------------------------------------------------------------------------
// Claude worker: status and token. The worker is a Claude Code routine or session on a Claude subscription;
// it authenticates to the claude-work function with this token, which also tells it which workspace's queue to work.
// Only the SHA-256 of the token is stored, on the workspace row.
// ---------------------------------------------------------------------------

async function workerToken(caller: Caller) {
  requirePerm(caller, "manage_integrations");
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = "rw_" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)))]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  const { error } = await platformClient().from("workspaces").update({ worker_token_sha256: hash }).eq("id", caller.workspace_id);
  if (error) throw new HttpError(500, "Could not save the worker token: " + error.message);
  await audit(caller.id, "integrations.worker_token", "claude_worker", `new worker token ending ${last4(token)}`);
  return { ok: true, token, endpoint: `${Deno.env.get("SUPABASE_URL")}/functions/v1/claude-work` };
}

async function workerStatus(admin: boolean) {
  const db = adminClient();
  const { data } = await db.from("app_settings").select("value").eq("key", "claude_worker").maybeSingle();
  const v = (data?.value ?? {}) as Record<string, unknown>;
  const last = v.last_seen ? String(v.last_seen) : null;
  const base = { last_seen: last, active: !!last && Date.now() - Date.parse(last) < 26 * 3600e3 };
  if (!admin) return base;
  const queue: Record<string, number> = {};
  await Promise.all(["gating", "held", "pending", "running", "failed"].map(async (st) => {
    const { count } = await db.from("research_queue").select("id", { count: "exact", head: true }).eq("status", st);
    queue[st] = count ?? 0;
  }));
  const { data: ws } = await platformClient().from("workspaces").select("worker_token_sha256").eq("id", currentWorkspace()).maybeSingle();
  const hasToken = !!ws?.worker_token_sha256;
  return {
    ...base,
    has_token: hasToken,
    endpoint: `${Deno.env.get("SUPABASE_URL")}/functions/v1/claude-work`,
    totals: v.totals ?? {},
    last_claim_at: v.last_claim_at ?? null,
    last_submit_at: v.last_submit_at ?? null,
    worker: v.worker ?? null,
    queue,
  };
}
