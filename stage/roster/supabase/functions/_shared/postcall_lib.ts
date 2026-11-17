// Pure helpers for post-call emails (no I/O), so they can be unit tested. The writing rules themselves live
// with the Claude worker in .claude/agents/post-call-writer.md; these are the parts the server owns. The seller's
// overview, live instances and banned product terms come from the profile; the constants are the defaults.
import { DEFAULT_PROFILE, type SellerProfile, wordsRe } from "./profile.ts";

export const NOTE_CAP = 50;
export const BRIEF_CAP = 75;

export const OVERVIEW = DEFAULT_PROFILE.product_overview;

/** Customers whose sites show the product live, as [name, url]. */
export const instancesOf = (p: SellerProfile) => p.customers.filter((c) => c.live_instance && c.url).map((c) => [c.name, c.url] as const);
export const INSTANCES = instancesOf(DEFAULT_PROFILE);


// deno-lint-ignore no-explicit-any
export type Row = Record<string, any>;
export type Situation = "meeting_booked" | "callback" | "post_demo" | "declined" | "connected";

export const HOUR = 3_600_000;
export const JOURNEY_EVENTS = 10;
export const NOTE_CHARS = 600;
export const AGENDA_CHARS = 200;

export const ist = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true,
});
export const whenIST = (iso: string | null | undefined) => (iso ? `${ist.format(new Date(iso))} IST` : "");
export const day = (iso: string | null | undefined) => (iso ? String(iso).slice(0, 10) : "");
export const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);
export const clip = (s: unknown, n: number) => {
  const t = String(s ?? "").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
};

/** Drops null, empty strings, empty arrays and empty objects, recursively. Keeps the facts JSON small. */
export function prune(v: unknown): unknown {
  if (Array.isArray(v)) {
    const a = v.map(prune).filter((x) => x !== undefined);
    return a.length ? a : undefined;
  }
  if (v && typeof v === "object") {
    const o: Row = {};
    for (const [k, x] of Object.entries(v)) {
      const p = prune(x);
      if (p !== undefined) o[k] = p;
    }
    return Object.keys(o).length ? o : undefined;
  }
  if (v === null || v === undefined || (typeof v === "string" && !v.trim())) return undefined;
  return v;
}

export const words = (s: string) =>
  s.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[*_`#>]/g, " ").split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

export function situationOf(note: Row, meetings: Row[], callbacks: Row[], calls: Row[], now: number): Situation {
  const at = ms(note.at);
  const live = meetings.filter((m) => m.status !== "canceled");
  // A demo that happened in the three days before the note means this is a post-demo follow-up.
  if (live.some((m) => m.status === "done" && ms(m.when) <= at && at - ms(m.when) < 72 * HOUR)) return "post_demo";
  if (live.some((m) => (m.status === "scheduled" || m.status === "rescheduling") && ms(m.when) > now)) return "meeting_booked";
  if (callbacks.some((c) => c.status === "open" && ms(c.when) > now)) return "callback";
  const near = calls.filter((c) => Math.abs(ms(c.at) - at) < 2 * HOUR).sort((a, b) => ms(b.at) - ms(a.at))[0];
  if (near && near.outcome === "no") return "declined";
  return "connected";
}

export function nextStep(meetings: Row[], callbacks: Row[], now: number): Row | undefined {
  const m = meetings
    .filter((x) => (x.status === "scheduled" || x.status === "rescheduling") && ms(x.when) > now)
    .sort((a, b) => ms(a.when) - ms(b.when))[0];
  if (m) return { type: "meeting", when: whenIST(m.when), at: m.when, mode: m.mode, location: m.mode === "online" ? "" : m.location };
  const c = callbacks.filter((x) => x.status === "open" && ms(x.when) > now).sort((a, b) => ms(a.when) - ms(b.when))[0];
  if (c) return { type: "callback", when: whenIST(c.when), at: c.when };
  return undefined;
}

export function assemble(out: Row, company: string, profile: SellerProfile = DEFAULT_PROFILE): { body: string; counted: string; cap: number } {
  const s = (k: string) => String(out[k] ?? "").trim();
  if (out.format === "brief") {
    const seller = profile.company_name;
    const live = instancesOf(profile);
    const instances = live.map(([n, u]) => `* ${n} - [Here](${u})`).join("\n");
    const parts = [
      s("greeting"), s("opening"),
      `**Product Overview:**\n\n${profile.product_overview}`,
      `**How ${seller} can help ${company}:**\n\n${s("company")}`,
      live.length ? `**Implemented instances of ${seller}:**\n\n${instances}` : "",
      s("ask"), s("signoff"),
    ];
    return { body: parts.filter(Boolean).join("\n\n"), counted: `${s("opening")} ${s("company")}`, cap: BRIEF_CAP };
  }
  return { body: [s("greeting"), s("core"), s("ask"), s("signoff")].filter(Boolean).join("\n\n"), counted: s("core"), cap: NOTE_CAP };
}

export const BANNED = /\b(chat ?bots?|bots?|widgets?|plug-?ins?|ai sdrs?|virtual assistants?|conversational ai)\b/i;

/** The product terms a draft must not use. "tool" is left out on purpose: emails talk about the prospect's tools. */
export function bannedTerms(p: SellerProfile): RegExp | null {
  if (p === DEFAULT_PROFILE) return BANNED;
  return wordsRe(p.never_call_it.filter((w) => !/^tools?$/i.test(w)));
}


// ---------------------------------------------------------------------------
// Timeline check. A rep's note can say "next week" while the booked callback says Thursday. The booked
// meeting or callback (the system record) is the source of truth; these helpers find the wording in a text
// that points somewhere else, so the writer is told up front and the draft is checked afterwards.
// ---------------------------------------------------------------------------

const IST_MS = 330 * 60_000;
const DAY_MS = 86_400_000;
/** Calendar date in IST as a day number (days since epoch, IST). */
const istDay = (t: number) => Math.floor((t + IST_MS) / DAY_MS);
const dayIso = (n: number) => new Date(n * DAY_MS).toISOString().slice(0, 10);
const istMinutes = (t: number) => Math.floor((((t + IST_MS) % DAY_MS) + DAY_MS) % DAY_MS / 60_000);
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WD_RE = "(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday|tues?|wed|thu(?:rs?)?|fri)";
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MON_RE = "(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*";
const NUM_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const wdIndex = (w: string) => {
  const k = w.slice(0, 3);
  return WEEKDAYS.findIndex((d) => d.startsWith(k));
};

export interface Mention {
  text: string;
  /** IST dates (YYYY-MM-DD) the wording can mean. */
  days: string[];
}

/** Date and time wording in a text, resolved against the moment it was written (ref). Wording it cannot resolve is ignored. */
export function timeMentions(text: string, ref: number): { dates: Mention[]; times: number[] } {
  let t = " " + String(text ?? "").toLowerCase().replace(/[\u2013\u2014]/g, "-") + " ";
  const today = istDay(ref);
  const dow = new Date(today * DAY_MS).getUTCDay();
  const dates: Mention[] = [];
  const times: number[] = [];
  const add = (m: string, days: number[]) => dates.push({ text: m.trim(), days: days.map(dayIso) });
  const take = (re: RegExp, fn: (m: RegExpMatchArray) => void) => {
    t = t.replace(re, (...a) => {
      const m = a.slice(0, -2) as unknown as RegExpMatchArray;
      fn(m);
      return " ";
    });
  };
  const yearOf = (mon: number, d: number) => {
    const y = new Date(today * DAY_MS).getUTCFullYear();
    const n = Date.UTC(y, mon, d) / DAY_MS;
    return n < today - 60 ? Date.UTC(y + 1, mon, d) / DAY_MS : n;
  };

  // Explicit dates first ("Thu, 15 Oct", "15th October", "Oct 15"); a weekday beside one is part of it.
  take(new RegExp(`\\b(?:${WD_RE},?\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MON_RE}\\b`, "g"), (m) =>
    add(m[0], [yearOf(MONTHS.indexOf(m[2]), Number(m[1]))]));
  take(new RegExp(`\\b(?:${WD_RE},?\\s+)?${MON_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, "g"), (m) =>
    add(m[0], [yearOf(MONTHS.indexOf(m[1]), Number(m[2]))]));

  take(/\bday after tomorrow\b/g, (m) => add(m[0], [today + 2]));
  take(/\btomorrow\b/g, (m) => add(m[0], [today + 1]));
  take(/\b(today|tonight)\b/g, (m) => add(m[0], [today]));
  take(/\bnext week\b/g, (m) => {
    const monday = today + ((8 - dow) % 7 || 7);
    add(m[0], [0, 1, 2, 3, 4, 5, 6].map((i) => monday + i));
  });
  take(/\bthis week\b/g, (m) => add(m[0], Array.from({ length: (7 - dow) % 7 + 1 }, (_, i) => today + i)));
  take(/\bin (\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten) (day|week)s?\b/g, (m) => {
    const n = NUM_WORDS[m[1]] ?? Number(m[1]);
    add(m[0], [today + n * (m[2] === "week" ? 7 : 1)]);
  });
  take(new RegExp(`\\b(next\\s+|this\\s+|coming\\s+|on\\s+)?(${WD_RE})\\b`, "g"), (m) => {
    const i = wdIndex(m[2]);
    if (i < 0) return;
    const ahead = (i - dow + 7) % 7;
    const monday = today + ((8 - dow) % 7 || 7);
    add(m[0], /^next/.test(m[1] ?? "") ? [monday + ((i + 6) % 7)] : [today + ahead]);
  });

  take(/\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?(?![a-z])/g, (m) => {
    const h = (Number(m[1]) % 12) + (m[3] === "p" ? 12 : 0);
    times.push(h * 60 + Number(m[2] ?? 0));
  });
  take(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g, (m) => times.push(Number(m[1]) * 60 + Number(m[2])));
  return { dates, times };
}

/** Wording in text that points to a different day or time than the booked next step. Empty when it all agrees. */
export function timelineConflicts(text: string, ref: number, next: Row | undefined): string[] {
  if (!next?.at) return [];
  const at = ms(next.at);
  const nextDay = dayIso(istDay(at));
  const { dates, times } = timeMentions(text, ref);
  const out: string[] = [];
  const label = `${next.type} booked for ${next.when}`;
  for (const m of dates) {
    if (!m.days.includes(nextDay)) out.push(`"${m.text}" does not match the ${label}`);
  }
  if (times.length && !times.includes(istMinutes(at))) out.push(`the time mentioned does not match the ${label}`);
  return out;
}

export interface DraftCheck {
  /** Missing or malformed parts: the draft can't be saved without them. */
  problems: string[];
  /** House-style misses the writer can fix on resubmit; on the last submit they are saved as flags. */
  style: string[];
  body: string;
  words: number;
  cap: number;
}

/** Field names writers commonly use instead of the schema's, mapped to the schema. Only fills a missing field. */
const ALIASES: Record<string, string[]> = {
  core: ["body", "message", "content", "main", "paragraph", "text", "email_body"],
  subject: ["subject_line", "title"],
  greeting: ["salutation", "hello", "opener"],
  signoff: ["sign_off", "closing", "signature", "sign-off"],
  opening: ["intro", "introduction"],
  company: ["company_paragraph", "about_company", "company_section"],
};

/**
 * Normalises a writer's answer before it is checked: known alternative field names are mapped to the schema's,
 * and a missing format is inferred from the fields present. Never overwrites a field the writer did set.
 */
export function normalizeDraft(out: unknown): Row | null {
  if (!out || typeof out !== "object" || Array.isArray(out)) return null;
  const o: Row = { ...(out as Row) };
  for (const [field, alts] of Object.entries(ALIASES)) {
    if (String(o[field] ?? "").trim()) continue;
    const hit = alts.find((k) => typeof o[k] === "string" && o[k].trim());
    if (hit) o[field] = o[hit];
  }
  if (typeof o.format === "string") o.format = o.format.trim().toLowerCase();
  if (o.format !== "note" && o.format !== "brief") {
    if (String(o.opening ?? "").trim() && String(o.company ?? "").trim()) o.format = "brief";
    else if (String(o.core ?? "").trim()) o.format = "note";
  }
  return o;
}

/** Validates a writer's answer and assembles the email. Locked parts (overview, instances) are added here. */
export function checkDraft(out: unknown, company: string, schedule?: { next?: Row; now: number }, profile: SellerProfile = DEFAULT_PROFILE): DraftCheck {
  const o = (out && typeof out === "object" ? out : {}) as Row;
  const s = (k: string) => String(o[k] ?? "").trim();
  const problems: string[] = [];
  if (o.format !== "note" && o.format !== "brief") problems.push('format must be "note" or "brief"');
  for (const k of ["subject", "greeting", "ask", "signoff"]) if (!s(k)) problems.push(`${k} is required`);
  if (o.format === "note" && !s("core")) problems.push('core is required for a note: put the main paragraph (at most 50 words) in a field named "core"');
  if (o.format === "brief" && (!s("opening") || !s("company"))) problems.push('opening and company are required for a brief: use fields named "opening" and "company"');
  if (o.flags !== undefined && !Array.isArray(o.flags)) problems.push("flags must be an array");
  if (problems.length) return { problems, style: [], body: "", words: 0, cap: NOTE_CAP };

  const { body, counted, cap } = assemble(o, company || "your team", profile);
  const n = words(counted);
  const written = [s("subject"), counted, s("greeting"), s("ask"), s("signoff")].join(" ");
  const style: string[] = [];
  if (n > cap) style.push(`${o.format === "brief" ? "opening plus company" : "core"} runs ${n} words against the ${cap}-word cap`);
  if (/[\u2014\u2013]/.test(written)) style.push("contains an em or en dash");
  const banned = written.match(bannedTerms(profile) ?? /$^/);
  if (banned) style.push(`uses the banned product term "${banned[0]}"`);
  if (s("subject") !== s("subject").toLowerCase() || s("subject").split(/\s+/).length > 4) style.push("subject must be lowercase, 2 to 4 words");
  if (schedule?.next) {
    for (const c of timelineConflicts([s("subject"), counted, s("ask")].join(". "), schedule.now, schedule.next)) style.push(`${c}; the booked time is the one to state`);
  }
  if (o.format === "brief" && body.split(profile.product_overview).length > 2) style.push("repeats the product overview, which the email already carries");
  return { problems, style, body, words: n, cap };
}
