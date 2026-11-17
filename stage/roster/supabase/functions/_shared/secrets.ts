// Integration secrets live in Supabase Vault (via service-role-only RPCs), one set per workspace. Only the platform's
// own OAuth apps, the OAuth state key and Exa (the platform runs company research for every workspace) are
// platform-wide. Workspace data and AI keys (Apollo, FullEnrich, Anthropic) never fall back to the operator's env vars:
// a workspace that hasn't connected its own key gets a "not connected" error instead of silently spending the
// platform's credits. Only the platform's OAuth app credentials (HubSpot, Google) and Exa may come from env.
// Also small helpers for integration_connections rows, which only the service role may write.
import { HttpError } from "./cors.ts";
import { adminClient, nowISO, platformClient } from "./supabase.ts";
import { currentWorkspace } from "./workspace.ts";

export type SecretName =
  | "int_apollo_key"
  | "int_fullenrich_key"
  | "int_exa_key"
  | "int_gmail_sender_tokens"
  | "int_hubspot_pat"
  | "int_anthropic_key"
  | "int_hubspot_app"
  | "int_hubspot_tokens"
  | "int_google_app"
  | "int_oauth_state_secret"
  | "int_research_wake"
  | "int_post_call_wake"
  | `int_google_tokens_${string}`
  | `int_hubspot_tokens_${string}`;

/** Env fallbacks for platform OAuth apps only. A string maps to one env var; an object maps JSON fields to env vars. */
const ENV_FALLBACK: Record<string, string | Record<string, string>> = {
  int_hubspot_app: { client_id: "HUBSPOT_CLIENT_ID", client_secret: "HUBSPOT_CLIENT_SECRET" },
  int_google_app: { client_id: "GOOGLE_CLIENT_ID", client_secret: "GOOGLE_CLIENT_SECRET" },
  int_exa_key: "EXA_API_KEY",
};

const HUMAN: Record<string, string> = {
  int_apollo_key: "Apollo",
  int_fullenrich_key: "FullEnrich",
  int_exa_key: "Exa",
  int_anthropic_key: "Anthropic",
  int_hubspot_app: "The HubSpot app",
  int_google_app: "The Google OAuth client",
};

/** Shared by every workspace: the platform's OAuth apps, the key that signs OAuth state, and the platform's Exa key. */
export const PLATFORM_SECRETS = new Set<string>(["int_hubspot_app", "int_google_app", "int_oauth_state_secret", "int_exa_key"]);
const ownerOf = (name: string): string | null => PLATFORM_SECRETS.has(name) ? null : currentWorkspace();
const cacheKey = (name: string) => `${ownerOf(name) ?? "platform"}:${name}`;

// Short-lived cache so one invocation reads each secret once. Kept brief because warm isolates
// serve many requests and a key saved elsewhere should take effect quickly.
const TTL_MS = 20_000;
const cache = new Map<string, { v: string | null; at: number }>();

export function clearSecretCache(name?: SecretName): void {
  if (name) cache.delete(cacheKey(name));
  else cache.clear();
}

/** Raw Vault read (no env fallback). Returns null when absent. */
export async function vaultGet(name: SecretName): Promise<string | null> {
  const key = cacheKey(name);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.v;
  const { data, error } = await platformClient().rpc("secret_get", { p_workspace: ownerOf(name), p_name: name });
  if (error) throw new Error(`Could not read secret ${name}: ${error.message}`);
  const v = typeof data === "string" && data !== "" ? data : null;
  cache.set(key, { v, at: Date.now() });
  return v;
}

function envFallback(name: string): string | null {
  const f = ENV_FALLBACK[name];
  if (!f) return null;
  if (typeof f === "string") return Deno.env.get(f) || null;
  const out: Record<string, string> = {};
  for (const [k, envName] of Object.entries(f)) {
    const v = Deno.env.get(envName);
    if (!v) return null;
    out[k] = v;
  }
  return JSON.stringify(out);
}

/** Vault secret, else the env fallback, else null. Vault errors fall back to env. */
export async function getSecret(name: SecretName): Promise<string | null> {
  let v: string | null = null;
  try {
    v = await vaultGet(name);
  } catch (e) {
    console.error(String(e));
  }
  return v ?? envFallback(name);
}

export async function getSecretJson<T>(name: SecretName): Promise<T | null> {
  const raw = await getSecret(name);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Like getSecret but throws a friendly 409 when nothing is configured. */
export async function requireSecret(name: SecretName): Promise<string> {
  const v = await getSecret(name);
  if (!v) {
    const who = HUMAN[name] ?? name;
    throw new HttpError(409, `${who} is not connected. Add it in Admin > Integrations.`);
  }
  return v;
}

/** Where a secret comes from: 'app' (Vault), 'env', or null. */
export async function secretSource(name: SecretName): Promise<"app" | "env" | null> {
  let v: string | null = null;
  try {
    v = await vaultGet(name);
  } catch { /* treat as absent */ }
  if (v) return "app";
  return envFallback(name) ? "env" : null;
}

export async function setSecret(name: SecretName, value: string): Promise<void> {
  const { error } = await platformClient().rpc("secret_set", { p_workspace: ownerOf(name), p_name: name, p_value: value });
  if (error) throw new Error(`Could not save secret: ${error.message}`);
  cache.set(cacheKey(name), { v: value, at: Date.now() });
}

export async function deleteSecret(name: SecretName): Promise<void> {
  const { error } = await platformClient().rpc("secret_delete", { p_workspace: ownerOf(name), p_name: name });
  if (error) throw new Error(`Could not delete secret: ${error.message}`);
  cache.set(cacheKey(name), { v: null, at: Date.now() });
}

export const last4 = (s: string) => String(s ?? "").trim().slice(-4);

// ---------------------------------------------------------------------------
// integration_connections helpers (service role)
// ---------------------------------------------------------------------------

export type Provider = "hubspot" | "google_calendar" | "apollo" | "fullenrich" | "exa" | "gmail_sender" | "anthropic" | "hubspot_app" | "google_app";

export interface ConnectionRow {
  id: string;
  provider: Provider;
  scope: "org" | "user";
  user_id: string | null;
  status: "connected" | "error" | "disconnected";
  account_label: string | null;
  meta: Record<string, unknown> | null;
  connected_by: string | null;
  connected_at: string | null;
  last_checked_at: string | null;
  error: string | null;
}

export async function getConnection(provider: Provider, userId: string | null = null): Promise<ConnectionRow | null> {
  let q = adminClient().from("integration_connections").select("*").eq("provider", provider);
  q = userId ? q.eq("scope", "user").eq("user_id", userId) : q.eq("scope", "org").is("user_id", null);
  const { data } = await q.maybeSingle();
  return (data as ConnectionRow | null) ?? null;
}

/** Insert or update the (provider, scope, user) row. The unique index uses an expression, so upsert by hand. */
export async function upsertConnection(
  provider: Provider,
  userId: string | null,
  fields: Partial<Omit<ConnectionRow, "id" | "provider" | "scope" | "user_id">>,
): Promise<void> {
  const db = adminClient();
  const scope = userId ? "user" : "org";
  for (let attempt = 0; attempt < 2; attempt++) {
    const existing = await getConnection(provider, userId);
    if (existing) {
      const { error } = await db.from("integration_connections").update(fields).eq("id", existing.id);
      if (error) throw new Error(`Could not update the connection: ${error.message}`);
      return;
    }
    const { error } = await db.from("integration_connections").insert({ provider, scope, user_id: userId, ...fields });
    if (!error) return;
    if (error.code !== "23505") throw new Error(`Could not save the connection: ${error.message}`);
    // Lost a race with a concurrent insert: loop and update instead.
  }
}

/** Updates status fields of an existing row only (never creates one). Best effort. */
export async function markConnection(
  provider: Provider,
  userId: string | null,
  status: ConnectionRow["status"],
  error: string | null,
): Promise<void> {
  try {
    let q = adminClient().from("integration_connections")
      .update({ status, error, last_checked_at: nowISO() })
      .eq("provider", provider);
    q = userId ? q.eq("scope", "user").eq("user_id", userId) : q.eq("scope", "org").is("user_id", null);
    await q.neq("status", "disconnected");
  } catch {
    // best effort
  }
}
