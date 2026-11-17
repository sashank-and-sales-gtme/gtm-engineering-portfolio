// Post-call emails for the Claude worker: the task the worker claims, and how its answer is checked and saved.
// The rep's note queues the task (post-call-email); the worker's post-call-writer agent drafts it; claude-work
// calls applyPostCallResult on submit. The worker never touches the database.
import { errMsg } from "./cors.ts";
import { adminClient, audit, coName, nowISO } from "./supabase.ts";
import { sellerBrief } from "./profile.ts";
import { loadProfile } from "./profile_store.ts";
import { loadDocuments } from "./documents.ts";
import { AGENDA_CHARS, checkDraft, clip, day, JOURNEY_EVENTS, ms, nextStep, normalizeDraft, NOTE_CHARS, prune, type Row, situationOf, timeMentions, timelineConflicts, whenIST } from "./postcall_lib.ts";

type QueueRow = { id: string; kind: string; payload: Record<string, any>; submits: number };

/**
 * Cross-checks the timing in a call note against the booked next step. The booked meeting or callback is the
 * record the app acts on, so it wins; the writer is told which wording in the note disagrees and must not repeat it.
 */
export function timelineFacts(note: Row, next: Row | undefined): Row | undefined {
  const ref = ms(note.at);
  const conflicts = timelineConflicts(String(note.text ?? ""), ref, next);
  if (conflicts.length) return { source_of_truth: "next", conflicts, rule: "State only the time in next. Do not repeat timing from the note. Flag the mismatch." };
  if (!next) {
    const said = timeMentions(String(note.text ?? ""), ref).dates.map((d) => d.text);
    if (said.length) return { source_of_truth: "none", note_timing_unbooked: said, rule: "No callback or meeting is booked. Do not state a date or time. Ask via the booking link and flag it." };
  }
  return undefined;
}

async function schedule(db: ReturnType<typeof adminClient>, leadId: string) {
  const [cbs, mts] = await Promise.all([
    db.from("callbacks").select("when,status").eq("lead_id", leadId),
    db.from("meetings").select("when,status,mode,location").eq("lead_id", leadId),
  ]);
  return { callbacks: cbs.data ?? [], meetings: mts.data ?? [] };
}

/** Everything the writer may use, read fresh at claim time and kept small. */
export async function buildFacts(note: Row, lead: Row, now: number) {
  const db = adminClient();
  const profile = await loadProfile();
  const [js, calls, cbs, mts] = await Promise.all([
    db.from("journeys").select("id,at,text,owner,kind").eq("lead_id", lead.id),
    db.from("calls").select("at,outcome,owner").eq("lead_id", lead.id),
    db.from("callbacks").select("when,status,agenda,owner,created_at").eq("lead_id", lead.id),
    db.from("meetings").select("when,status,mode,location,history,owner").eq("lead_id", lead.id),
  ]);
  const journeys = js.data ?? [], callRows = calls.data ?? [], callbacks = cbs.data ?? [], meetings = mts.data ?? [];

  const ownerIds = new Set<string>([note.owner, ...[...journeys, ...callRows, ...callbacks, ...meetings].map((r) => r.owner)].filter(Boolean));
  const { data: profs } = await db.from("profiles").select("id,full_name,email").in("id", [...ownerIds]);
  const nameOf = (id: string) => {
    const p = (profs ?? []).find((x) => x.id === id);
    return String(p?.full_name || p?.email?.split("@")[0] || "a colleague").trim();
  };
  const by = (id: string) => (id === note.owner ? "sender" : nameOf(id).split(/\s+/)[0]);

  const events: Row[] = [];
  journeys.filter((j) => j.id !== note.id && (j.kind === "context" || j.kind === "hubspot"))
    .forEach((j) => events.push({ d: day(j.at), t: ms(j.at), e: j.kind === "hubspot" ? "crm activity" : "note", v: clip(j.text, NOTE_CHARS), by: j.kind === "hubspot" ? undefined : by(j.owner) }));
  callRows.forEach((c) =>
    events.push({ d: day(c.at), t: ms(c.at), e: "call", v: c.outcome === "yes" ? "meeting booked" : c.outcome, by: by(c.owner) })
  );
  callbacks.forEach((c) =>
    events.push({ d: day(c.created_at), t: ms(c.created_at), e: "callback set", v: [whenIST(c.when), clip(c.agenda, AGENDA_CHARS)].filter(Boolean).join(": "), by: by(c.owner) })
  );
  meetings.forEach((m) =>
    (Array.isArray(m.history) ? m.history : []).forEach((h: Row) =>
      events.push({ d: day(h.at), t: ms(h.at), e: "meeting " + String(h.event || "").replace(/_/g, " "), v: whenIST(h.when), by: by(m.owner) })
    )
  );
  events.sort((a, b) => a.t - b.t);
  const recent = events.slice(-JOURNEY_EVENTS).map(({ t: _t, ...rest }) => rest);
  const older = events.length - recent.length;

  const masked = /\*/.test(String(lead.name ?? ""));
  const domain = String(lead.domain ?? "").replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "").toLowerCase();
  return prune({
    seller: sellerBrief(profile),
    insider_context: await loadDocuments(12_000),
    sender: { name: nameOf(note.owner) },
    situation: situationOf(note, meetings, callbacks, callRows, now),
    contact: { name: masked ? String(lead.name).split(/\s+/)[0] : lead.name, title: lead.title },
    account: {
      company: coName(lead.company), site: domain ? `https://${domain}` : "", segment: lead.segment, employees: lead.employees, hq: lead.hq,
      persona: lead.persona, fit: lead.fit_reason, status: lead.status_evidence, adjacency: lead.adjacency,
      pain_points: lead.pain_points, competitive: lead.competitive, angle: lead.angle, proof_point: lead.proof_point,
    },
    note: { at: day(note.at), text: note.text },
    journey: recent,
    earlier: older > 0 ? `${older} older events not shown` : "",
    next: nextStep(meetings, callbacks, now),
    timeline: timelineFacts(note, nextStep(meetings, callbacks, now)),
  }) as Row;
}

/** The claimed task, or null when the note, draft or contact is gone (the row is then skipped). */
export async function postCallTask(row: QueueRow) {
  const db = adminClient();
  const draftId = String(row.payload?.draft_id ?? "");
  const { data: draft } = await db.from("email_drafts").select("id,journey_id,lead_id").eq("id", draftId).maybeSingle();
  if (!draft) return null;
  const [{ data: note }, { data: lead }] = await Promise.all([
    db.from("journeys").select("*").eq("id", draft.journey_id).maybeSingle(),
    db.from("leads").select("*").eq("id", draft.lead_id).maybeSingle(),
  ]);
  if (!note || !lead) return null;
  return { id: row.id, kind: "post_call_email", draft_id: draftId, facts: await buildFacts(note, lead, Date.now()) };
}

export interface PostCallOutcome {
  status: "done" | "retry" | "failed";
  problems?: Record<string, string[]>;
  error?: string;
}

/** Checks a submitted draft. Style misses go back for a fix; on the last submit they are saved as flags. */
export async function applyPostCallResult(row: QueueRow, result: unknown): Promise<PostCallOutcome> {
  const db = adminClient();
  const lastChance = (row.submits ?? 0) >= 2;
  const draftId = String(row.payload?.draft_id ?? "");
  const { data: draft } = await db.from("email_drafts").select("id,lead_id,journey_id,owner").eq("id", draftId).maybeSingle();
  if (!draft) return { status: "failed", error: "the draft no longer exists" };
  const { data: lead } = await db.from("leads").select("name,company").eq("id", draft.lead_id).maybeSingle();
  const { data: note } = await db.from("journeys").select("at,text").eq("id", draft.journey_id).maybeSingle();
  const sched = await schedule(db, draft.lead_id);
  const now = Date.now();
  const next = nextStep(sched.meetings, sched.callbacks, now);

  const out = normalizeDraft(result);
  const c = checkDraft(out, coName(lead?.company), { next, now }, await loadProfile());
  if (c.problems.length) {
    return lastChance ? { status: "failed", error: c.problems.join("; ") } : { status: "retry", problems: { draft: c.problems } };
  }
  if (c.style.length && !lastChance) return { status: "retry", problems: { style: c.style } };

  const flags: string[] = (Array.isArray(out!.flags) ? out!.flags : []).map((f: unknown) => clip(f, 240)).filter(Boolean).slice(0, 6);
  const tl = note ? timelineFacts(note, next) : undefined;
  if (tl?.conflicts) flags.unshift(`Timing: the note says one thing and the booked ${next?.type} says ${next?.when}. The draft follows the booking. Correct the ${next?.type} if the note is right.`);
  else if (tl?.note_timing_unbooked) flags.unshift("Timing: the note mentions a time but no callback or meeting is booked. The draft has no date. Book it, then redraft.");
  for (const s of c.style) flags.push(`Style: ${s}. Fix before sending.`);
  const { error } = await db.from("email_drafts").update({
    status: "ready", format: out!.format, subject: String(out!.subject).trim(), body: c.body, flags, words: c.words,
    error: null, edited: false, updated_at: nowISO(),
  }).eq("id", draftId);
  if (error) throw new Error("Draft received but could not be saved");
  await audit(null, "claude_worker.post_call_email", coName(lead?.company), `${lead?.name ?? ""}: ${out!.format}, ${c.words} words`);
  return { status: "done" };
}
