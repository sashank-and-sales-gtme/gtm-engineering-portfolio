import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { DayPicker } from "react-day-picker";
import "react-day-picker/style.css";
import { nowWall } from "../lib/actions";

/**
 * One date, or date and time, picker for the whole app.
 * Values are plain strings in IST wall time, the same shape the native inputs used:
 * "2026-11-02" (date) or "2026-11-02T11:00" (datetime). Empty string means not set.
 * It shows day-before-month ("Mon 2 Nov, 11:00 am"), offers quick choices, a month calendar,
 * half-hour time slots, and a box that understands "tomorrow 3pm".
 */
type Mode = "date" | "datetime";
type Props = {
  id: string;
  value: string;
  onChange: (v: string) => void;
  mode?: Mode;
  min?: string;
  max?: string;
  label?: string;
  placeholder?: string;
  clearable?: boolean;
  required?: boolean;
};

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");
const keyOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromKey = (k: string) => {
  const [y, m, d] = k.slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d);
};
const addDays = (k: string, n: number) => {
  const d = fromKey(k);
  d.setDate(d.getDate() + n);
  return keyOf(d);
};

export const formatWhen = (v: string, mode: Mode = "datetime") => {
  if (!v) return "";
  const d = fromKey(v);
  const day = `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}${d.getFullYear() !== new Date().getFullYear() ? " " + d.getFullYear() : ""}`;
  if (mode === "date" || v.length < 16) return day;
  const h = Number(v.slice(11, 13)),
    m = v.slice(14, 16);
  return `${day}, ${h % 12 || 12}:${m} ${h < 12 ? "am" : "pm"}`;
};

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
/** Reads short phrases: "tomorrow 3pm", "mon 10:30", "2 nov 11am", "in 2 hours", "2026-11-02 09:00". Returns null when it cannot. */
export function parseWhen(text: string, now: string, mode: Mode): string | null {
  let s = text.trim().toLowerCase();
  if (!s) return null;
  const today = now.slice(0, 10);
  let date: string | null = null;
  let time: string | null = null;
  const rel = s.match(/^in (\d+) (hour|hr|day|week)s?$/);
  if (rel) {
    const n = Number(rel[1]);
    if (rel[2] === "day") return mode === "date" ? addDays(today, n) : addDays(today, n) + "T" + now.slice(11, 16);
    if (rel[2] === "week") return mode === "date" ? addDays(today, 7 * n) : addDays(today, 7 * n) + "T" + now.slice(11, 16);
    const t = new Date(fromKey(today).getTime());
    t.setHours(Number(now.slice(11, 13)) + n, Number(now.slice(14, 16)));
    return mode === "date" ? keyOf(t) : `${keyOf(t)}T${pad(t.getHours())}:${pad(t.getMinutes())}`;
  }
  const tm = s.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (tm) {
    if (tm[3]) {
      let h = Number(tm[1]) % 12;
      if (tm[3] === "pm") h += 12;
      time = `${pad(h)}:${tm[2] || "00"}`;
    } else time = `${pad(Number(tm[4]))}:${tm[5]}`;
    s = s.replace(tm[0], " ").trim();
  }
  s = s.replace(/\bat\b/g, " ").replace(/\s+/g, " ").trim();
  if (s === "" || s === "today" || s === "now") date = today;
  else if (s === "tomorrow" || s === "tmrw") date = addDays(today, 1);
  else if (s === "yesterday") date = addDays(today, -1);
  else if (/^\d{4}-\d{2}-\d{2}$/.test(s)) date = s;
  else {
    const wd = s.match(/^(?:next )?(sun|mon|tue|wed|thu|fri|sat)[a-z]*$/);
    const dm = s.match(/^(\d{1,2})(?:st|nd|rd|th)? ([a-z]{3})[a-z]*(?: (\d{4}))?$/) || s.match(/^([a-z]{3})[a-z]* (\d{1,2})(?:st|nd|rd|th)?(?: (\d{4}))?$/);
    if (wd) {
      const cur = fromKey(today).getDay();
      let diff = (WEEKDAYS.indexOf(wd[1]) - cur + 7) % 7;
      if (diff === 0) diff = 7;
      date = addDays(today, diff);
    } else if (dm) {
      const dayN = Number(/^\d/.test(dm[1]) ? dm[1] : dm[2]);
      const mon = MONTHS.map((x) => x.toLowerCase()).indexOf(/^\d/.test(dm[1]) ? dm[2] : dm[1]);
      if (mon < 0 || dayN < 1 || dayN > 31) return null;
      const y = dm[3] ? Number(dm[3]) : fromKey(today).getFullYear();
      let d = new Date(y, mon, dayN);
      if (!dm[3] && keyOf(d) < today) d = new Date(y + 1, mon, dayN);
      date = keyOf(d);
    }
  }
  if (!date) return null;
  if (mode === "date") return date;
  return `${date}T${time || (date === today ? now.slice(11, 16) : "10:00")}`;
}

const SLOTS = Array.from({ length: 25 }, (_, i) => `${pad(8 + Math.floor(i / 2))}:${i % 2 ? "30" : "00"}`);
const slotLabel = (t: string) => {
  const h = Number(t.slice(0, 2));
  return `${h % 12 || 12}:${t.slice(3)} ${h < 12 ? "am" : "pm"}`;
};

function nextMonday(today: string) {
  const diff = (1 - fromKey(today).getDay() + 7) % 7 || 7;
  return addDays(today, diff);
}

export default function DateTimeField({ id, value, onChange, mode = "datetime", min, max, label, placeholder, clearable, required }: Props) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [msg, setMsg] = useState("");
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState({ right: false, up: false });
  const now = nowWall();
  const today = now.slice(0, 10);
  const past = !!max && !min;
  const cur = value || "";
  const curDay = cur.slice(0, 10);
  const curTime = cur.length >= 16 ? cur.slice(11, 16) : "";

  // Open toward the side and direction that has room, so the popover is never cut off by the screen edge.
  useLayoutEffect(() => {
    if (!open || !pop.current || !trigger.current) return;
    const r = pop.current.getBoundingClientRect(),
      tr = trigger.current.getBoundingClientRect();
    setPlace({ right: r.right > window.innerWidth - 8 && tr.right - r.width >= 8, up: r.bottom > window.innerHeight - 8 && tr.top - r.height - 6 >= 8 });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      trigger.current && trigger.current.focus();
    };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const within = (v: string) => (!min || v >= min.slice(0, v.length)) && (!max || v <= max.slice(0, v.length));
  const apply = (v: string, close: boolean) => {
    if (!within(v)) {
      setMsg(past ? "That is in the future. Pick a time up to now." : max ? "That is after the latest allowed date." : "That is before the earliest allowed date.");
      return;
    }
    setMsg("");
    onChange(v);
    if (close) {
      setOpen(false);
      trigger.current && trigger.current.focus();
    }
  };
  const pickDay = (k: string) => {
    if (mode === "date") return apply(k, true);
    let time = curTime || "10:00";
    if (max && k + "T" + time > max) time = max.slice(11, 16);
    apply(k + "T" + time, false);
  };
  const pickTime = (t: string) => apply((curDay || today) + "T" + t, true);

  const chips: Array<[string, string]> = (
    mode === "date"
      ? past
        ? [["Today", today], ["Yesterday", addDays(today, -1)], ["7 days ago", addDays(today, -7)]]
        : [["Today", today], ["Tomorrow", addDays(today, 1)], ["Next Monday", nextMonday(today)]]
      : past
      ? [["Now", now.slice(0, 16)], ["Yesterday, same time", addDays(today, -1) + "T" + now.slice(11, 16)]]
      : [["Tomorrow 10:00 am", addDays(today, 1) + "T10:00"], ["Next Monday 10:00 am", nextMonday(today) + "T10:00"], ["In 1 week", addDays(today, 7) + "T10:00"]]
  ) as Array<[string, string]>;

  const slots = curTime && !SLOTS.includes(curTime) ? [...SLOTS, curTime].sort() : SLOTS;
  const disabled: Array<{ before: Date } | { after: Date }> = [];
  if (min) disabled.push({ before: fromKey(min) });
  if (max) disabled.push({ after: fromKey(max) });

  return (
    <div className="dtf" ref={wrap}>
      <button
        type="button"
        id={id}
        ref={trigger}
        className="dtf-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label ? `${label}: ${cur ? formatWhen(cur, mode) : "not set"}` : undefined}
        aria-required={required || undefined}
        onClick={() => {
          setOpen(!open);
          setMsg("");
          setText("");
        }}
      >
        <span className={cur ? "" : "dtf-empty"}>{cur ? formatWhen(cur, mode) : placeholder || (mode === "date" ? "Pick a date" : "Pick date and time")}</span>
        <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="5" width="18" height="16" rx="2" />
          <path d="M3 10h18M8 3v4M16 3v4" />
        </svg>
      </button>
      {open ? (
        <div
          ref={pop}
          className={"dtf-pop" + (place.right ? " right" : "") + (place.up ? " up" : "")}
          // Inside a <label>, a click on plain popover space would re-click the trigger and close it.
          onClick={(e) => {
            if (!(e.target as HTMLElement).closest("button,input")) e.preventDefault();
          }}
          role="dialog" aria-label={label || (mode === "date" ? "Choose a date" : "Choose date and time")}>
          <div className="dtf-chips">
            {chips.map(([l, v]) => (
              <button type="button" key={l} className="btn ghost small" onClick={() => apply(mode === "date" ? v.slice(0, 10) : v, true)}>
                {l}
              </button>
            ))}
          </div>
          <form
            className="dtf-type"
            onSubmit={(e) => {
              e.preventDefault();
              const v = parseWhen(text, now.slice(0, 16), mode);
              if (!v) return setMsg(mode === "date" ? 'Try "tomorrow", "mon" or "2 nov".' : 'Try "tomorrow 3pm", "mon 10:30" or "2 nov 11am".');
              apply(v, true);
            }}
          >
            <input
              id={id + "-type"}
              type="text"
              value={text}
              placeholder={mode === "date" ? 'Or type: "tomorrow", "2 nov"' : 'Or type: "tomorrow 3pm"'}
              aria-label="Type a date"
              onChange={(e) => setText(e.target.value)}
            />
            <button className="btn small" type="submit" disabled={!text.trim()}>
              Set
            </button>
          </form>
          <div className={"dtf-body" + (mode === "datetime" ? " with-time" : "")}>
            <DayPicker
              mode="single"
              weekStartsOn={1}
              showOutsideDays
              selected={curDay ? fromKey(curDay) : undefined}
              defaultMonth={curDay ? fromKey(curDay) : fromKey(today)}
              today={fromKey(today)}
              disabled={disabled}
              onSelect={(d) => d && pickDay(keyOf(d))}
            />
            {mode === "datetime" ? (
              <div className="dtf-slots" role="listbox" aria-label="Time">
                {slots.map((t) => (
                  <button
                    type="button"
                    role="option"
                    key={t}
                    aria-selected={t === curTime}
                    className={"dtf-slot" + (t === curTime ? " on" : "")}
                    disabled={!within((curDay || today) + "T" + t)}
                    onClick={() => pickTime(t)}
                  >
                    {slotLabel(t)}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <div className="dtf-foot">
            <span className="note" role="status">{msg || (cur ? formatWhen(cur, mode) + " IST" : "Times are IST")}</span>
            {clearable && cur ? (
              <button type="button" className="btn ghost small" onClick={() => { onChange(""); setOpen(false); }}>
                Clear
              </button>
            ) : null}
            {mode === "datetime" ? (
              <button type="button" className="btn small" onClick={() => setOpen(false)}>
                Done
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
