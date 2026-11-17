// POST {meeting_id}: drafts a reply for a meeting in the reschedule queue.
// Reads the caller's Gmail thread with the prospect (read only) and their Google Calendar, works out free slots, and
// queues the reply for the Claude worker (research_queue kind 'reschedule_email'). The reschedule_drafts row goes
// drafting -> ready / failed and Realtime updates the page.
// Errors: 409 {error:'reconnect'|'not_connected'} when Google needs connecting or the Gmail permission.
import { errMsg, HttpError, json, readJson, serve } from "../_shared/cors.ts";
import { adminClient, getCaller, nowISO } from "../_shared/supabase.ts";
import { GoogleAuthError } from "../_shared/google.ts";
import { calendarSlots, readThread } from "../_shared/reschedule.ts";
import { wakePostCall } from "../_shared/wake.ts";

serve(async (req) => {
  if (req.method !== "POST") throw new HttpError(405, "Use POST");
  const caller = await getCaller(req);
  const { meeting_id } = await readJson<{ meeting_id?: string }>(req);
  if (!meeting_id) throw new HttpError(400, "meeting_id is required");

  // Read through the caller's client so RLS decides visibility.
  const { data: m, error } = await caller.client.from("meetings").select("*").eq("id", meeting_id).maybeSingle();
  if (error) throw new HttpError(500, "Could not load the meeting");
  if (!m) throw new HttpError(404, "Meeting not found or not visible to you");

  const db = adminClient();
  const { data: lead } = m.lead_id ? await db.from("leads").select("id,enrichment,domain").eq("id", m.lead_id).maybeSingle() : { data: null };
  const { data: me } = await db.from("profiles").select("email").eq("id", caller.id).maybeSingle();
  const prospectEmail = String(lead?.enrichment?.email ?? "").trim().toLowerCase();
  const domain = String(lead?.domain ?? "").replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "").toLowerCase();
  const selfEmail = String(me?.email ?? "").toLowerCase();

  // The caller's own Google: their inbox and their calendar.
  let thread, candidates;
  try {
    [thread, candidates] = await Promise.all([readThread(caller.id, selfEmail, prospectEmail, domain), calendarSlots(caller.id, selfEmail, Date.now())]);
  } catch (e) {
    if (e instanceof GoogleAuthError) {
      return json({ ok: false, error: e.code === "not_configured" ? "not_connected" : e.code, message: e.message }, 409);
    }
    throw new HttpError(502, errMsg(e));
  }
  if (candidates.length < 5) throw new HttpError(409, "Your calendar has fewer than 5 free slots in the next two weeks.");

  const start = { status: "drafting", error: null, updated_at: nowISO() };
  const { data: existing } = await db.from("reschedule_drafts").select("id").eq("meeting_id", meeting_id).maybeSingle();
  let draftId = existing?.id as string | undefined;
  if (draftId) await db.from("reschedule_drafts").update({ ...start, owner: caller.id }).eq("id", draftId);
  else {
    const { data: row, error: insErr } = await db.from("reschedule_drafts")
      .insert({ meeting_id, lead_id: m.lead_id, owner: caller.id, ...start }).select("id").single();
    if (insErr) throw new HttpError(500, "Could not start the draft");
    draftId = row.id;
  }

  // One open queue row per draft; a fresh request replaces what an unclaimed row would have used.
  const payload = { draft_id: draftId, meeting_id, emails: thread.messages, candidates };
  const { data: open } = await db.from("research_queue").select("id,status").eq("kind", "reschedule_email")
    .contains("payload", { draft_id: draftId }).in("status", ["pending", "running"]).limit(1);
  if (open?.length && open[0].status === "pending") await db.from("research_queue").update({ payload }).eq("id", open[0].id);
  else if (!open?.length) {
    const { error: qe } = await db.from("research_queue").insert({ kind: "reschedule_email", status: "pending", priority: 1, rep_id: caller.id, payload });
    if (qe) {
      await db.from("reschedule_drafts").update({ status: "failed", error: "Could not queue the draft" }).eq("id", draftId);
      throw new HttpError(500, "Could not queue the draft");
    }
  }
  const wake = await wakePostCall();
  return json({ ok: true, status: "drafting", emails: thread.messages.length, slots: candidates.length, wake }, 202);
});
