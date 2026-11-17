// Optional wake-ups for the worker routines: fire a routine's API trigger when work is waiting, so it doesn't sit
// until the next scheduled run. Each workspace has its own routines, saved in Admin > Integrations as the secrets
// int_research_wake / int_post_call_wake ({url, token}). The schedule stays as the backstop.
import { errMsg, fetchWithTimeout } from "./cors.ts";
import { getSecretJson, type SecretName } from "./secrets.ts";
import { adminClient } from "./supabase.ts";
import { currentWorkspace } from "./workspace.ts";

const FIRE_PREFIX = "https://api.anthropic.com/v1/claude_code/routines/";
/** The workspace that existed before workspaces; it keeps the old env-var configuration. */
const STARTING_WORKSPACE = "00000000-0000-4000-8000-000000000001";

export type WakeKind = "research" | "post_call";
const SECRET: Record<WakeKind, SecretName> = { research: "int_research_wake", post_call: "int_post_call_wake" };
const ENV: Record<WakeKind, string> = { research: "RESEARCH_WAKE", post_call: "POST_CALL_WAKE" };

/** The token only ever goes to Anthropic's routine endpoint. */
export function validWakeUrl(url: string): boolean {
  return url.startsWith(FIRE_PREFIX) && url.endsWith("/fire") && !/\s/.test(url);
}

export async function wakeConfig(kind: WakeKind): Promise<{ url: string; token: string } | null> {
  let cfg = await getSecretJson<{ url?: string; token?: string }>(SECRET[kind]);
  if (!cfg && currentWorkspace() === STARTING_WORKSPACE) {
    cfg = { url: Deno.env.get(`${ENV[kind]}_URL`), token: Deno.env.get(`${ENV[kind]}_TOKEN`) };
  }
  const url = (cfg?.url ?? "").trim();
  const token = (cfg?.token ?? "").trim();
  if (!validWakeUrl(url) || !token) return null;
  return { url, token };
}

async function fire(kind: WakeKind, gapSeconds: number, text: string): Promise<"fired" | "skipped" | "off" | "error"> {
  const cfg = await wakeConfig(kind).catch(() => null);
  if (!cfg) return "off";
  const db = adminClient();
  const reset = () => db.rpc(`${kind}_reset_wake`).then(() => {}, () => {});
  try {
    const { data: go } = await db.rpc(`${kind}_should_wake`, { p_gap_seconds: gapSeconds });
    if (go !== true) return "skipped";
    const r = await fetchWithTimeout(cfg.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.token}`, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    }, 15000);
    if (r.ok) return "fired";
    await reset();
    console.error(`${kind} wake failed:`, r.status);
    return "error";
  } catch (e) {
    await reset();
    console.error(`${kind} wake failed:`, errMsg(e));
    return "error";
  }
}

/** Wakes the research routine when Claude work is pending and no worker is on it, at most once per 10 minutes. */
export function wakeResearch() {
  return fire("research", 600, "Roster research is queued.");
}

/** Wakes the post-call routine unless it was woken in the last 20 seconds. Never throws. */
export function wakePostCall() {
  return fire("post_call", 20, "Post-call drafts are queued.");
}
