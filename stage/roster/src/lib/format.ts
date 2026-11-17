/* Time and text helpers. Inputs of type datetime-local are read as IST wall time
   (Asia/Kolkata, the business timezone) and stored as ISO timestamptz. Display is also
   in IST, labelled, so everyone sees the same time wherever their browser is. */

export const TZ = "Asia/Kolkata";

export const pad = (n: number) => String(n).padStart(2, "0");
export const nowISO = () => new Date().toISOString();
export const DAY = 864e5;

const WALL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/;

/** True when a datetime-local value is complete. */
export const validWall = (s: string | null | undefined) => !!s && WALL.test(String(s));

/** "2026-10-12T14:30" (IST wall time) -> ISO string. */
export function istToISO(s: string): string {
  const m = String(s).match(WALL);
  if (!m) return "";
  return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00+05:30`).toISOString();
}

/** ISO -> "YYYY-MM-DDTHH:MM" in IST, for prefilling datetime-local inputs. */
export function isoToIst(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(new Date(iso).getTime() + 330 * 60000);
  if (isNaN(d.getTime())) return "";
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export const toDate = (iso: string | null | undefined): Date | null => {
  if (!iso) return null;
  const s = String(iso);
  // A bare date or date-time with no zone is an IST wall time.
  const bare = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/.test(s);
  const d = bare ? new Date((s.length === 10 ? s + "T00:00" : s.slice(0, 16)) + ":00+05:30") : new Date(s);
  return isNaN(d.getTime()) ? null : d;
};
export const tms = (x: string | null | undefined): number => {
  const d = toDate(x);
  return d ? d.getTime() : NaN;
};
export const addMin = (iso: string, m: number) => new Date(new Date(iso).getTime() + m * 60000).toISOString();
/** IST calendar day of an instant, as "YYYY-MM-DD". */
export const dayKey = (d: Date) => {
  const t = new Date(d.getTime() + 330 * 60000);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
};
export const dk = (iso: string | null | undefined) => {
  const d = toDate(iso);
  return d ? dayKey(d) : "";
};
/** "Mon 12 Oct" in IST. */
export const fmtDay = (iso: string | null | undefined) => {
  const d = toDate(iso);
  return d ? d.toLocaleDateString("en-IN", { timeZone: TZ, weekday: "short", day: "numeric", month: "short" }).replace(",", "") : "";
};
/** "8:24 pm IST". */
export const fmtTime = (iso: string | null | undefined) => {
  const d = toDate(iso);
  return d ? d.toLocaleTimeString("en-IN", { timeZone: TZ, hour: "numeric", minute: "2-digit" }).toLowerCase() + " IST" : "";
};
/** "Mon 12 Oct · 8:24 pm IST", the one format for any scheduled time. */
export const fmtWhen = (iso: string | null | undefined) => {
  const a = fmtDay(iso);
  return a ? `${a} · ${fmtTime(iso)}` : "";
};
/** "12 Oct, 8:24 pm IST", for journey and audit stamps. */
export const fmtStamp = (iso: string | null | undefined) => {
  const d = toDate(iso);
  return d
    ? d.toLocaleDateString("en-IN", { timeZone: TZ, day: "numeric", month: "short" }) + ", " + fmtTime(iso)
    : "";
};
/** "1 account" / "2 accounts". */
export const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;
/** Clean headcount band from a research note: "251-1000 (Apollo filter; ...)" -> "251–1,000 employees". */
export function fmtEmployees(v: unknown): string {
  const s = String(v ?? "").trim();
  if (!s) return "";
  const m = s.match(/(\d[\d,]*)\s*[-–to]+\s*(\d[\d,]*)/);
  const fmt = (x: string) => Number(x.replace(/,/g, "")).toLocaleString("en-US");
  if (m) return `${fmt(m[1])}–${fmt(m[2])} employees`;
  const one = s.match(/\d[\d,]*/);
  return one ? `${fmt(one[0])} employees` : "";
}
export const coName = (s: string | null | undefined) => String(s || "").replace(/\s*\(.*?\)/g, "").trim();

export function titleGroup(t: string | null | undefined) {
  const s = String(t || "");
  if (/demand/i.test(s)) return "Demand Gen";
  if (/growth/i.test(s)) return "Growth";
  if (/digital|performance/i.test(s)) return "Digital & Performance";
  return "General marketing";
}
export function industry(seg: string | null | undefined) {
  const s = String(seg || "").toLowerCase();
  if (/\bhr\b|payroll|learning|l&d|talent|employee|workforce|enablement/.test(s)) return "HR & Learning";
  if (/logistic|fleet|delivery|freight|cargo|supply|shipping|warehouse|transport/.test(s)) return "Logistics & Supply chain";
  if (/fintech|bank|lending|financ|wealth|payment|equity|working capital|loyalty|bfsi/.test(s)) return "Fintech & BFSI";
  if (/security|identity|endpoint|observability|network|cloud|infrastructure|telecom/.test(s)) return "Security, Cloud & IT";
  if (/adtech|advertis|marketing|\bcx\b|customer|crm|messaging|commerce|retail|restaurant|media|ccaas/.test(s)) return "Martech, CX & Commerce";
  if (/data|\bai\b|analytics|intelligence|workflow|low-code|automation|planning|contract|services|work/.test(s)) return "Data, AI & Ops";
  return "Other";
}
export const splitName = (n: string | null | undefined) => {
  const p = String(n || "").replace(/\s*\(.*?\)/g, "").trim().split(/\s+/);
  const first = p.shift() || "";
  const last = p.join(" ");
  return { first, last: /\*/.test(last) ? "" : last, masked: /\*/.test(last) };
};

/** "Ratandeep Gu***a" -> "Ratandeep G." (surname is hidden until enrichment); other names unchanged. */
export function shortName(name: string | null | undefined): string {
  const s = String(name || "").trim();
  if (!/\*/.test(s)) return s;
  const parts = s.split(/\s+/);
  const first = parts.shift() || "";
  const last = parts.join(" ");
  return last ? `${first} ${last[0]}.` : first;
}

/** Timeline presets for filtering by roster date. Days are IST calendar days, weeks run Monday to Sunday. */
export const RANGES: Array<[string, string]> = [
  ["all", "All time"],
  ["this_week", "This week"],
  ["next_week", "Next week"],
  ["last_week", "Last week"],
  ["7", "Last 7 days"],
  ["14", "Last 14 days"],
  ["30", "Last 30 days"],
  ["90", "Last 90 days"],
  ["custom", "Custom range"],
];
const keyPlus = (k: string, n: number) => {
  const d = new Date(k + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
/** Inclusive [from, to] IST day keys for a preset, or null for all time. */
export function rangeBounds(key: string, from = "", to = ""): [string, string] | null {
  const today = dayKey(new Date());
  const monday = keyPlus(today, -((new Date(today + "T00:00:00Z").getUTCDay() + 6) % 7));
  if (key === "this_week") return [monday, keyPlus(monday, 6)];
  if (key === "next_week") return [keyPlus(monday, 7), keyPlus(monday, 13)];
  if (key === "last_week") return [keyPlus(monday, -7), keyPlus(monday, -1)];
  if (/^\d+$/.test(key)) return [keyPlus(today, -(+key - 1)), today];
  if (key === "custom" && (from || to)) return [from || "0000-01-01", to || "9999-12-31"];
  return null;
}
/** "12–18 Oct" for a range, for the filter's caption. */
export function fmtRange(b: [string, string] | null): string {
  if (!b) return "";
  const f = (k: string) => (/^\d{4}-\d{2}-\d{2}$/.test(k) && !k.startsWith("0000") && !k.startsWith("9999") ? fmtDay(k).replace(/^\w+ /, "") : "");
  const a = f(b[0]),
    z = f(b[1]);
  return a && z ? (a === z ? a : `${a} – ${z}`) : a ? `from ${a}` : z ? `until ${z}` : "";
}
