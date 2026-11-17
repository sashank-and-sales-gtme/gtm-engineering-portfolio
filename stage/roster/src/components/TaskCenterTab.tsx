import { useEffect, type ReactNode, type DragEvent } from "react";
import DateTimeField from "./DateTimeField";
import { useX, type Ctx } from "../lib/ctx";
import type { Row } from "../lib/data";
import { coName, DAY, dayKey, dk, fmtDay, fmtStamp, fmtTime, fmtWhen, isoToIst, nowISO, plural, tms, toDate, validWall, shortName } from "../lib/format";
import { contextFor, ownerOf, pname, vCallbacks, vMeetings, vTasks } from "../lib/perms";
import { addTask, moveItem, retryCal, saveBlockOrder, setTaskDone, taskCal, updateTask } from "../lib/actions";
import { connectGoogleCalendar, googleState, syncGTasks } from "../lib/google";
import { DelConfirm, MoreMenu, outcomeUI } from "./common";

export const SIX = (
  <svg width="10" height="16" viewBox="0 0 10 16" aria-hidden="true">
    <g fill="currentColor">
      <circle cx="2.5" cy="3" r="1.5" />
      <circle cx="7.5" cy="3" r="1.5" />
      <circle cx="2.5" cy="8" r="1.5" />
      <circle cx="7.5" cy="8" r="1.5" />
      <circle cx="2.5" cy="13" r="1.5" />
      <circle cx="7.5" cy="13" r="1.5" />
    </g>
  </svg>
);

type Item = { kind: "cb" | "rs" | "mt" | "ct"; when: string; ref: Row };
const itemKey = (it: Item) => it.kind + ":" + it.ref.id;

export function taskItems(X: Ctx): Item[] {
  const items: Item[] = [];
  vCallbacks(X)
    .filter((c) => c.status === "open")
    .forEach((c) => items.push({ kind: "cb", when: c.when, ref: c }));
  vMeetings(X)
    .filter((m) => m.status === "rescheduling")
    .forEach((m) => {
      const h = (Array.isArray(m.history) ? m.history : []).slice(-1)[0];
      items.push({ kind: "rs", when: h && h.at ? h.at : m.when, ref: m });
    });
  vMeetings(X)
    .filter((m) => m.status === "scheduled")
    .forEach((m) => items.push({ kind: "mt", when: m.when, ref: m }));
  vTasks(X).forEach((t) => items.push({ kind: "ct", when: t.when, ref: t }));
  return items.sort((a, b) => (tms(a.when) || 0) - (tms(b.when) || 0));
}
function orderBlock(X: Ctx, arr: Item[]) {
  const order = X.S.orderLocal || X.D.order;
  const idx = new Map(order.map((k, i) => [k, i]));
  return arr.slice().sort((a, b) => {
    const ia = idx.has(itemKey(a)) ? idx.get(itemKey(a))! : 1e9,
      ib = idx.has(itemKey(b)) ? idx.get(itemKey(b))! : 1e9;
    return ia - ib || (tms(a.when) || 0) - (tms(b.when) || 0);
  });
}
function CtxBlock({ X, leadId, k }: { X: Ctx; leadId: string; k: string }) {
  const cs = contextFor(X, leadId);
  if (!cs.length)
    return (
      <div className="note" style={{ marginTop: 4 }}>
        No call context saved yet.
      </div>
    );
  const open = X.S.openCtx.has(k),
    show = open ? cs : cs.slice(0, 1);
  return (
    <>
      {show.map((j) => (
        <div className="ctxbox" key={j.id}>
          <span className="jt mono">{fmtStamp(j.at)}</span>
          {"\n"}
          {j.text}
        </div>
      ))}
      {cs.length > 1 ? (
        <button
          className="btn ghost small"
          style={{ marginTop: 4 }}
          onClick={() => {
            open ? X.S.openCtx.delete(k) : X.S.openCtx.add(k);
            X.rerender();
          }}
        >
          {open ? "Show latest only" : "Show all " + cs.length + " notes"}
        </button>
      ) : null}
    </>
  );
}

function clearDnD() {
  document.querySelectorAll(".trow.over,.trow.dragging").forEach((r) => r.classList.remove("over", "dragging"));
}

const isOpen = (it: Item) => it.kind !== "ct" || !it.ref.done;
/** An open callback or task whose time has already passed today (IST). */
function isLate(it: Item, nowMs: number) {
  if (it.kind !== "cb" && it.kind !== "ct") return false;
  if (!isOpen(it)) return false;
  const t = tms(it.when);
  return !isNaN(t) && t < nowMs && dk(it.when) === dayKey(new Date(nowMs));
}

const closeMenu = (el: HTMLElement) => {
  const d = el.closest("details");
  d && d.removeAttribute("open");
};

const DURS = ["15", "30", "45", "60"];

function openEdit(X: Ctx, r: Row) {
  X.S.forms["edit:" + r.id] = { title: r.title || "", when: isoToIst(r.when), duration: String(r.duration || 15), notes: r.notes || "" };
  X.rerender();
  setTimeout(() => {
    const el = document.getElementById("te-title-" + r.id) as HTMLInputElement | null;
    el && el.focus();
  }, 0);
}
function closeEdit(X: Ctx, id: string) {
  delete X.S.forms["edit:" + id];
  X.rerender();
}

function EditTask({ X, r }: { X: Ctx; r: Row }) {
  const key = "edit:" + r.id,
    f = X.S.forms[key],
    busy = X.S.busy.has("task-edit:" + r.id);
  const set = (k: string, v: string) => {
    f[k] = v;
    X.rerender();
  };
  const durs = DURS.includes(f.duration) ? DURS : [...DURS, f.duration];
  const save = async () => {
    if (!f.title.trim()) return X.toast("A task needs a name.");
    if (!validWall(f.when)) return X.toast("Pick a date and time.");
    X.S.busy.add("task-edit:" + r.id);
    X.rerender();
    try {
      await updateTask(X, r.id, { title: f.title, when: f.when, duration: +f.duration, notes: f.notes });
      delete X.S.forms[key];
    } finally {
      X.S.busy.delete("task-edit:" + r.id);
      X.rerender();
    }
  };
  return (
    <div className="form tedit">
      <label className="full">
        Task
        <input id={"te-title-" + r.id} value={f.title} onChange={(e) => set("title", e.target.value)} />
      </label>
      <label>
        Date and time (IST)
        <DateTimeField id={"te-when-" + r.id} label="Date and time" value={f.when} onChange={(v) => set("when", v)} />
      </label>
      <label>
        Duration
        <select id={"te-dur-" + r.id} value={f.duration} onChange={(e) => set("duration", e.target.value)}>
          {durs.map((d) => (
            <option key={d} value={d}>
              {d} min
            </option>
          ))}
        </select>
      </label>
      <label className="full">
        Notes
        <textarea id={"te-notes-" + r.id} value={f.notes} onChange={(e) => set("notes", e.target.value)} />
      </label>
      <div className="row full">
        <button className="btn" disabled={busy} onClick={save}>
          {busy ? "Saving…" : "Save"}
        </button>
        <button className="btn ghost" disabled={busy} onClick={() => closeEdit(X, r.id)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function TaskRow({ X, it, block, late }: { X: Ctx; it: Item; block: string; late: boolean }) {
  const r = it.ref,
    key = itemKey(it);
  const goto = (t: string) => {
    X.S.tab = t;
    X.rerender();
  };
  // Inside the Today block the day is in the header, so only the time is shown.
  const when = (iso: string) => (block === "today" ? fmtTime(iso) : fmtWhen(iso));
  const latePill = late ? <span className="pill warn">Late</span> : null;
  const whose = ownerOf(X, r) !== X.uid ? <span className="note"> · {pname(X, ownerOf(X, r))}</span> : null;
  const grip = (
    <div className="tgrip">
      <button
        className="handle"
        draggable
        data-drag={key}
        data-block={block}
        aria-label="Drag to reorder. Use arrow keys to move."
        title="Drag to reorder"
        onDragStart={(e: DragEvent<HTMLButtonElement>) => {
          X.S.drag = { key, block };
          const row = (e.currentTarget as HTMLElement).closest(".trow") as HTMLElement | null;
          row && row.classList.add("dragging");
          try {
            e.dataTransfer.setData("text/plain", key);
            e.dataTransfer.effectAllowed = "move";
            row && e.dataTransfer.setDragImage(row, 16, 16);
          } catch (_) {}
        }}
        onDragEnd={() => {
          clearDnD();
          X.S.drag = null;
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            moveItem(X, block, key, e.key === "ArrowUp" ? -1 : 1);
          }
        }}
      >
        {SIX}
      </button>
      <span className="mv">
        <button aria-label="Move up" onClick={() => moveItem(X, block, key, -1)}>▲</button>
        <button aria-label="Move down" onClick={() => moveItem(X, block, key, 1)}>▼</button>
      </span>
    </div>
  );
  const wrap = (inner: ReactNode, cls = "") => (
    <div
      className={"trow" + (late ? " late" : "") + (cls ? " " + cls : "")}
      data-key={key}
      data-block={block}
      onDragOver={(e) => {
        if (!X.S.drag || X.S.drag.block !== block) return;
        e.preventDefault();
        document.querySelectorAll(".trow.over").forEach((x) => x.classList.remove("over"));
        (e.currentTarget as HTMLElement).classList.add("over");
      }}
      onDrop={(e) => {
        const d = X.S.drag;
        clearDnD();
        if (d && d.block === block && d.key !== key) {
          e.preventDefault();
          const keys = (X.S.blocks[block] || []).filter((k) => k !== d.key);
          const at = keys.indexOf(key);
          keys.splice(at, 0, d.key);
          saveBlockOrder(X, keys);
        }
        X.S.drag = null;
      }}
    >
      {grip}
      {inner}
    </div>
  );
  if (it.kind === "cb") {
    const ui = outcomeUI(X, r.lead_id, r.id);
    return wrap(
      <>
        <span className="tlead">
          <span className="kind cb">Callback</span>
        </span>
        <div className="tbody">
          <strong className="ttl">
            {shortName(r.contact)} · {coName(r.company)}
          </strong>
          {latePill}
          {whose}
          <div className="muted small">
            {when(r.when)} · Agenda: {r.agenda}
          </div>
          {r.cal_status === "failed" ? (
            <div className="err small">
              {r.cal_error || "Not in Google Tasks."}{" "}
              <button className="btn ghost small" onClick={() => retryCal(X, r.id)}>
                Add to Google Tasks
              </button>
            </div>
          ) : null}
          <CtxBlock X={X} leadId={r.lead_id} k={key} />
          <div className="toutcome">{ui.control}</div>
          {ui.form}
        </div>
        <div className="actions">
          <MoreMenu label="More actions for this callback">
            <DelConfirm X={X} kind="callback" id={r.id} label="callback" />
          </MoreMenu>
        </div>
      </>
    );
  }
  if (it.kind === "rs")
    return wrap(
      <>
        <span className="tlead">
          <span className="kind rs">Reschedule</span>
        </span>
        <div className="tbody">
          <strong className="ttl">
            {shortName(r.contact)} · {coName(r.company)}
          </strong>
          {whose}
          <div className="muted small">
            Missed {fmtWhen(r.when)}
            {r.reschedules ? ` · rescheduled ${r.reschedules}× before` : ""}. Rebook through HubSpot.
          </div>
          <CtxBlock X={X} leadId={r.lead_id} k={key} />
        </div>
        <div className="actions">
          <button className="btn ghost small" onClick={() => goto("meetings")}>Open queue</button>
          <MoreMenu label="More actions for this meeting">
            <DelConfirm X={X} kind="meeting" id={r.id} label="meeting" />
          </MoreMenu>
        </div>
      </>
    );
  if (it.kind === "mt")
    return wrap(
      <>
        <span className="tlead">
          <span className="kind mt">Meeting</span>
        </span>
        <div className="tbody">
          <strong className="ttl">
            {shortName(r.contact)} · {coName(r.company)}
          </strong>
          {whose}
          <div className="muted small">
            {when(r.when)} ·{" "}
            {r.mode === "offline" ? (
              r.location || "in person"
            ) : r.meet_link ? (
              <a href={r.meet_link} target="_blank" rel="noopener">Join Meet</a>
            ) : (
              "Meet link pending"
            )}
          </div>
        </div>
        <div className="actions">
          <button className="btn ghost small" onClick={() => goto("meetings")}>Prep</button>
        </div>
      </>
    );
  const editing = !!X.S.forms["edit:" + r.id];
  return wrap(
    <>
      <span className="tlead">
        <input
          type="checkbox"
          id={"td-" + r.id}
          checked={!!r.done}
          aria-label="Mark done"
          onChange={(e) => setTaskDone(X, r.id, e.target.checked)}
        />
      </span>
      <div className={"tbody" + (r.done ? " done" : "")}>
        {editing ? (
          <EditTask X={X} r={r} />
        ) : (
          <>
            <button className="ttl tedit-open" title="Edit task" onClick={() => openEdit(X, r)}>
              {r.title}
            </button>
            {latePill}
            {whose}
            <div className="muted small">
              {when(r.when)} · {r.duration || 15} min{r.notes ? " · " + r.notes : ""}{" "}
              {r.cal_status === "added" ? (
                <span className="pill ok">{r.cal_kind === "task" ? "in Google Tasks" : "on calendar"}</span>
              ) : r.cal_status === "failed" ? (
                <span className="err">{r.cal_error || ""}</span>
              ) : null}
            </div>
          </>
        )}
      </div>
      <div className="actions">
        {!editing && (r.cal_status === "failed" || r.cal_status === "none") ? (
          <button className="btn ghost small" onClick={() => taskCal(X, r.id)}>Add to Google Tasks</button>
        ) : null}
        <MoreMenu label="More actions for this task">
          {!editing ? (
            <button
              className="btn ghost small"
              onClick={(e) => {
                closeMenu(e.currentTarget);
                openEdit(X, r);
              }}
            >
              Edit
            </button>
          ) : null}
          <DelConfirm X={X} kind="task" id={r.id} label="task" />
        </MoreMenu>
      </div>
    </>,
    "tk-task"
  );
}

export default function TaskCenterTab() {
  const X = useX();
  const S = X.S;
  // Pull in anything ticked off in Google Tasks: on open and every two minutes while the Task Center is on screen.
  useEffect(() => {
    if (googleState() !== "connected") return;
    const run = () => {
      if (!document.hidden) syncGTasks();
    };
    run();
    const t = window.setInterval(run, 120_000);
    return () => window.clearInterval(t);
  }, [googleState()]);
  const nowMs = Date.now();
  const realToday = dayKey(new Date(nowMs));
  const today = S.f.taskDay || realToday,
    items = taskItems(X);
  const dki = (it: Item) => dk(it.when);
  const overdue = orderBlock(X, items.filter((it) => isOpen(it) && dki(it) && dki(it) < today && it.kind !== "mt" && it.kind !== "rs"));
  // Late items (open callbacks/tasks whose time passed earlier today) go first; everything keeps its saved order otherwise.
  const todayAll = orderBlock(X, items.filter((it) => (dki(it) === today && it.kind !== "rs") || (it.kind === "rs" && dki(it) <= today)));
  const lateSet = new Set(todayAll.filter((it) => isLate(it, nowMs)).map(itemKey));
  const todays = [...todayAll.filter((it) => lateSet.has(itemKey(it))), ...todayAll.filter((it) => !lateSet.has(itemKey(it)))];
  const dueToday = todays.filter(isOpen).length;
  // `today` is an IST calendar day; step 7 days in absolute time (IST has no DST).
  const start = toDate(today);
  const endK = start ? dayKey(new Date(start.getTime() + 7 * DAY)) : today;
  const upcoming = orderBlock(X, items.filter((it) => isOpen(it) && dki(it) > today && dki(it) <= endK && it.kind !== "rs"));
  const tf = S.forms.task || (S.forms.task = { title: "", when: "", duration: "15", notes: "", cal: true });
  const calOk = googleState() === "connected";
  if (!calOk) tf.cal = false;
  else if (!tf.calTouched) tf.cal = true;
  S.blocks = { overdue: overdue.map(itemKey), today: todays.map(itemKey), next: upcoming.map(itemKey) };
  const setT = (k: string, v: any) => {
    tf[k] = v;
    X.rerender();
  };
  const connect = async () => {
    try {
      await connectGoogleCalendar();
    } catch (e: any) {
      X.toast((e && e.message) || "Could not start the calendar connection.");
    }
  };
  // One thing at a time: the first open item that was due or is due today. Skipping moves on to the next one for this visit.
  const skipped: Set<string> = S.forms["tk-skip"] || (S.forms["tk-skip"] = new Set<string>());
  const pool = today === realToday ? [...overdue, ...todays].filter(isOpen) : [];
  const focusIt = pool.find((it) => !skipped.has(itemKey(it)));
  const focusTitle = (it: Item) =>
    it.kind === "ct" ? it.ref.title : it.kind === "mt" || it.kind === "rs" ? `${shortName(it.ref.contact)} · ${coName(it.ref.company)}` : it.ref.contact ? `${shortName(it.ref.contact)} · ${coName(it.ref.company)}` : "Callback";
  const focusKind = (it: Item) => (it.kind === "ct" ? "Task" : it.kind === "cb" ? "Callback" : it.kind === "mt" ? "Meeting" : "Needs a new time");
  const nowCard = pool.length ? (
    <section className="nowcard" aria-label="Now">
      {focusIt ? (
        <>
          <div className="nowcard-main">
            <span className="note">Now · {focusKind(focusIt)}</span>
            <strong className="nowcard-title">{focusTitle(focusIt)}</strong>
            <span className="muted small">
              {fmtWhen(focusIt.when)}
              {focusIt.kind === "cb" && focusIt.ref.agenda ? " · " + focusIt.ref.agenda : ""}
            </span>
          </div>
          <div className="nowcard-acts">
            {focusIt.kind === "ct" ? (
              <button className="btn" onClick={() => setTaskDone(X, focusIt.ref.id, true)}>Mark done</button>
            ) : focusIt.kind === "mt" || focusIt.kind === "rs" ? (
              <button className="btn" onClick={() => { S.tab = "meetings"; X.rerender(); }}>{focusIt.kind === "mt" ? "Open prep" : "Open queue"}</button>
            ) : (
              <button
                className="btn"
                onClick={() => {
                  const h = document.querySelector(`[data-drag="${CSS.escape(itemKey(focusIt))}"]`);
                  const row = h && h.closest(".trow");
                  if (row) row.scrollIntoView({ block: "center", behavior: "smooth" });
                }}
              >
                Show it
              </button>
            )}
            <button className="btn ghost" onClick={() => { skipped.add(itemKey(focusIt)); X.rerender(); }}>Skip for now</button>
          </div>
          <span className="note">{pool.length - 1 - [...skipped].filter((k) => pool.some((it) => itemKey(it) === k)).length} more after this</span>
        </>
      ) : (
        <p className="note">You have seen everything due. Skipped items stay in the lists below.</p>
      )}
    </section>
  ) : null;
  const block = (id: string, h: string, count: string, arr: Item[], emptyTxt: string) => (
    <div className="section">
      <div className="section-head">
        <h2>
          {h}
          {count ? <span className="thcount"> · {count}</span> : null}
        </h2>
      </div>
      {arr.length ? (
        <div className="card tcard" data-dropblock={id}>
          {arr.map((it) => (
            <TaskRow key={itemKey(it)} X={X} it={it} block={id} late={id === "today" && lateSet.has(itemKey(it))} />
          ))}
        </div>
      ) : (
        <div className="empty">{emptyTxt}</div>
      )}
    </div>
  );
  return (
    <div className="section tasks-tab">
      <div className="controls">
        <label className="note" htmlFor="f-day">Day</label>
        <DateTimeField
          id="f-day"
          mode="date"
          label="Day"
          value={today}
          onChange={(v) => {
            S.f.taskDay = v || null;
            X.rerender();
          }}
        />
        <button
          className="btn ghost small"
          onClick={() => {
            S.f.taskDay = null;
            X.rerender();
          }}
        >
          Today
        </button>
        <span className="note">Drag the six-dot handle to reorder within a block.</span>
      </div>
      {nowCard}
      {overdue.length ? <div className="focus">{block("overdue", "Was due", plural(overdue.length, "item"), overdue, "")}</div> : null}
      {block("today", today === realToday ? "Today" : fmtDay(today), dueToday + " due", todays, "Nothing scheduled for this day.")}
      {block("next", "Next 7 days", upcoming.length ? plural(upcoming.length, "item") : "", upcoming, "Nothing coming up.")}
      <div className="section">
        <h2>Add a task</h2>
        <div className="form">
          <label className="full">
            Task
            <input id="t-title" value={tf.title} placeholder="e.g. Send Globex the case study" onChange={(e) => setT("title", e.target.value)} />
          </label>
          <label>
            Date and time (IST)
            <DateTimeField id="t-when" label="Date and time" value={tf.when} onChange={(v) => setT("when", v)} />
          </label>
          <label>
            Duration
            <select id="t-dur" value={tf.duration} onChange={(e) => setT("duration", e.target.value)}>
              {DURS.map((d) => (
                <option key={d} value={d}>
                  {d} min
                </option>
              ))}
            </select>
          </label>
          <div className="tcal">
            <label className="tcal-box">
              <input
                type="checkbox"
                id="t-cal"
                checked={!!tf.cal}
                disabled={!calOk}
                aria-describedby={calOk ? undefined : "t-cal-hint"}
                onChange={(e) => {
                  tf.calTouched = true;
                  setT("cal", e.target.checked);
                }}
              />
              Add to Google Tasks
            </label>
            {calOk ? (
              <div className="hint">Shows in Google Calendar and Gmail. Tick it off there or here; both stay in step.</div>
            ) : (
              <div className="hint" id="t-cal-hint">
                Connect Google to add tasks.{" "}
                <button className="linkbtn" onClick={connect}>
                  Connect Google
                </button>
              </div>
            )}
          </div>
          <label className="full">
            Notes
            <textarea id="t-notes" value={tf.notes} onChange={(e) => setT("notes", e.target.value)} />
          </label>
          <div className="row full">
            <button className="btn" disabled={S.busy.has("task")} onClick={() => addTask(X)}>
              {S.busy.has("task") ? "Adding…" : "Add task"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
