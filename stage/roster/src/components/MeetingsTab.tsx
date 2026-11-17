import type { MouseEvent, ReactNode } from "react";
import DateTimeField from "./DateTimeField";
import { useX, type Ctx } from "../lib/ctx";
import type { Row } from "../lib/data";
import { coName, dayKey, dk, fmtDay, fmtStamp, fmtTime, fmtWhen, nowISO, plural, toDate, shortName } from "../lib/format";
import { bookingLink, can, vMeetings } from "../lib/perms";
import { buildPrep, doDelete, findMeetLink, meetingHappened, rebook, upd } from "../lib/actions";
import { askDel, BookSlot, copyText, MoreMenu, noDel } from "./common";
import RescheduleBox from "./RescheduleBox";


/** Plain-words status for a meeting that has no Meet link yet. */
function linkStatusText(s: string | null | undefined): string {
  const v = String(s || "");
  if (v === "looking") return "Looking on your calendar…";
  if (v === "event found, no Meet link") return "Calendar event has no Meet link";
  // Calendar connection problems (from calErr) are already written for people. Show them as they are.
  if (/google calendar/i.test(v)) return v;
  return "No Meet link yet";
}

function MeetLinkCell({ X, m }: { X: Ctx; m: Row }) {
  if (m.mode === "offline")
    return (
      <span className="small">
        <b>In person</b>
        <br />
        {m.location || "Location not set"}
      </span>
    );
  if (m.meet_link)
    return (
      <a href={m.meet_link} target="_blank" rel="noopener" className="meet-link">
        {String(m.meet_link).replace("https://", "")}
      </a>
    );
  const looking = m.link_status === "looking";
  return (
    <div className="meet-missing">
      <span className="note">{linkStatusText(m.link_status)}</span>
      {looking ? null : (
        <button
          className="btn ghost small"
          onClick={async () => {
            try {
              await upd(X, "meetings", m.id, { link_status: "looking" });
              findMeetLink(X, m);
            } catch (_) {}
          }}
        >
          Find on calendar
        </button>
      )}
    </div>
  );
}

/** Prep brief panel, shown with the row. One button: Build or Rebuild. The Claude worker writes the brief;
    the row updates live when it lands. */
function PrepBlock({ X, m }: { X: Ctx; m: Row }) {
  const busy = X.S.busy.has("prep:" + m.id);
  const queued = m.prep_status === "queued";
  const waiting = queued ? (
    <p className="note">
      Queued for the Claude worker{m.prep_requested_at ? ` at ${fmtStamp(m.prep_requested_at)}` : ""}. It appears here after the next worker run.
    </p>
  ) : m.prep_status === "failed" ? (
    <p className="note err">The Claude worker could not build the last brief. Try again.</p>
  ) : null;
  if (m.prep)
    return (
      <div className="prep">
        <pre id={"prep-" + m.id}>{m.prep}</pre>
        <div className="row">
          <button className="btn ghost small" onClick={() => copyText(X, m.prep)}>Copy brief</button>
          <button className="btn ghost small" disabled={busy || queued} onClick={() => buildPrep(X, m.id)}>
            {busy ? "Queuing…" : queued ? "Rebuild queued" : "Rebuild brief"}
          </button>
        </div>
        {waiting}
      </div>
    );
  return (
    <div className="prep prep-empty">
      {waiting || <p className="note">No prep brief yet. It is built from this contact's roster research, the call context in the deal journey and HubSpot activity.</p>}
      <button className="btn ghost small" disabled={busy || queued} onClick={() => buildPrep(X, m.id)}>
        {busy ? "Queuing…" : queued ? "Brief queued" : "Build prep brief"}
      </button>
    </div>
  );
}

/** Move a meeting to the reschedule queue without counting a no-show. */
async function askReschedule(X: Ctx, m: Row) {
  const prev = { status: m.status, history: m.history || [] };
  try {
    await upd(X, "meetings", m.id, {
      status: "rescheduling",
      history: [...(m.history || []), { at: nowISO(), event: "reschedule_requested", when: m.when }],
    });
    X.toast("Moved to the reschedule queue.", () => upd(X, "meetings", m.id, prev));
  } catch (_) {}
}

function OutcomeButtons({ X, m }: { X: Ctx; m: Row }) {
  return (
    <div className="outcome" role="group" aria-label="Meeting outcome">
      <span className="outcome-label">How did it go?</span>
      <button className="btn small" id={"hp-" + m.id} onClick={() => meetingHappened(X, m.id, "yes")} title="The meeting happened. Moves it to Completed and the contact to Met.">
        Done
      </button>
      <button className="btn ghost small" onClick={() => meetingHappened(X, m.id, "no")} title="They did not join. Counts a no-show and moves it to the reschedule queue.">
        No-show
      </button>
      <button className="btn ghost small" onClick={() => askReschedule(X, m)} title="The meeting needs a new time. Moves it to the reschedule queue without counting a no-show.">
        Reschedule
      </button>
    </div>
  );
}

const closeMenu = (e: MouseEvent<HTMLElement>) => e.currentTarget.closest("details")?.removeAttribute("open");

export function MeetingRow({ X, m, mode }: { X: Ctx; m: Row; mode: "resched" | "sched" | "done" }) {
  const d = toDate(m.when);
  const past = !!d && d < new Date();
  const rs = X.S.forms["rs:" + m.id] || {};
  const link = bookingLink(X);
  const delKey = "meeting:" + m.id;
  const canDel = can(X, "delete_records");
  const confirming = canDel && X.S.confirmDel === delKey;
  const ctl =
    mode === "resched" ? (
      <div className="form" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))" }}>
        <label>
          New date and time (IST)
          <DateTimeField
            id={"rs-" + m.id}
            label="New date and time"
            value={rs.when || ""}
            onChange={(v) => {
              (X.S.forms["rs:" + m.id] || (X.S.forms["rs:" + m.id] = {})).when = v;
              X.rerender();
            }}
          />
        </label>
        <div className="row">
          <button className="btn small" disabled={X.S.busy.has("rs:" + m.id)} onClick={() => rebook(X, m.id)}>Rebook</button>
          {link ? <button className="btn ghost small" onClick={() => copyText(X, link)}>Copy HubSpot link</button> : null}
        </div>
      </div>
    ) : mode === "done" ? (
      <span className="pill ok">Done</span>
    ) : past ? (
      <OutcomeButtons X={X} m={m} />
    ) : (
      <span className="muted small">Outcome after the call</span>
    );
  return (
    <div className="card">
      <div className="mrow">
        <div className="when" title={fmtWhen(m.when)}>
          <b>{fmtDay(m.when)}</b>
          {fmtTime(m.when)}
          {past && mode === "sched" ? (
            <>
              <br />
              <span className="pill warn" style={{ margin: 0 }} title="The start time has passed. Use Done, No-show or Reschedule to record whether the meeting happened.">
                Confirm attendance
              </span>
            </>
          ) : null}
        </div>
        <div style={{ minWidth: 0 }}>
          <strong>{shortName(m.contact)}</strong> · {coName(m.company)}
          {m.hs_deal_id && X.D.settings.hubspot?.portal_id ? (
            <>
              {" "}
              <a className="pill adj" style={{ textDecoration: "none" }} href={`https://app.hubspot.com/contacts/${X.D.settings.hubspot.portal_id}/record/0-3/${m.hs_deal_id}`} target="_blank" rel="noopener">
                HubSpot deal
              </a>
            </>
          ) : null}
          <div className="muted small">
            {m.title}
            {m.reschedules ? ` · rescheduled ${m.reschedules}×` : ""}
            {m.no_shows ? ` · ${plural(m.no_shows, "no-show")}` : ""}
            {m.hs_synced_at ? ` · synced ${fmtStamp(m.hs_synced_at)}` : ""}
          </div>
        </div>
        <div style={{ minWidth: 0 }}>
          <MeetLinkCell X={X} m={m} />
        </div>
        <div className="actions">
          {ctl}
          {canDel ? (
            <MoreMenu label="More actions for this meeting">
              <button
                className="btn ghost small"
                onClick={(e) => {
                  closeMenu(e);
                  askDel(X, delKey);
                }}
              >
                Delete meeting
              </button>
            </MoreMenu>
          ) : null}
        </div>
      </div>
      {confirming ? (
        <div className="confirm meet-confirm" role="alert">
          Delete this meeting? This doesn't cancel the meeting in HubSpot or your calendar.
          <button className="btn danger small" onClick={() => doDelete(X, delKey)}>Delete</button>
          <button className="btn ghost small" onClick={() => noDel(X)}>Keep</button>
        </div>
      ) : null}
      {mode === "resched" ? (
        <div className="rs-wrap">
          <RescheduleBox X={X} m={m} />
        </div>
      ) : null}
      {mode !== "done" || m.prep ? <PrepBlock X={X} m={m} /> : null}
    </div>
  );
}

function Group({ title, count, note, children, focus }: { title: string; count: number; note?: string; children: ReactNode; focus?: boolean }) {
  if (!count) return null;
  return (
    <div className={focus ? "focus" : "meet-group"}>
      <div className="section-head">
        <h2>
          {title} <span className="muted meet-count">({count})</span>
        </h2>
        {note ? <span className="note">{note}</span> : null}
      </div>
      <div className="list">{children}</div>
    </div>
  );
}

export default function MeetingsTab() {
  const X = useX();
  const by = (a: Row, b: Row) => String(a.when).localeCompare(String(b.when));
  const all = vMeetings(X);
  const now = new Date();
  const today = dayKey(now);
  const isPast = (m: Row) => {
    const d = toDate(m.when);
    return !!d && d < now;
  };
  const rs = all.filter((m) => m.status === "rescheduling").sort(by),
    sc = all.filter((m) => m.status === "scheduled").sort(by),
    dn = all.filter((m) => m.status === "done").sort((a, b) => by(b, a));
  const needs = sc.filter(isPast),
    todays = sc.filter((m) => !isPast(m) && dk(m.when) === today),
    upcoming = sc.filter((m) => !isPast(m) && dk(m.when) !== today);
  const row = (mode: "resched" | "sched" | "done") => (m: Row) => <MeetingRow key={m.id} X={X} m={m} mode={mode} />;
  return (
    <div className="section">
      <div className="controls meet-book">
        <BookSlot X={X} />
        <span className="note">Book demos through the team's HubSpot link. Admins change it in Admin &gt; Integrations.</span>
      </div>
      <Group title="Needs outcome" count={needs.length} focus note="The start time has passed. Record whether each meeting happened.">
        {needs.map(row("sched"))}
      </Group>
      <Group title="Reschedule queue" count={rs.length} focus note={`${plural(rs.length, "meeting")} did not happen. Rebook each through HubSpot, then enter the new time.`}>
        {rs.map(row("resched"))}
      </Group>
      <Group title="Today" count={todays.length} note="Meet links are read from your Google Calendar. In-person meetings show the location.">
        {todays.map(row("sched"))}
      </Group>
      <Group title="Upcoming" count={upcoming.length} note={todays.length ? undefined : "Meet links are read from your Google Calendar. In-person meetings show the location."}>
        {upcoming.map(row("sched"))}
      </Group>
      {!sc.length && !rs.length ? <div className="empty">No booked meetings yet. Log "Booked a meeting" on a contact in Accounts.</div> : null}
      {dn.length ? (
        <details className="card" id="done-meetings" open={X.S.openDone}>
          <summary
            style={{ padding: "12px 14px" }}
            onClick={(e) => {
              e.preventDefault();
              X.S.openDone = !X.S.openDone;
              X.rerender();
            }}
          >
            <strong>Completed meetings</strong> <span className="muted">({dn.length})</span>
          </summary>
          <div className="list" style={{ padding: "0 10px 10px" }}>
            {dn.map(row("done"))}
          </div>
        </details>
      ) : null}
    </div>
  );
}
