// Reschedule replies. reschedule-email reads the rep's Gmail thread with the prospect and their calendar, and queues a
// task (research_queue kind 'reschedule_email') with the conversation and the free slots. The worker's
// reschedule-writer picks 5 slots that fit what the prospect said and writes the reply; claude-work checks it here.
import { errMsg } from "./cors.ts";
import { adminClient, audit, coName, nowISO } from "./supabase.ts";
import { busyFrom, checkReply, composeReply, freeSlots, header, messageText, newPart, type ReplyIn, type Slot, slotLabel } from "./reschedule_lib.ts";
import { gcal, gmailRead } from "./google.ts";
import { loadProfile } from "./profile_store.ts";

type Row = Record<string, any>;
type QueueRow = { id: string; kind: string; payload: Record<string, any>; submits: number };

const istDay = (iso: string) => slotLabel(iso).replace(/ · .*$/, "");

/** The last few messages between the rep and the prospect (or anyone at the prospect's domain), oldest first. */
export async function readThread(userId: string, selfEmail: string, prospectEmail: string, domain: string) {
  const who = prospectEmail ? `from:${prospectEmail} OR to:${prospectEmail} OR cc:${prospectEmail}` : domain ? `from:@${domain} OR to:@${domain}` : "";
  if (!who) return { messages: [] as Row[], query: "" };
  const q = `(${who}) newer_than:120d -in:chats`;
  const list = await gmailRead<{ messages?: Array<{ id: string }> }>(userId, "/messages", { q, maxResults: "8" });
  const ids = (list.messages ?? []).map((m) => m.id);
  const me = selfEmail.toLowerCase(),
    them = prospectEmail.toLowerCase();
  const messages: Row[] = [];
  for (const id of ids) {
    const m = await gmailRead<Row>(userId, `/messages/${id}`, { format: "full" });
    const h = m.payload?.headers;
    const from = header(h, "From");
    const fromAddr = (from.match(/<([^>]+)>/)?.[1] ?? from).trim().toLowerCase();
    const text = newPart(messageText(m.payload));
    if (!text) continue;
    messages.push({
      t: Number(m.internalDate) || Date.parse(header(h, "Date")) || 0,
      from: fromAddr === me ? "sender" : (them && fromAddr === them) || (domain && fromAddr.endsWith("@" + domain)) ? "prospect" : from.replace(/<[^>]+>/, "").trim() || "someone else",
      subject: header(h, "Subject").slice(0, 160),
      thread: m.threadId,
      text,
    });
  }
  messages.sort((a, b) => a.t - b.t);
  return { messages, query: q };
}

/** Free slots on the rep's primary calendar for the next 10 business days. */
export async function calendarSlots(userId: string, selfEmail: string, now: number): Promise<Slot[]> {
  const r = await gcal<{ items?: Row[] }>(userId, "/calendars/primary/events", {
    query: {
      timeMin: new Date(now).toISOString(),
      timeMax: new Date(now + 16 * 864e5).toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "250",
    },
  });
  return freeSlots(busyFrom(r.items ?? [], selfEmail), now, { days: 10 });
}

/** The claimed task, or null when the draft or meeting is gone (the row is then skipped). */
export async function rescheduleTask(row: QueueRow) {
  const db = adminClient();
  const draftId = String(row.payload?.draft_id ?? "");
  const { data: d } = await db.from("reschedule_drafts").select("id,meeting_id,lead_id,owner").eq("id", draftId).maybeSingle();
  if (!d) return null;
  const [{ data: m }, { data: lead }, { data: me }] = await Promise.all([
    db.from("meetings").select("*").eq("id", d.meeting_id).maybeSingle(),
    d.lead_id ? db.from("leads").select("name,title,company,domain,angle,persona").eq("id", d.lead_id).maybeSingle() : Promise.resolve({ data: null }),
    db.from("profiles").select("full_name,email").eq("id", d.owner).maybeSingle(),
  ]);
  if (!m) return null;
  const hist = (Array.isArray(m.history) ? m.history : []).slice(-6).map((h: Row) => ({ event: String(h.event || "").replace(/_/g, " "), when: h.when ? slotLabel(h.when) : undefined }));
  const masked = /\*/.test(String(lead?.name ?? m.contact ?? ""));
  return {
    id: row.id,
    kind: "reschedule_email",
    draft_id: draftId,
    facts: {
      today: istDay(nowISO()),
      seller: { company: (await loadProfile()).company_name },
      sender: { name: me?.full_name || String(me?.email ?? "").split("@")[0] },
      contact: { name: masked ? String(lead?.name ?? m.contact).split(/\s+/)[0] : lead?.name ?? m.contact, title: lead?.title ?? m.title, company: coName(lead?.company ?? m.company) },
      meeting: {
        was: m.when ? slotLabel(m.when) : null,
        mode: m.mode,
        reschedules: m.reschedules || 0,
        no_shows: m.no_shows || 0,
        history: hist,
      },
      emails: (row.payload?.emails ?? []).map((e: Row) => ({ from: e.from, date: e.t ? istDay(new Date(e.t).toISOString()) : "", subject: e.subject, text: e.text })),
      candidates: (row.payload?.candidates ?? []).map((s: Slot) => ({ id: s.id, when: s.label })),
    },
  };
}

export interface RescheduleOutcome {
  status: "done" | "retry" | "failed";
  problems?: Record<string, string[]>;
  error?: string;
}

/** Checks a submitted reply and saves it with the slot list built from the picked candidates. */
export async function applyRescheduleResult(row: QueueRow, result: unknown): Promise<RescheduleOutcome> {
  const db = adminClient();
  const lastChance = (row.submits ?? 0) >= 2;
  const draftId = String(row.payload?.draft_id ?? "");
  const { data: d } = await db.from("reschedule_drafts").select("id,meeting_id").eq("id", draftId).maybeSingle();
  if (!d) return { status: "failed", error: "the draft no longer exists" };
  const cands: Slot[] = Array.isArray(row.payload?.candidates) ? row.payload.candidates : [];
  const r = (result && typeof result === "object" ? result : null) as ReplyIn | null;
  const c = checkReply(r, cands);
  if (c.problems.length) return lastChance ? { status: "failed", error: c.problems.join("; ") } : { status: "retry", problems: { reply: c.problems } };
  const flags = (Array.isArray(r!.flags) ? r!.flags : []).map((f) => String(f).slice(0, 240)).filter(Boolean).slice(0, 6);
  const read = r!.read && typeof r!.read === "object" ? r!.read : {};
  const subject = String(r!.subject).trim().slice(0, 160);
  const { error } = await db.from("reschedule_drafts").update({
    status: "ready", subject, body: composeReply(r!, c.picked), slots: c.picked.slice().sort((a, b) => a.iso.localeCompare(b.iso)),
    flags, read, error: null, edited: false, updated_at: nowISO(),
  }).eq("id", draftId);
  if (error) throw new Error("Reply received but could not be saved");
  // The prospect's emails were only needed for writing; drop them from the queue row.
  await db.from("research_queue").update({ payload: { draft_id: draftId, meeting_id: d.meeting_id, candidates: cands } }).eq("id", row.id);
  await audit(null, "claude_worker.reschedule_email", "", `meeting ${d.meeting_id}`);
  return { status: "done" };
}

/** Marks a draft failed with a reason the rep can act on. Never throws. */
export async function failDraft(draftId: string, e: unknown) {
  try {
    await adminClient().from("reschedule_drafts").update({ status: "failed", error: errMsg(e).slice(0, 300), updated_at: nowISO() }).eq("id", draftId);
  } catch { /* ignore */ }
}
