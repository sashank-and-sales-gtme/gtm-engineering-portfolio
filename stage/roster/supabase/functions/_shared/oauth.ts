// Signed OAuth state, redirect/callback URLs and return_to validation shared by
// the `integrations` (oauth_start) and `oauth-callback` functions.
import { HttpError } from "./cors.ts";
import { adminClient, env } from "./supabase.ts";
import { setSecret, vaultGet } from "./secrets.ts";

export type OAuthProvider = "hubspot" | "hubspot_user" | "google_calendar" | "gmail_sender";

export interface OAuthState {
  p: OAuthProvider;
  uid: string;
  rt: string;
  n: string;
  exp: number; // epoch ms
}

const STATE_TTL_MS = 10 * 60 * 1000;
const enc = new TextEncoder();

export function callbackUrl(): string {
  return `${env("SUPABASE_URL").replace(/\/$/, "")}/functions/v1/oauth-callback`;
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/** The HMAC key, created in Vault on first use. Re-reads after creating so racing writers agree. */
async function stateSecret(): Promise<string> {
  let s = await vaultGet("int_oauth_state_secret");
  if (s) return s;
  await setSecret("int_oauth_state_secret", b64url(crypto.getRandomValues(new Uint8Array(32))));
  s = await vaultGet("int_oauth_state_secret");
  if (!s) throw new HttpError(500, "Could not create the OAuth state secret");
  return s;
}

async function hmac(data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(await stateSecret()), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

export async function signState(p: OAuthProvider, uid: string, rt: string): Promise<string> {
  const payload: OAuthState = { p, uid, rt, n: b64url(crypto.getRandomValues(new Uint8Array(12))), exp: Date.now() + STATE_TTL_MS };
  const body = b64url(enc.encode(JSON.stringify(payload)));
  return `${body}.${b64url(await hmac(body))}`;
}

export async function verifyState(state: string | null): Promise<OAuthState> {
  const [body, sig] = String(state ?? "").split(".");
  if (!body || !sig) throw new Error("Missing or malformed state");
  let given: Uint8Array;
  try {
    given = b64urlDecode(sig);
  } catch {
    throw new Error("Malformed state signature");
  }
  if (!timingSafeEqual(await hmac(body), given)) throw new Error("State signature does not match");
  let payload: OAuthState;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
  } catch {
    throw new Error("Unreadable state");
  }
  if (!payload.exp || payload.exp < Date.now()) throw new Error("The sign-in link expired. Try connecting again.");
  if (!["hubspot", "hubspot_user", "google_calendar", "gmail_sender"].includes(payload.p)) throw new Error("Unknown provider in state");
  return payload;
}

/** APP_URL plus app_settings 'allowed_origins' ({"origins": [...]}) as origins. */
async function allowedOrigins(): Promise<string[]> {
  const out: string[] = [];
  const app = appUrl();
  if (app) out.push(new URL(app).origin);
  const { data } = await adminClient().from("app_settings").select("value").eq("key", "allowed_origins").maybeSingle();
  const v = data?.value as { origins?: unknown } | unknown[] | null;
  const list = Array.isArray(v) ? v : Array.isArray((v as { origins?: unknown })?.origins) ? (v as { origins: unknown[] }).origins : [];
  for (const o of list) {
    const n = toUrl(String(o));
    if (n) out.push(new URL(n).origin);
  }
  return out;
}

/** A full URL from a value that may lack its scheme ("app.vercel.app" -> "https://app.vercel.app"), or null. */
export function toUrl(v: string | null | undefined): string | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const withScheme = /^https?:\/\//i.test(s) ? s : (/^(localhost|127\.0\.0\.1)(:|\/|$)/.test(s) ? "http://" : "https://") + s;
  try {
    const u = new URL(withScheme);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}
/** The APP_URL secret as a full URL, tolerating a value saved without https://. */
export const appUrl = () => toUrl(Deno.env.get("APP_URL"));

/** return_to when its origin is APP_URL or an allowed origin, else APP_URL, else null. */
export async function safeReturnTo(rt: string | null | undefined): Promise<string | null> {
  const origins = await allowedOrigins();
  const u = toUrl(rt);
  if (u && origins.includes(new URL(u).origin)) return u;
  return appUrl();
}

/** Appends ?connected=<provider> or ?connect_error=<msg> to the return URL. */
export function withResult(base: string, result: { connected?: string; error?: string }): string {
  const u = new URL(toUrl(base) ?? base);
  u.searchParams.delete("connected");
  u.searchParams.delete("connect_error");
  if (result.connected) u.searchParams.set("connected", result.connected);
  if (result.error) u.searchParams.set("connect_error", result.error.slice(0, 200));
  return u.toString();
}
