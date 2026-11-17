import { supabase, invokeFn } from "./supabase";
import { createEvent, deleteEvent, listEvents, calErr, createGTask, patchGTask, deleteGTask } from "./google";
import type { Ctx } from "./ctx";
import type { Row } from "./data";
import { TABLES, syncLocal } from "./data";
import { addMin, coName, fmtDay, fmtTime, isoToIst, istToISO, nowISO, plural, validWall } from "./format";
import { readProfile } from "./profile";
import { can, canActOn, leadById, meetingFor, pname, roleGuard, roleName, runsOthersAdds, workVisible } from "./perms";

const pkOf = (table: string) => (TABLES.find((t) => t.table === table) || { pk: "id" }).pk;

/* ---------- db helpers ---------- */
export async function upd(X: Ctx, table: string, id: string, data: Row) {
  if (
    table === "meetings" &&
    !("link_status" in data && Object.keys(data).every((k) => /^(meet_link|location|link_status|cal_title|cal_event_id|cal_link)$/.test(k)))
  )
    data = { ...data, page_updated_at: nowISO() };
  const { error } = await supabase.from(table).update(data).eq(pkOf(table), id);
  if (error) {
    X.toast("Could not save. " + (error.code || ""));
    throw error;
  }
  syncLocal(table, { ...data, [pkOf(table)]: id });
}
export async function ins(table: string, data: Row): Promise<Row> {
  const { data: row, error } = await supabase.from(table).insert(data).select().single();
  if (error) throw error;
  syncLocal(table, row as Row);
  return row as Row;
}
export async function del(table: string, id: string) {
  const { error } = await supabase.from(table).delete().eq(pkOf(table), id);
  if (error) throw error;
  syncLocal(table, { [pkOf(table)]: id }, true);
}
export async function delWithUndo(X: Ctx, table: string, row: Row, label: string, extraUndo?: (id: string, data: Row) => Promise<any>) {
  const id = row[pkOf(table)];
  await del(table, id);
  X.toast(label + " deleted.", async () => {
    const { error } = await supabase.from(table).insert(row);
    if (error) throw error;
    syncLocal(table, row);
    if (extraUndo) await extraUndo(id, row);
  });
}
export async function audit(action: string, target?: string, detail?: string) {
  try {
    await supabase.from("audit_log").insert({ action, target: target || "", detail: detail || "" });
  } catch (_) {}
}

/* ---------- calendar ---------- */
async function calBlock(o: { summary: string; start: string; minutes: number; description?: string }) {
  return createEvent({ summary: o.summary, start: o.start, end: addMin(o.start, o.minutes), description: o.description });
}
void calBlock;

/* ---------- Google Tasks: callbacks and to-dos live there, ticked off from Google or the roster ---------- */
const rosterLink = (company: string) => `${window.location.origin}/#/accounts/${encodeURIComponent(coName(company).toLowerCase())}`;
type CallbackIn = { contact: string; company: string; when: string; agenda: string; title?: string; angle?: string };
const callbackNotes = (c: CallbackIn) =>
  [`Agenda: ${c.agenda}`, c.title ? `${c.title} at ${coName(c.company)}` : "", c.angle ? `Angle: ${c.angle}` : "", `Open in the roster: ${rosterLink(c.company)}`]
    .filter(Boolean)
    .join("\n");
/** A callback as a Google Task. The time goes in the title because Google Tasks keeps only the date. */
async function callbackTask(c: CallbackIn) {
  return createGTask({ title: `Callback: ${c.contact} (${coName(c.company)}) · ${fmtTime(c.when)}`, notes: callbackNotes(c), due: c.when });
}
/**
 * Puts a callback in Google: the Task (ticked off from Google closes it) plus a 15-minute Calendar event at the exact
 * time, since the Tasks API drops the time and the task would otherwise sit on the day as all-day. The event is best
 * effort: if it fails the Task still counts.
 */
async function callbackToGoogle(c: CallbackIn): Promise<{ cal_event_id: string; cal_block_id: string | null }> {
  const cal_event_id = await callbackTask(c);
  let cal_block_id: string | null = null;
  try {
    cal_block_id = (await createEvent({ summary: `Callback: ${c.contact} (${coName(c.company)})`, start: c.when, end: addMin(c.when, 15), description: callbackNotes(c) })) || null;
  } catch (_) {}
  return { cal_event_id, cal_block_id };
}
async function todoTask(t: { title: string; when: string; notes?: string }) {
  return createGTask({ title: `${t.title} · ${fmtTime(t.when)}`, notes: t.notes || "", due: t.when });
}
/** Removes whatever a row points to in Google: a Task, or an older calendar block. */
async function removeGoogle(kind: string | null | undefined, id: string, blockId?: string | null) {
  if (blockId) await deleteEvent(blockId).catch(() => {});
  if (!id) return;
  if (kind === "task") await deleteGTask(id);
  else await deleteEvent(id);
}
/** Ticks the Google Task off (or reopens it) to match the roster. Best effort. */
export async function syncGoogleDone(row: Row | undefined, done: boolean) {
  if (row && row.cal_kind === "task" && row.cal_event_id) await patchGTask(row.cal_event_id, { completed: done }).catch(() => {});
}
/** Marks a to-do done or open in the roster and in Google Tasks. */
export async function setTaskDone(X: Ctx, id: string, done: boolean) {
  const t = X.D.tasks.find((x) => x.id === id);
  try {
    await upd(X, "tasks", id, { done, done_at: done ? nowISO() : null });
  } catch (_) {
    return;
  }
  syncGoogleDone(t, done);
}

export async function findMeetLink(X: Ctx, m: Row) {
  if (!m.when || m.mode === "offline") return;
  try {
    const evs = await listEvents(addMin(m.when, -60), addMin(m.when, 60));
    const coKey = coName(m.company).toLowerCase().split(/\s+/)[0];
    const first = String(m.contact || "").split(" ")[0].toLowerCase();
    const hay = (e: any) => (String(e.summary || e.title || "") + " " + JSON.stringify(e.attendees || [])).toLowerCase();
    const startOf = (e: any) => {
      const s = (e.start && (e.start.dateTime || e.start.date)) || e.startTime || "";
      const t = new Date(s).getTime();
      return isNaN(t) ? NaN : Math.floor(t / 60000);
    };
    const target = Math.floor(new Date(m.when).getTime() / 60000);
    const exact = (e: any) => startOf(e) === target;
    const match = (e: any) => (coKey && coKey.length > 2 && hay(e).includes(coKey)) || (first.length > 2 && hay(e).includes(first));
    const seller = readProfile(X.D.settings.profile).company_name.toLowerCase();
    const demoish = (e: any) => /demo/i.test(e.summary || "") || (seller.length > 2 && String(e.summary || "").toLowerCase().includes(seller));
    const ev = evs.find((e) => match(e) && exact(e)) || evs.find(match) || evs.find((e) => exact(e) && demoish(e));
    if (!ev) {
      await upd(X, "meetings", m.id, { link_status: "not found on calendar yet" });
      return;
    }
    const video =
      ev.conferenceData && Array.isArray(ev.conferenceData.entryPoints)
        ? (ev.conferenceData.entryPoints.find((p: any) => p.entryPointType === "video") || {}).uri
        : "";
    const link =
      ev.hangoutLink ||
      video ||
      ev.conferenceUrl ||
      (JSON.stringify(ev).match(/https:\/\/meet\.google\.com\/[a-z0-9-]+/i) || [])[0] ||
      "";
    const loc = ev.location && !/meet\.google\.com/.test(ev.location) ? ev.location : "";
    await upd(X, "meetings", m.id, {
      meet_link: link,
      location: m.location || loc,
      link_status: link ? "found" : "event found, no Meet link",
      cal_title: ev.summary || ev.title || "",
      cal_event_id: ev.id || "",
      cal_link: ev.htmlLink || "",
    });
  } catch (e) {
    await upd(X, "meetings", m.id, { link_status: calErr(e) }).catch(() => {});
  }
}

/* ---------- HubSpot via edge function ---------- */
export async function syncJourney(X: Ctx, jid: string) {
  X.S.busy.add("hs:" + jid);
  X.rerender();
  try {
    const r = await invokeFn<{ ok: boolean; target?: string; error?: string }>("hubspot-note", { journey_id: jid });
    if (r && r.ok === false) throw { message: r.error || "HubSpot sync failed" };
    X.toast(r && r.target === "deal" ? "Saved to the journey and the POC deal in HubSpot." : "Saved to the journey and the HubSpot contact.");
  } catch (e: any) {
    await supabase.from("journeys").update({ hs_status: "failed", hs_error: "HubSpot refused the request: " + ((e && e.message) || "") }).eq("id", jid).neq("hs_status", "synced");
    X.toast("Saved to the journey. HubSpot sync failed.");
  } finally {
    X.S.busy.delete("hs:" + jid);
    X.rerender();
  }
}

/* ---------- outcome cycle ---------- */
export function formFor(X: Ctx, key: string) {
  return X.S.forms[key] || (X.S.forms[key] = { outcome: "", when: "", agenda: "", mode: "online", location: "", at: "", dnpWhen: "", dnpNote: "" });
}

/** Default retry for a DNP, as IST wall time: the next working day at the same time of day, kept within
    10:00 to 18:00 and rounded to the half hour. */
export function dnpRetryWall(from = Date.now()): string {
  const ist = new Date(from + 5.5 * 3600 * 1000);
  ist.setUTCDate(ist.getUTCDate() + 1);
  while (ist.getUTCDay() === 0 || ist.getUTCDay() === 6) ist.setUTCDate(ist.getUTCDate() + 1);
  let mins = Math.round((ist.getUTCHours() * 60 + ist.getUTCMinutes()) / 30) * 30;
  mins = Math.min(18 * 60, Math.max(10 * 60, mins));
  ist.setUTCHours(Math.floor(mins / 60), mins % 60, 0, 0);
  return ist.toISOString().slice(0, 16);
}

/** Outcomes in the order the dropdown lists them. */
export const OUTCOMES: Array<[string, string, string]> = [
  ["yes", "Meeting booked", "Booked a meeting"],
  ["callback", "Callback", "New callback"],
  ["dnp", "Did not pick up (DNP)", "Did not pick up (DNP)"],
  ["no", "No meeting", "Not interested"],
  ["wrong_icp", "Wrong ICP", "Wrong ICP"],
];
export const OUTCOME_LABEL: Record<string, string> = Object.fromEntries(OUTCOMES.map(([v, l]) => [v, l]));

/** When the call happened, from an IST wall-time field (blank means now). Returns "" when it is in the future. */
export function callTime(v: string | undefined): string {
  if (!v || !validWall(v)) return nowISO();
  const iso = istToISO(v);
  return new Date(iso).getTime() > Date.now() + 5 * 60000 ? "" : iso;
}
export const nowWall = () => isoToIst(nowISO());

export async function submitOutcome(X: Ctx, leadId: string, cbId: string | null) {
  const key = cbId ? "cb:" + cbId : "ld:" + leadId,
    f = formFor(X, key),
    l = leadById(X, leadId);
  if (!l || !f.outcome) return;
  const at = callTime(f.at);
  if (!at) return X.toast("The call time can't be in the future.");
  if ((f.outcome === "yes" || f.outcome === "callback") && !validWall(f.when)) return X.toast("Add the date and time first.");
  if (f.outcome === "callback" && !f.agenda.trim()) return X.toast("Add the callback agenda.");
  // DNPs always get a retry callback: no DNP is logged without one.
  if (f.outcome === "dnp") {
    if (!validWall(f.dnpWhen)) return X.toast("Set when to call back. Every DNP needs a callback.");
    if (new Date(istToISO(f.dnpWhen)).getTime() < Date.now()) return X.toast("The callback time is in the past.");
  }
  if (f.outcome === "yes" && f.mode === "offline" && !f.location.trim()) return X.toast("Add the meeting location.");
  if (!canActOn(X, l) && !(cbId && workVisible(X, X.D.callbacks.find((c) => c.id === cbId))))
    return X.toast("This contact is assigned to someone else.");
  X.S.busy.add(key);
  X.rerender();
  const base = { lead_id: leadId, company: l.company, contact: l.name, title: l.title, segment: l.segment || "", title_scope: l.title_scope || "" };
  const prev_lead = { stage: l.stage || "", last_outcome: l.last_outcome || "", last_call_at: l.last_call_at || null };
  try {
    const callRow = await ins("calls", { ...base, outcome: f.outcome, at, from_kind: cbId ? "callback" : "contact", closed_callback_id: cbId || null, prev_lead });
    const undo = () => undoCall(X, callRow.id);
    if (cbId) {
      await upd(X, "callbacks", cbId, { status: "done", done_at: nowISO(), outcome: f.outcome });
      syncGoogleDone(X.D.callbacks.find((c) => c.id === cbId), true);
    }
    if (f.outcome === "yes") {
      const when = istToISO(f.when);
      const m = await ins("meetings", {
        ...base, when, mode: f.mode, location: f.mode === "offline" ? f.location.trim() : "", meet_link: "", link_status: "looking",
        status: "scheduled", reschedules: 0, no_shows: 0, prep: "", history: [{ at: nowISO(), event: "booked", when }], call_id: callRow.id,
        page_updated_at: nowISO(),
      });
      await upd(X, "calls", callRow.id, { meeting_id: m.id });
      await upd(X, "leads", leadId, { stage: "meeting", last_outcome: "yes", last_call_at: at });
      findMeetLink(X, m);
      X.toast("Meeting saved. Looking for it on your calendar.", undo);
    } else if (f.outcome === "callback" || f.outcome === "dnp") {
      const dnp = f.outcome === "dnp";
      const when = istToISO(dnp ? f.dnpWhen : f.when);
      const tries = X.D.calls.filter((c) => c.lead_id === leadId && c.outcome === "dnp").length; // includes this one
      const agenda = dnp
        ? [`Retry after DNP (attempt ${tries + 1}).`, String(f.dnpNote || "").trim()].filter(Boolean).join(" ")
        : f.agenda.trim();
      const cb = await ins("callbacks", { ...base, when, agenda, status: "open", cal_status: "adding", call_id: callRow.id });
      await upd(X, "calls", callRow.id, { new_callback_id: cb.id });
      await upd(X, "leads", leadId, { stage: "callback", last_outcome: f.outcome, last_call_at: at });
      const what = dnp ? `DNP logged. Callback set for ${fmtDay(when)} ${fmtTime(when)}` : "Callback saved";
      try {
        const g = await callbackToGoogle({ contact: l.name, company: l.company, when, agenda, title: l.title, angle: l.angle });
        await upd(X, "callbacks", cb.id, { cal_status: "added", ...g, cal_kind: "task" });
        X.toast(`${what} and added to Google${g.cal_block_id ? " Tasks and your calendar" : " Tasks"}.`, undo);
      } catch (e) {
        await upd(X, "callbacks", cb.id, { cal_status: "failed", cal_error: calErr(e), cal_kind: "task" });
        X.toast(`${what}. Adding it to Google Tasks failed.`, undo);
      }
    } else if (f.outcome === "wrong_icp") {
      await upd(X, "leads", leadId, { last_outcome: "wrong_icp", last_call_at: at });
      await setLeadDq(X, l, true, "Wrong ICP", true);
      X.toast(`${l.name} marked Wrong ICP and disqualified.`, undo, { label: "Find more ICPs", fn: () => findMoreIcps(X, l) });
    } else {
      await upd(X, "leads", leadId, { last_outcome: f.outcome, last_call_at: at });
      X.toast("Call logged.", undo);
    }
    delete X.S.forms[key];
  } catch (e: any) {
    if (e && e.message) X.toast("Could not save. " + e.message);
  } finally {
    X.S.busy.delete(key);
    X.rerender();
  }
}

/* Reverse a logged call and everything it created: the booked meeting, the new callback (and its calendar block),
   the closed callback (reopened), and the contact's previous stage. */
export async function undoCall(X: Ctx, callId: string) {
  const call = X.D.calls.find((c) => c.id === callId);
  const made = call && call.new_callback_id ? X.D.callbacks.find((c) => c.id === call.new_callback_id) : undefined;
  const closed = call && call.closed_callback_id ? X.D.callbacks.find((c) => c.id === call.closed_callback_id) : undefined;
  const { data, error } = await supabase.rpc("undo_call", { p_call_id: callId });
  if (error) throw error;
  // A Wrong ICP call also disqualified the contact; undoing the call brings them back.
  if (call && call.outcome === "wrong_icp" && call.lead_id) {
    const l = leadById(X, call.lead_id);
    if (l && l.dq_reason === "Wrong ICP") await setLeadDq(X, l, false, "", true).catch(() => {});
  }
  const evId = data && (data as any).deleted_callback_cal_event_id;
  if (evId) {
    try {
      await removeGoogle(made ? made.cal_kind : "event", evId, made && made.cal_block_id);
    } catch (_) {
      X.toast("Call undone. Remove the callback from Google by hand.");
    }
  }
  // The callback this call had closed is open again, in Google too.
  syncGoogleDone(closed, false);
}
export function callUndoNote(X: Ctx, c: Row) {
  const m = c.meeting_id && X.D.meetings.find((x) => x.id === c.meeting_id),
    cb = c.new_callback_id && X.D.callbacks.find((x) => x.id === c.new_callback_id);
  if (m)
    return `This also deletes the meeting booked for ${fmtDay(m.when)} ${fmtTime(m.when)}${
      m.status !== "scheduled" ? " and its " + (m.status === "done" ? "done" : "no-show") + " history" : ""
    }. HubSpot and your calendar keep their copy.`;
  if (cb) return `This also deletes the callback set for ${fmtDay(cb.when)} ${fmtTime(cb.when)} and its calendar block.`;
  if (c.closed_callback_id) return "The callback this call closed reopens.";
  return "";
}
export async function retryCal(X: Ctx, cbId: string) {
  const c = X.D.callbacks.find((x) => x.id === cbId);
  if (!c) return;
  X.S.busy.add("cal:" + cbId);
  X.rerender();
  try {
    const l = leadById(X, c.lead_id);
    const g = await callbackToGoogle({ contact: c.contact, company: c.company, when: c.when, agenda: c.agenda, title: l?.title, angle: l?.angle });
    await upd(X, "callbacks", cbId, { cal_status: "added", ...g, cal_error: "", cal_kind: "task" });
    X.toast(g.cal_block_id ? "Added to your Google Tasks and calendar." : "Added to your Google Tasks.");
  } catch (e) {
    await upd(X, "callbacks", cbId, { cal_status: "failed", cal_error: calErr(e) }).catch(() => {});
  } finally {
    X.S.busy.delete("cal:" + cbId);
    X.rerender();
  }
}

/* ---------- connected call ---------- */
export async function submitCtx(X: Ctx, leadId: string, text: string, when = "") {
  const l = leadById(X, leadId);
  if (!l) return;
  text = text.trim();
  if (!text) return X.toast("Add the conversation context.");
  const at = callTime(when);
  if (!at) return X.toast("The call time can't be in the future.");
  X.S.modal = null;
  delete X.S.forms["ctx:" + l.id];
  X.rerender();
  try {
    const hs = can(X, "hubspot_notes");
    const j = await ins("journeys", {
      lead_id: l.id, company: l.company, contact: l.name, text, at, kind: "context",
      hs_status: hs ? "syncing" : "off", stage: meetingFor(X, l.id) ? "demo" : "pre-demo",
    });
    X.S.openAcct.add(coName(l.company).toLowerCase());
    draftEmail(X, j.id as string, true);
    if (hs) syncJourney(X, j.id);
    else X.toast("Saved to the deal journey.");
  } catch (_) {
    X.toast("Could not save the context.");
  }
}

/** Corrects the text of a call note. The HubSpot note (if synced) is not changed; the follow-up draft can be redone. */
export async function editNote(X: Ctx, id: string, text: string) {
  const j = X.D.journeys.find((x) => x.id === id);
  text = text.trim();
  if (!j || j.text === text) return;
  if (!text) return X.toast("A call note can't be empty.");
  try {
    await upd(X, "journeys", id, { text });
  } catch (_) {
    return;
  }
  const hasDraft = X.D.drafts.some((d) => d.journey_id === id && d.status !== "drafting");
  const msg = j.hs_status === "synced" ? "Note updated. The HubSpot copy is unchanged; edit it there too." : "Note updated.";
  X.toast(msg, null, hasDraft ? { label: "Redraft email", fn: () => draftEmail(X, id) } : null);
}

/* ---------- post-call email ---------- */
/** Queues a follow-up draft for a call note. auto: the silent call made right after a note is saved. */
export async function draftEmail(X: Ctx, journeyId: string, auto = false) {
  const k = "draft:" + journeyId;
  if (X.S.busy.has(k)) return;
  if (!auto) {
    const d = X.D.drafts.find((x) => x.journey_id === journeyId);
    if (d && d.edited && !window.confirm("Regenerating replaces your edits to this draft. Continue?")) return;
    X.S.busy.add(k);
    X.rerender();
  }
  try {
    await invokeFn<{ ok: boolean; skipped?: string }>("post-call-email", { journey_id: journeyId, auto });
  } catch (e: any) {
    if (!auto) X.toast((e && e.message) || "Couldn't queue the draft.");
  } finally {
    if (!auto) {
      X.S.busy.delete(k);
      X.rerender();
    }
  }
}
export async function saveDraft(X: Ctx, id: string, patch: { subject?: string; body?: string }) {
  await upd(X, "email_drafts", id, { ...patch, edited: true, updated_at: nowISO() });
}

/* ---------- disqualify, closed lost, find more ICPs ---------- */
const rpcErr = (e: any) => (e && /not allowed/i.test(e.message || "") ? "You can't change these contacts." : "Could not save.");
/** Disqualify or requalify one contact. quiet: no toast (the caller shows its own). */
export async function setLeadDq(X: Ctx, l: Row, on: boolean, reason: string, quiet = false) {
  const { error } = await supabase.rpc("set_lead_dq", { p_lead_id: l.id, p_on: on, p_reason: reason || null });
  if (error) {
    X.toast(rpcErr(error));
    throw error;
  }
  syncLocal("leads", { id: l.id, dq_at: on ? nowISO() : null, dq_reason: on ? reason || "Not a fit" : null, dq_by: on ? X.uid : null, dq_scope: on ? "contact" : null });
  if (!quiet) X.toast(on ? `${l.name} disqualified.` : `${l.name} is back in play.`, () => setLeadDq(X, l, !on, l.dq_reason || reason, true));
}
/** Disqualify or requalify every contact at a company. */
export async function setAccountDq(X: Ctx, company: string, leads: Row[], on: boolean, reason: string) {
  const { error } = await supabase.rpc("set_account_dq", { p_company: company, p_on: on, p_reason: reason || null });
  if (error) return X.toast(rpcErr(error));
  for (const l of leads) syncLocal("leads", { id: l.id, dq_at: on ? nowISO() : null, dq_reason: on ? reason || "Not a fit" : null, dq_by: on ? X.uid : null, dq_scope: on ? "company" : null });
  X.toast(on ? `${coName(company)} disqualified. It's under Disqualified in the status filter.` : `${coName(company)} is back in play.`, on ? () => setAccountDq(X, company, leads, false, "") : null);
}
/** Close an account as lost / cold, or reopen it. */
export async function setAccountLost(X: Ctx, company: string, leads: Row[], on: boolean, reason: string) {
  const { error } = await supabase.rpc("set_account_lost", { p_company: company, p_on: on, p_reason: reason || null });
  if (error) return X.toast(rpcErr(error));
  for (const l of leads) syncLocal("leads", { id: l.id, lost_at: on ? nowISO() : null, lost_reason: on ? reason || "Went cold" : null, lost_by: on ? X.uid : null });
  X.toast(on ? `${coName(company)} moved to Closed lost / Cold.` : `${coName(company)} reopened.`, on ? () => setAccountLost(X, company, leads, false, "") : null);
}
/* ---------- lead distribution ---------- */
export type DistPlan = {
  applied: boolean;
  assigned: number;
  unmatched: number;
  by_reason: Record<string, number>;
  reps: Array<{ rep_id: string; name: string; contacts: number; accounts: number }>;
  unmatched_companies: string[];
};
/** Preview (apply = false) or run the distribution of unassigned contacts to the reps in rotation. */
export async function distributeLeads(X: Ctx, apply: boolean): Promise<DistPlan | null> {
  const t0 = new Date(Date.now() - 5000).toISOString();
  const { data, error } = await supabase.rpc("distribute_unassigned_leads", { p_apply: apply });
  if (error) {
    X.toast(error && /not allowed/i.test(error.message || "") ? "Your role can't distribute contacts." : "Could not distribute. " + (error.message || ""));
    return null;
  }
  if (apply) {
    const { data: rows } = await supabase.from("leads").select("id,assigned_to,assigned_at,assigned_by").gte("assigned_at", t0);
    for (const r of rows || []) syncLocal("leads", r as Row);
  }
  return data as DistPlan;
}
/** Hand a set of contacts to one person (null unassigns). Returns how many changed. */
export async function assignLeadsBulk(X: Ctx, leads: Row[], rep: string | null): Promise<number> {
  const { data, error } = await supabase.rpc("assign_leads_bulk", { p_ids: leads.map((l) => l.id), p_rep: rep });
  if (error) {
    X.toast(/not allowed/i.test(error.message || "") ? "Your role can't assign contacts." : "Could not assign. " + (error.message || ""));
    return 0;
  }
  const at = nowISO();
  for (const l of leads) if ((l.assigned_to || null) !== rep) syncLocal("leads", { id: l.id, assigned_to: rep, assigned_at: at, assigned_by: X.uid });
  return Number(data) || 0;
}

/** After a Wrong ICP call: search Apollo for other marketing leaders at the same account, to pick and enrich. */
export async function findMoreIcps(X: Ctx, l: Row) {
  if (!can(X, "add_company")) return X.toast("Your role can't add contacts. Ask an admin.");
  const domain = String(l.domain || "").toLowerCase();
  if (!domain) return X.toast("This account has no domain to search.");
  const running = X.D.addreqs.find((r) => r.domain === domain && r.mode === "more" && !["done", "failed"].includes(r.status));
  if (running) return X.toast("Already looking for alternate contacts here. Pick them under Being added.");
  X.S.busy.add("more:" + l.id);
  X.rerender();
  try {
    const forRep = l.assigned_to && l.assigned_to !== X.uid && runsOthersAdds(X) ? l.assigned_to : "";
    const r = await ins("add_requests", { company: l.company, domain, mode: "more", status: "searching", picked: [], candidates: [], note: "", ...(forRep ? { owner: forRep } : {}) });
    X.toast((await fireAdd(X, r.id)) ? `Searching Apollo for alternate ICP contacts at ${coName(l.company)}. Pick who to enrich under Being added.` : "Could not start the search.");
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch (_) {
    X.toast("Could not start the search.");
  } finally {
    X.S.busy.delete("more:" + l.id);
    X.rerender();
  }
}

/* ---------- reschedule reply ---------- */
/** Reads the rep's thread with the prospect and their calendar, and queues a reply offering 5 new times. */
export async function draftReschedule(X: Ctx, meetingId: string) {
  const k = "rsd:" + meetingId;
  if (X.S.busy.has(k)) return;
  const d = X.D.rdrafts.find((x) => x.meeting_id === meetingId);
  if (d && d.edited && !window.confirm("Redrafting replaces your edits to this reply. Continue?")) return;
  X.S.busy.add(k);
  X.rerender();
  try {
    const r = await invokeFn<{ ok: boolean; emails?: number; slots?: number; error?: string; message?: string }>("reschedule-email", { meeting_id: meetingId });
    if (r && r.ok === false) throw { message: r.message || r.error };
    X.toast(`Read ${plural(r.emails || 0, "email")} and found ${r.slots || 0} free slots. The reply appears here when the Claude worker runs.`);
  } catch (e: any) {
    const m = (e && e.message) || "";
    X.toast(/reconnect|not.?connected|Gmail access/i.test(m) ? "Reconnect Google (profile menu > Connections) so the roster can read your inbox." : m || "Couldn't start the reply.");
  } finally {
    X.S.busy.delete(k);
    X.rerender();
  }
}
export async function saveRescheduleDraft(X: Ctx, id: string, patch: { subject?: string; body?: string }) {
  await upd(X, "reschedule_drafts", id, { ...patch, edited: true, updated_at: nowISO() });
}

/* ---------- add company ---------- */
async function fireAdd(X: Ctx, id: string) {
  try {
    await invokeFn("add-company", { request_id: id });
    return true;
  } catch (e: any) {
    await supabase.from("add_requests").update({ status: "failed", note: (e && e.message) || "Could not start." }).eq("id", id);
    return false;
  }
}
export async function submitAdd(X: Ctx) {
  const a = X.S.modal;
  if (!a || a.type !== "add") return;
  a.company = a.company.trim();
  a.domain = a.domain.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
  if (!a.company || !a.domain) return X.toast("Add the company name and domain.");
  if (X.D.leads.some((l) => (l.domain || "").toLowerCase() === a.domain) && a.mode === "next" && !a.name.trim())
    X.toast("That account is already on the roster.");
  if (a.mode === "now" && !can(X, "enrich_now")) return X.toast("Your role can't enrich now. Queue it for the next batch.");
  X.S.busy.add("add");
  X.rerender();
  const forRep = a.for && a.for !== X.uid && runsOthersAdds(X) ? a.for : "";
  const doc: Row = { company: a.company, domain: a.domain, mode: a.mode, picked: [], candidates: [], note: "", ...(forRep ? { owner: forRep } : {}) };
  const who = forRep ? ` for ${pname(X, forRep)}` : "";
  const person = a.name.trim() ? [{ name: a.name.trim(), title: a.title.trim(), linkedin: a.linkedin.trim() }] : [];
  try {
    if (a.mode === "next") {
      await ins("add_requests", { ...doc, status: "queued", contact: person[0] || null });
      X.toast(`Queued for the next batch${who}.`);
    } else if (person.length) {
      const r = await ins("add_requests", { ...doc, status: "enriching", picked: person, contact: person[0] });
      X.toast((await fireAdd(X, r.id)) ? `Checking HubSpot and enriching${who}. The lead appears after the next Claude worker run.` : "Could not start enrichment.");
    } else {
      const r = await ins("add_requests", { ...doc, status: "searching" });
      X.toast((await fireAdd(X, r.id)) ? `Searching Apollo for contacts${who}.` : "Could not start the search.");
    }
    X.S.modal = null;
    X.S.tab = "accounts";
  } catch (_) {
    X.toast("Could not add the company.");
  } finally {
    X.S.busy.delete("add");
    X.rerender();
  }
}
export async function enrichPicked(X: Ctx, id: string) {
  const r = X.D.addreqs.find((x) => x.id === id),
    sel: number[] = X.S.forms["pick:" + id] || [];
  if (!r || !sel.length) return;
  try {
    await upd(X, "add_requests", r.id, { status: "enriching", picked: sel.map((i) => r.candidates[i]) });
    delete X.S.forms["pick:" + r.id];
    X.toast((await fireAdd(X, r.id)) ? "Checking HubSpot and enriching. Leads appear after the next Claude worker run." : "Could not start enrichment.");
  } catch (_) {}
}
/** Fallback when the Apollo search finds nobody (or the wrong people): enrich contacts typed in by hand.
    On a "pick" request the ticked candidates go along with them. */
export async function addManualContacts(X: Ctx, id: string, people: Array<{ name: string; title: string; linkedin: string }>) {
  const r = X.D.addreqs.find((x) => x.id === id);
  if (!r || !can(X, "add_company")) return X.toast("Your role can't add contacts. Ask an admin.");
  const typed = people
    .map((p) => ({ name: p.name.trim(), title: p.title.trim(), linkedin: p.linkedin.trim() }))
    .filter((p) => p.name);
  if (!typed.length) return X.toast("Add at least one name.");
  if (typed.some((p) => p.linkedin && !/^https?:\/\/([a-z]+\.)?linkedin\.com\/in\//i.test(p.linkedin))) return X.toast("LinkedIn links should look like https://www.linkedin.com/in/…");
  const sel: number[] = X.S.forms["pick:" + id] || [];
  const ticked = r.status === "pick" && Array.isArray(r.candidates) ? sel.map((i) => r.candidates[i]).filter(Boolean) : [];
  if (ticked.length && !can(X, "enrich_now")) return X.toast("Untick the Apollo contacts, or ask an admin to enrich them.");
  const k = "manual:" + id;
  X.S.busy.add(k);
  X.rerender();
  try {
    await upd(X, "add_requests", id, {
      status: "enriching",
      picked: [...ticked, ...typed],
      contact: typed[0],
      mode: r.mode === "next" ? "now" : r.mode,
      note: "",
    });
    delete X.S.forms["pick:" + id];
    delete X.S.forms["manual:" + id];
    const n = ticked.length + typed.length;
    X.toast((await fireAdd(X, id)) ? `Checking HubSpot and enriching ${plural(n, "contact")}. Leads appear after the next Claude worker run.` : "Could not start enrichment.");
  } catch (_) {
    X.toast("Could not add the contacts.");
  } finally {
    X.S.busy.delete(k);
    X.rerender();
  }
}
export async function refire(X: Ctx, id: string) {
  const r = X.D.addreqs.find((x) => x.id === id) || {};
  await upd(X, "add_requests", id, { status: (r.picked || []).length ? "enriching" : "searching", note: "" });
  X.toast((await fireAdd(X, id)) ? "Started again." : "Could not start.");
}

/* ---------- meetings ---------- */
export async function buildPrep(X: Ctx, id: string) {
  X.S.busy.add("prep:" + id);
  X.rerender();
  try {
    await invokeFn("prep-brief", { meeting_id: id });
    X.S.openPrep.add(id);
    X.toast("Brief queued for the Claude worker. It appears here after the next run.");
  } catch (e: any) {
    X.toast("Could not queue the brief. " + String((e && e.message) || ""));
  } finally {
    X.S.busy.delete("prep:" + id);
    X.rerender();
  }
}
export async function rebook(X: Ctx, id: string) {
  const f = X.S.forms["rs:" + id] || {},
    m = X.D.meetings.find((x) => x.id === id);
  if (!m || !validWall(f.when)) return X.toast("Enter the new date and time.");
  X.S.busy.add("rs:" + m.id);
  X.rerender();
  const when = istToISO(f.when);
  const prev = { when: m.when, status: m.status, reschedules: m.reschedules || 0, meet_link: m.meet_link || "", link_status: m.link_status || "", history: m.history || [] };
  try {
    await upd(X, "meetings", m.id, {
      when, status: "scheduled", reschedules: (m.reschedules || 0) + 1, meet_link: "", link_status: "looking",
      history: [...(m.history || []), { at: nowISO(), event: "rebooked", when }],
    });
    delete X.S.forms["rs:" + m.id];
    findMeetLink(X, { ...m, when });
    X.toast("Meeting rebooked.", () => upd(X, "meetings", m.id, prev));
  } catch (_) {
  } finally {
    X.S.busy.delete("rs:" + m.id);
    X.rerender();
  }
}
export async function meetingHappened(X: Ctx, id: string, v: string) {
  const m = X.D.meetings.find((x) => x.id === id);
  if (!m || !v) return;
  const prev = { status: m.status, no_shows: m.no_shows || 0, history: m.history || [], done_at: m.done_at || null };
  try {
    if (v === "yes") {
      await upd(X, "meetings", m.id, { status: "done", done_at: nowISO(), history: [...(m.history || []), { at: nowISO(), event: "done" }] });
      if (m.lead_id) await upd(X, "leads", m.lead_id, { stage: "met" }).catch(() => {});
      X.toast("Marked as done.", async () => {
        await upd(X, "meetings", m.id, prev);
        if (m.lead_id) await upd(X, "leads", m.lead_id, { stage: "meeting" });
      });
    } else {
      await upd(X, "meetings", m.id, {
        status: "rescheduling", no_shows: (m.no_shows || 0) + 1,
        history: [...(m.history || []), { at: nowISO(), event: "no_show", when: m.when }],
      });
      X.toast("Moved to the reschedule queue.", () => upd(X, "meetings", m.id, prev));
    }
  } catch (_) {}
}
/** Shared HubSpot booking link. Admin only (manage_integrations); must be a HubSpot meetings URL. */
export async function saveLink(X: Ctx, v: string) {
  v = v.trim();
  if (!can(X, "manage_integrations")) return X.toast("Only admins can change the booking link.");
  if (!/^https:\/\/meetings[\w.-]*\.hubspot\.com\/\S+/i.test(v)) return X.toast("Enter the full HubSpot meetings link, starting with https://meetings");
  const { error } = await supabase.from("app_settings").upsert({ key: "booking_link", value: { url: v }, updated_at: nowISO() });
  X.toast(error ? "Could not save the link." : "Scheduling link saved.");
}

/* ---------- CRM guard ---------- */
// Automatic (quiet) checks run two at a time so opening a big account doesn't burst HubSpot.
const guardQueue: Array<() => void> = [];
let guardRunning = 0;
function guardSlot(): Promise<void> {
  if (guardRunning < 2) {
    guardRunning++;
    return Promise.resolve();
  }
  return new Promise((res) => guardQueue.push(() => { guardRunning++; res(); }));
}
function guardDone() {
  guardRunning--;
  const next = guardQueue.shift();
  if (next) next();
}

/** Checks the roster and HubSpot for anyone else working this person. The verdict is saved on the lead. */
export async function checkGuard(X: Ctx, leadId: string, quiet = false) {
  const key = "guard:" + leadId;
  if (X.S.busy.has(key)) return;
  X.S.busy.add(key);
  if (quiet) await guardSlot();
  X.rerender();
  try {
    const r = await invokeFn<{ ok: boolean; guard: Row }>("crm-guard", { lead_id: leadId });
    if (!quiet && r && r.guard) X.toast(r.guard.level === "clear" ? "No one else is working this person." : "Check the CRM notes before calling.");
  } catch (e: any) {
    if (!quiet) X.toast("Could not check the CRM. " + ((e && e.message) || ""));
  } finally {
    if (quiet) guardDone();
    X.S.busy.delete(key);
    X.rerender();
  }
}

/* ---------- approval + enrichment ---------- */
/** Approve (or un-approve) a contact. Approving enriches it straight away: Apollo, then FullEnrich if no email. */
export async function approveLead(X: Ctx, l: Row, checked: boolean) {
  try {
    await upd(X, "leads", l.id, { approved: checked, approved_at: checked ? nowISO() : null });
  } catch (_) {
    return;
  }
  if (!checked) return X.toast("Approval removed.");
  const e = l.enrichment || {};
  if (e.email || e.status === "enriching") return X.toast("Approved.");
  await enrichLead(X, l.id, false, "Approved. Enriching now (about 1 Apollo credit).");
}
/** Start (or retry) enrichment for one approved contact. The row updates live when it finishes. */
export async function enrichLead(X: Ctx, id: string, force = false, okText = "Enriching now (about 1 Apollo credit).") {
  X.S.busy.add("enrich:" + id);
  X.rerender();
  try {
    await invokeFn("enrich-lead", { lead_id: id, force });
    X.toast(okText);
  } catch (e: any) {
    X.toast("Could not start enrichment. " + ((e && e.message) || ""));
  } finally {
    X.S.busy.delete("enrich:" + id);
    X.rerender();
  }
}

/** Asks FullEnrich for a phone number (about 10 FullEnrich credits) for a contact that already has an email. */
export async function findPhone(X: Ctx, id: string) {
  X.S.busy.add("enrich:" + id);
  X.rerender();
  try {
    const r = await invokeFn<{ status?: string; enrichment?: Row }>("enrich-lead", { lead_id: id, phone: true });
    X.toast(
      r && r.status === "found" && r.enrichment && r.enrichment.phone
        ? `Phone found (${r.enrichment.phone_source || "Apollo"}).`
        : "Asking Apollo for a phone number (8 credits only if it finds a mobile). It can take a few minutes; FullEnrich is tried only if Apollo has none."
    );
  } catch (e: any) {
    X.toast("Could not start the phone lookup. " + ((e && e.message) || ""));
  } finally {
    X.S.busy.delete("enrich:" + id);
    X.rerender();
  }
}
/** Picks up a FullEnrich job that was still running when the first call stopped waiting. */
export async function checkFullEnrich(X: Ctx, id: string) {
  X.S.busy.add("enrich:" + id);
  X.rerender();
  try {
    const r = await invokeFn<{ status?: string }>("enrich-lead", { lead_id: id, poll: true });
    if (r && r.status === "enriching") X.toast("Still working. Check again in a minute.");
  } catch (e: any) {
    X.toast("Could not check FullEnrich. " + ((e && e.message) || ""));
  } finally {
    X.S.busy.delete("enrich:" + id);
    X.rerender();
  }
}

/* ---------- tasks ---------- */
/** Edit a custom task in place. Moves its calendar block when the time, length or title changes. */
export async function updateTask(X: Ctx, id: string, patch: { title?: string; when?: string; duration?: number; notes?: string }) {
  const t = X.D.tasks.find((x) => x.id === id);
  if (!t) return;
  const next: Row = {};
  if (patch.title !== undefined) {
    if (!patch.title.trim()) return X.toast("A task needs a name.");
    next.title = patch.title.trim();
  }
  if (patch.when !== undefined) {
    if (!validWall(patch.when)) return X.toast("Pick a date and time.");
    next.when = istToISO(patch.when);
  }
  if (patch.duration !== undefined) next.duration = +patch.duration;
  if (patch.notes !== undefined) next.notes = patch.notes.trim();
  const prev: Row = { title: t.title, when: t.when, duration: t.duration, notes: t.notes };
  try {
    await upd(X, "tasks", id, next);
  } catch (_) {
    return;
  }
  const changed = (next.when && next.when !== t.when) || (next.title && next.title !== t.title) || (next.notes !== undefined && next.notes !== t.notes);
  if (changed && t.cal_event_id) {
    const m = { ...t, ...next };
    try {
      if (t.cal_kind === "task") await patchGTask(t.cal_event_id, { title: `${m.title} · ${fmtTime(m.when)}`, notes: m.notes || "", due: m.when });
      else {
        // An older calendar block becomes a Google Task.
        await deleteEvent(t.cal_event_id).catch(() => {});
        const tid = await todoTask({ title: m.title, when: m.when, notes: m.notes || "" });
        await upd(X, "tasks", id, { cal_status: "added", cal_event_id: tid, cal_error: "", cal_kind: "task" });
      }
    } catch (e) {
      await upd(X, "tasks", id, { cal_status: "failed", cal_error: calErr(e) }).catch(() => {});
    }
  }
  X.toast("Task updated.", () => upd(X, "tasks", id, prev));
}


export async function addTask(X: Ctx) {
  const tf = X.S.forms.task;
  if (!tf.title.trim() || !validWall(tf.when)) return X.toast("Add a task name, date and time.");
  X.S.busy.add("task");
  X.rerender();
  const when = istToISO(tf.when);
  try {
    const t = await ins("tasks", { title: tf.title.trim(), when, duration: +tf.duration, notes: tf.notes.trim(), done: false, cal_status: tf.cal ? "adding" : "none", cal_kind: "task" });
    if (tf.cal) {
      try {
        const id = await todoTask({ title: tf.title.trim(), when, notes: tf.notes.trim() });
        await upd(X, "tasks", t.id, { cal_status: "added", cal_event_id: id });
        X.toast("Task added to your Google Tasks.");
      } catch (e) {
        await upd(X, "tasks", t.id, { cal_status: "failed", cal_error: calErr(e) });
        X.toast("Task saved. Adding it to Google Tasks failed.");
      }
    } else X.toast("Task added.");
    X.S.forms.task = { title: "", when: "", duration: "15", notes: "", cal: true };
  } catch (_) {
    X.toast("Could not add the task.");
  } finally {
    X.S.busy.delete("task");
    X.rerender();
  }
}
export async function taskCal(X: Ctx, id: string) {
  const t = X.D.tasks.find((x) => x.id === id);
  if (!t) return;
  try {
    const ev = await todoTask({ title: t.title, when: t.when, notes: t.notes || "" });
    await upd(X, "tasks", id, { cal_status: "added", cal_event_id: ev, cal_error: "", cal_kind: "task" });
    X.toast("Added to your Google Tasks.");
  } catch (e) {
    await upd(X, "tasks", id, { cal_status: "failed", cal_error: calErr(e) }).catch(() => {});
  }
}
export async function saveBlockOrder(X: Ctx, keys: string[]) {
  const cur = X.S.orderLocal || X.D.order;
  const rest = cur.filter((k) => !keys.includes(k));
  const order = [...keys, ...rest].slice(0, 800);
  X.S.orderLocal = order;
  X.rerender();
  const { error } = await supabase.from("task_order").upsert({ user_id: X.uid, order });
  if (error) X.toast("Could not save the new order.");
}
export function moveItem(X: Ctx, block: string, key: string, dir: number) {
  const keys = (X.S.blocks[block] || []).slice(),
    i = keys.indexOf(key),
    j = i + dir;
  if (i < 0 || j < 0 || j >= keys.length) return;
  [keys[i], keys[j]] = [keys[j], keys[i]];
  saveBlockOrder(X, keys).then(() => {
    setTimeout(() => {
      const h = document.querySelector(`[data-drag="${CSS.escape(key)}"]`) as HTMLElement | null;
      h && h.focus();
    }, 0);
  });
}

/* ---------- delete ---------- */
export async function doDelete(X: Ctx, spec: string) {
  const i = spec.indexOf(":"),
    kind = spec.slice(0, i),
    id = spec.slice(i + 1);
  X.S.confirmDel = null;
  try {
    if (kind === "user") {
      const u = X.D.profiles.find((x) => x.id === id);
      if (!u) return;
      const g = roleGuard(X, u, u.role);
      if (g && !/at most/.test(g)) return X.toast(g);
      await delWithUndo(X, "profiles", u, "User");
      await audit("user removed", id, `${u.email} · ${roleName(X, u.role)}`);
      return;
    }
    if (kind === "invite") {
      const v = X.D.invites.find((x) => x.email === id);
      if (!v) return;
      await delWithUndo(X, "invites", v, "Invite");
      await audit("invite removed", "", v.email);
      return;
    }
    if (kind === "call") {
      await undoCall(X, id);
      X.toast("Call undone.");
      return;
    }
    if (kind === "ctx") {
      const j = X.D.journeys.find((x) => x.id === id);
      if (j) await delWithUndo(X, "journeys", j, "Call note");
      return;
    }
    if (kind === "meeting") {
      const m = X.D.meetings.find((x) => x.id === id);
      if (m) await delWithUndo(X, "meetings", m, "Meeting");
      return;
    }
    if (kind === "request") {
      const r = X.D.addreqs.find((x) => x.id === id);
      if (r) await delWithUndo(X, "add_requests", r, "Request");
      return;
    }
    if (kind === "callback" || kind === "task") {
      const table = kind === "callback" ? "callbacks" : "tasks",
        doc = (kind === "callback" ? X.D.callbacks : X.D.tasks).find((x) => x.id === id);
      if (!doc) return;
      let removed = false;
      if (doc.cal_event_id) {
        try {
          await removeGoogle(doc.cal_kind, doc.cal_event_id, doc.cal_block_id);
          removed = true;
        } catch (_) {}
      }
      await delWithUndo(X, table, doc, kind === "callback" ? "Callback" : "Task", async (rid, data) => {
        if (!removed) return;
        try {
          const g =
            kind === "callback"
              ? await callbackToGoogle({ contact: data.contact, company: data.company, when: data.when, agenda: data.agenda })
              : { cal_event_id: await todoTask({ title: data.title, when: data.when, notes: data.notes || "" }) };
          await supabase.from(table).update({ ...g, cal_status: "added", cal_kind: "task" }).eq("id", rid);
        } catch (e) {
          await supabase.from(table).update({ cal_status: "failed", cal_error: calErr(e) }).eq("id", rid);
        }
      });
      if (kind === "callback") {
        const l = leadById(X, doc.lead_id);
        if (l && l.stage === "callback" && !X.D.callbacks.some((c) => c.id !== id && c.lead_id === l.id && c.status === "open"))
          upd(X, "leads", l.id, { stage: "" }).catch(() => {});
      }
    }
  } catch (_) {
    X.toast("Could not delete.");
  } finally {
    X.rerender();
  }
}

/* ---------- admin ---------- */
export async function setUserRole(X: Ctx, uid: string, role: string) {
  const u = X.D.profiles.find((x) => x.id === uid);
  if (!u) return;
  const g = roleGuard(X, u, role);
  if (g) {
    X.toast(g);
    X.rerender();
    return;
  }
  const prev = u.role,
    wasPending = u.status === "pending";
  const patch: Row = { role, updated_at: nowISO() };
  if (wasPending) patch.status = "active";
  const { error } = await supabase.from("profiles").update(patch).eq("id", uid);
  if (error) return X.toast("Could not change the role. " + (error.message || ""));
  await audit(wasPending ? "user approved" : "role changed", uid, wasPending ? roleName(X, role) : `${roleName(X, prev)} to ${roleName(X, role)}`);
  X.toast(wasPending ? `${pname(X, uid)} approved as ${roleName(X, role)}.` : `${pname(X, uid)} is now ${roleName(X, role)}.`);
}
/** The owner leaves: ownership passes to the longest-standing other active Super Admin, then the owner is signed out. */
export async function ownerLeave(X: Ctx) {
  const { data, error } = await supabase.rpc("owner_leave");
  if (error) return X.toast(error.message || "Could not leave the roster.");
  X.toast(`You left the roster. ${pname(X, String(data || ""))} is now the owner.`);
  setTimeout(() => supabase.auth.signOut(), 1800);
}
export async function toggleSuspend(X: Ctx, uid: string) {
  const u = X.D.profiles.find((x) => x.id === uid);
  if (!u) return;
  const g = roleGuard(X, u, u.role);
  if (g && !/at most/.test(g)) return X.toast(g);
  const st = u.status === "active" ? "suspended" : "active";
  const { error } = await supabase.from("profiles").update({ status: st, updated_at: nowISO() }).eq("id", uid);
  if (error) return X.toast("Could not update the user. " + (error.message || ""));
  await audit(st === "active" ? "user restored" : "user suspended", uid, "");
  X.toast(st === "active" ? "Access restored." : "Access suspended.", async () => {
    const { error: e2 } = await supabase.from("profiles").update({ status: u.status }).eq("id", uid);
    if (e2) throw e2;
  });
}
export async function setHubspotOwner(X: Ctx, uid: string, v: string) {
  const { error } = await supabase.from("profiles").update({ hubspot_owner_id: v.trim() || null, hubspot_owner_label: null, updated_at: nowISO() }).eq("id", uid);
  if (error) return X.toast("Could not save the HubSpot owner id.");
  await audit("hubspot owner id set", uid, v.trim() || "cleared");
  X.toast("HubSpot owner id saved.");
}
export async function addInvite(X: Ctx) {
  const email = X.S.invite.email.trim().toLowerCase(),
    role = X.S.invite.role;
  const domain = (X.D.settings.allowed_domain && X.D.settings.allowed_domain.domain) || "";
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) return X.toast("Enter an email address.");
  if (domain && !email.endsWith("@" + domain)) return X.toast(`Only @${domain} accounts can sign in.`);
  const existing = X.D.profiles.find((p) => String(p.email).toLowerCase() === email);
  if (existing) return X.toast("That person has already signed in. Set their role in the table below.");
  const g = roleGuard(X, null, role);
  if (g) return X.toast(g);
  X.S.busy.add("invite");
  X.rerender();
  try {
    await invokeFn("invite-user", { email, role });
    X.S.invite = { email: "", role: "sdr" };
    X.toast(`Invite emailed to ${email}. They join as ${roleName(X, role)} from the link.`);
  } catch (e: any) {
    X.toast((e && e.message) || "Could not send the invite.");
  } finally {
    X.S.busy.delete("invite");
    X.rerender();
  }
}
/** Sends a fresh link to someone who was invited but hasn't signed in yet. */
export async function resendInvite(X: Ctx, email: string) {
  try {
    await invokeFn("invite-user", { email, resend: true });
    X.toast(`New invite link sent to ${email}.`);
  } catch (e: any) {
    X.toast((e && e.message) || "Could not resend the invite.");
  }
}
export async function addRole(X: Ctx) {
  const n = String(X.S.forms.newRole || "").trim();
  if (!n) return X.toast("Name the role first.");
  const id = n.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "role";
  if (id === "super_admin" || X.D.roles.some((r) => r.id === id)) return X.toast("A role with that name exists.");
  const { error } = await supabase.from("roles").insert({ id, name: n, perms: ["view_dashboard"], system: false });
  if (error) return X.toast("Could not add the role.");
  await audit("role created", "", n);
  X.S.forms.newRole = "";
  X.toast("Role added. Tick its permissions below.");
}
export async function deleteRole(X: Ctx, id: string) {
  if (X.D.profiles.some((u) => u.role === id)) return X.toast("Reassign its users first.");
  const old = X.D.roles.find((r) => r.id === id);
  if (!old) return;
  try {
    await delWithUndo(X, "roles", old, "Role");
    await audit("role deleted", "", old.name || id);
  } catch (_) {
    X.toast("Could not delete the role.");
  }
}
export async function togglePerm(X: Ctx, roleId: string, perm: string, on: boolean, label: string) {
  const r = X.D.roles.find((x) => x.id === roleId);
  if (!r) return;
  const cur = new Set<string>(r.perms || []);
  on ? cur.add(perm) : cur.delete(perm);
  const { error } = await supabase.from("roles").update({ perms: [...cur] }).eq("id", roleId);
  if (error) return X.toast("Could not save the permission.");
  await audit("permission " + (on ? "granted" : "removed"), "", `${roleName(X, roleId)}: ${label}`);
}
export async function renameRole(X: Ctx, roleId: string, name: string) {
  name = name.trim();
  if (!name) return;
  const { error } = await supabase.from("roles").update({ name }).eq("id", roleId);
  if (!error) await audit("role renamed", "", name);
}
