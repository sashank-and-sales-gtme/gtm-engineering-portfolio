// POST {action:'create'|'delete'|'list', ...}: Google Calendar for the caller, using their stored tokens.
//   create {summary, start_iso, end_iso, description?} -> {ok, id, htmlLink}
//   delete {event_id}                                  -> {ok, deleted}
//   list   {time_min, time_max}                        -> {ok, events: [...]}
//   task_create {title, notes?, due_iso}               -> {ok, id, link}   Google Task in the default list
//   task_patch  {task_id, title?, notes?, due_iso?, completed?} -> {ok}
//   task_delete {task_id}                              -> {ok, deleted}
//   task_sync                                          -> {ok, callbacks, tasks}  closes items ticked off in Google
// Errors: 409 {error:'not_connected'} when the user has no Google connection,
//         409 {error:'reconnect'} when Google revoked or expired the grant.
import { HttpError, json, readJson, serve } from "../_shared/cors.ts";
import { getCaller } from "../_shared/supabase.ts";
import { gcal, GoogleAuthError, gtasks } from "../_shared/google.ts";
import { dueFor, syncCompleted } from "../_shared/gtasks.ts";

const TZ = "Asia/Kolkata";

// deno-lint-ignore no-explicit-any
type Ev = Record<string, any>;

function isoOrThrow(v: unknown, field: string): string {
  const s = String(v ?? "");
  if (!s || Number.isNaN(Date.parse(s))) throw new HttpError(400, `${field} must be an ISO date-time`);
  return new Date(s).toISOString();
}

serve(async (req) => {
  if (req.method !== "POST") throw new HttpError(405, "Use POST");
  const caller = await getCaller(req);
  // deno-lint-ignore no-explicit-any
  const body = await readJson<Record<string, any>>(req);
  const action = String(body.action ?? "");

  try {
    if (action === "create") {
      const summary = String(body.summary ?? "").trim();
      if (!summary) throw new HttpError(400, "summary is required");
      const start = isoOrThrow(body.start_iso, "start_iso");
      const end = isoOrThrow(body.end_iso, "end_iso");
      if (Date.parse(end) <= Date.parse(start)) throw new HttpError(400, "end_iso must be after start_iso");
      const ev = await gcal<Ev>(caller.id, "/calendars/primary/events", {
        method: "POST",
        query: { sendUpdates: "none" },
        body: {
          summary: summary.slice(0, 1000),
          description: String(body.description ?? "").slice(0, 8000),
          start: { dateTime: start, timeZone: TZ },
          end: { dateTime: end, timeZone: TZ },
        },
      });
      return json({ ok: true, id: ev.id, htmlLink: ev.htmlLink ?? null });
    }

    if (action === "delete") {
      const id = String(body.event_id ?? "").trim();
      if (!id) throw new HttpError(400, "event_id is required");
      try {
        await gcal(caller.id, `/calendars/primary/events/${encodeURIComponent(id)}`, { method: "DELETE", query: { sendUpdates: "none" } });
      } catch (e) {
        // Already gone counts as deleted.
        if (e instanceof HttpError && (e.status === 404 || e.status === 410)) return json({ ok: true, deleted: false, already_gone: true });
        throw e;
      }
      return json({ ok: true, deleted: true });
    }

    if (action === "task_create") {
      const title = String(body.title ?? "").trim();
      if (!title) throw new HttpError(400, "title is required");
      const due = isoOrThrow(body.due_iso, "due_iso");
      const t = await gtasks<Ev>(caller.id, "/lists/@default/tasks", {
        method: "POST",
        body: { title: title.slice(0, 1000), notes: String(body.notes ?? "").slice(0, 8000), due: dueFor(due) },
      });
      return json({ ok: true, id: t.id, link: t.webViewLink ?? null });
    }

    if (action === "task_patch") {
      const id = String(body.task_id ?? "").trim();
      if (!id) throw new HttpError(400, "task_id is required");
      const patch: Ev = {};
      if (typeof body.title === "string") patch.title = body.title.slice(0, 1000);
      if (typeof body.notes === "string") patch.notes = body.notes.slice(0, 8000);
      if (body.due_iso) patch.due = dueFor(isoOrThrow(body.due_iso, "due_iso"));
      if (typeof body.completed === "boolean") {
        patch.status = body.completed ? "completed" : "needsAction";
        if (!body.completed) patch.completed = null;
      }
      try {
        await gtasks(caller.id, `/lists/@default/tasks/${encodeURIComponent(id)}`, { method: "PATCH", body: patch });
      } catch (e) {
        if (e instanceof HttpError && (e.status === 404 || e.status === 410)) return json({ ok: true, gone: true });
        throw e;
      }
      return json({ ok: true });
    }

    if (action === "task_delete") {
      const id = String(body.task_id ?? "").trim();
      if (!id) throw new HttpError(400, "task_id is required");
      try {
        await gtasks(caller.id, `/lists/@default/tasks/${encodeURIComponent(id)}`, { method: "DELETE" });
      } catch (e) {
        if (e instanceof HttpError && (e.status === 404 || e.status === 410)) return json({ ok: true, deleted: false, already_gone: true });
        throw e;
      }
      return json({ ok: true, deleted: true });
    }

    if (action === "task_sync") {
      return json({ ok: true, ...(await syncCompleted(caller.id)) });
    }

    if (action === "list") {
      const timeMin = isoOrThrow(body.time_min, "time_min");
      const timeMax = isoOrThrow(body.time_max, "time_max");
      const r = await gcal<{ items?: Ev[] }>(caller.id, "/calendars/primary/events", {
        query: { timeMin, timeMax, singleEvents: "true", orderBy: "startTime", maxResults: "250", timeZone: TZ },
      });
      const events = (r.items ?? []).filter((e) => e.status !== "cancelled").map((e) => {
        const video = Array.isArray(e.conferenceData?.entryPoints)
          ? e.conferenceData.entryPoints.find((p: Ev) => p.entryPointType === "video")
          : null;
        return {
          id: e.id,
          summary: e.summary ?? "",
          start: e.start?.dateTime ?? e.start?.date ?? null,
          end: e.end?.dateTime ?? e.end?.date ?? null,
          attendees: (e.attendees ?? []).map((a: Ev) => ({
            email: a.email ?? "",
            displayName: a.displayName ?? "",
            responseStatus: a.responseStatus ?? "",
          })),
          conferenceUrl: video?.uri ?? null,
          hangoutLink: e.hangoutLink ?? null,
          location: e.location ?? null,
          htmlLink: e.htmlLink ?? null,
        };
      });
      return json({ ok: true, events });
    }
  } catch (e) {
    if (e instanceof GoogleAuthError) {
      return json({ ok: false, error: e.code === "not_configured" ? "not_connected" : e.code, message: e.message }, 409);
    }
    throw e;
  }

  throw new HttpError(400, "action must be create, delete, list, task_create, task_patch, task_delete or task_sync");
});
