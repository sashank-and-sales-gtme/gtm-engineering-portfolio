// Google OAuth (per-user Calendar tokens stored in Vault) and Calendar REST helpers.
import { fetchWithTimeout, HttpError } from "./cors.ts";
import { adminClient } from "./supabase.ts";
import { getSecretJson, markConnection, setSecret, vaultGet } from "./secrets.ts";

export const TASKS_SCOPE = "https://www.googleapis.com/auth/tasks";
/** Read-only Gmail: reschedule replies read the rep's thread with the prospect. Nothing is sent or changed. */
export const GMAIL_READ_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
export const GOOGLE_SCOPES = ["openid", "email", "https://www.googleapis.com/auth/calendar.events", TASKS_SCOPE, GMAIL_READ_SCOPE];
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CAL = "https://www.googleapis.com/calendar/v3";

export interface GoogleTokens {
  refresh_token: string;
  access_token?: string;
  expires_at?: number; // epoch ms
  email?: string;
}
export interface OAuthApp {
  client_id: string;
  client_secret: string;
}

/** Error codes the calendar function maps to {error: code}. */
export class GoogleAuthError extends Error {
  code: "not_connected" | "reconnect" | "not_configured";
  constructor(code: "not_connected" | "reconnect" | "not_configured", message: string) {
    super(message);
    this.code = code;
  }
}

export const googleTokensName = (userId: string) => `int_google_tokens_${userId}` as const;

export async function googleApp(): Promise<OAuthApp | null> {
  const app = await getSecretJson<OAuthApp>("int_google_app");
  return app?.client_id && app?.client_secret ? app : null;
}

/** The Google Workspace domain sign-in is limited to, or "" when sign-in is by invitation only. */
export async function allowedDomain(): Promise<string> {
  const { data } = await adminClient().from("app_settings").select("value").eq("key", "allowed_domain").maybeSingle();
  return String((data?.value as { domain?: string } | null)?.domain || "").trim().toLowerCase();
}

/** Google's hd hint for an OAuth URL; left out when no domain is set. */
export const hdParam = (domain: string): Record<string, string> => (domain ? { hd: domain } : {});

/** POST https://oauth2.googleapis.com/token (form encoded). Throws with Google's error code in the message. */
export async function googleTokenRequest(params: Record<string, string>): Promise<{
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
  scope?: string;
}> {
  const r = await fetchWithTimeout(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  }, 20000);
  const text = await r.text();
  // deno-lint-ignore no-explicit-any
  let data: any = {};
  try {
    data = JSON.parse(text);
  } catch { /* keep empty */ }
  if (!r.ok || !data.access_token) {
    const code = String(data.error ?? r.status);
    const e = new Error(`Google token request failed: ${code}${data.error_description ? ` (${data.error_description})` : ""}`);
    (e as Error & { googleCode?: string }).googleCode = code;
    throw e;
  }
  return data;
}

const inflight = new Map<string, Promise<string>>();

/**
 * A valid Calendar access token for the user, refreshed via the stored refresh token when it
 * expires within 60s. Marks the connection 'error' and throws 'reconnect' on invalid_grant.
 */
export async function googleAccessToken(userId: string, force = false): Promise<string> {
  const raw = await vaultGet(googleTokensName(userId));
  if (!raw) throw new GoogleAuthError("not_connected", "Google Calendar is not connected");
  let tokens: GoogleTokens;
  try {
    tokens = JSON.parse(raw);
  } catch {
    throw new GoogleAuthError("reconnect", "Stored Google tokens are unreadable");
  }
  if (!tokens.refresh_token) throw new GoogleAuthError("reconnect", "No Google refresh token stored");
  if (!force && tokens.access_token && Number(tokens.expires_at ?? 0) > Date.now() + 60_000) return tokens.access_token;

  const pending = inflight.get(userId);
  if (pending) return await pending;
  const p = (async () => {
    const app = await googleApp();
    if (!app) throw new GoogleAuthError("not_configured", "The Google OAuth client is not set up. Ask an admin.");
    try {
      const t = await googleTokenRequest({
        grant_type: "refresh_token",
        client_id: app.client_id,
        client_secret: app.client_secret,
        refresh_token: tokens.refresh_token,
      });
      const next: GoogleTokens = {
        ...tokens,
        access_token: t.access_token,
        refresh_token: t.refresh_token || tokens.refresh_token,
        expires_at: Date.now() + (t.expires_in ?? 3600) * 1000,
      };
      await setSecret(googleTokensName(userId), JSON.stringify(next));
      return t.access_token;
    } catch (e) {
      const code = (e as Error & { googleCode?: string }).googleCode;
      if (code === "invalid_grant" || code === "unauthorized_client" || code === "invalid_client") {
        await markConnection("google_calendar", userId, "error", "Google access was revoked or expired. Reconnect Google Calendar.");
        throw new GoogleAuthError("reconnect", "Google access was revoked or expired");
      }
      throw e;
    }
  })().finally(() => inflight.delete(userId));
  inflight.set(userId, p);
  return await p;
}

/** Calendar API call as the user. Retries once with a forced refresh on 401. */
export async function gcal<T = unknown>(
  userId: string,
  path: string,
  init: { method?: string; body?: unknown; query?: Record<string, string> } = {},
): Promise<T> {
  let token = await googleAccessToken(userId);
  const qs = init.query ? `?${new URLSearchParams(init.query).toString()}` : "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetchWithTimeout(`${CAL}${path}${qs}`, {
      method: init.method ?? "GET",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }, 20000);
    if (r.status === 401 && attempt === 0) {
      token = await googleAccessToken(userId, true);
      continue;
    }
    const text = await r.text();
    if (!r.ok) {
      if (r.status === 401) {
        await markConnection("google_calendar", userId, "error", "Google rejected the token. Reconnect Google Calendar.");
        throw new GoogleAuthError("reconnect", "Google rejected the token");
      }
      let msg = text.slice(0, 300);
      try {
        msg = JSON.parse(text).error?.message ?? msg;
      } catch { /* keep raw */ }
      throw new HttpError(r.status === 404 || r.status === 410 ? r.status : 502, `Google Calendar ${r.status}: ${msg}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }
  throw new HttpError(502, "Google Calendar did not answer");
}

/**
 * Google Tasks API call as the user (callbacks and to-dos live there, so they show in Google Calendar and can be ticked
 * off from either side). A connection made before Tasks was added lacks the scope: that surfaces as "reconnect".
 */
export async function gtasks<T = unknown>(
  userId: string,
  path: string,
  init: { method?: string; body?: unknown; query?: Record<string, string> } = {},
): Promise<T> {
  let token = await googleAccessToken(userId);
  const qs = init.query ? `?${new URLSearchParams(init.query).toString()}` : "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetchWithTimeout(`https://tasks.googleapis.com/tasks/v1${path}${qs}`, {
      method: init.method ?? "GET",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }, 20000);
    if (r.status === 401 && attempt === 0) {
      token = await googleAccessToken(userId, true);
      continue;
    }
    const text = await r.text();
    if (!r.ok) {
      if (r.status !== 404 && r.status !== 410) console.error(`gtasks ${r.status}:`, text.slice(0, 300));
      // A disabled API is also a 403 PERMISSION_DENIED, so check for it first: reconnecting can't fix it, and treating it
      // as a missing scope marked the whole Google connection broken on every callback.
      if (r.status === 403 && /has not been used|SERVICE_DISABLED|accessNotConfigured|is disabled/i.test(text)) {
        throw new HttpError(503, "The Google Tasks API is off in the Google Cloud project of the OAuth client. Enable it (APIs & Services > Library > Google Tasks API).");
      }
      if (r.status === 401 || (r.status === 403 && /insufficient|ACCESS_TOKEN_SCOPE/i.test(text))) {
        await markConnection("google_calendar", userId, "error", "Reconnect Google to allow Google Tasks.");
        throw new GoogleAuthError("reconnect", "Google Tasks access was not granted. Reconnect Google.");
      }
      let msg = text.slice(0, 300);
      try {
        msg = JSON.parse(text).error?.message ?? msg;
      } catch { /* keep raw */ }
      throw new HttpError(r.status === 404 || r.status === 410 ? r.status : 502, `Google Tasks ${r.status}: ${msg}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }
  throw new HttpError(502, "Google Tasks did not answer");
}

/** Gmail API (read only) as the user. A connection made before Gmail was added lacks the scope: that is "reconnect". */
export async function gmailRead<T = unknown>(userId: string, path: string, query: Record<string, string> = {}): Promise<T> {
  let token = await googleAccessToken(userId);
  const qs = Object.keys(query).length ? `?${new URLSearchParams(query).toString()}` : "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetchWithTimeout(`https://gmail.googleapis.com/gmail/v1/users/me${path}${qs}`, {
      headers: { Authorization: `Bearer ${token}` },
    }, 20000);
    if (r.status === 401 && attempt === 0) {
      token = await googleAccessToken(userId, true);
      continue;
    }
    const text = await r.text();
    if (!r.ok) {
      // A disabled API is also a 403 PERMISSION_DENIED, so check for it before treating the 403 as a missing scope.
      if (r.status === 403 && /has not been used|SERVICE_DISABLED|accessNotConfigured|is disabled/i.test(text)) {
        throw new HttpError(503, "The Gmail API is off in the Google Cloud project of the OAuth client. Enable it (APIs & Services > Library > Gmail API).");
      }
      if (r.status === 401 || (r.status === 403 && /insufficient|scope|PERMISSION_DENIED/i.test(text))) {
        console.error("gmail 403:", text.slice(0, 300));
        throw new GoogleAuthError("reconnect", "Gmail access was not granted. Reconnect Google and tick the box to read your email.");
      }
      let msg = text.slice(0, 300);
      try {
        msg = JSON.parse(text).error?.message ?? msg;
      } catch { /* keep raw */ }
      throw new HttpError(502, `Gmail ${r.status}: ${msg}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }
  throw new HttpError(502, "Gmail did not answer");
}

/** Best-effort token revocation. */
export async function revokeGoogleToken(token: string): Promise<void> {
  try {
    await fetchWithTimeout("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
    }, 10000);
  } catch {
    // ignore
  }
}

/** Email from an id_token payload (no signature check needed: it came straight from Google's token endpoint over TLS). */
export function emailFromIdToken(idToken?: string): string | null {
  if (!idToken) return null;
  try {
    const part = idToken.split(".")[1];
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    const payload = JSON.parse(atob(b64));
    return payload.email_verified === false ? null : (payload.email ?? null);
  } catch {
    return null;
  }
}

export async function googleUserinfoEmail(accessToken: string): Promise<string | null> {
  const r = await fetchWithTimeout("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  }, 10000);
  if (!r.ok) return null;
  const d = await r.json();
  return d.email_verified === false ? null : (d.email ?? null);
}
