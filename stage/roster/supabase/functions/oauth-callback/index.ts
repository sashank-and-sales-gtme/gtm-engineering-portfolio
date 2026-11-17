// GET ?code&state (&error): OAuth redirect target for HubSpot and Google Calendar (verify_jwt = false).
// Trust comes from the HMAC-signed state minted by `integrations` oauth_start for a signed-in member.
import { corsHeaders, errMsg, fetchWithTimeout } from "../_shared/cors.ts";
import { adminClient, audit, nowISO, workspaceOfUser } from "../_shared/supabase.ts";
import { setWorkspace, withRequestContext } from "../_shared/workspace.ts";
import { getSecretJson, setSecret, upsertConnection } from "../_shared/secrets.ts";
import { hsOwnerByUserId, hsPortalId, hubspotTokenRequest, type HubSpotTokens, hubspotUserTokensName, mapHubspotOwners, type OAuthApp } from "../_shared/hubspot.ts";
import { allowedDomain, emailFromIdToken, googleApp, googleTokenRequest, type GoogleTokens, googleTokensName, googleUserinfoEmail } from "../_shared/google.ts";
import { appUrl, callbackUrl, type OAuthState, safeReturnTo, verifyState, withResult } from "../_shared/oauth.ts";
import { SENDER_SECRET, senderAddress } from "../_shared/gmail.ts";

class ConnectError extends Error {}

Deno.serve((req: Request) => withRequestContext(() => handle(req)));

async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const url = new URL(req.url);
  let state: OAuthState | null = null;
  try {
    state = await verifyState(url.searchParams.get("state"));
  } catch (e) {
    return await finish(null, { error: errMsg(e) });
  }
  // The connection belongs to the workspace of the member who started it.
  const ws = await workspaceOfUser(state.uid).catch(() => null);
  if (!ws) return await finish(null, { error: "Your access is not active" });
  setWorkspace(ws);

  const providerError = url.searchParams.get("error");
  if (providerError) {
    const desc = url.searchParams.get("error_description");
    return await finish(state, { error: providerError === "access_denied" ? "Access was not granted" : (desc || providerError) });
  }
  const code = url.searchParams.get("code");
  if (!code) return await finish(state, { error: "No authorization code was returned" });

  try {
    // The member who started the flow must still be active.
    const { data: prof } = await adminClient().from("profiles").select("id,email,status,role,is_owner").eq("id", state.uid).maybeSingle();
    if (!prof || prof.status !== "active") throw new ConnectError("Your access is not active");

    if (state.p === "hubspot") await connectHubspot(state, code, prof.role, !!prof.is_owner);
    else if (state.p === "hubspot_user") await connectHubspotUser(state, code);
    else if (state.p === "gmail_sender") await connectSender(state, code, prof.role, !!prof.is_owner);
    else await connectGoogle(state, code, String(prof.email));
    return await finish(state, { connected: state.p });
  } catch (e) {
    if (!(e instanceof ConnectError)) console.error("oauth-callback:", errMsg(e));
    return await finish(state, { error: errMsg(e) });
  }
}

async function connectHubspot(state: OAuthState, code: string, role: string | null, isOwner: boolean) {
  // Re-check the permission at callback time (role could have changed within the 10 minutes).
  if (!isOwner && role !== "super_admin") {
    const { data: r } = await adminClient().from("roles").select("perms").eq("id", role ?? "").maybeSingle();
    if (!((r?.perms as string[] | undefined) ?? []).includes("manage_integrations")) {
      throw new ConnectError("Your role does not allow connecting HubSpot");
    }
  }
  const app = await getSecretJson<OAuthApp>("int_hubspot_app");
  if (!app?.client_id || !app?.client_secret) throw new ConnectError("The HubSpot app is not set up");

  const t = await hubspotTokenRequest({
    grant_type: "authorization_code",
    client_id: app.client_id,
    client_secret: app.client_secret,
    redirect_uri: callbackUrl(),
    code,
  });
  if (!t.refresh_token) throw new ConnectError("HubSpot did not return a refresh token");

  const info = await fetchWithTimeout(`https://api.hubapi.com/oauth/v1/access-tokens/${encodeURIComponent(t.access_token)}`, {}, 15000)
    .then((r) => (r.ok ? r.json() : {}))
    .catch(() => ({})) as { hub_id?: number; user?: string; hub_domain?: string; scopes?: string[] };

  const tokens: HubSpotTokens = {
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expires_at: Date.now() + (t.expires_in ?? 1800) * 1000,
    hub_id: info.hub_id,
    user_email: info.user,
  };
  await setSecret("int_hubspot_tokens", JSON.stringify(tokens));

  const now = nowISO();
  await upsertConnection("hubspot", null, {
    status: "connected",
    account_label: `Portal ${info.hub_id ?? "?"} · ${info.user ?? "unknown user"}`,
    meta: { hub_id: info.hub_id ?? null, hub_domain: info.hub_domain ?? null, scopes: info.scopes ?? [] },
    connected_by: state.uid,
    connected_at: now,
    last_checked_at: now,
    error: null,
  });
  await audit(state.uid, "integrations.connect", "hubspot", `portal ${info.hub_id ?? "?"} as ${info.user ?? "?"}`);
  // The app links deals to app.hubspot.com/contacts/<portal>/..., so keep the connected portal id in settings.
  if (info.hub_id) {
    const { data: cur } = await adminClient().from("app_settings").select("value").eq("key", "hubspot").maybeSingle();
    await adminClient().from("app_settings").upsert({ key: "hubspot", value: { ...((cur?.value as object | null) ?? {}), portal_id: String(info.hub_id) } });
  }

  try {
    const m = await mapHubspotOwners(adminClient());
    if (m.mapped) await audit(state.uid, "integrations.map_owners", "hubspot", `mapped ${m.mapped} of ${m.checked}`);
  } catch (e) {
    console.error("owner mapping failed:", errMsg(e));
  }
}

async function connectGoogle(state: OAuthState, code: string, profileEmail: string) {
  const app = await googleApp();
  if (!app) throw new ConnectError("The Google OAuth client is not set up");
  const t = await googleTokenRequest({
    grant_type: "authorization_code",
    client_id: app.client_id,
    client_secret: app.client_secret,
    redirect_uri: callbackUrl(),
    code,
  });
  const email = (emailFromIdToken(t.id_token) ?? (await googleUserinfoEmail(t.access_token)) ?? "").toLowerCase();
  const domain = await allowedDomain();
  if (!email || (domain && !email.endsWith(`@${domain}`))) {
    await fetchWithTimeout("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: t.refresh_token || t.access_token }).toString(),
    }, 10000).catch(() => null);
    throw new ConnectError(email ? `Use your @${domain} Google account` : "Google didn't share the account's email address. Try again.");
  }
  if (t.scope && !t.scope.includes("https://www.googleapis.com/auth/calendar.events")) {
    throw new ConnectError("Calendar access was not granted. Tick the calendar box and try again.");
  }
  if (t.scope && !t.scope.includes("https://www.googleapis.com/auth/tasks")) {
    throw new ConnectError("Google Tasks access was not granted. Tick the Tasks box and try again; callbacks and to-dos go there.");
  }
  if (!t.refresh_token) throw new ConnectError("Google did not return a refresh token. Try again.");

  const tokens: GoogleTokens = {
    refresh_token: t.refresh_token,
    access_token: t.access_token,
    expires_at: Date.now() + (t.expires_in ?? 3600) * 1000,
    email,
  };
  await setSecret(googleTokensName(state.uid), JSON.stringify(tokens));
  const now = nowISO();
  await upsertConnection("google_calendar", state.uid, {
    status: "connected",
    account_label: email,
    meta: { matches_profile: email === profileEmail.toLowerCase(), scopes: (t.scope ?? "").split(" ").filter(Boolean) },
    connected_by: state.uid,
    connected_at: now,
    last_checked_at: now,
    error: null,
  });
  await audit(state.uid, "integrations.connect", "google_calendar", email);
}

/** The mailbox that sends invitations as the team address: the address itself, or a workspace mailbox with it as an alias. */
async function connectSender(state: OAuthState, code: string, role: string | null, isOwner: boolean) {
  if (!isOwner && role !== "super_admin") {
    const { data: r } = await adminClient().from("roles").select("perms").eq("id", role ?? "").maybeSingle();
    const perms = (r?.perms as string[] | undefined) ?? [];
    if (!perms.includes("manage_integrations") && !perms.includes("manage_users")) throw new ConnectError("Your role can't connect the invite mailbox");
  }
  const app = await googleApp();
  if (!app) throw new ConnectError("The Google OAuth client is not set up");
  const t = await googleTokenRequest({ grant_type: "authorization_code", client_id: app.client_id, client_secret: app.client_secret, redirect_uri: callbackUrl(), code });
  const email = (emailFromIdToken(t.id_token) ?? (await googleUserinfoEmail(t.access_token)) ?? "").toLowerCase();
  const want = await senderAddress();
  const revoke = () =>
    fetchWithTimeout("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: t.refresh_token || t.access_token }).toString(),
    }, 10000).catch(() => null);
  const domain = await allowedDomain();
  if (!email || (domain && !email.endsWith(`@${domain}`))) {
    await revoke();
    throw new ConnectError(email ? `Use a @${domain} mailbox${want ? ` that can send as ${want}` : ""}` : "Google didn't share the account's email address. Try again.");
  }
  if (t.scope && !t.scope.includes("https://www.googleapis.com/auth/gmail.send")) {
    await revoke();
    throw new ConnectError("Sending email was not allowed. Tick the Gmail box and try again.");
  }
  if (!t.refresh_token) throw new ConnectError("Google did not return a refresh token. Try again.");
  const tokens: GoogleTokens = { refresh_token: t.refresh_token, access_token: t.access_token, expires_at: Date.now() + (t.expires_in ?? 3600) * 1000, email };
  await setSecret(SENDER_SECRET, JSON.stringify(tokens));
  const now = nowISO();
  await upsertConnection("gmail_sender", null, { status: "connected", account_label: !want || email === want ? email : `${email}, sending as ${want}`, meta: { mailbox: email, sends_as: want || email }, connected_by: state.uid, connected_at: now, last_checked_at: now, error: null });
  await audit(state.uid, "integrations.connect", "gmail_sender", email);
}

async function finish(state: OAuthState | null, result: { connected?: string; error?: string }): Promise<Response> {
  const base = await safeReturnTo(state?.rt ?? null).catch(() => appUrl());
  if (!base) {
    const msg = result.connected ? `Connected ${result.connected}. You can close this tab.` : `Could not connect: ${result.error ?? "unknown error"}`;
    return new Response(msg, { status: result.connected ? 200 : 400, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  return new Response(null, { status: 302, headers: { Location: withResult(base, result), "Cache-Control": "no-store" } });
}

/**
 * A rep signs in to HubSpot: their HubSpot login proves which HubSpot owner they are, so it sets
 * profiles.hubspot_owner_id, and their token is kept so notes they log are written as them.
 */
async function connectHubspotUser(state: OAuthState, code: string) {
  const app = await getSecretJson<OAuthApp>("int_hubspot_app");
  if (!app?.client_id || !app?.client_secret) throw new ConnectError("The HubSpot app is not set up. Ask an admin.");
  const t = await hubspotTokenRequest({
    grant_type: "authorization_code",
    client_id: app.client_id,
    client_secret: app.client_secret,
    redirect_uri: callbackUrl(),
    code,
  });
  if (!t.refresh_token) throw new ConnectError("HubSpot did not return a refresh token");
  const info = await fetchWithTimeout(`https://api.hubapi.com/oauth/v1/access-tokens/${encodeURIComponent(t.access_token)}`, {}, 15000)
    .then((r) => (r.ok ? r.json() : {}))
    .catch(() => ({})) as { hub_id?: number; user?: string; user_id?: number };
  if (!info.user_id) throw new ConnectError("HubSpot didn't say which user signed in. Try again.");

  // Must be the same HubSpot account the roster is connected to.
  const portal = await hsPortalId();
  if (portal && info.hub_id && String(info.hub_id) !== portal) {
    throw new ConnectError(`You signed in to a different HubSpot account (${info.hub_id}). Use the team's HubSpot account (${portal}).`);
  }
  const owner = await hsOwnerByUserId(info.user_id);
  if (!owner) throw new ConnectError(`${info.user ?? "That HubSpot user"} is not an owner in HubSpot yet. Ask a HubSpot admin to give you a seat.`);

  const db = adminClient();
  // The login is proof: if someone else was mapped to this owner by hand, that mapping was wrong.
  const { data: others } = await db.from("profiles").select("id,email").eq("hubspot_owner_id", owner.id).neq("id", state.uid);
  for (const o of others ?? []) {
    await db.from("profiles").update({ hubspot_owner_id: null }).eq("id", o.id);
    await audit(state.uid, "hubspot.owner_unlinked", o.email, `owner ${owner.id} now belongs to the rep who signed in as ${info.user ?? owner.email ?? ""}`);
  }
  const { error } = await db.from("profiles").update({ hubspot_owner_id: owner.id }).eq("id", state.uid);
  if (error) throw new Error("Could not save your HubSpot owner");

  const tokens: HubSpotTokens = {
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expires_at: Date.now() + (t.expires_in ?? 1800) * 1000,
    hub_id: info.hub_id,
    user_email: info.user,
  };
  await setSecret(hubspotUserTokensName(state.uid), JSON.stringify(tokens));
  const now = nowISO();
  const name = [owner.firstName, owner.lastName].filter(Boolean).join(" ");
  await upsertConnection("hubspot", state.uid, {
    status: "connected",
    account_label: `${name || info.user || "HubSpot user"} · owner ${owner.id}`,
    meta: { hub_id: info.hub_id ?? null, hs_user_id: info.user_id, owner_id: owner.id, email: info.user ?? owner.email ?? null },
    connected_by: state.uid,
    connected_at: now,
    last_checked_at: now,
    error: null,
  });
  await audit(state.uid, "hubspot.linked", info.user ?? "", `HubSpot owner ${owner.id}${name ? ` (${name})` : ""}`);
}
