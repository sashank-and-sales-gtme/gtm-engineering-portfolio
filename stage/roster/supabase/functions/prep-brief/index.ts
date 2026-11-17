// POST {meeting_id}: queues a two-minute prep brief for the Claude worker. The brief lands on the meeting
// (prep, prep_status 'ready') when the worker submits it; Realtime updates the page.
import { HttpError, json, readJson, serve } from "../_shared/cors.ts";
import { adminClient, getCaller, nowISO } from "../_shared/supabase.ts";
import { wakeResearch } from "../_shared/wake.ts";

serve(async (req) => {
  if (req.method !== "POST") throw new HttpError(405, "Use POST");
  const caller = await getCaller(req);
  const { meeting_id } = await readJson<{ meeting_id?: string }>(req);
  if (!meeting_id) throw new HttpError(400, "meeting_id is required");

  const { data: m, error } = await caller.client.from("meetings").select("id,prep_status").eq("id", meeting_id).maybeSingle();
  if (error) throw new HttpError(500, "Could not load the meeting");
  if (!m) throw new HttpError(404, "Meeting not found or not visible to you");

  const db = adminClient();
  const { data: open } = await db.from("research_queue").select("id").eq("kind", "prep_brief")
    .contains("payload", { meeting_id }).in("status", ["pending", "running"]).limit(1);
  if (!open?.length) {
    const { error: qe } = await db.from("research_queue").insert({
      kind: "prep_brief", status: "pending", priority: 2, rep_id: caller.id,
      payload: { meeting_id, requested_by: caller.id },
    });
    if (qe) throw new HttpError(500, "Could not queue the brief");
  }
  const at = nowISO();
  await db.from("meetings").update({ prep_status: "queued", prep_requested_at: at }).eq("id", meeting_id);
  const wake = await wakeResearch();
  return json({ ok: true, status: "queued", requested_at: at, wake });
});
