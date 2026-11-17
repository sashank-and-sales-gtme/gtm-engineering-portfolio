import { useX, type Ctx } from "../lib/ctx";
import DateTimeField from "./DateTimeField";
import type { Row } from "../lib/data";
import { coName, DAY, dayKey, fmtDay, plural, titleGroup, tms } from "../lib/format";
import { accountPriority } from "../lib/priority";
import SdrOverview, { dialsAndConnects } from "./SdrOverview";
import { assignedTo, leadById, ownerId, ownerOf, pname, seeAllWork, vCallbacks, visibleLeads, vMeetings, workVisible } from "../lib/perms";

type Pred = (t: number) => boolean;
type M = { leads: number; calls: number; conn: number; booked: number; done: number; ns: number; cbs: number };

const leadDate = (l: Row) => {
  const b = String(l.batch || "").replace("manual-", "");
  const c = tms(l.created_at);
  return !isNaN(c) ? c : tms(b + "T09:00:00");
};
const doneAt = (m: Row) => {
  if (m.status !== "done") return NaN;
  const h = (Array.isArray(m.history) ? m.history : []).filter((x: any) => x.event === "done").slice(-1)[0];
  const a = tms(m.done_at);
  if (!isNaN(a)) return a;
  const b = tms(h && h.at);
  return !isNaN(b) ? b : tms(m.when);
};
const noShowTimes = (m: Row): number[] => {
  const h = (Array.isArray(m.history) ? m.history : []).filter((x: any) => x.event === "no_show").map((x: any) => tms(x.at));
  if (h.length) return h;
  return m.no_shows ? Array(m.no_shows).fill(tms(m.when)) : [];
};
function between(lo: number, hi: number): Pred {
  return (t) => !isNaN(t) && t > lo && t <= hi;
}

function makeMetrics(X: Ctx) {
  const rep = X.S.f2.rep;
  const repOK = (d: Row) => rep === "all" || ownerOf(X, d) === rep;
  const DL = visibleLeads(X).filter((l) => rep === "all" || assignedTo(l) === rep || (!assignedTo(l) && rep === ownerId(X)));
  const DC = X.D.calls.filter((c) => workVisible(X, c) && repOK(c));
  const DM = vMeetings(X).filter(repOK);
  const DJ = X.D.journeys.filter((j) => j.kind !== "hubspot" && workVisible(X, j) && repOK(j));
  const DCB = vCallbacks(X).filter(repOK);
  const { dials, connects } = dialsAndConnects(DC, DJ);
  function metrics(pred: Pred, keyFn?: (l: Row) => string, key?: string): M {
    const f = (x: Row) => !keyFn || keyFn(x) === key;
    const L = DL.filter((l) => f(l) && pred(leadDate(l))).length,
      C = dials.filter((c) => f(leadById(X, c.lead_id) || c) && pred(tms(c.at))).length,
      J = connects.filter((j) => f(leadById(X, j.lead_id) || j) && pred(tms(j.at))).length;
    const Ms = DM.filter((m) => f(leadById(X, m.lead_id) || m));
    return {
      leads: L,
      calls: C,
      conn: J,
      booked: Ms.filter((m) => pred(tms(m.created_at))).length,
      done: Ms.filter((m) => pred(doneAt(m))).length,
      ns: Ms.reduce((s, m) => s + noShowTimes(m).filter(pred).length, 0),
      cbs: DCB.filter((c) => f(leadById(X, c.lead_id) || c) && pred(tms(c.created_at))).length,
    };
  }
  return { metrics, DM, DL, DC, DJ, DCB };
}

/** IST midnight at the start of a YYYY-MM-DD day, in ms. */
const istDay = (k: string) => new Date(k + "T00:00:00+05:30").getTime();
/** The dashboard window: 7, 30 or 90 days, all time (charts read the last 28 days), or custom dates. */
function periodPreds(p: string, from: string, to: string) {
  const now = Date.now();
  let N = p === "30" ? 30 : p === "90" ? 90 : p === "all" ? 28 : 7,
    end = now;
  let span = p === "all" ? "last 28 days" : `last ${N} days`;
  if (p === "custom" && from && to && from <= to) {
    const lo = istDay(from);
    end = Math.min(now, istDay(to) + DAY - 1);
    N = Math.max(1, Math.round((end - lo) / DAY));
    span = from === to ? fmtDay(from) : `${fmtDay(from)} to ${fmtDay(to)}`;
  }
  const insN = p === "all" ? 7 : N;
  return {
    dcur: between(end - insN * DAY, end),
    dprev: between(end - 2 * insN * DAY, end - insN * DAY),
    label: p === "all" ? "this week vs last week" : p === "custom" ? `vs the ${insN} days before` : `vs previous ${insN} days`,
    N,
    end,
    span,
  };
}
type Insight = { tone: "good" | "bad" | "flat" | "act"; big: string; text: string; go?: { label: string; run: () => void } };
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
const change = (cur: number, prev: number) => (prev ? Math.round(((cur - prev) / prev) * 100) : cur ? 100 : 0);
const STAGE_NAMES = ["Not approved", "Approved", "Callback", "Demo booked", "Demo done", "Closed lost / Cold"];

/** Accounts the viewer can see, with their stage (0-4), best tier and priority, for the stage mix and callouts. */
function accountRows(X: Ctx) {
  const groups = new Map<string, Row[]>();
  visibleLeads(X).filter((l) => l.dq_scope !== "company").forEach((l) => {
    const k = coName(l.company).toLowerCase();
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(l);
  });
  const now = Date.now();
  return [...groups.entries()].map(([k, c]) => {
    const ids = new Set(c.map((l) => l.id));
    const ms = X.D.meetings.filter((m) => ids.has(m.lead_id));
    const cbs = X.D.callbacks.filter((x) => ids.has(x.lead_id) && x.status === "open");
    const stage = c.some((l) => l.lost_at) ? 5 : ms.some((m) => m.status === "done") ? 4 : ms.length ? 3 : cbs.length ? 2 : c.some((l) => l.approved) ? 1 : 0;
    const tier = c.map((l) => l.tier || "U").sort((a, b) => "SABCXU".indexOf(a) - "SABCXU".indexOf(b))[0];
    const next = [...ms.filter((m) => m.status === "scheduled").map((m) => tms(m.when)), ...cbs.map((x) => tms(x.when))].filter((t) => t >= now);
    return { k, name: coName(c[0].company), stage, tier, pr: accountPriority(X, c, tier).p, next: next.length ? Math.min(...next) : NaN, called: X.D.calls.some((x) => ids.has(x.lead_id)) };
  });
}

/** Plain-language readings of the numbers: what moved, what converts, and what needs doing next. */
function buildInsights(X: Ctx, dc: M, dp: M, label: string, accts: ReturnType<typeof accountRows>, byTitle: Array<[string, number]>): Insight[] {
  const out: Insight[] = [];
  const span = /week/.test(label) ? "this week" : /before/.test(label) ? "in this period" : `in the last ${(label.match(/\d+/) || ["7"])[0]} days`;
  const goAccounts = (patch: Partial<typeof X.S.f>) => () => {
    Object.assign(X.S.f, { range: "all", from: "", to: "", tiers: [], appr: "all", scope: "all", q: "" }, patch);
    window.location.hash = "#/accounts";
  };
  if (dc.calls || dp.calls) {
    const ch = change(dc.calls, dp.calls);
    out.push({
      tone: ch > 0 ? "good" : ch < 0 ? "bad" : "flat",
      big: dc.calls + (dc.calls === 1 ? " call" : " calls"),
      text: dp.calls ? `${span[0].toUpperCase() + span.slice(1)}. Calls are ${ch > 0 ? "up" : ch < 0 ? "down" : "flat"}${ch ? " " + Math.abs(ch) + "%" : ""} ${label} (${dp.calls} before).` : `logged ${span}, with nothing to compare against yet.`,
    });
  }
  if (dc.calls) {
    const r = pct(dc.booked, dc.calls),
      rp = pct(dp.booked, dp.calls);
    out.push({
      tone: r > rp ? "good" : r < rp ? "bad" : "flat",
      big: r + "%",
      text: dc.booked ? `of calls booked a demo: ${dc.booked} of ${dc.calls}${dp.calls ? `, ${r >= rp ? "up" : "down"} from ${rp}%` : ""}.` : `of calls booked a demo. None of the ${dc.calls} calls has turned into a meeting yet.`,
    });
  }
  const demos = accts.filter((a) => a.stage >= 3 && a.stage < 5);
  if (demos.length) {
    const top = demos.filter((a) => "SA".includes(a.tier)).length;
    out.push({ tone: "flat", big: `${top} of ${demos.length}`, text: `${demos.length === 1 ? "account with a demo is" : "accounts with a demo are"} Tier S or A. ${top === demos.length ? "Research is pointing reps at the right accounts." : "Some demos are coming from lower tiers; worth a look at the tiering."}` });
  }
  const best = byTitle.filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1])[0];
  if (best) out.push({ tone: "good", big: best[0], text: `leaders booked the most demos ${span} (${best[1]}).` });
  const idle = accts.filter((a) => a.pr === "high" && isNaN(a.next) && a.stage < 5);
  if (idle.length)
    out.push({
      tone: "act",
      big: String(idle.length),
      text: `High-priority ${idle.length === 1 ? "account has" : "accounts have"} no callback or demo scheduled${idle.length <= 3 ? ": " + idle.map((a) => a.name).join(", ") : ""}.`,
      go: { label: "Open accounts", run: goAccounts({ sort: "priority", dir: 1 }) },
    });
  const fresh = accts.filter((a) => "SA".includes(a.tier) && !a.called && a.stage < 5);
  if (fresh.length)
    out.push({ tone: "act", big: String(fresh.length), text: `Tier S and A ${fresh.length === 1 ? "account hasn't" : "accounts haven't"} had a call yet.`, go: { label: "Show them", run: goAccounts({ tiers: ["S", "A"], appr: "all" }) } });
  const soon = accts.filter((a) => !isNaN(a.next) && a.next - Date.now() < 2 * DAY).length;
  if (soon) out.push({ tone: "act", big: String(soon), text: `${soon === 1 ? "account has" : "accounts have"} a callback or demo in the next 48 hours.`, go: { label: "Task Center", run: () => (window.location.hash = "#/tasks") } });
  if (dc.ns || dp.ns) out.push({ tone: dc.ns < dp.ns ? "good" : dc.ns > dp.ns ? "bad" : "flat", big: String(dc.ns), text: `no-show${dc.ns === 1 ? "" : "s"} ${label} (${dp.ns} before). ${dc.ns ? "Send a same-day reminder before each demo." : ""}`.trim() });
  return out.slice(0, 6);
}

const INSIGHT_CAP = 2;
function Insights({ items, all, onToggle }: { items: Insight[]; all: boolean; onToggle: () => void }) {
  if (!items.length) return null;
  const shown = all ? items : items.slice(0, INSIGHT_CAP);
  return (
    <section className="insights" aria-label="What the numbers say">
      {shown.map((it, i) => (
        <article className={"insight t-" + it.tone} key={i}>
          <span className="ins-ic" aria-hidden="true">{it.tone === "good" ? "↗" : it.tone === "bad" ? "↘" : it.tone === "act" ? "→" : "≈"}</span>
          <p>
            <b>{it.big}</b> {it.text}
          </p>
          {it.go ? (
            <button className="linkbtn" onClick={it.go.run}>
              {it.go.label}
            </button>
          ) : null}
        </article>
      ))}
      {items.length > INSIGHT_CAP ? (
        <button type="button" className="btn ghost small" onClick={onToggle}>
          {all ? "Show fewer" : `Show ${items.length - INSIGHT_CAP} more`}
        </button>
      ) : null}
    </section>
  );
}

/** Where every visible account sits in the pipeline right now, as one segmented bar. */
function StageMix({ accts }: { accts: ReturnType<typeof accountRows> }) {
  const n = accts.length || 1;
  const counts = STAGE_NAMES.map((_, i) => accts.filter((a) => a.stage === i).length);
  const moved = accts.filter((a) => a.stage > 0 && a.stage < 5).length;
  return (
    <section className="card pad stagemix">
      <div className="section-head">
        <h2>Pipeline right now</h2>
        <span className="note">
          {accts.length} accounts · {pct(moved, accts.length)}% past Not approved
        </span>
      </div>
      <div className="sm-bar" role="img" aria-label={STAGE_NAMES.map((s, i) => `${s}: ${counts[i]}`).join(", ")}>
        {counts.map((c, i) =>
          c ? <span key={i} className={"sm-seg s" + i} style={{ flexGrow: c, minWidth: 6 }} data-tip={`${STAGE_NAMES[i]}: ${c} (${pct(c, n)}%)`} /> : null
        )}
      </div>
      <ul className="sm-legend">
        {STAGE_NAMES.map((s, i) => (
          <li key={s}>
            <i className={"s" + i} aria-hidden="true" />
            <span>{s}</span>
            <b>{counts[i]}</b>
          </li>
        ))}
      </ul>
    </section>
  );
}

function lsDetail() {
  try {
    return localStorage.getItem("roster.dashDetail") === "1";
  } catch (_) {
    return false;
  }
}

export default function DashboardTab() {
  const X = useX();
  const { metrics, DM, DL, DC, DJ, DCB } = makeMetrics(X);
  const P = periodPreds(X.S.f.period, X.S.f.dFrom, X.S.f.dTo),
    dc = metrics(P.dcur),
    dp = metrics(P.dprev);
  const tg = ["Demand Gen", "Growth", "Digital & Performance", "General marketing"];
  const accts = accountRows(X);
  const insights = buildInsights(X, dc, dp, P.label, accts, tg.map((t) => [t, metrics(P.dcur, (l) => titleGroup(l.title), t).booked]));
  const today = dayKey(new Date());
  // Charts and breakdown are one click away and remembered, so the first view stays short.
  const detail = X.S.forms["dash-detail"] === undefined ? lsDetail() : !!X.S.forms["dash-detail"];
  const toggleDetail = () => {
    X.S.forms["dash-detail"] = !detail;
    try {
      localStorage.setItem("roster.dashDetail", detail ? "0" : "1");
    } catch (_) {}
    X.rerender();
  };
  const setP = (v: string) => {
    X.S.f.period = v;
    if (v === "custom" && !X.S.f.dFrom) {
      X.S.f.dFrom = dayKey(new Date(Date.now() - 13 * DAY));
      X.S.f.dTo = today;
    }
    X.rerender();
  };
  const setD = (k: "dFrom" | "dTo", v: string) => {
    X.S.f[k] = v;
    X.rerender();
  };
  return (
    <div className="section dash">
      <div className="controls">
        <div className="seg" role="group" aria-label="Period">
          {[
            ["7", "7 days"],
            ["30", "30 days"],
            ["90", "90 days"],
            ["all", "All time"],
            ["custom", "Custom"],
          ].map(([v, l]) => (
            <button key={v} aria-pressed={X.S.f.period === v} onClick={() => setP(v)}>
              {l}
            </button>
          ))}
        </div>
        {X.S.f.period === "custom" ? (
          <span className="range-custom">
            <DateTimeField id="d-from" mode="date" label="From" clearable value={X.S.f.dFrom} max={X.S.f.dTo || today} onChange={(v) => setD("dFrom", v)} />
            <span className="muted">to</span>
            <DateTimeField id="d-to" mode="date" label="To" clearable value={X.S.f.dTo} min={X.S.f.dFrom || undefined} max={today} onChange={(v) => setD("dTo", v)} />
          </span>
        ) : null}
        {seeAllWork(X) ? (
          <>
            <label className="note" htmlFor="f-rep">Rep</label>
            <select
              id="f-rep"
              value={X.S.f2.rep}
              onChange={(e) => {
                X.S.f2.rep = e.target.value;
                X.rerender();
              }}
            >
              <option value="all">Everyone</option>
              {X.D.profiles
                .filter((u) => u.status === "active")
                .map((u) => (
                  <option key={u.id} value={u.id}>
                    {pname(X, u.id)}
                  </option>
                ))}
            </select>
          </>
        ) : (
          <span className="note">Showing your own activity.</span>
        )}
        <span className="note">Dials are every logged call; connects are dials that weren't "did not pick up".</span>
      </div>
      <section className="dash-headline" aria-label="Summary">
        <p>
          <b>{plural(dc.calls, "call")}</b>, <b>{dc.conn} connected</b>. {dc.booked ? <b>{plural(dc.booked, "demo")} booked.</b> : <span className="muted">No demos booked yet.</span>}
        </p>
      </section>
      <Insights items={insights} all={!!X.S.forms["dash-ins"]} onToggle={() => { X.S.forms["dash-ins"] = !X.S.forms["dash-ins"]; X.rerender(); }} />
      <div className="dash-detail-bar">
        <button type="button" className="btn ghost small" aria-expanded={detail} onClick={toggleDetail}>
          {detail ? "Hide charts and breakdown" : "Show charts and breakdown"}
        </button>
      </div>
      {detail ? (
        <>
          <SdrOverview X={X} DL={DL} DC={DC} DM={DM} DJ={DJ} DCB={DCB} N={P.N} end={P.end} span={P.span} showReps={seeAllWork(X) && X.S.f2.rep === "all"} />
          <StageMix accts={accts} />
        </>
      ) : null}
    </div>
  );
}
