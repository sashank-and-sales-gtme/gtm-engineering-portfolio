// Pure helpers for reschedule replies: free slots from the rep's calendar, readable text from Gmail messages, and
// the checks and layout for the reply the Claude worker writes. No I/O here, so it is all unit tested.

const IST_MS = 5.5 * 3600e3;
const MIN = 60e3;

export interface Slot {
  id: string;
  iso: string;
  label: string;
}

/** "Tue, 21 Oct · 11:00 am IST" */
export function slotLabel(iso: string): string {
  const d = new Date(Date.parse(iso) + IST_MS);
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()];
  const mo = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
  let h = d.getUTCHours();
  const m = String(d.getUTCMinutes()).padStart(2, "0");
  const ap = h >= 12 ? "pm" : "am";
  h = h % 12 || 12;
  return `${wd}, ${d.getUTCDate()} ${mo} · ${h}:${m} ${ap} IST`;
}

export interface SlotOpts {
  days?: number; // business days to look ahead
  times?: string[]; // IST start times, "HH:MM"
  durationMin?: number;
  bufferMin?: number; // gap kept around busy events
  minLeadHours?: number; // earliest slot from now
}

/**
 * Candidate meeting starts on the next business days (Mon to Fri, IST) at the given times, skipping anything that
 * overlaps a busy interval (with a buffer either side) or starts too soon.
 */
export function freeSlots(busy: Array<[number, number]>, now: number, o: SlotOpts = {}): Slot[] {
  const days = o.days ?? 10,
    times = o.times ?? ["10:00", "11:00", "12:00", "14:30", "15:30", "16:30", "17:30"],
    dur = (o.durationMin ?? 30) * MIN,
    buf = (o.bufferMin ?? 10) * MIN,
    earliest = now + (o.minLeadHours ?? 18) * 3600e3;
  const out: Slot[] = [];
  // Midnight IST of today, as a UTC instant.
  const istNow = new Date(now + IST_MS);
  let dayStart = Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate()) - IST_MS;
  // Count business days from the first day that can hold a slot.
  for (let seen = 0, guard = 0; seen < days && guard < days * 3; guard++, dayStart += 24 * 3600e3) {
    const wd = new Date(dayStart + IST_MS).getUTCDay();
    if (wd === 0 || wd === 6 || dayStart + 24 * 3600e3 <= earliest) continue;
    seen++;
    for (const t of times) {
      const [hh, mm] = t.split(":").map(Number);
      const start = dayStart + (hh * 60 + mm) * MIN;
      if (start < earliest) continue;
      const end = start + dur;
      if (busy.some(([a, b]) => a < end + buf && b > start - buf)) continue;
      const iso = new Date(start).toISOString();
      out.push({ id: `s${out.length + 1}`, iso, label: slotLabel(iso) });
    }
  }
  return out;
}

/** Busy intervals from Calendar events (all-day events and declined or transparent ones are ignored). */
// deno-lint-ignore no-explicit-any
export function busyFrom(events: any[], selfEmail = ""): Array<[number, number]> {
  const me = selfEmail.toLowerCase();
  return events
    .filter((e) => e && e.status !== "cancelled" && e.transparency !== "transparent" && e.start?.dateTime && e.end?.dateTime)
    // deno-lint-ignore no-explicit-any
    .filter((e) => !(e.attendees ?? []).some((a: any) => (a.self || (me && String(a.email).toLowerCase() === me)) && a.responseStatus === "declined"))
    .map((e) => [Date.parse(e.start.dateTime), Date.parse(e.end.dateTime)] as [number, number])
    .filter(([a, b]) => !isNaN(a) && !isNaN(b));
}

/* ---------- Gmail ---------- */

export function b64urlDecode(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

const stripHtml = (h: string) =>
  h.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|tr)>/gi, "\n").replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&quot;/g, '"');

/** The readable text of a Gmail message payload: text/plain if present, else stripped text/html. */
// deno-lint-ignore no-explicit-any
export function messageText(payload: any): string {
  const find = (p: any, type: string): string => {
    if (!p) return "";
    if (p.mimeType === type && p.body?.data) return b64urlDecode(p.body.data);
    for (const c of p.parts ?? []) {
      const t = find(c, type);
      if (t) return t;
    }
    return "";
  };
  const plain = find(payload, "text/plain");
  return plain || stripHtml(find(payload, "text/html"));
}

/** Drops the quoted history and signature noise so only what this message adds is kept. */
export function newPart(text: string, max = 1200): string {
  const lines = text.replace(/\r/g, "").split("\n");
  const out: string[] = [];
  for (const l of lines) {
    if (/^On .{4,200}wrote:\s*$/.test(l.trim()) || /^-{2,}\s*Original Message/i.test(l.trim()) || /^From: .+/.test(l.trim()) && out.length > 2) break;
    if (/^>/.test(l.trim())) continue;
    out.push(l);
  }
  const t = out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return t.length > max ? t.slice(0, max).replace(/\s+\S*$/, "") + " …" : t;
}

export const header = (h: Array<{ name: string; value: string }> | undefined, name: string) =>
  (h ?? []).find((x) => x.name.toLowerCase() === name.toLowerCase())?.value ?? "";

/* ---------- the reply ---------- */

export interface ReplyIn {
  subject?: unknown;
  greeting?: unknown;
  opening?: unknown;
  slots?: unknown;
  close?: unknown;
  signoff?: unknown;
  flags?: unknown;
  read?: unknown;
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const words = (s: string) => (s.match(/\S+/g) ?? []).length;
const CLOCK = /\b\d{1,2}(:\d{2})?\s?(am|pm|a\.m\.|p\.m\.)(?=\W|$)|\b\d{1,2}:\d{2}\b/i;
const DATE = /\b\d{1,2}(st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}(st|nd|rd|th)?\b/i;
const LINK = /https?:\/\/|meetings[-.]|hubspot|calendly/i;

/**
 * Checks the writer's reply. Times live only in the slot list the server builds, so the prose may not carry its own
 * clock times, dates or a scheduling link (the point is that the prospect just replies with a slot).
 */
export function checkReply(r: ReplyIn | null, candidates: Slot[]): { problems: string[]; picked: Slot[] } {
  const problems: string[] = [];
  if (!r || typeof r !== "object") return { problems: ["result must be a JSON object"], picked: [] };
  const ids = Array.isArray(r.slots) ? r.slots.map((x) => String(x)) : [];
  const picked = ids.map((id) => candidates.find((c) => c.id === id)).filter(Boolean) as Slot[];
  if (ids.length !== 5) problems.push(`slots must list exactly 5 candidate ids (got ${ids.length})`);
  else if (new Set(ids).size !== 5) problems.push("slots must be 5 different ids");
  else if (picked.length !== 5) problems.push(`slots has ids that are not in candidates: ${ids.filter((i) => !candidates.some((c) => c.id === i)).join(", ")}`);
  if (new Set(picked.map((p) => p.iso.slice(0, 10))).size < 2 && picked.length === 5) problems.push("spread the 5 slots over at least 2 days");
  if (!str(r.subject)) problems.push("subject is empty");
  if (!str(r.greeting)) problems.push("greeting is empty");
  if (!str(r.opening)) problems.push("opening is empty");
  if (!str(r.signoff)) problems.push("signoff is empty");
  const prose = [str(r.opening), str(r.close)].join("\n");
  if (words(prose) > 90) problems.push(`opening and close are ${words(prose)} words; keep them to 90`);
  if (CLOCK.test(prose)) problems.push("the prose has a clock time; times belong only in the slot list");
  if (DATE.test(prose)) problems.push("the prose has a calendar date; dates belong only in the slot list");
  if (LINK.test(prose + str(r.subject))) problems.push("no links or scheduling pages; the prospect replies with a slot");
  if (/—/.test(prose + str(r.subject))) problems.push("no em dashes");
  return { problems, picked };
}

/** The reply as plain text, with the picked slots listed in time order. */
export function composeReply(r: ReplyIn, picked: Slot[]): string {
  const list = picked.slice().sort((a, b) => a.iso.localeCompare(b.iso)).map((s) => `* ${s.label}`).join("\n");
  return [str(r.greeting), str(r.opening), list, str(r.close), str(r.signoff)].filter(Boolean).join("\n\n");
}
