import type { ReactNode } from "react";
import type { Ctx } from "../lib/ctx";
import type { Row } from "../lib/data";
import { coName, DAY, dayKey, fmtWhen, tms } from "../lib/format";
import { pname } from "../lib/perms";

/* The SDR overview: headline numbers with their trend and change, daily activity against the previous period, the
   conversion path, rep standings, top-tier coverage and what is due next. Brand palette and type throughout. */

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
const keysFor = (n: number, end: number) => Array.from({ length: n }, (_, i) => dayKey(new Date(end - (n - 1 - i) * DAY)));
function perDay(times: number[], keys: string[]): number[] {
  const idx = new Map(keys.map((k, i) => [k, i]));
  const out = keys.map(() => 0);
  for (const t of times) {
    if (isNaN(t)) continue;
    const i = idx.get(dayKey(new Date(t)));
    if (i !== undefined) out[i]++;
  }
  return out;
}

/**
 * Dials and connects. Every logged outcome is a dial; a connect is a dial that wasn't "did not pick up". A connected-call
 * note with no outcome logged for that contact the same day counts as both, so reps who only log context aren't lost.
 */
export function dialsAndConnects(DC: Row[], DJ: Row[]) {
  const sameDay = new Set(DC.map((c) => c.lead_id + "|" + dayKey(new Date(tms(c.at) || 0))));
  const extra = DJ.filter((j) => !isNaN(tms(j.at)) && !sameDay.has(j.lead_id + "|" + dayKey(new Date(tms(j.at)))));
  const dials = [...DC, ...extra];
  const connects = [...DC.filter((c) => c.outcome !== "dnp"), ...extra];
  return { dials, connects };
}

/** Accounts won (first demo done) and lost (closed lost / cold), with when it happened. */
export function winLoss(DL: Row[], DM: Row[]) {
  const acct = new Map<string, Row[]>();
  for (const l of DL) {
    const k = coName(l.company).toLowerCase();
    if (!acct.has(k)) acct.set(k, []);
    acct.get(k)!.push(l);
  }
  const wins: number[] = [],
    losses: number[] = [];
  for (const ls of acct.values()) {
    const ids = new Set(ls.map((l) => l.id));
    const lost = ls.find((l) => l.lost_at);
    if (lost) {
      losses.push(tms(lost.lost_at));
      continue;
    }
    const first = DM.filter((m) => ids.has(m.lead_id) && m.status === "done")
      .map((m) => {
        const h = (Array.isArray(m.history) ? m.history : []).filter((x: Row) => x.event === "done").slice(-1)[0];
        const t = tms(m.done_at);
        return !isNaN(t) ? t : !isNaN(tms(h && h.at)) ? tms(h.at) : tms(m.when);
      })
      .filter((t) => !isNaN(t))
      .sort((a, b) => a - b)[0];
    if (first !== undefined) wins.push(first);
  }
  return { wins, losses };
}

/**
 * A smooth SVG path through the points (monotone cubic, so the curve never overshoots below zero or above a peak).
 */
export function smoothPath(pts: Array<[number, number]>): string {
  const n = pts.length;
  if (!n) return "";
  if (n < 3) return pts.map(([x, y], i) => `${i ? "L" : "M"}${x},${y}`).join(" ");
  const dx = pts.slice(1).map((p, i) => p[0] - pts[i][0]);
  const m = pts.slice(1).map((p, i) => (p[1] - pts[i][1]) / (dx[i] || 1));
  const t: number[] = [m[0]];
  for (let i = 1; i < n - 1; i++) t.push(m[i - 1] * m[i] <= 0 ? 0 : (3 * (dx[i - 1] + dx[i])) / ((2 * dx[i] + dx[i - 1]) / m[i - 1] + (dx[i] + 2 * dx[i - 1]) / m[i]));
  t.push(m[n - 2]);
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += ` C${pts[i][0] + h},${pts[i][1] + h * t[i]} ${pts[i + 1][0] - h},${pts[i + 1][1] - h * t[i + 1]} ${pts[i + 1][0]},${pts[i + 1][1]}`;
  }
  return d;
}

function Change({ cur, prev, pts = false, lower = false, label }: { cur: number; prev: number; pts?: boolean; lower?: boolean; label: string }) {
  const d = cur - prev;
  if (!d) return <span className="ov-chg flat">no change {label}</span>;
  const good = lower ? d < 0 : d > 0;
  const rel = !pts && prev ? ` (${d > 0 ? "+" : ""}${Math.round((d / prev) * 100)}%)` : "";
  return (
    <span className={"ov-chg " + (good ? "good" : "bad")}>
      {d > 0 ? "▲" : "▼"} {Math.abs(d)}
      {pts ? " pts" : ""}
      {rel} <em>{label}</em>
    </span>
  );
}

/** Rounded mini bars for a headline card: one bar per day (or per few days), the latest ones brightest. */
function Trend({ cur, tone = "accent", unit }: { cur: number[]; prev?: number[]; tone?: "accent" | "green" | "gold"; unit: string }) {
  // Group days so a 30-day period still reads as ~10 bars.
  const size = Math.max(1, Math.ceil(cur.length / 10));
  const bars: number[] = [];
  for (let i = 0; i < cur.length; i += size) bars.push(cur.slice(i, i + size).reduce((a, b) => a + b, 0));
  const max = Math.max(1, ...bars);
  return (
    <div className={"ov-bars t-" + tone} aria-hidden="true">
      {bars.map((v, i) => (
        <span
          key={i}
          className={i >= bars.length - 2 ? "hot" : ""}
          style={{ height: `${12 + (v / max) * 88}%`, animationDelay: i * 25 + "ms" }}
          data-tip={`${v} ${unit}${size > 1 ? ` in ${size} days` : ""}`}
        />
      ))}
    </div>
  );
}

/** A half dial with an 80% target band. */
function Dial({ value }: { value: number | null }) {
  const R = 40,
    cx = 50,
    cy = 48;
  const pt = (p: number) => {
    const a = Math.PI * (1 - p / 100);
    return [cx + R * Math.cos(a), cy - R * Math.sin(a)];
  };
  const arc = (a: number, b: number) => {
    const [x1, y1] = pt(a),
      [x2, y2] = pt(b);
    return `M ${x1} ${y1} A ${R} ${R} 0 0 1 ${x2} ${y2}`;
  };
  return (
    <svg className="ov-dial" viewBox="0 0 100 56" aria-hidden="true">
      <path d={arc(0, 100)} className="track" />
      <path d={arc(80, 100)} className="target" />
      {value ? <path d={arc(0, Math.min(100, value))} className="val" /> : null}
    </svg>
  );
}

function Kpi({ label, value, unit, foot, children, trend }: { label: string; value: ReactNode; unit?: string; foot: ReactNode; children?: ReactNode; trend?: ReactNode }) {
  return (
    <article className="ov-kpi">
      <h3>{label}</h3>
      <div className="ov-num">
        {value}
        {unit ? <small>{unit}</small> : null}
      </div>
      {foot}
      {children}
      {trend}
    </article>
  );
}

function Lines({ series, labels, dates, gid = "ov-area", cls = "" }: { series: Array<{ name: string; cls: string; vals: number[]; area?: boolean; peak?: boolean }>; labels: string[]; dates: string[]; gid?: string; cls?: string }) {
  const W = 640,
    H = 220,
    padL = 26,
    padB = 22,
    padT = 26;
  const n = Math.max(2, ...series.map((s) => s.vals.length));
  const max = Math.max(1, ...series.flatMap((s) => s.vals));
  const top = max <= 4 ? 4 : Math.ceil((max * 1.15) / 4) * 4;
  const x = (i: number) => padL + (i / (n - 1)) * (W - padL - 10);
  const y = (v: number) => padT + (1 - v / top) * (H - padT - padB);
  const base = y(0);
  return (
    <svg className={"ov-lines " + cls} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={series.map((s) => `${s.name}: ${s.vals.reduce((a, b) => a + b, 0)}`).join(", ")}>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" className="ga-top" />
          <stop offset="100%" className="ga-bot" />
        </linearGradient>
      </defs>
      {[0, 0.5, 1].map((f) => (
        <g key={f}>
          <line x1={padL} x2={W - 10} y1={y(top * f)} y2={y(top * f)} className="gl" />
          <text x={padL - 8} y={y(top * f) + 3} textAnchor="end" className="ax">
            {Math.round(top * f)}
          </text>
        </g>
      ))}
      {labels.map((l, i) =>
        l ? (
          <text key={i} x={x(i)} y={H - 4} textAnchor="middle" className="ax">
            {l}
          </text>
        ) : null
      )}
      {series.map((s) => {
        const pts = s.vals.map((v, i) => [x(i), y(v)] as [number, number]);
        const d = smoothPath(pts);
        const pk = s.peak ? s.vals.indexOf(Math.max(...s.vals)) : -1;
        return (
          <g key={s.name} className={"sr " + s.cls}>
            {s.area ? <path className="area" d={`${d} L${pts[pts.length - 1][0]},${base} L${pts[0][0]},${base} Z`} fill={`url(#${gid})`} /> : null}
            <path className="ln" d={d} />
            {s.cls === "win" || s.cls === "loss" ? <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r="4" className="end-dot" /> : null}
            {pk >= 0 && s.vals[pk] > 0 ? (
              <g className="peak">
                <line x1={pts[pk][0]} x2={pts[pk][0]} y1={pts[pk][1]} y2={base} className="pk-line" />
                <circle cx={pts[pk][0]} cy={pts[pk][1]} r="5.5" className="pk-dot" />
                <g transform={`translate(${Math.min(Math.max(pts[pk][0], padL + 46), W - 56)},${Math.max(pts[pk][1] - 14, 12)})`}>
                  <rect x="-46" y="-11" width="92" height="20" rx="6" className="pk-tag" />
                  <text textAnchor="middle" y="3" className="pk-txt">
                    Peak: {s.vals[pk]} {s.name.toLowerCase()}
                  </text>
                </g>
              </g>
            ) : null}
            {pts.map((p, i) => (
              <circle key={i} cx={p[0]} cy={p[1]} r="9" className="hit" data-tip={`${dates[i]}: ${s.vals[i]} ${s.name.toLowerCase()}`} />
            ))}
          </g>
        );
      })}
    </svg>
  );
}

export default function SdrOverview({ X, DL, DC, DM, DJ, DCB, N, end, span, showReps }: { X: Ctx; DL: Row[]; DC: Row[]; DM: Row[]; DJ: Row[]; DCB: Row[]; N: number; end: number; span: string; showReps: boolean }) {
  const now = Date.now();
  const inCur = (t: number) => !isNaN(t) && t > end - N * DAY && t <= end;
  const inPrev = (t: number) => !isNaN(t) && t > end - 2 * N * DAY && t <= end - N * DAY;
  const cur = keysFor(N, end),
    prev = keysFor(N, end - N * DAY);
  const step = N > 120 ? 30 : N > 45 ? 14 : N > 14 ? 7 : 2;
  const labels = cur.map((k, i) => ((N - 1 - i) % step === 0 ? (N > 45 ? new Date(k + "T00:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : String(+k.slice(8))) : ""));

  const { dials, connects } = dialsAndConnects(DC, DJ);
  const callT = dials.map((c) => tms(c.at));
  const connT = connects.map((j) => tms(j.at));
  const dnp = DC.filter((c) => c.outcome === "dnp" && inCur(tms(c.at))).length;
  const bookT = DM.map((m) => tms(m.created_at));
  const doneT = DM.filter((m) => m.status === "done").map((m) => tms(m.done_at || m.when));
  const nsT = DM.flatMap((m) => (Array.isArray(m.history) ? m.history : []).filter((h: Row) => h.event === "no_show").map((h: Row) => tms(h.at)));
  const count = (ts: number[], f: (t: number) => boolean) => ts.filter(f).length;

  const calls = count(callT, inCur),
    callsP = count(callT, inPrev);
  const conn = count(connT, inCur),
    connP = count(connT, inPrev);
  const booked = count(bookT, inCur),
    bookedP = count(bookT, inPrev);
  const done = count(doneT, inCur),
    doneP = count(doneT, inPrev);
  const ns = count(nsT, inCur),
    nsP = count(nsT, inPrev);
  const connRate = pct(conn, calls),
    connRateP = pct(connP, callsP);
  const show = done + ns ? pct(done, done + ns) : null,
    showP = doneP + nsP ? pct(doneP, doneP + nsP) : null;

  const callsDay = perDay(callT, cur),
    callsDayP = perDay(callT, prev),
    connDay = perDay(connT, cur),
    bookDay = perDay(bookT, cur);

  // Conversion path for the period: each step counts people, not events.
  const people = (rows: Row[]) => new Set(rows.map((r) => r.lead_id).filter(Boolean)).size;
  const path: Array<[string, number]> = [
    ["Contacts added", DL.filter((l) => inCur(tms(l.created_at))).length],
    ["Approved", DL.filter((l) => inCur(tms(l.approved_at))).length],
    ["Called", people(dials.filter((c) => inCur(tms(c.at))))],
    ["Connected", people(connects.filter((j) => inCur(tms(j.at))))],
    ["Demo booked", booked],
    ["Demo done", done],
  ];
  const pathMax = Math.max(1, ...path.map((p) => p[1]));

  // Rep standings for the period.
  const reps = showReps
    ? X.D.profiles
        .filter((u) => u.status === "active")
        .map((u) => {
          const mine = (r: Row) => r.owner === u.id;
          return {
            id: u.id,
            name: pname(X, u.id),
            c: dials.filter((x) => mine(x) && inCur(tms(x.at))).length,
            j: connects.filter((x) => mine(x) && inCur(tms(x.at))).length,
            b: DM.filter((x) => mine(x) && inCur(tms(x.created_at))).length,
            d: DM.filter((x) => mine(x) && x.status === "done" && inCur(tms(x.done_at || x.when))).length,
            open: DL.filter((l) => l.assigned_to === u.id && l.approved).length,
          };
        })
        .filter((r) => r.c || r.b || r.open)
        .sort((a, b) => b.b - a.b || b.c - a.c)
    : [];

  // Top-tier coverage: accounts with at least one call, by best tier.
  const acct = new Map<string, { tier: string; called: boolean }>();
  const calledLeads = new Set(DC.map((c) => c.lead_id));
  for (const l of DL) {
    const k = coName(l.company).toLowerCase();
    const t = l.tier || "U";
    const was = acct.get(k);
    const best = !was || "SABCXU".indexOf(t) < "SABCXU".indexOf(was.tier) ? t : was.tier;
    acct.set(k, { tier: best, called: (was?.called ?? false) || calledLeads.has(l.id) });
  }
  const tiers = ["S", "A", "B", "C"]
    .map((t) => {
      const all = [...acct.values()].filter((a) => a.tier === t);
      return { t, n: all.length, c: all.filter((a) => a.called).length };
    })
    .filter((r) => r.n);
  const top = tiers.filter((r) => "SA".includes(r.t));
  const topN = top.reduce((s, r) => s + r.n, 0),
    topC = top.reduce((s, r) => s + r.c, 0);

  // Due in the next 48 hours.
  const soon = [
    ...DCB.filter((c) => c.status === "open").map((c) => ({ t: tms(c.when), kind: "Callback", who: c.contact, co: c.company, owner: c.owner })),
    ...DM.filter((m) => m.status === "scheduled").map((m) => ({ t: tms(m.when), kind: "Demo", who: m.contact, co: m.company, owner: m.owner })),
  ]
    .filter((x) => !isNaN(x.t) && x.t >= now - 2 * 3600e3 && x.t <= now + 2 * DAY)
    .sort((a, b) => a.t - b.t)
    .slice(0, 6);

  // Win / loss: cumulative over the period, so both lines only grow.
  const wl = winLoss(DL, DM);
  const wDay = perDay(wl.wins, cur),
    lDay = perDay(wl.losses, cur);
  const cum = (a: number[]) => a.reduce<number[]>((o, v, i) => (o.push((i ? o[i - 1] : 0) + v), o), []);
  const wCum = cum(wDay),
    lCum = cum(lDay);
  const W = wCum[wCum.length - 1] || 0,
    L = lCum[lCum.length - 1] || 0;
  const Wall = wl.wins.length,
    Lall = wl.losses.length;
  const ratio = (w: number, l: number) => (l ? (w / l).toFixed(1).replace(/\.0$/, "") + " : 1" : w ? `${w} : 0` : "–");

  const per = `vs previous ${N} days`;
  return (
    <section className="ov" aria-label="SDR overview">
      <div className="ov-kpis">
        <Kpi label="Dials" value={calls} foot={<Change cur={calls} prev={callsP} label={per} />} trend={<Trend cur={callsDay} unit="calls" />} />
        <Kpi
          label="Connect rate"
          value={calls ? connRate : "–"}
          unit={calls ? "%" : ""}
          foot={calls ? <Change cur={connRate} prev={connRateP} pts label={per} /> : <span className="ov-chg flat">no calls yet</span>}
          trend={<Trend cur={connDay} tone="green" unit="connects" />}
        >
          <span className="ov-sub">
            {conn} connected of {calls} dials{dnp ? ` · ${dnp} DNP` : ""}
          </span>
        </Kpi>
        <Kpi label="Demos booked" value={booked} foot={<Change cur={booked} prev={bookedP} label={per} />} trend={<Trend cur={bookDay} tone="gold" unit="demos booked" />}>
          <span className="ov-sub">{calls ? `${pct(booked, calls)}% of calls booked a demo` : " "}</span>
        </Kpi>
        <Kpi
          label="Show rate"
          value={show === null ? "–" : show}
          unit={show === null ? "" : "%"}
          foot={
            show !== null && showP !== null ? (
              <Change cur={show} prev={showP} pts label={per} />
            ) : (
              <span className="ov-chg flat">
                {done} done · {ns} no-show{ns === 1 ? "" : "s"}
              </span>
            )
          }
        >
          <Dial value={show} />
        </Kpi>
      </div>

      <div className="ov-row">
        <article className="ov-card ov-activity">
          <header>
            <h3>Daily activity</h3>
            <span className="ov-legend">
              <span><i className="calls" /> Dials</span>
              <span><i className="conn" /> Connects</span>
              <span><i className="prev" /> Dials, previous {N} days</span>
            </span>
          </header>
          <Lines
            labels={labels}
            dates={cur.map((k) => new Date(k + "T00:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short" }))}
            series={[
              { name: "Dials last period", cls: "prev", vals: callsDayP },
              { name: "Dials", cls: "calls", vals: callsDay, area: true, peak: true },
              { name: "Connects", cls: "conn", vals: connDay },
            ]}
          />
        </article>
        <article className="ov-card ov-path">
          <header>
            <h3>Conversion path</h3>
            <span className="note">{span}</span>
          </header>
          <ol>
            {path.map(([name, v], i) => (
              <li key={name}>
                <span className="p-name">{name}</span>
                <span className="p-bar">
                  <span style={{ width: `${v ? Math.max(3, (v / pathMax) * 100) : 0}%` }} />
                </span>
                <b>{v}</b>
                <span className="p-rate">{i && path[i - 1][1] ? `${pct(v, path[i - 1][1])}%` : ""}</span>
              </li>
            ))}
          </ol>
        </article>
      </div>

      <div className="ov-row ov-wl-row">
        <article className="ov-card ov-wl">
          <header>
            <h3>Win / loss</h3>
            <span className="ov-legend">
              <span><i className="win" /> Won (demo done)</span>
              <span><i className="loss" /> Closed lost / Cold</span>
            </span>
          </header>
          <Lines
            gid="ov-wl-area"
            cls="wl"
            labels={labels}
            dates={cur.map((k) => new Date(k + "T00:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short" }))}
            series={[
              { name: "Lost so far", cls: "loss", vals: lCum },
              { name: "Won so far", cls: "win", vals: wCum, area: true },
            ]}
          />
        </article>
        <article className="ov-card ov-wl-sum">
          <header>
            <h3>Win / loss ratio</h3>
            <span className="note">{span}</span>
          </header>
          <div className="ov-num">{ratio(W, L)}</div>
          <span className="ov-sub">
            {W} won · {L} lost{W + L ? ` · ${pct(W, W + L)}% win rate` : ""}
          </span>
          <div className="wl-bar" role="img" aria-label={`${W} won, ${L} lost`}>
            {W + L ? (
              <>
                <span className="w" style={{ flexGrow: W }} />
                <span className="l" style={{ flexGrow: L }} />
              </>
            ) : null}
          </div>
          <dl className="wl-all">
            <div>
              <dt>All time</dt>
              <dd>
                {ratio(Wall, Lall)} <span className="muted">({Wall} won · {Lall} lost)</span>
              </dd>
            </div>
            <div>
              <dt>Loss rate</dt>
              <dd>{Wall + Lall ? pct(Lall, Wall + Lall) + "%" : "–"} of decided accounts</dd>
            </div>
          </dl>
        </article>
      </div>

      <div className={"ov-row ov-row3" + (showReps ? "" : " no-reps")}>
        {showReps ? (
          <article className="ov-card ov-reps">
            <header>
              <h3>Reps</h3>
              <span className="note">{span}</span>
            </header>
            {reps.length ? (
              <table>
                <thead>
                  <tr>
                    <th>Rep</th>
                    <th className="n">Dials</th>
                    <th className="n">Connects</th>
                    <th className="n">Demos</th>
                    <th className="n">Done</th>
                    <th className="n" title="Approved contacts assigned to them">Approved</th>
                  </tr>
                </thead>
                <tbody>
                  {reps.map((r, i) => (
                    <tr key={r.id}>
                      <td>
                        <span className={"ov-rank" + (i === 0 && r.b ? " top" : "")}>{i + 1}</span> {r.name}
                      </td>
                      <td className="n">{r.c}</td>
                      <td className="n">{r.j}</td>
                      <td className="n"><b>{r.b}</b></td>
                      <td className="n">{r.d}</td>
                      <td className="n">{r.open}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="note">No rep activity in this period.</p>
            )}
          </article>
        ) : null}
        <article className="ov-card ov-cover">
          <header>
            <h3>Top-tier coverage</h3>
          </header>
          <div className="ov-num">
            {topN ? pct(topC, topN) : "–"}
            {topN ? <small>%</small> : null}
          </div>
          <span className="ov-sub">
            of Tier S and A accounts have had a call ({topC} of {topN})
          </span>
          <ul>
            {tiers.map((r) => (
              <li key={r.t}>
                <span className={"tier tier-lbl sm " + r.t}>Tier {r.t}</span>
                <span className="p-bar">
                  <span style={{ width: `${pct(r.c, r.n)}%` }} />
                </span>
                <span className="mono">
                  {r.c}/{r.n}
                </span>
              </li>
            ))}
          </ul>
        </article>
        <article className="ov-card ov-soon">
          <header>
            <h3>Next 48 hours</h3>
            <a className="linkbtn" href="#/tasks">Task Center →</a>
          </header>
          {soon.length ? (
            <ul>
              {soon.map((s, i) => (
                <li key={i}>
                  <span className={"ov-kind " + (s.kind === "Demo" ? "demo" : "cb")}>{s.kind}</span>
                  <span className="ov-who">
                    <b>{s.who}</b> · {coName(s.co)}
                    <span className="ov-when">
                      {fmtWhen(new Date(s.t).toISOString())}
                      {showReps ? ` · ${pname(X, s.owner).split(" ")[0]}` : ""}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="note">Nothing due. Callbacks and demos for the next two days show here.</p>
          )}
        </article>
      </div>
    </section>
  );
}
