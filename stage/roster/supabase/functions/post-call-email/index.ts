// POST {journey_id, auto?}: queues a follow-up email draft for one call note (a journeys row of kind "context").
// The Claude worker drafts it (post_call_email in research_queue); the email_drafts row goes
// drafting -> ready / failed and Realtime updates the page. auto: true is the call made right after a note
// is saved: it never replaces an existing draft and skips declined calls.
import { HttpError, json, readJson, serve } from "../_shared/cors.ts";
import { adminClient, getCaller, nowISO } from "../_shared/supabase.ts";
import { situationOf } from "../_shared/postcall_lib.ts";
import { wakePostCall } from "../_shared/wake.ts";

serve(async (req) => {
  if (req.method !== "POST") throw new HttpError(405, "Use POST");
  const caller = await getCaller(req);
  const { journey_id, auto } = await readJson<{ journey_id?: string; auto?: boolean }>(req);
  if (!journey_id) throw new HttpError(400, "journey_id is required");

  // Read through the caller's client so RLS decides visibility.
  const { data: note, error } = await caller.client.from("journeys").select("*").eq("id", journey_id).maybeSingle();
  if (error) throw new HttpError(500, "Could not load the call note");
  if (!note) throw new HttpError(404, "Call note not found or not visible to you");
  if (note.kind !== "context") throw new HttpError(400, "Drafts are only made from call notes");

  const db = adminClient();
  const { data: existing } = await db.from("email_drafts").select("id,status").eq("journey_id", journey_id).maybeSingle();
  if (auto && existing) return json({ ok: true, status: existing.status });

  if (auto) {
    const [{ data: mts }, { data: cbs }, { data: calls }] = await Promise.all([
      db.from("meetings").select("when,status").eq("lead_id", note.lead_id),
      db.from("callbacks").select("when,status").eq("lead_id", note.lead_id),
      db.from("calls").select("at,outcome").eq("lead_id", note.lead_id),
    ]);
    if (situationOf(note, mts ?? [], cbs ?? [], calls ?? [], Date.now()) === "declined") return json({ ok: true, skipped: "declined" });
  }

  let draftId = existing?.id as string | undefined;
  const start = { status: "drafting", error: null, updated_at: nowISO() };
  if (draftId) {
    await db.from("email_drafts").update(start).eq("id", draftId);
  } else {
    const { data: row, error: insErr } = await db.from("email_drafts")
      .insert({ journey_id, lead_id: note.lead_id, owner: note.owner, ...start }).select("id").single();
    if (insErr) {
      if (insErr.code === "23505") return json({ ok: true, status: "drafting" });
      throw new HttpError(500, "Could not start the draft");
    }
    draftId = row.id;
  }

  // One open queue row per draft. A row the worker already holds keeps going; its answer is still fresh enough.
  const { data: open } = await db.from("research_queue").select("id").eq("kind", "post_call_email")
    .contains("payload", { draft_id: draftId }).in("status", ["pending", "running"]).limit(1);
  if (!open?.length) {
    const { error: qe } = await db.from("research_queue").insert({
      kind: "post_call_email", status: "pending", priority: 2, rep_id: caller.id,
      payload: { draft_id: draftId, journey_id, requested_by: caller.id },
    });
    if (qe) {
      await db.from("email_drafts").update({ status: "failed", error: "Could not queue the draft" }).eq("id", draftId);
      throw new HttpError(500, "Could not queue the draft");
    }
  }
  const wake = await wakePostCall();
  return json({ ok: true, status: "drafting", wake }, 202);
});
