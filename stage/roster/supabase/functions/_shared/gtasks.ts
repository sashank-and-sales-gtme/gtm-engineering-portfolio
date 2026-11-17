// Two-way completion sync between roster callbacks / to-dos and the owner's Google Tasks. A task ticked off in Google
// (Calendar, Gmail or the Tasks app) closes the roster item; the roster closes the Google task itself when the rep
// finishes in the app. Pure helpers are exported for tests.
import { adminClient, nowISO } from "./supabase.ts";
import { gtasks } from "./google.ts";

// deno-lint-ignore no-explicit-any
type GTask = Record<string, any>;

/** The IST calendar day of an instant, as Google Tasks' date-only due ("YYYY-MM-DDT00:00:00.000Z"). */
export function dueFor(iso: string): string {
  const d = new Date(Date.parse(iso) + 330 * 60_000);
  return `${d.toISOString().slice(0, 10)}T00:00:00.000Z`;
}

/** Google task ids that are completed, from a list response. */
export function completedIds(items: GTask[]): Set<string> {
  return new Set(items.filter((t) => t.status === "completed" && !t.deleted).map((t) => String(t.id)));
}

/** Every task in the user's default list changed in the last 45 days, completed and hidden ones included. */
async function recentTasks(userId: string): Promise<GTask[]> {
  const out: GTask[] = [];
  let pageToken = "";
  for (let i = 0; i < 5; i++) {
    const q: Record<string, string> = {
      showCompleted: "true", showHidden: "true", showDeleted: "false", maxResults: "100",
      updatedMin: new Date(Date.now() - 45 * 864e5).toISOString(),
    };
    if (pageToken) q.pageToken = pageToken;
    const r = await gtasks<{ items?: GTask[]; nextPageToken?: string }>(userId, "/lists/@default/tasks", { query: q });
    out.push(...(r.items ?? []));
    if (!r.nextPageToken) break;
    pageToken = r.nextPageToken;
  }
  return out;
}

/** Closes the user's roster callbacks and to-dos whose Google task was ticked off. Returns how many closed. */
export async function syncCompleted(userId: string): Promise<{ callbacks: number; tasks: number }> {
  const db = adminClient();
  const [{ data: cbs }, { data: tks }] = await Promise.all([
    db.from("callbacks").select("id,cal_event_id").eq("owner", userId).eq("status", "open").eq("cal_kind", "task").not("cal_event_id", "is", null),
    db.from("tasks").select("id,cal_event_id").eq("owner", userId).eq("done", false).eq("cal_kind", "task").not("cal_event_id", "is", null),
  ]);
  if (!(cbs ?? []).length && !(tks ?? []).length) return { callbacks: 0, tasks: 0 };
  const done = completedIds(await recentTasks(userId));
  const now = nowISO();
  const cbIds = (cbs ?? []).filter((c) => done.has(String(c.cal_event_id))).map((c) => c.id);
  const tkIds = (tks ?? []).filter((t) => done.has(String(t.cal_event_id))).map((t) => t.id);
  if (cbIds.length) await db.from("callbacks").update({ status: "done", done_at: now, outcome: "done_in_google" }).in("id", cbIds);
  if (tkIds.length) await db.from("tasks").update({ done: true, done_at: now }).in("id", tkIds);
  return { callbacks: cbIds.length, tasks: tkIds.length };
}

/** Everyone with open Google-task items, for the background sync. */
export async function ownersWithOpenTasks(): Promise<string[]> {
  const db = adminClient();
  const [{ data: a }, { data: b }] = await Promise.all([
    db.from("callbacks").select("owner").eq("status", "open").eq("cal_kind", "task").not("cal_event_id", "is", null).limit(1000),
    db.from("tasks").select("owner").eq("done", false).eq("cal_kind", "task").not("cal_event_id", "is", null).limit(1000),
  ]);
  return [...new Set([...(a ?? []), ...(b ?? [])].map((r) => String(r.owner)).filter(Boolean))];
}
