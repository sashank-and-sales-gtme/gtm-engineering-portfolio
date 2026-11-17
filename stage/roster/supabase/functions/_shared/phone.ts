// The phone waterfall: Apollo first (people/match with reveal_phone_number, delivered to the apollo-phone webhook),
// FullEnrich only when Apollo reports no number or nothing arrives within PHONE_WAIT_MS.
import { env } from "./supabase.ts";
import { currentWorkspace } from "./workspace.ts";

export const PHONE_WAIT_MS = 15 * 60_000;

// deno-lint-ignore no-explicit-any
type Any = any;
type Phone = { number: string; type: string };

/** Every phone number in an Apollo payload (sync match or webhook), mobiles first. Pure, so it can be tested. */
export function extractPhones(payload: Any): Phone[] {
  const out: Phone[] = [];
  const seen = new Set<string>();
  const walk = (v: Any, depth: number) => {
    if (!v || depth > 6) return;
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
    if (typeof v !== "object") return;
    if (Array.isArray(v.phone_numbers)) {
      for (const p of v.phone_numbers) {
        const number = String(p?.sanitized_number || p?.raw_number || p?.number || "").trim();
        if (!number || seen.has(number)) continue;
        if (/invalid|no_status_dnc/i.test(String(p?.status ?? p?.status_cd ?? ""))) continue;
        seen.add(number);
        out.push({ number, type: String(p?.type_cd || p?.type || "").toLowerCase() });
      }
    }
    for (const [k, x] of Object.entries(v)) if (k !== "phone_numbers" && typeof x === "object") walk(x, depth + 1);
  };
  walk(payload, 0);
  return out.sort((a, b) => Number(/mobile/.test(b.type)) - Number(/mobile/.test(a.type)));
}

const enc = new TextEncoder();
async function hmacHex(data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(env("SUPABASE_SERVICE_ROLE_KEY")), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode("apollo-phone:" + data)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The webhook URL Apollo calls for one lead, signed so nobody else can post phone numbers into the roster. */
/** The workspace that existed before workspaces; webhook URLs issued then carry no workspace. */
const STARTING_WORKSPACE = "00000000-0000-4000-8000-000000000001";

export async function phoneWebhookUrl(leadId: string, nonce: string): Promise<string> {
  const base = `${env("SUPABASE_URL").replace(/\/$/, "")}/functions/v1/apollo-phone`;
  const ws = currentWorkspace();
  const q = new URLSearchParams({ w: ws, lead: leadId, n: nonce, sig: await hmacHex(`${ws}:${leadId}:${nonce}`) });
  return `${base}?${q.toString()}`;
}

/** The workspace a signed webhook URL belongs to, or null when the signature is wrong. */
export async function verifyPhoneWebhook(ws: string, leadId: string, nonce: string, sig: string): Promise<string | null> {
  if (!leadId || !nonce || !sig) return null;
  if (ws && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(ws)) return null;
  const want = await hmacHex(ws ? `${ws}:${leadId}:${nonce}` : `${leadId}:${nonce}`);
  if (want.length !== sig.length) return null;
  let d = 0;
  for (let i = 0; i < want.length; i++) d |= want.charCodeAt(i) ^ sig.charCodeAt(i);
  return d === 0 ? ws || STARTING_WORKSPACE : null;
}
