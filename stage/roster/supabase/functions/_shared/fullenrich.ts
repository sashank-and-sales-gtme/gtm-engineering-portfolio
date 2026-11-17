// FullEnrich waterfall used after Apollo finds no email (queue-gate and enrich-lead), and for phone numbers.
// API: https://docs.fullenrich.com/api/v1/contact/enrich/bulk/post.md (start) and .../get.md (result).
import { fetchWithTimeout, sleep } from "./cors.ts";
import { splitName } from "./supabase.ts";
import { getSecret } from "./secrets.ts";
import { type FeResult, parseFinished } from "./fullenrich_parse.ts";

export type { FeResult };

const BASE = "https://app.fullenrich.com/api/v1/contact/enrich/bulk";
export type FeField = "contact.emails" | "contact.phones";

export interface FePerson {
  name: string;
  domain?: string;
  company?: string;
  linkedin?: string;
}
export type FePoll = { state: "pending" } | { state: "failed"; error: string } | { state: "done"; result: FeResult };

async function headers() {
  const key = await getSecret("int_fullenrich_key");
  if (!key) throw new Error("FullEnrich isn't connected");
  return { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}

/** Starts a FullEnrich job for one contact and returns its id. Throws with a readable reason (never silently). */
export async function fullEnrichStart(p: FePerson, fields: FeField[]): Promise<string> {
  const { first, last } = splitName(p.name);
  // FullEnrich needs first + last name and a company, or a LinkedIn URL. A masked surname ("Gu***a") is not usable.
  if (!p.linkedin && !(first && last && (p.domain || p.company))) {
    throw new Error("FullEnrich needs the full name and a company, or a LinkedIn URL");
  }
  const r = await fetchWithTimeout(BASE, {
    method: "POST",
    headers: await headers(),
    body: JSON.stringify({
      name: `roster ${p.company ?? ""}`.trim().slice(0, 60),
      datas: [{
        firstname: first || undefined, lastname: last || undefined, domain: p.domain || undefined,
        company_name: p.company || undefined, linkedin_url: p.linkedin || undefined, enrich_fields: fields,
      }],
    }),
  }, 20000);
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`FullEnrich ${r.status}${r.status === 401 ? " (key rejected)" : ""}: ${t.slice(0, 160)}`);
  }
  const { enrichment_id } = await r.json().catch(() => ({}));
  if (!enrichment_id) throw new Error("FullEnrich did not return an enrichment id");
  return String(enrichment_id);
}

/** One look at a FullEnrich job. Slow or rate-limited answers stay pending; credit and key problems fail with a reason. */
export async function fullEnrichPoll(id: string): Promise<FePoll> {
  const r = await fetchWithTimeout(`${BASE}/${id}`, { headers: await headers() }, 15000).catch(() => null);
  if (!r) return { state: "pending" };
  if (r.status === 401 || r.status === 403) return { state: "failed", error: "FullEnrich rejected the key" };
  if (r.status === 404) return { state: "failed", error: "FullEnrich lost the job" };
  if (!r.ok) return { state: "pending" };
  const d = await r.json().catch(() => ({}));
  if (d.status === "FINISHED") return { state: "done", result: parseFinished(d) };
  if (d.status === "CREDITS_INSUFFICIENT") return { state: "failed", error: "FullEnrich is out of credits" };
  if (d.status === "CANCELED" || d.status === "UNKNOWN") return { state: "failed", error: `FullEnrich ${String(d.status).toLowerCase()}` };
  return { state: "pending" };
}

/** Polls a job for up to about 110s. Returns the last poll state (pending means it is still running). */
export async function fullEnrichWait(id: string, tries = 22): Promise<FePoll> {
  let last: FePoll = { state: "pending" };
  for (let i = 0; i < tries; i++) {
    await sleep(5000);
    last = await fullEnrichPoll(id);
    if (last.state !== "pending") return last;
  }
  return last;
}

/** Start and wait. Used by queue-gate, where a contact is enriched in one pass. Returns the result or null, with the reason logged. */
export async function fullEnrich(p: FePerson, fields: FeField[] = ["contact.emails", "contact.phones"]): Promise<FeResult | null> {
  try {
    const poll = await fullEnrichWait(await fullEnrichStart(p, fields));
    if (poll.state === "done") return poll.result;
    console.error("FullEnrich:", poll.state === "failed" ? poll.error : "still running after 110s");
  } catch (e) {
    console.error("FullEnrich:", e instanceof Error ? e.message : e);
  }
  return null;
}
