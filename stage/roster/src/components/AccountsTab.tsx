import { useEffect, useRef, useState, type ReactNode } from "react";
import DateTimeField from "./DateTimeField";
import GettingStarted from "./GettingStarted";
import { readIcp } from "../lib/icp";
import { emailCheck, providerName, statusWord } from "../lib/email";
import { useX, type Ctx } from "../lib/ctx";
import type { Row } from "../lib/data";
import { coName, dk, fmtDay, fmtEmployees, fmtRange, fmtStamp, fmtTime, fmtWhen, nowISO, plural, RANGES, rangeBounds, splitName } from "../lib/format";
import { assignedTo, can, canActOn, meetingFor, openCallback, pname, visibleLeads } from "../lib/perms";
import { addManualContacts, approveLead, assignLeadsBulk, findMoreIcps, OUTCOME_LABEL, formFor, meetingHappened, setAccountDq, setAccountLost, setLeadDq, callUndoNote, checkGuard, doDelete, editNote, checkFullEnrich, enrichLead, enrichPicked, findPhone, refire, retryCal, syncJourney, upd } from "../lib/actions";
import { supabase } from "../lib/supabase";
import { askDel, DelConfirm, MoreMenu, noDel, outcomeUI } from "./common";
import { accountPriority, PRIORITY_LABEL, priorityRank, type Priority } from "../lib/priority";
import DraftBox from "./DraftBox";
import { smooth } from "../lib/motion";

const tierRank = (t: string) => ({ S: 0, A: 1, B: 2, C: 3, X: 4 } as Record<string, number>)[t] ?? 5;
const TIER_TIP: Record<string, string> = {
  S: "Tier S: a company you added that passed research.",
  A: "Tier A: strongest fit, signals confirmed.",
  B: "Tier B: good fit, some gaps.",
  C: "Tier C: weaker or unconfirmed fit.",
  X: "Tier X: a company you added that did not pass research.",
};
const tierTip = (t: string) =>
  (TIER_TIP[t] || "No tier yet.") + " Tiers: S = added by you and qualified, A = strongest fit, B = good fit with gaps, C = weaker fit, X = added by you, not qualified.";
function TierBadge({ t, small }: { t: string; small?: boolean }) {
  const k = t || "U";
  return (
    <span className={"tier tier-lbl " + k + (small ? " sm" : "")} title={tierTip(k)}>
      {k === "U" ? "No tier" : "Tier " + k}
    </span>
  );
}
/** "Ratandeep Gu***a" -> "Ratandeep G."; full names pass through. */
function shortName(name: string) {
  const sn = splitName(name);
  if (!sn.masked) return String(name || "");
  const rawLast = String(name || "").replace(/\s*\(.*?\)/g, "").trim().split(/\s+/).slice(1).join(" ");
  const ini = rawLast.replace(/\*/g, "").charAt(0).toUpperCase();
  return sn.first + (ini ? " " + ini + "." : "");
}
function DisplayName({ name }: { name: string }) {
  if (!splitName(name).masked) return <strong>{name}</strong>;
  return (
    <>
      <strong title="Full name after enrichment">{shortName(name)}</strong>{" "}
      <span className="hint">Full name after enrichment</span>
    </>
  );
}
const initials = (n: string) =>
  String(n || "")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
const srcName = (s: string) => (/full/i.test(String(s || "")) ? "FullEnrich" : s ? "Apollo" : "");

/** Every email the providers returned, the best first, each with where it came from and how trustworthy it is. */
function emailRows(e: any): Array<{ email: string; source: string; status: string }> {
  if (!e) return [];
  const rows = [
    { email: e.email, source: providerName(e.source), status: e.email_status },
    { email: e.apollo_email, source: "Apollo", status: e.apollo_status },
    { email: e.fe_email, source: "FullEnrich", status: e.fe_email_status },
  ].filter((r) => r.email);
  const seen = new Set<string>();
  return rows.filter((r) => {
    const k = String(r.email).toLowerCase() + "|" + r.source;
    if (seen.has(k) || (r !== rows[0] && String(r.email).toLowerCase() === String(rows[0].email).toLowerCase() && r.source === rows[0].source)) return false;
    seen.add(k);
    return true;
  });
}

/** The day a contact belongs to on the roster: its batch's Monday, the day it was added by hand, or when it landed. */
export function rosterDay(l: Row): string {
  const m = /(\d{4}-\d{2}-\d{2})/.exec(String(l.batch || ""));
  return m ? m[1] : dk(l.created_at);
}
function filteredLeads(X: Ctx) {
  const f = X.S.f,
    q = f.q.toLowerCase();
  return visibleLeads(X)
    // A disqualified company only shows under the Disqualified filter; a disqualified contact stays with its account.
    .filter((l) => (f.appr === "dq" ? !!l.dq_at : l.dq_scope !== "company"))
    .filter((l) => f.appr !== "mine" || assignedTo(l) === X.uid)
    .filter((l) => f.appr !== "unassigned" || !assignedTo(l))
    .filter((l) => {
      const b = rangeBounds(f.range, f.from, f.to);
      if (!b) return true;
      const d = rosterDay(l);
      return !!d && d >= b[0] && d <= b[1];
    })
    .filter((l) => !f.tiers.length || f.tiers.includes(l.tier || "U"))
    .filter((l) => f.scope === "all" || l.title_scope === f.scope)
    .filter(
      (l) =>
        f.appr === "all" ||
        f.appr === "dq" ||
        f.appr === "mine" ||
        f.appr === "unassigned" ||
        (f.appr === "approved" ? l.approved : f.appr === "pending" ? !l.approved : f.appr === "callback" ? !!openCallback(X, l.id) : !!meetingFor(X, l.id))
    )
    .filter((l) => !q || [l.name, l.company, l.title, l.angle, l.segment].join(" ").toLowerCase().includes(q));
}
function PainList({ p }: { p: any }) {
  const arr = Array.isArray(p) ? p : [];
  if (!arr.length) return <li>None found</li>;
  return (
    <>
      {arr.map((x: any, i: number) => (
        <li key={i}>
          {x.detail} <span className={"tag " + (x.label || "")}>{x.label}</span>
          {x.source ? (
            <>
              {" "}
              <a href={x.source} target="_blank" rel="noopener">source</a>
            </>
          ) : null}
        </li>
      ))}
    </>
  );
}
/** Enrichment state for one contact: email and phone (each shown when found), progress, and what to do next. */
function EnrichState({ X, l, act }: { X: Ctx; l: Row; act: boolean }) {
  const e: any = l.enrichment || null;
  const busy = X.S.busy.has("enrich:" + l.id);
  const waiting = !!e && e.status === "enriching";
  // A run that has gone quiet (the cloud task stopped, or FullEnrich is slow) offers a way forward instead of spinning forever.
  const quiet = waiting && Date.now() - Date.parse(e.at || "") > 3 * 60_000;
  if (busy || (waiting && !quiet))
    return <span className="enrich muted">{e && e.fe_id ? "Enriching with FullEnrich…" : "Enriching…"}</span>;
  if (waiting && quiet)
    return (
      <span className="enrich">
        <span className="muted">Still waiting on {e.fe_id ? "FullEnrich" : "enrichment"}</span>{" "}
        {act ? (
          <button className="btn ghost small" onClick={() => (e.fe_id ? checkFullEnrich(X, l.id) : enrichLead(X, l.id, true))}>
            {e.fe_id ? "Check FullEnrich" : "Retry"}
          </button>
        ) : null}
      </span>
    );
  const hasEmail = !!(e && e.email && e.status !== "failed");
  const hasPhone = !!(e && e.phone);
  // The phone waterfall in progress: Apollo first, FullEnrich only if Apollo has no number.
  const phoneStep =
    !hasPhone && e && e.phone_stage === "apollo" ? (
      <span className="muted">
        {" "}· Phone: asking Apollo…
        {act && Date.now() - Date.parse(e.phone_requested_at || "") > 15 * 60_000 ? (
          <>
            {" "}
            <button className="btn ghost small" onClick={() => checkFullEnrich(X, l.id)}>Try FullEnrich</button>
          </>
        ) : null}
      </span>
    ) : !hasPhone && e && e.phone_stage === "fullenrich" ? (
      <span className="muted"> · Phone: Apollo had none, trying FullEnrich…</span>
    ) : !hasPhone && e && e.phone_stage === "none" ? (
      <span className="hint"> · No phone: {e.phone_error || "neither Apollo nor FullEnrich found one"}</span>
    ) : null;
  if (hasEmail || hasPhone)
    return (
      <span className="enrich">
        {hasEmail ? (
          emailRows(e).map((r, i) => (
            <span key={r.source + r.email}>
              {i ? <br /> : null}
              <a href={"mailto:" + r.email}>{r.email}</a>
              <span className="muted"> · {r.source} · {statusWord(r.status)}</span>
            </span>
          ))
        ) : <span className="muted">No email found</span>}
        {hasPhone ? (
          <>
            <br />
            <a href={"tel:" + String(e.phone).replace(/[^\d+]/g, "")}>{e.phone}</a>
            <span className="muted"> · from {srcName(e.phone_source || "FullEnrich")}{e.phone_type ? ` · ${e.phone_type.replace(/_/g, " ")}` : ""}</span>
          </>
        ) : null}
        {!hasEmail && e.fe_error ? <span className="hint"> ({e.fe_error})</span> : null}{" "}
        {act && !hasEmail ? (
          <button className="btn ghost small" title="Tries again. Uses about 1 Apollo credit." onClick={() => enrichLead(X, l.id, true)}>Retry</button>
        ) : null}
        {phoneStep}
        {act && hasEmail && !hasPhone && !phoneStep ? (
          <button className="btn ghost small" title="Asks Apollo first (8 credits, only if it finds a mobile). FullEnrich is tried only if Apollo has no number." onClick={() => findPhone(X, l.id)}>Find phone</button>
        ) : null}
        {act && hasEmail && !hasPhone && e && e.phone_stage === "none" ? (
          <button className="btn ghost small" onClick={() => findPhone(X, l.id)}>Try again</button>
        ) : null}
        {hasEmail && !hasPhone && e.fe_error ? <span className="hint"> ({e.fe_error})</span> : null}
      </span>
    );
  if (e && (e.status === "no email" || e.status === "failed"))
    return (
      <span className="enrich">
        <span className="muted">No email found</span>
        {e.status === "failed" && e.error ? <span className="hint"> ({e.error})</span> : null}
        {e.fe_error ? <span className="hint"> (FullEnrich: {e.fe_error})</span> : null}{" "}
        {act ? (
          <button className="btn ghost small" title="Tries again. Uses about 1 Apollo credit." onClick={() => enrichLead(X, l.id, true)}>
            Retry
          </button>
        ) : null}
      </span>
    );
  if (l.approved)
    return (
      <span className="enrich">
        <span className="muted">No email yet</span>{" "}
        {act ? (
          <button className="btn ghost small" title="Uses about 1 Apollo credit." onClick={() => enrichLead(X, l.id, false)}>
            Find email
          </button>
        ) : null}
      </span>
    );
  return <span className="enrich muted">Approve to find a work email</span>;
}
/** Every contact shows LinkedIn the same way: the profile, or (while it is being found) a ready-made LinkedIn search. */
function LinkedInLine({ l }: { l: Row }) {
  const url = String(l.linkedin || "");
  if (url) {
    const href = url.startsWith("http") ? url : "https://" + url;
    const handle = href.replace(/^https?:\/\/(www\.)?linkedin\.com\/in\//, "").replace(/\/$/, "");
    return (
      <div className="small c-li">
        <a href={href} target="_blank" rel="noopener" className="li-link">
          <span className="li-badge" aria-hidden="true">in</span>
          LinkedIn{handle && handle !== href ? <span className="muted"> /{decodeURIComponent(handle)}</span> : null}
        </a>
      </div>
    );
  }
  const q = encodeURIComponent(`${String(l.name || "").replace(/\*+/g, "")} ${coName(l.company)}`.trim());
  return (
    <div className="small c-li">
      <a href={`https://www.linkedin.com/search/results/people/?keywords=${q}`} target="_blank" rel="noopener" className="li-link li-search">
        <span className="li-badge" aria-hidden="true">in</span>
        {l.linkedin_checked_at ? "Profile not found · search LinkedIn" : "Finding profile · search LinkedIn"}
      </a>
    </div>
  );
}
function ContactStatus({ X, l }: { X: Ctx; l: Row }) {
  const cb = openCallback(X, l.id),
    m = meetingFor(X, l.id);
  if (m && m.status === "done") return <span className="pill ok">met {fmtDay(m.when)}</span>;
  if (m && m.status === "rescheduling") return <span className="pill warn">reschedule needed</span>;
  if (m) return <span className="pill ok">meeting {fmtWhen(m.when)}</span>;
  if (cb) return <span className="pill hold">callback {fmtWhen(cb.when)}</span>;
  const cs = X.D.calls.filter((c) => c.lead_id === l.id);
  const n = cs.length,
    dnp = cs.filter((c) => c.outcome === "dnp").length;
  if (!n) return null;
  if (dnp === n) return <span className="pill hold">{dnp === 1 ? "didn't pick up" : `didn't pick up ×${dnp}`}</span>;
  return <span className="pill warn">{n} call{n > 1 ? "s" : ""}, no meeting{dnp ? ` · ${dnp} DNP` : ""}</span>;
}
function HsPill({ X, j }: { X: Ctx; j: Row }) {
  if (j.hs_status === "off") return <span className="pill warn">roster only</span>;
  if (j.hs_status === "synced")
    return (
      <>
        <span className="pill ok">HubSpot {j.hs_target || ""}</span>
        {j.hs_error ? <> <span className="note">{j.hs_error}</span></> : null}
      </>
    );
  if (j.hs_status === "failed")
    return (
      <>
        <span className="pill crit">HubSpot not synced</span> <span className="note err">{j.hs_error || ""}</span>{" "}
        <button
          className="btn ghost small"
          disabled={X.S.busy.has("hs:" + j.id)}
          onClick={() =>
            supabase.from("journeys").update({ hs_status: "syncing", hs_error: "" }).eq("id", j.id).then(() => syncJourney(X, j.id))
          }
        >
          Sync to HubSpot
        </button>
      </>
    );
  return <span className="pill hold">syncing to HubSpot</span>;
}
function JDel({ X, kind, id, note }: { X: Ctx; kind: string; id: string; note: string }) {
  if (!can(X, "delete_records")) return null;
  const k = kind + ":" + id;
  if (X.S.confirmDel === k)
    return (
      <div className="confirm" style={{ marginTop: 4 }}>
        {kind === "call" ? "Undo this call?" : "Delete this call note?"} {note}{" "}
        <button className="btn danger small" onClick={() => doDelete(X, k)}>{kind === "call" ? "Undo call" : "Delete"}</button>
        <button className="btn ghost small" onClick={() => noDel(X)}>Keep</button>
      </div>
    );
  return (
    <MoreMenu label={kind === "call" ? "More actions for this call" : "More actions for this note"}>
      <button className="btn ghost small" onClick={() => askDel(X, k)}>
        {kind === "call" ? "Undo call" : "Delete note"}
      </button>
    </MoreMenu>
  );
}
/** HubSpot email events in the journey: label, pill tone, pill text. */
const EMAIL_EVENT: Record<string, [string, string, string]> = {
  email_sent: ["Email sent", "off", "email"],
  email_open: ["Email opened", "adj", "opened"],
  email_click: ["Link clicked", "adj", "clicked"],
  email_reply: ["Email reply", "ok", "replied"],
};
/** "replied 2 days ago" or "opened 3 h ago" from HubSpot's tracking on the contact; reply wins. */
function emailBadge(l: Row): { text: string; tone: string; title: string } | null {
  const a = l.email_activity || {};
  const ago = (iso: string) => {
    const h = Math.round((Date.now() - Date.parse(iso)) / 3600e3);
    return h < 1 ? "just now" : h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
  };
  if (a.replied) return { text: `replied ${ago(a.replied)}`, tone: "ok", title: `Replied to a sales email ${fmtStamp(a.replied)}` };
  if (a.clicked && Date.now() - Date.parse(a.clicked) < 14 * 864e5) return { text: `clicked ${ago(a.clicked)}`, tone: "adj", title: `Clicked a link ${fmtStamp(a.clicked)}` };
  if (a.opened && Date.now() - Date.parse(a.opened) < 14 * 864e5) return { text: `opened ${ago(a.opened)}`, tone: "adj", title: `Opened a sales email ${fmtStamp(a.opened)}` };
  return null;
}

function Journey({ X, contacts }: { X: Ctx; contacts: Row[] }) {
  const ids = new Set(contacts.map((c) => c.id));
  const ev: Array<{ at: string; ctx?: boolean; key: string; node: ReactNode }> = [];
  X.D.journeys
    .filter((j) => ids.has(j.lead_id))
    .forEach((j) =>
      ev.push({
        at: j.at,
        ctx: true,
        key: "j" + j.id,
        node: (
          <>
            <span className="jt">
              {fmtStamp(j.at)} · {j.kind === "hubspot" ? EMAIL_EVENT[j.stage]?.[0] || "From HubSpot" : "Connected call"} · {shortName(j.contact)}
              {j.stage === "demo" ? " · after demo booked" : ""}
            </span>{" "}
            {j.kind === "hubspot" ? (
              EMAIL_EVENT[j.stage] ? <span className={"pill " + EMAIL_EVENT[j.stage][1]}>{EMAIL_EVENT[j.stage][2]}</span> : <span className="pill off">HubSpot activity</span>
            ) : (
              <HsPill X={X} j={j} />
            )}
            {j.kind === "context" && "noteedit:" + j.id in X.S.forms ? (
              <div className="draft-edit">
                <label className="note" htmlFor={"ne-" + j.id}>Call note</label>
                <textarea
                  id={"ne-" + j.id}
                  style={{ minHeight: 90 }}
                  value={X.S.forms["noteedit:" + j.id]}
                  onChange={(e) => {
                    X.S.forms["noteedit:" + j.id] = e.target.value;
                    X.rerender();
                  }}
                />
                <div className="row draft-actions">
                  <button
                    className="btn ghost small"
                    onClick={() => {
                      delete X.S.forms["noteedit:" + j.id];
                      X.rerender();
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    className="btn small"
                    onClick={async () => {
                      const t = X.S.forms["noteedit:" + j.id];
                      delete X.S.forms["noteedit:" + j.id];
                      X.rerender();
                      await editNote(X, j.id, t);
                    }}
                  >
                    Save
                  </button>
                </div>
              </div>
            ) : (
              <p>{j.text}</p>
            )}
            {j.kind === "context" && !("noteedit:" + j.id in X.S.forms) && (j.owner === X.uid || can(X, "view_all_meetings")) ? (
              <button
                className="btn ghost small"
                onClick={() => {
                  X.S.forms["noteedit:" + j.id] = j.text;
                  X.rerender();
                }}
              >
                Edit note
              </button>
            ) : null}
            {j.kind === "context" ? <DraftBox X={X} j={j} /> : null}
            {j.kind === "hubspot" ? null : (
              <JDel X={X} kind="ctx" id={j.id} note={j.hs_status === "synced" ? "The HubSpot note stays in HubSpot; remove it there if needed." : ""} />
            )}
          </>
        ),
      })
    );
  X.D.calls
    .filter((c) => ids.has(c.lead_id))
    .forEach((c) =>
      ev.push({
        at: c.at,
        key: "c" + c.id,
        node: (
          <>
            <span className="jt">
              {fmtStamp(c.at)} · Call outcome · {shortName(c.contact)}
            </span>
            <p>{c.outcome === "callback" ? "Callback scheduled" : OUTCOME_LABEL[c.outcome] || "No meeting"}</p>
            <JDel X={X} kind="call" id={c.id} note={callUndoNote(X, c)} />
          </>
        ),
      })
    );
  X.D.meetings
    .filter((m) => ids.has(m.lead_id))
    .forEach((m) =>
      (Array.isArray(m.history) ? m.history : []).forEach((h: any, i: number) =>
        ev.push({
          at: h.at,
          key: "m" + m.id + i,
          node: (
            <>
              <span className="jt">
                {fmtStamp(h.at)} · Meeting · {shortName(m.contact)}
              </span>
              <p>
                {h.event === "booked"
                  ? "Booked for " + fmtWhen(h.when)
                  : h.event === "rebooked"
                  ? "Rebooked for " + fmtWhen(h.when)
                  : h.event === "done"
                  ? "Meeting done"
                  : h.event === "canceled"
                  ? "Canceled"
                  : "No-show, moved to reschedule"}
              </p>
            </>
          ),
        })
      )
    );
  ev.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return (
    <div className="journey">
      <div className="section-head">
        <h3 style={{ margin: 0 }}>Deal journey</h3>
        <span className="note">{ev.length ? plural(ev.length, "entry", "entries") : ""}</span>
      </div>
      {ev.length ? (
        <div className="jlist">
          {ev.slice(0, 30).map((e) => (
            <div key={e.key} className={"jitem " + (e.ctx ? "ctx" : "")}>
              {e.node}
            </div>
          ))}
        </div>
      ) : (
        <p className="note">No activity yet. Approve a contact, then use "Log connected call" after a live conversation to start the journey.</p>
      )}
    </div>
  );
}
const FUNCTION_LABEL: Record<string, string> = {
  demand_gen: "Demand gen", growth: "Growth", digital: "Digital", general: "General marketing", other: "Outside the ICP function",
};

/** The researcher's person fit check: what was verified beyond Apollo's title and location filters. */
function PersonCheck({ pc }: { pc: any }) {
  if (!pc) return null;
  const verdict = pc.verdict === "fit" ? <span className="pill ok">fit</span> : pc.verdict === "partial" ? <span className="pill warn">partial</span> : <span className="pill crit">no fit</span>;
  return (
    <div>
      <h3>Person check {verdict}</h3>
      <p>
        India: {pc.in_india === "yes" ? "yes" : pc.in_india === "no" ? "no" : "unconfirmed"}
        {pc.location_evidence ? ` (${pc.location_evidence})` : ""}
      </p>
      <p>
        Role: {FUNCTION_LABEL[pc.function] || pc.function}
        {pc.function_evidence ? `. ${pc.function_evidence}` : ""}
        {pc.seniority_ok === false ? " Below Head level." : ""}
      </p>
      <p>
        Scope: {pc.scope || "unknown"}
        {pc.in_role_since && pc.in_role_since !== "unknown" ? ` · in role since ${pc.in_role_since}` : ""}
        {pc.owns ? ` · owns ${pc.owns}` : ""}
      </p>
      {Array.isArray(pc.signals) && pc.signals.length ? (
        <ul>
          {pc.signals.map((x: any, i: number) => (
            <li key={i}>
              {x.detail}{" "}
              {x.source ? (
                <a href={x.source} target="_blank" rel="noopener">source</a>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

const GUARD_TTL_MS = 12 * 3600e3;

/** Result of the roster + HubSpot check for other people working this contact. */
function GuardNote({ X, l, act }: { X: Ctx; l: Row; act: boolean }) {
  const g = l.guard;
  const busy = X.S.busy.has("guard:" + l.id);
  if (!g && !busy) return null;
  if (!g) return <div className="note small">Checking HubSpot and the roster…</div>;
  if (g.level === "clear")
    return (
      <div className="small" style={{ marginTop: 4 }}>
        <span className="pill ok" title={`Checked ${fmtStamp(g.at)}`}>CRM clear</span>
      </div>
    );
  return (
    <div className={g.level === "block" ? "note small err" : "note small"} role={g.level === "block" ? "alert" : undefined} style={{ marginTop: 6 }}>
      <b>{g.level === "block" ? "Someone else is working this person." : "Check before calling."}</b>{" "}
      {(g.reasons || []).join("; ")}.{" "}
      <span className="muted">Checked {fmtStamp(g.at)}.</span>{" "}
      {act ? (
        <button className="btn ghost small" disabled={busy} onClick={() => checkGuard(X, l.id)}>
          {busy ? "Checking…" : "Check again"}
        </button>
      ) : null}
    </div>
  );
}

const CONTACT_DQ = ["Wrong ICP", "Left the company", "Wrong function or seniority", "Duplicate", "Do not contact", "Other"];
const COMPANY_DQ = ["Not a fit (size or industry)", "Existing customer or partner", "Competitor", "Already in an active deal", "Do not contact", "Other"];
const LOST_REASONS = ["Went cold, no response", "Not interested", "No budget", "Bad timing", "Chose a competitor", "Other"];

/** Every open account (and the Approve dialog): search Apollo for other ICP contacts at the company (free), then
    pick who to enrich under Being added, so credits go on the right people. Filed for the account's rep when an
    admin runs it. */
const altEligible = (X: Ctx, a: Acct) =>
  can(X, "add_company") && a.rank !== LOST && !a.c.every((l) => l.dq_scope === "company") && !!a.c.find((l) => l.domain);
function AltContactsBtn({ X, a, compact, onStart }: { X: Ctx; a: Acct; compact?: boolean; onStart?: () => void }) {
  if (!altEligible(X, a)) return null;
  const l = a.c.find((x) => x.approved && x.domain) || a.c.find((x) => x.domain)!;
  const domain = String(l.domain).toLowerCase();
  const running = X.D.addreqs.find((r) => r.domain === domain && r.mode === "more" && !["done", "failed"].includes(r.status));
  const busy = X.S.busy.has("more:" + l.id);
  const label = busy ? "Searching…" : running ? (running.status === "pick" ? "Pick alternates" : "Finding alternates…") : compact ? "+ Alternates" : "Find alternate contacts";
  return (
    <button
      type="button"
      className={"btn ghost small alt-btn" + (compact ? " compact" : "")}
      disabled={busy || (!!running && running.status !== "pick")}
      title={running ? "A search for alternate contacts is already running. Pick them under Being added." : `Search Apollo for other ICP contacts at ${a.name}, then pick who to enrich`}
      aria-label={`Find alternate contacts at ${a.name}`}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onStart && onStart();
        if (running) {
          window.scrollTo({ top: 0, behavior: "smooth" });
          return;
        }
        findMoreIcps(X, l);
      }}
      onDragStart={(e) => e.preventDefault()}
    >
      {label}
    </button>
  );
}

/** A disqualified contact's banner: why, who, and the way back (plus Find alternate contacts). */
function DqNote({ X, l, act }: { X: Ctx; l: Row; act: boolean }) {
  if (!l.dq_at) return null;
  const busy = X.S.busy.has("more:" + l.id);
  return (
    <div className="dq-note">
      <span className="pill crit">Disqualified</span>
      <span className="small">
        {l.dq_reason || "Not a fit"}
        {l.dq_scope === "company" ? " (whole company)" : ""} · {pname(X, l.dq_by)} · {fmtDay(l.dq_at)}
      </span>
      {act ? (
        <span className="dq-acts">
          {l.dq_scope !== "company" && l.domain && can(X, "add_company") ? (
            <button className="btn small" disabled={busy} onClick={() => findMoreIcps(X, l)}>
              {busy ? "Searching…" : "Find alternate contacts"}
            </button>
          ) : null}
          {l.dq_scope !== "company" ? (
            <button className="btn ghost small" onClick={() => setLeadDq(X, l, false, "").catch(() => {})}>
              Requalify
            </button>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

function Contact({ X, l, fullRes }: { X: Ctx; l: Row; fullRes?: boolean }) {
  const cb = openCallback(X, l.id),
    m = meetingFor(X, l.id),
    ui = outcomeUI(X, l.id, cb ? cb.id : null),
    resOpen = !!fullRes || X.S.openRes.has(l.id);
  const showOutcome = !(m && m.status !== "done" && !cb);
  const act = canActOn(X, l);
  // Re-check the CRM when an approved contact is shown and the last verdict is older than 12 hours.
  useEffect(() => {
    const g = l.guard;
    if (act && l.approved && (!g || !g.at || Date.now() - Date.parse(g.at) > GUARD_TTL_MS)) checkGuard(X, l.id, true);
  }, [l.id, l.approved, act]);
  const toggleRes = () => {
    resOpen ? X.S.openRes.delete(l.id) : X.S.openRes.add(l.id);
    X.rerender();
  };
  const assign = async (v: string) => {
    const prev = assignedTo(l) || null;
    try {
      await upd(X, "leads", l.id, { assigned_to: v || null, assigned_at: nowISO(), assigned_by: X.uid });
      X.toast(v ? `Assigned to ${pname(X, v)}.` : "Unassigned.", () => upd(X, "leads", l.id, { assigned_to: prev }));
    } catch (_) {}
  };
  const approve = (checked: boolean) => approveLead(X, l, checked);
  const hasEmail = !!(l.enrichment && (l.enrichment as any).email);
  const openConnected = () => {
    X.S.modal = { type: "ctx", leadId: l.id, text: X.S.forms["ctx:" + l.id] || "" };
    X.rerender();
  };
  return (
    <div className="contact">
      <div className="crow">
        <div className="c-id">
          <div className="cname">
            <DisplayName name={l.name} /> <TierBadge t={l.tier} small />
          </div>
          <div className="muted small">{l.title}</div>
          <div className="small">{emailCheck(l)}</div>
          <div className="badges">
            {l.status_check === "unconfirmed" ? <span className="pill warn" title="We could not confirm they are still in this role.">status unconfirmed</span> : null}
            {l.source === "manual" ? <span className="pill off">added by you</span> : null}
            {l.source === "suggested" ? <span className="pill off" title="A researcher found this person while working the account">suggested by research</span> : null}
            <ContactStatus X={X} l={l} />
            {(() => {
              const b = emailBadge(l);
              return b ? <span className={"pill " + b.tone} title={b.title}>✉ {b.text}</span> : null;
            })()}
          </div>
          <div className="small c-reach" style={{ marginTop: 4 }}>
            <EnrichState X={X} l={l} act={act} />
          </div>
          <LinkedInLine l={l} />
          {l.approved && !l.dq_at ? <GuardNote X={X} l={l} act={act} /> : null}
          <DqNote X={X} l={l} act={act} />
        </div>
        <div className="small c-angle">
          <p className="c-angle-text">{l.angle}</p>
          {cb ? (
            <div className="note c-cb" style={{ marginTop: 6 }}>
              <b>Open callback</b> {fmtWhen(cb.when)}: {cb.agenda}
              {cb.cal_status === "failed" ? (
                <>
                  {" "}
                  <span className="err">{cb.cal_error || "Not in Google Tasks."}</span>{" "}
                  <button className="btn ghost small" disabled={X.S.busy.has("cal:" + cb.id)} onClick={() => retryCal(X, cb.id)}>
                    Add to Google Tasks
                  </button>
                </>
              ) : cb.cal_status === "added" ? (
                <> <span className="pill ok">{cb.cal_kind === "task" ? "in Google Tasks" : "on calendar"}</span></>
              ) : null}
            </div>
          ) : null}
          {fullRes ? null : (
            <button className="btn ghost small" style={{ marginTop: 6 }} onClick={toggleRes}>
              {resOpen ? "Hide research" : "Show research"}
            </button>
          )}
        </div>
        <div className="actions">
          <div className="act-grid">
            {can(X, "assign_leads") ? (
              <>
                <label className="act-l" htmlFor={"as-" + l.id}>
                  Owner
                </label>
                <select id={"as-" + l.id} value={assignedTo(l)} onChange={(e) => assign(e.target.value)}>
                  <option value="">Unassigned</option>
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
              <>
                <span className="act-l">Owner</span>
                <span className="small">{assignedTo(l) ? pname(X, assignedTo(l)) : "Unassigned"}</span>
              </>
            )}
            <span className="act-l">Status</span>
            {act && l.dq_at ? (
              <span className="muted small">Disqualified · not in the calling list</span>
            ) : act ? (
              <label className="approve" title={hasEmail ? "Approve this contact for calling." : "Approving finds their work email. Uses about 1 Apollo credit."}>
                <input type="checkbox" id={"ap-" + l.id} checked={!!l.approved} onChange={(e) => approve(e.target.checked)} />
                {l.approved ? "Approved" : "Approve"}
                {!l.approved && !hasEmail ? <span className="hint">about 1 Apollo credit</span> : null}
              </label>
            ) : (
              <span className="small">{l.approved ? "Approved" : "Not approved"}</span>
            )}
            {act && !l.dq_at ? (
              l.approved ? (
                showOutcome ? (
                  ui.control
                ) : (
                  <>
                    <span className="act-l">Outcome</span>
                    <span className="note">Meeting tracked in Meetings</span>
                  </>
                )
              ) : (
                <span className="note">Approve to start calling</span>
              )
            ) : null}
          </div>
          {act && !l.dq_at ? (
            <div className="act-foot">
              {l.approved ? (
                <button className="btn ghost small" id={"cc-" + l.id} onClick={openConnected}>
                  Log connected call
                </button>
              ) : null}
              <select
                className="dq-pick"
                aria-label={`Disqualify ${l.name}`}
                value=""
                onChange={(e) => e.target.value && setLeadDq(X, l, true, e.target.value).catch(() => {})}
              >
                <option value="">Disqualify…</option>
                {CONTACT_DQ.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
        </div>
      </div>
      {showOutcome && act && l.approved && !l.dq_at ? ui.form : null}
      {resOpen ? (
        <div className="research">
          <div>
            <h3>ICP fit</h3>
            <p>{l.fit_reason || "Research pending"}</p>
            {l.employees ? (
              <p className="hint" style={{ marginTop: 6 }}>
                Headcount source: {String(l.employees)}
              </p>
            ) : null}
          </div>
          <div><h3>Still in role?</h3><p>{l.status_evidence || "Not checked yet"}</p></div>
          <PersonCheck pc={l.person_check} />
          <div><h3>Who they are</h3><p>{l.persona}</p></div>
          <div><h3>Similar companies</h3><p>{l.adjacency && l.adjacency !== "none" ? l.adjacency : "None found"}</p></div>
          <div><h3>Pain points</h3><ul><PainList p={l.pain_points} /></ul></div>
          <div><h3>Competitors</h3><p>{l.competitive || "No confirmed competitor evaluation"}</p></div>
          <div><h3>Proof point</h3><p>{l.proof_point}</p></div>
        </div>
      ) : null}
    </div>
  );
}

/** Furthest stage any contact in the account has reached, plus the next scheduled date. */
function acctStage(X: Ctx, cs: Row[]) {
  let rank = 0,
    label = "Not approved",
    next = "";
  const bump = (r: number, l: string) => {
    if (r > rank) {
      rank = r;
      label = l;
    }
  };
  const nexts: string[] = [];
  cs.forEach((l) => {
    if (l.approved) bump(1, "Approved");
    const cb = openCallback(X, l.id);
    if (cb) {
      bump(2, "Callback " + fmtDay(cb.when));
      nexts.push(cb.when);
    }
    const m = meetingFor(X, l.id);
    if (m && m.status === "done") bump(4, "Demo done");
    else if (m) {
      bump(3, "Demo booked");
      if (m.status !== "rescheduling" && m.when) nexts.push(m.when);
    }
  });
  const now = Date.now();
  next = nexts.filter((w) => new Date(w).getTime() >= now).sort()[0] || "";
  const lost = cs.find((l) => l.lost_at);
  if (lost) return { label: "Closed lost / Cold", cls: "s-lost", next: "", lostReason: String(lost.lost_reason || ""), lostAt: String(lost.lost_at) };
  const cls = ["s-new", "s-appr", "s-cb", "s-demo", "s-done"][rank];
  return { label, cls, next, lostReason: "", lostAt: "" };
}

const REQ_LBL: Record<string, [string, string]> = {
  queued: ["hold", "next batch"],
  searching: ["hold", "searching Apollo"],
  pick: ["adj", "pick contacts"],
  enriching: ["hold", "enriching + research"],
  done: ["ok", "done"],
  failed: ["crit", "failed"],
};
/** Hand-typed contacts for a request whose Apollo search failed or found the wrong people. */
type ManualRow = { name: string; title: string; linkedin: string };
function ManualContacts({ X, r }: { X: Ctx; r: Row }) {
  const k = "manual:" + r.id;
  const rows: ManualRow[] | undefined = X.S.forms[k];
  const busy = X.S.busy.has(k);
  if (!rows) {
    return (
      <button
        className="btn ghost small"
        onClick={() => {
          X.S.forms[k] = [{ name: r.contact?.name || "", title: r.contact?.title || "", linkedin: r.contact?.linkedin || "" }];
          X.rerender();
        }}
      >
        Add contacts manually
      </button>
    );
  }
  const set = (i: number, f: keyof ManualRow, v: string) => {
    rows[i] = { ...rows[i], [f]: v };
    X.rerender();
  };
  const ticked = r.status === "pick" ? (X.S.forms["pick:" + r.id] || []).length : 0;
  const n = rows.filter((x) => x.name.trim()).length + ticked;
  return (
    <div className="form" style={{ marginTop: 8 }}>
      <p className="note full" style={{ margin: 0 }}>
        Add the people you want at {coName(r.company)}. The roster checks HubSpot, finds their work email, then the Claude worker researches them like any other add.
      </p>
      {rows.map((x, i) => (
        <div key={i} className="full" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))", gap: 8, alignItems: "end" }}>
          <label>
            Name *
            <input id={`mc-${r.id}-${i}-name`} value={x.name} onChange={(e) => set(i, "name", e.target.value)} />
          </label>
          <label>
            Title
            <input value={x.title} onChange={(e) => set(i, "title", e.target.value)} placeholder="Head of Growth" />
          </label>
          <label>
            LinkedIn URL
            <input value={x.linkedin} onChange={(e) => set(i, "linkedin", e.target.value)} placeholder="https://www.linkedin.com/in/…" />
          </label>
          {rows.length > 1 ? (
            <button className="btn ghost small" aria-label={`Remove contact ${i + 1}`} onClick={() => (rows.splice(i, 1), X.rerender())}>
              Remove
            </button>
          ) : null}
        </div>
      ))}
      <div className="row full">
        {rows.length < 5 ? (
          <button className="btn ghost small" onClick={() => (rows.push({ name: "", title: "", linkedin: "" }), X.rerender())}>
            Add another
          </button>
        ) : null}
        <button className="btn small" disabled={busy || !n} onClick={() => addManualContacts(X, r.id, rows)}>
          {busy ? "Starting…" : `Enrich ${n || ""} contact${n === 1 ? "" : "s"}`.replace("  ", " ")}
        </button>
        <button className="btn ghost small" onClick={() => (delete X.S.forms[k], X.rerender())}>
          Cancel
        </button>
        {ticked ? <span className="note">Includes the {ticked} ticked above.</span> : null}
      </div>
    </div>
  );
}
/** A failed request that hand-typed contacts can rescue (not one blocked by another rep's claim or a recent ICP fail). */
const manualHelps = (r: Row) =>
  r.status === "pick" || (r.status === "failed" && !/already belongs to|failed the ICP or CRM check/i.test(String(r.note || "")));

const REQ_CAP = 5;
const CAND_CAP = 3;

/** One request row. Needs-you rows show the pick list; working rows are a single quiet line. */
function RequestRow({ X, r }: { X: Ctx; r: Row }) {
  const [c, t0] = REQ_LBL[r.status] || ["warn", r.status];
  const t = r.mode === "more" && r.status !== "failed" ? "more ICPs · " + t0 : t0;
  const sel: number[] = X.S.forms["pick:" + r.id] || [];
  const cands = Array.isArray(r.candidates) ? r.candidates : [];
  const allCands = !!X.S.forms["cands:" + r.id];
  const shown = allCands ? cands : cands.slice(0, CAND_CAP);
  const togglePick = (i: number, on: boolean) => {
    const arr: number[] = X.S.forms["pick:" + r.id] || (X.S.forms["pick:" + r.id] = []);
    if (on && !arr.includes(i)) arr.push(i);
    if (!on && arr.includes(i)) arr.splice(arr.indexOf(i), 1);
    X.rerender();
  };
  const selectAll = () => {
    X.S.forms["pick:" + r.id] = sel.length === cands.length ? [] : cands.map((_: unknown, i: number) => i);
    X.rerender();
  };
  const quiet = r.status !== "failed";
  return (
    <div className="req" key={r.id}>
      <div style={{ minWidth: 0 }}>
        <strong>{r.company}</strong> <span className="mono muted">{r.domain}</span>
        <span className={"pill " + c}>{t}</span>
        {r.owner && r.owner !== X.uid ? <span className="pill off">for {pname(X, r.owner)}</span> : null}
        {r.contact && r.contact.name ? <> <span className="note">· {r.contact.name}</span></> : null}
        {r.note ? (
          <p className="note">
            {r.note}
            {r.credits_used ? " · credits: " + r.credits_used : ""}
          </p>
        ) : null}
        {r.status === "pick" && cands.length ? (
          <div className="cands">
            {shown.map((p: any, i: number) => (
              <label key={i}>
                <input type="checkbox" id={`pk-${r.id}-${i}`} checked={sel.includes(i)} onChange={(e) => togglePick(i, e.target.checked)} />
                {p.name} <span className="muted">{p.title || ""}</span>
              </label>
            ))}
            {cands.length > CAND_CAP ? (
              <div className="row">
                <button type="button" className="btn ghost small" onClick={() => { X.S.forms["cands:" + r.id] = !allCands; X.rerender(); }}>
                  {allCands ? "Show fewer" : `Show ${cands.length - CAND_CAP} more`}
                </button>
                <button type="button" className="btn ghost small" onClick={selectAll}>
                  {sel.length === cands.length ? "Clear selection" : "Select all"}
                </button>
              </div>
            ) : null}
            <div className="row">
              <button className="btn small" disabled={!sel.length || !can(X, "enrich_now")} onClick={() => enrichPicked(X, r.id)}>
                Enrich {sel.length || ""} selected
              </button>
              <span className="note">
                {sel.length
                  ? `About ${sel.length} Apollo credit${sel.length === 1 ? "" : "s"} (standard match, work email only). Research gates run after.`
                  : "Tick the people to enrich."}
              </span>
            </div>
          </div>
        ) : null}
        {manualHelps(r) && can(X, "add_company") && X.S.forms["manual:" + r.id] ? <ManualContacts X={X} r={r} /> : null}
      </div>
      <div className="actions">
        {manualHelps(r) && can(X, "add_company") && !X.S.forms["manual:" + r.id] ? <ManualContacts X={X} r={r} /> : null}
        {r.status === "failed" && r.mode === "now" ? (
          <button className="btn ghost small" onClick={() => refire(X, r.id)}>Retry</button>
        ) : null}
        {quiet ? (
          <MoreMenu label={`More for ${r.company}`}>
            <DelConfirm X={X} kind="request" id={r.id} label="request" />
          </MoreMenu>
        ) : (
          <DelConfirm X={X} kind="request" id={r.id} label="request" />
        )}
      </div>
    </div>
  );
}

/** A group of requests with a cap, so the panel stays one size however many are queued. */
function ReqGroup({ X, id, title, rows, openByDefault, cap = REQ_CAP }: { X: Ctx; id: string; title: string; rows: Row[]; openByDefault: boolean; cap?: number }) {
  if (!rows.length) return null;
  const open = X.S.forms["reqs:" + id] === undefined ? openByDefault : !!X.S.forms["reqs:" + id];
  const all = !!X.S.forms["reqs:all:" + id];
  const list = all ? rows : rows.slice(0, cap);
  return (
    <div className="req-group">
      <button
        type="button"
        className="req-group-head"
        aria-expanded={open}
        onClick={() => {
          X.S.forms["reqs:" + id] = !open;
          X.rerender();
        }}
      >
        <span aria-hidden="true">{open ? "▾" : "▸"}</span> {title} <span className="muted">({rows.length})</span>
      </button>
      {open ? (
        <>
          {list.map((r) => (
            <RequestRow key={r.id} X={X} r={r} />
          ))}
          {rows.length > cap ? (
            <div className="req req-more">
              <button
                type="button"
                className="btn ghost small"
                onClick={() => {
                  X.S.forms["reqs:all:" + id] = !all;
                  X.rerender();
                }}
              >
                {all ? "Show fewer" : `Show ${rows.length - cap} more`}
              </button>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function Requests({ X }: { X: Ctx }) {
  // Finished adds live in the list as Tier S (qualified) or Tier X (not); only work in flight shows here.
  const rq = X.D.addreqs
    .filter((r) => r.status !== "done")
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  if (!rq.length) return null;
  // Rows that need a person come first and sit in their own group; background work is folded away.
  const need = rq.filter((r) => r.status === "pick");
  const failed = rq.filter((r) => r.status === "failed");
  const working = rq.filter((r) => r.status !== "pick" && r.status !== "failed");
  const bits = [need.length ? `${need.length} need${need.length === 1 ? "s" : ""} you` : "", working.length ? `${working.length} working` : "", failed.length ? `${failed.length} failed` : ""].filter(Boolean);
  const clearing = X.S.confirmDel === "requests:failed";
  return (
    <div className="section">
      <div className="section-head">
        <h2>Being added</h2>
        <span className="note" role="status">{bits.join(" · ")}</span>
      </div>
      <div className="card reqs">
        <ReqGroup X={X} id="need" title="Needs you" rows={need} openByDefault cap={2} />
        <ReqGroup X={X} id="working" title="Working" rows={working} openByDefault={false} />
        <ReqGroup X={X} id="failed" title="Failed" rows={failed} openByDefault={false} />
        {failed.length > 1 && can(X, "delete_records") && X.S.forms["reqs:failed"] ? (
          <div className="req req-more">
            {clearing ? (
              <div className="confirm">
                Delete all {failed.length} failed requests?
                <button
                  className="btn danger small"
                  onClick={async () => {
                    noDel(X);
                    for (const r of failed) await doDelete(X, "request:" + r.id);
                  }}
                >
                  Delete all
                </button>
                <button className="btn ghost small" onClick={() => noDel(X)}>Keep</button>
              </div>
            ) : (
              <button className="btn danger small" onClick={() => askDel(X, "requests:failed")}>Clear all failed</button>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

type Acct = {
  k: string;
  c: Row[];
  name: string;
  best: string;
  st: ReturnType<typeof acctStage>;
  rank: number;
  owners: string[];
  day: string;
  nJ: number;
  pr: { p: Priority; reasons: string[]; manual: boolean };
};
const STAGES: Array<[string, string]> = [
  ["s-new", "Not approved"],
  ["s-appr", "Approved"],
  ["s-cb", "Callback"],
  ["s-demo", "Demo booked"],
  ["s-done", "Demo done"],
  ["s-lost", "Closed lost / Cold"],
];
const LOST = 5;
const COLS: Array<[string, string]> = [
  ["tier", "Tier"],
  ["priority", "Priority"],
  ["company", "Company"],
  ["contacts", "Contacts"],
  ["stage", "Stage"],
  ["owner", "Owner"],
  ["next", "Next step"],
  ["day", "Roster date"],
];
const TIERS = ["S", "A", "B", "C", "X"];
const lsView = () => {
  try {
    return localStorage.getItem("roster.acctView") === "board" ? "board" : "table";
  } catch (_) {
    return "table";
  }
};

/** "Sashank Koundinya" -> "Sashank K." for tight table cells; the full name is in the tooltip. */
const firstLast = (n: string) => {
  const w = String(n || "").trim().split(/\s+/);
  return w.length > 1 && !n.includes("@") ? `${w[0]} ${w[w.length - 1][0]}.` : n;
};
function Owners({ X, a, short }: { X: Ctx; a: Acct; short?: boolean }) {
  if (!a.owners.length) return <span className="muted">Unassigned</span>;
  if (a.owners.length === 1) return <span title={pname(X, a.owners[0])}>{short ? firstLast(pname(X, a.owners[0])) : pname(X, a.owners[0])}</span>;
  return <span title={a.owners.map((o) => pname(X, o)).join(", ")}>{a.owners.map((o) => initials(pname(X, o))).join(", ")}</span>;
}

/** What research would call this contact's tier: its company-fit tier, filed as S when it was added by hand. */
const researchTier = (l: Row) => {
  const f = l.fit_tier || l.tier || "";
  return l.source === "manual" && ["A", "B", "C"].includes(f) ? "S" : f;
};

/** Re-tag every contact at an account. "reset" hands the tier back to research. */
async function setAccountTier(X: Ctx, a: Acct, v: string) {
  const prev = a.c.map((l) => ({ id: l.id, tier: l.tier, tier_set_by: l.tier_set_by || null }));
  try {
    for (const l of a.c) {
      await upd(X, "leads", l.id, v === "reset" ? { tier: researchTier(l) || null, tier_set_by: null } : { tier: v, tier_set_by: X.uid });
    }
    X.toast(v === "reset" ? `${a.name} is back on its research tier.` : `${a.name} tagged Tier ${v}.`, async () => {
      for (const p of prev) await upd(X, "leads", p.id, { tier: p.tier, tier_set_by: p.tier_set_by });
    });
  } catch (_) {}
}
async function setAccountPriority(X: Ctx, a: Acct, v: string) {
  const prev = a.c.map((l) => ({ id: l.id, v: l.priority_override || null }));
  try {
    for (const l of a.c) if (canActOn(X, l) || can(X, "assign_leads")) await upd(X, "leads", l.id, { priority_override: v || null });
    X.toast(v ? `${a.name} set to ${PRIORITY_LABEL[v as Priority]} priority.` : `${a.name} priority is automatic again.`, async () => {
      for (const p of prev) await upd(X, "leads", p.id, { priority_override: p.v });
    });
  } catch (_) {}
}

/** The account's tier as a tag. People with edit_tiers re-tag it from the tag itself. */
function TierTag({ X, a, small }: { X: Ctx; a: Acct; small?: boolean }) {
  const badge = <TierBadge t={a.best} small={small} />;
  if (!can(X, "edit_tiers")) return badge;
  const manual = a.c.some((l) => l.tier_set_by);
  const rt = researchTier(a.c[0]);
  return (
    <span className={"tagedit" + (manual ? " is-manual" : "")} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      {badge}
      <select
        aria-label={`Tier for ${a.name}`}
        value=""
        title={manual ? "Tagged by hand. Change or reset the tier." : "Change the tier"}
        onChange={(e) => e.target.value && setAccountTier(X, a, e.target.value)}
      >
        <option value="">Change tier…</option>
        {TIERS.map((t) => (
          <option key={t} value={t} disabled={t === a.best}>
            Tier {t}
          </option>
        ))}
        {manual ? <option value="reset">Reset to research{rt ? ` (Tier ${rt})` : ""}</option> : null}
      </select>
    </span>
  );
}

function PriorityMark({ pr }: { pr: Acct["pr"] }) {
  return (
    <span className={"prio p-" + pr.p} title={`${PRIORITY_LABEL[pr.p]} priority: ${pr.reasons.join(", ")}`}>
      <span className="prio-bars" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      {PRIORITY_LABEL[pr.p]}
      {pr.manual ? <span className="sr-only"> (set by hand)</span> : null}
    </span>
  );
}

/** Account-level controls shown when an account is open: tier tag, priority and why. */
function AcctTools({ X, a }: { X: Ctx; a: Acct }) {
  const canPin = a.c.some((l) => canActOn(X, l)) || can(X, "assign_leads");
  return (
    <div className="acct-tools">
      <span className="at-item">
        <span className="at-l">Tier</span>
        <TierTag X={X} a={a} />
        {a.c.some((l) => l.tier_set_by) ? <span className="hint">tagged by hand · research said {researchTier(a.c[0]) || "none"}</span> : null}
      </span>
      <span className="at-item">
        <span className="at-l">Priority</span>
        <PriorityMark pr={a.pr} />
        {canPin ? (
          <select
            aria-label={`Priority for ${a.name}`}
            value={a.pr.manual ? a.pr.p : ""}
            onChange={(e) => setAccountPriority(X, a, e.target.value)}
          >
            <option value="">Automatic</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
        ) : null}
        <span className="hint">{a.pr.reasons.join(" · ")}</span>
      </span>
      <StageTools X={X} a={a} />
      <AltContactsBtn X={X} a={a} />
    </div>
  );
}

/** Stage move (both views), Closed lost reason and reopen, and disqualifying the whole company. */
function StageTools({ X, a }: { X: Ctx; a: Acct }) {
  const canWork = a.c.some((l) => canActOn(X, l)) || can(X, "assign_leads");
  if (!canWork) return null;
  const forward = STAGES.map((x, i) => [i, x[1]] as [number, string]).filter(([i]) => !moveCheck(a.rank, i));
  const coDq = a.c.length > 0 && a.c.every((l) => l.dq_scope === "company");
  return (
    <>
      <span className="at-item">
        <span className="at-l">Stage</span>
        {a.rank === LOST ? (
          <>
            <span className="hint">
              {a.st.lostReason || "Went cold"} · {fmtDay(a.st.lostAt)}
            </span>
            <button className="btn ghost small" onClick={() => setAccountLost(X, a.c[0].company, a.c, false, "")}>
              Reopen
            </button>
          </>
        ) : forward.length ? (
          <select aria-label={`Move ${a.name} to stage`} value="" onChange={(e) => e.target.value && tryMove(X, a, +e.target.value)}>
            <option value="">Move to…</option>
            {forward.map(([i, l]) => (
              <option key={i} value={i}>
                {l}
              </option>
            ))}
          </select>
        ) : null}
      </span>
      <span className="at-item">
        <span className="at-l">Company</span>
        {coDq ? (
          <>
            <span className="pill crit">Disqualified</span>
            <span className="hint">{a.c[0].dq_reason}</span>
            <button className="btn ghost small" onClick={() => setAccountDq(X, a.c[0].company, a.c, false, "")}>
              Requalify
            </button>
          </>
        ) : (
          <select aria-label={`Disqualify ${a.name}`} value="" onChange={(e) => e.target.value && setAccountDq(X, a.c[0].company, a.c, true, e.target.value)}>
            <option value="">Disqualify company…</option>
            {COMPANY_DQ.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        )}
      </span>
    </>
  );
}

/** The open account's tools, journey and contacts, shared by the table's expanded row and the side panel. */
function AccountBody({ X, a, fullRes }: { X: Ctx; a: Acct; fullRes?: boolean }) {
  return (
    <>
      <AcctTools X={X} a={a} />
      <Journey X={X} contacts={a.c} />
      <div className="contacts">
        {a.c
          .slice()
          .sort((x, y) => tierRank(x.tier) - tierRank(y.tier))
          .map((l) => (
            <Contact key={l.id} X={X} l={l} fullRes={fullRes} />
          ))}
      </div>
    </>
  );
}

/** Whether an account may move from one stage to another: forward only, and Demo done only from Demo booked. */
function moveCheck(from: number, to: number): string {
  if (to === from) return "same";
  // Any open account can be closed as lost; a lost account comes back by reopening it.
  if (to === LOST) return "";
  if (from === LOST) return "";
  if (from === 1 && to === 0) return "Approved accounts can't go back to Not approved.";
  if (to < from) return "Accounts only move forward. To step back, undo the call or cancel the meeting behind the stage.";
  if (to === 4 && from !== 3) return "Book the demo first, then mark it done.";
  return "";
}
function tryMove(X: Ctx, a: Acct, to: number) {
  const why = moveCheck(a.rank, to);
  if (why === "same") return;
  if (why) return X.toast(why);
  if (!a.c.some((l) => canActOn(X, l))) return X.toast("These contacts are assigned to someone else.");
  X.S.move = { k: a.k, to };
  X.rerender();
}

/** Board view: one column per stage. Drag a card forward to approve, set a callback, book or close a demo. */
function Board({ X, accts }: { X: Ctx; accts: Acct[] }) {
  const [drag, setDrag] = useState<Acct | null>(null);
  const [over, setOver] = useState(-1);
  // Closed lost / Cold folds into a slim rail so the working stages fit on screen; the choice is remembered.
  const [lostOpen, setLostOpen] = useState(() => {
    try {
      return localStorage.getItem("roster.lostOpen") === "1";
    } catch (_) {
      return false;
    }
  });
  const showLost = (v: boolean) => {
    setLostOpen(v);
    try {
      localStorage.setItem("roster.lostOpen", v ? "1" : "0");
    } catch (_) {}
  };
  const open = (k: string) => {
    X.S.panel = k;
    X.S.panelFull = false;
    smooth(X.rerender);
  };
  return (
    <div className={"board" + (drag ? " is-dragging" : "") + (lostOpen ? "" : " lost-rail")} role="list" aria-label="Accounts by stage">
      {STAGES.map(([cls, label], i) => {
        const col = accts.filter((a) => a.rank === i);
        const verdict = drag ? moveCheck(drag.rank, i) : "same";
        const rail = i === LOST && !lostOpen;
        return (
          <section
            className={"bcol " + cls + (rail ? " is-rail" : "") + (drag && over === i ? (verdict && verdict !== "same" ? " drop-no" : verdict ? "" : " drop-ok") : "") + (drag && !verdict ? " can-drop" : "")}
            key={cls}
            role="listitem"
            aria-label={`${label}, ${col.length}`}
            onDragOver={(e) => {
              if (!drag) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = verdict ? "none" : "move";
              if (over !== i) setOver(i);
            }}
            onDragLeave={(e) => {
              if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setOver(-1);
            }}
            onDrop={(e) => {
              e.preventDefault();
              const a = drag;
              setDrag(null);
              setOver(-1);
              if (a) tryMove(X, a, i);
            }}
          >
            {rail ? (
              <button className="bcol-rail" onClick={() => showLost(true)} aria-expanded={false} title={`Show ${label}`}>
                <span className="bcol-n">{col.length}</span>
                <span className="rail-l">{label}</span>
              </button>
            ) : (
            <>
            <header className="bcol-head">
              <span className={"stage " + cls}>{label}</span>
              <span className="bcol-n">{col.length}</span>
              {i === LOST ? (
                <button className="iconbtn" onClick={() => showLost(false)} aria-expanded={true} aria-label={`Fold ${label}`} title="Fold this column">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M9 6l6 6-6 6" />
                  </svg>
                </button>
              ) : null}
            </header>
            <div className="bcol-body">
              {col.length ? null : <p className="bcol-empty">{drag && !verdict ? "Drop here" : "Nothing here"}</p>}
              {col.map((a) => {
                const c = a.c[0];
                return (
                  <div key={a.k} className="bcard-wrap">
                  <button
                    className={"bcard" + (X.S.panel === a.k ? " is-open" : "") + (drag && drag.k === a.k ? " is-lifted" : "")}
                    onClick={() => open(a.k)}
                    aria-haspopup="dialog"
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("text/plain", a.k);
                      setDrag(a);
                    }}
                    onDragEnd={() => {
                      setDrag(null);
                      setOver(-1);
                    }}
                  >
                    <span className="bcard-top">
                      <TierBadge t={a.best} small />
                      <PriorityMark pr={a.pr} />
                    </span>
                    <strong className="bcard-name">{a.name}</strong>
                    {(() => {
                      const b = a.c.map(emailBadge).find(Boolean);
                      return b ? <span className={"bcard-mail pill " + b.tone} title={b.title}>✉ {b.text}</span> : null;
                    })()}
                    <span className="bcard-seg">{c.segment || c.domain || ""}</span>
                    <span className="bcard-foot">
                      <span className="bcard-ppl">
                        {plural(a.c.length, "contact")}
                        {a.st.next ? ` · ${fmtDay(a.st.next)}` : a.nJ ? ` · ${plural(a.nJ, "note")}` : ""}
                      </span>
                      <span className="bcard-own" title={a.owners.map((o) => pname(X, o)).join(", ") || "Unassigned"}>
                        {a.owners.length ? a.owners.map((o) => initials(pname(X, o))).join(" ") : "—"}
                      </span>
                    </span>
                  </button>
                  <AltContactsBtn X={X} a={a} />
                  </div>
                );
              })}
            </div>
            </>
            )}
          </section>
        );
      })}
    </div>
  );
}

/** What a forward move needs: which contacts to approve, the callback or demo details, or which demo happened. */
function MoveDialog({ X, a, to }: { X: Ctx; a: Acct; to: number }) {
  const close = () => {
    // Drop the outcome this dialog pre-filled, so the contact's own outcome buttons start clean.
    const armed = X.S.forms["move"]?.armed;
    if (armed) delete X.S.forms[armed];
    delete X.S.forms["move"];
    X.S.move = null;
    X.rerender();
  };
  const mine = a.c.filter((l) => canActOn(X, l));
  const F = X.S.forms["move"] || (X.S.forms["move"] = { lead: (mine.find((l) => l.approved) || mine[0] || {}).id || "", sel: mine.filter((l) => !l.approved).map((l) => l.id), armed: "" });
  const lead = mine.find((l) => l.id === F.lead) || mine[0];
  const cb = lead ? openCallback(X, lead.id) : null;
  const key = cb ? "cb:" + cb.id : lead ? "ld:" + lead.id : "";
  const outcome = a.rank === LOST ? "" : to === 2 ? "callback" : to === 3 ? "yes" : "";
  // The outcome form clears its own state once it saves; that is the signal to close.
  useEffect(() => {
    if (!outcome || !key || !lead?.approved) return;
    if (!X.S.forms[key]) {
      if (F.armed === key) {
        close();
        return;
      }
    }
    const f = formFor(X, key);
    if (f.outcome !== outcome) {
      f.outcome = outcome;
      F.armed = key;
      X.rerender();
    }
  });
  useEffect(() => () => void delete X.S.forms["move"], []);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    (ref.current?.querySelector("input, select, button.btn") as HTMLElement | null)?.focus();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, []);
  const reopen = a.rank === LOST;
  const title = reopen ? "Reopen the account" : ["", "Approve contacts", "Set a callback", "Book a demo", "Mark the demo done", "Close as lost / cold"][to];
  let body: ReactNode = null;
  if (reopen) {
    body = (
      <>
        <p className="note">
          {a.name} goes back to the stage its contacts have reached. It was closed as {a.st.lostReason || "lost"} on {fmtDay(a.st.lostAt)}.
        </p>
        <div className="row">
          <button
            className="btn"
            onClick={async () => {
              close();
              await setAccountLost(X, a.c[0].company, a.c, false, "");
            }}
          >
            Reopen
          </button>
          <button className="btn ghost" onClick={close}>Cancel</button>
        </div>
      </>
    );
  } else if (to === LOST) {
    const reason = F.lostReason || LOST_REASONS[0];
    body = (
      <>
        <p className="note">Closing counts toward the loss rate on the dashboard. Open callbacks and meetings stay as they are; you can reopen the account later.</p>
        <div className="form">
          <label>
            Reason
            <select
              value={reason}
              onChange={(e) => {
                F.lostReason = e.target.value;
                X.rerender();
              }}
            >
              {LOST_REASONS.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </label>
          {reason === "Other" ? (
            <label>
              What happened
              <input
                value={F.lostNote || ""}
                placeholder="One line on why"
                onChange={(e) => {
                  F.lostNote = e.target.value;
                  X.rerender();
                }}
              />
            </label>
          ) : null}
        </div>
        <div className="row">
          <button
            className="btn danger"
            onClick={async () => {
              const r = reason === "Other" && (F.lostNote || "").trim() ? "Other: " + F.lostNote.trim() : reason;
              close();
              await setAccountLost(X, a.c[0].company, a.c, true, r);
            }}
          >
            Close as lost
          </button>
          <button className="btn ghost" onClick={close}>Cancel</button>
        </div>
      </>
    );
  } else if (to === 1) {
    const pending = mine.filter((l) => !l.approved);
    body = (
      <>
        <p className="note">Approving finds each contact's work email (about 1 Apollo credit each).</p>
        <div className="cands">
          {pending.map((l) => (
            <label key={l.id}>
              <input
                type="checkbox"
                checked={F.sel.includes(l.id)}
                onChange={(e) => {
                  F.sel = e.target.checked ? [...F.sel, l.id] : F.sel.filter((x: string) => x !== l.id);
                  X.rerender();
                }}
              />
              {l.name} <span className="muted">{l.title}</span>
            </label>
          ))}
        </div>
        <div className="row">
          <button
            className="btn"
            disabled={!F.sel.length}
            onClick={async () => {
              const pick = pending.filter((l) => F.sel.includes(l.id));
              delete X.S.forms["move"];
              close();
              for (const l of pick) await approveLead(X, l, true);
            }}
          >
            Approve {F.sel.length || ""}
          </button>
          <button className="btn ghost" onClick={close}>Cancel</button>
        </div>
        {altEligible(X, a) ? (
          <div className="alt-in-dialog">
            <span className="note">Not the right people? Find other ICP contacts first (free search; you pick who to enrich).</span>
            <AltContactsBtn X={X} a={a} onStart={close} />
          </div>
        ) : null}
      </>
    );
  } else if (to === 4) {
    const ms = X.D.meetings.filter((m) => a.c.some((l) => l.id === m.lead_id) && m.status === "scheduled");
    body = ms.length ? (
      <div className="list">
        {ms.map((m) => (
          <div key={m.id} className="row" style={{ justifyContent: "space-between" }}>
            <span>
              <b>{m.contact}</b> <span className="muted">· {fmtWhen(m.when)}</span>
            </span>
            <button
              className="btn small"
              onClick={async () => {
                close();
                await meetingHappened(X, m.id, "yes");
              }}
            >
              It happened
            </button>
          </div>
        ))}
      </div>
    ) : (
      <p className="note">No scheduled demo at this account.</p>
    );
  } else {
    const picker =
      mine.length > 1 ? (
        <label className="mv-pick">
          Contact
          <select
            value={F.lead}
            onChange={(e) => {
              F.lead = e.target.value;
              F.armed = "";
              X.rerender();
            }}
          >
            {mine.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name} · {l.approved ? "approved" : "not approved"}
              </option>
            ))}
          </select>
        </label>
      ) : null;
    body = !lead ? (
      <p className="note">No contact here you can act on.</p>
    ) : !lead.approved ? (
      <>
        {picker}
        <p className="note">{lead.name} isn't approved yet. Approving finds their work email (about 1 Apollo credit).</p>
        <div className="row">
          <button className="btn" onClick={() => approveLead(X, lead, true)}>Approve and continue</button>
          <button className="btn ghost" onClick={close}>Cancel</button>
        </div>
      </>
    ) : (
      <>
        {picker}
        {outcomeUI(X, lead.id, cb ? cb.id : null).form}
      </>
    );
  }
  return (
    <div className="modal" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="mv-h" ref={ref}>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div>
            <p className="eyebrow">
              {STAGES[a.rank][1]} → {reopen ? "Back in the pipeline" : STAGES[to][1]}
            </p>
            <h2 id="mv-h">
              {title} · {a.name}
            </h2>
          </div>
          <button className="iconbtn" onClick={close} aria-label="Cancel move">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
        {body}
      </div>
    </div>
  );
}

/** The account in a slide-over (from a board card) or full screen (Expand, or its own link in a new tab). */
function Panel({ X, a }: { X: Ctx; a: Acct }) {
  const ref = useRef<HTMLDivElement>(null);
  const back = useRef<HTMLElement | null>(null);
  const full = X.S.panelFull;
  const close = () => {
    X.S.panel = null;
    X.S.panelFull = false;
    X.rerender();
    setTimeout(() => back.current?.focus(), 0);
  };
  useEffect(() => {
    back.current = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !X.S.modal && !X.S.move) close();
    };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [a.k]);
  const c = a.c[0],
    emp = fmtEmployees(c.employees);
  const link = `${location.pathname}${location.search}#/accounts/${encodeURIComponent(a.k)}`;
  return (
    <div className={"panel-scrim" + (full ? " is-full" : "")} onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <aside className={"panel" + (full ? " is-full" : "")} role="dialog" aria-modal="true" aria-labelledby="panel-h" tabIndex={-1} ref={ref}>
        <header className="panel-head">
          <div className="panel-id">
            <div className="row">
              <TierTag X={X} a={a} />
              <span className={"stage " + a.st.cls}>{a.st.label}</span>
              <PriorityMark pr={a.pr} />
            </div>
            <h2 id="panel-h">{a.name}</h2>
            <p className="note">
              {[c.segment, emp, c.domain].filter(Boolean).join(" · ")}
              {" · "}
              <Owners X={X} a={a} />
              {a.st.next ? ` · Next ${fmtWhen(a.st.next)}` : ""}
            </p>
          </div>
          <div className="panel-actions">
            <button
              className="iconbtn"
              onClick={() => {
                X.S.panelFull = !full;
                smooth(X.rerender);
              }}
              aria-label={full ? "Exit full screen" : "Expand to full screen"}
              title={full ? "Exit full screen" : "Expand to full screen"}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d={full ? "M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" : "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"} />
              </svg>
            </button>
            <a className="iconbtn" href={link} target="_blank" rel="noopener" aria-label="Open in a new tab" title="Open in a new tab">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />
              </svg>
            </a>
            <button className="iconbtn" onClick={close} aria-label="Close account">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>
        </header>
        <div className="panel-body">
          <AccountBody X={X} a={a} fullRes />
        </div>
      </aside>
    </div>
  );
}

/** The tier filter: one dropdown of checkboxes. Nothing ticked means every tier. */
function TierFilter({ X, present }: { X: Ctx; present: Set<string> }) {
  const S = X.S;
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const out = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", out);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", out);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  const opts = TIERS.filter((t) => "ABC".includes(t) || present.has(t)).concat(present.has("U") || present.has("") ? ["U"] : []);
  const label = !S.f.tiers.length ? "All tiers" : S.f.tiers.length <= 2 ? "Tier " + S.f.tiers.join(", ") : `${S.f.tiers.length} tiers`;
  const toggle = (t: string, on: boolean) => {
    S.f.tiers = on ? [...S.f.tiers, t] : S.f.tiers.filter((x) => x !== t);
    X.rerender();
  };
  return (
    <div className={"ddrop" + (open ? " is-open" : "")} ref={box}>
      <button className={"ddrop-btn" + (S.f.tiers.length ? " on" : "")} aria-expanded={open} aria-controls="tier-menu" onClick={() => setOpen(!open)}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 7l9-4 9 4-9 4zM3 12l9 4 9-4M3 17l9 4 9-4" />
        </svg>
        {label}
        <svg className="chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open ? (
        <div className="ddrop-menu" id="tier-menu" role="group" aria-label="Tiers">
          {opts.map((t) => (
            <label key={t} className="ddrop-item" title={TIER_TIP[t]}>
              <input type="checkbox" checked={S.f.tiers.includes(t)} onChange={(e) => toggle(t, e.target.checked)} />
              <TierBadge t={t} small />
              <span className="hint">{t === "U" ? "Not researched yet" : (TIER_TIP[t] || "").replace(/^Tier \w: /, "")}</span>
            </label>
          ))}
          <div className="ddrop-foot">
            <button
              className="linkbtn"
              onClick={() => {
                S.f.tiers = [];
                X.rerender();
              }}
            >
              All tiers
            </button>
            <button className="btn small" onClick={() => setOpen(false)}>Done</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Bulk assign from the table: every contact at the ticked accounts goes to one person, so a company stays with one rep. */
function BulkBar({ X, accts, sel }: { X: Ctx; accts: Acct[]; sel: Set<string> }) {
  const picked = accts.filter((a) => sel.has(a.k));
  if (!picked.length) return null;
  const keys = new Set(picked.map((a) => a.k));
  const leads = visibleLeads(X).filter((l) => keys.has(coName(l.company).toLowerCase()));
  const rep: string = X.S.forms["bulk:rep"] ?? "";
  const busy = X.S.busy.has("bulk");
  const go = async () => {
    const to = rep || null;
    const before = leads.map((l) => ({ l, prev: (l.assigned_to as string) || null }));
    X.S.busy.add("bulk");
    X.rerender();
    const n = await assignLeadsBulk(X, leads, to);
    X.S.busy.delete("bulk");
    sel.clear();
    X.rerender();
    if (!n) return X.toast("Nothing changed: they already belong to that person.");
    const undo = async () => {
      const byPrev = new Map<string, Row[]>();
      for (const { l, prev } of before) {
        if (prev === to) continue;
        const k = prev || "";
        byPrev.set(k, [...(byPrev.get(k) || []), { ...l, assigned_to: to }]);
      }
      for (const [k, ls] of byPrev) await assignLeadsBulk(X, ls, k || null);
    };
    X.toast(`${plural(n, "contact")} at ${plural(picked.length, "account")} ${to ? "assigned to " + pname(X, to) : "unassigned"}.`, undo);
  };
  return (
    <div className="bulkbar" role="region" aria-label="Bulk assign">
      <strong>
        {plural(picked.length, "account")} · {plural(leads.length, "contact")} selected
      </strong>
      <label className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
        Assign to
        <select aria-label="Assign selected to" value={rep} onChange={(e) => { X.S.forms["bulk:rep"] = e.target.value; X.rerender(); }}>
          <option value="">Unassigned</option>
          {X.D.profiles
            .filter((u) => u.status === "active" && u.role)
            .sort((a, b) => pname(X, a.id).localeCompare(pname(X, b.id)))
            .map((u) => (
              <option key={u.id} value={u.id}>
                {pname(X, u.id)}
              </option>
            ))}
        </select>
      </label>
      <button className="btn small" disabled={busy} onClick={go}>
        {busy ? "Assigning…" : "Assign"}
      </button>
      <button className="btn ghost small" disabled={busy} onClick={() => { sel.clear(); X.rerender(); }}>
        Clear
      </button>
    </div>
  );
}

/** The few accounts to work next, each with why, how many calls so far and one button. Skipping hides one for the session, so the list ends. */
function NextUp({ X, accts, onOpen }: { X: Ctx; accts: Acct[]; onOpen: (k: string) => void }) {
  const skipped: Set<string> = X.S.forms["nextup-skip"] || (X.S.forms["nextup-skip"] = new Set<string>());
  const pool = accts
    .filter((a) => a.rank !== LOST && a.rank < 3 && !a.c.every((l) => l.dq_at) && a.c.some((l) => canActOn(X, l)))
    .sort((a, b) => priorityRank(a.pr.p) - priorityRank(b.pr.p) || tierRank(a.best) - tierRank(b.best) || a.name.localeCompare(b.name));
  const left = pool.filter((a) => !skipped.has(a.k));
  if (!pool.length) return null;
  const callsOf = (a: Acct) => {
    const ids = new Set(a.c.map((l) => l.id));
    return X.D.calls.filter((c) => ids.has(c.lead_id)).length;
  };
  return (
    <section className="nextup" aria-label="Next up">
      <div className="section-head">
        <h2>Next up</h2>
        <span className="note" role="status">{left.length ? `${Math.min(3, left.length)} of ${left.length} to work` : "You are through this list"}</span>
      </div>
      {left.length ? (
        <ol className="nextup-list">
          {left.slice(0, 3).map((a, i) => {
            const n = callsOf(a);
            return (
              <li key={a.k} className="nextup-item">
                <div className="nextup-main">
                  <strong>{a.name}</strong>
                  <span className="note">
                    {a.pr.reasons[0]} · {n ? `${n} call${n === 1 ? "" : "s"} so far` : "Not called yet"}
                  </span>
                </div>
                <div className="nextup-acts">
                  <button className={"btn small" + (i ? " ghost" : "")} onClick={() => onOpen(a.k)}>
                    {i ? "Open" : "Start"}
                  </button>
                  <button
                    className="btn ghost small"
                    onClick={() => {
                      skipped.add(a.k);
                      X.rerender();
                    }}
                  >
                    Skip for now
                  </button>
                </div>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="note">Nothing else is waiting here. Skipped accounts return when you reload.</p>
      )}
    </section>
  );
}

export default function AccountsTab() {
  const X = useX();
  const S = X.S;
  const viewInit = useRef(false);
  if (!viewInit.current) {
    viewInit.current = true;
    S.acctView = lsView();
  }
  const ls = filteredLeads(X),
    groups = new Map<string, Row[]>();
  ls.forEach((l) => {
    const k = coName(l.company).toLowerCase();
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(l);
  });
  const toAcct = (k: string, c: Row[]): Acct => {
    const st = acctStage(X, c);
    const best = c.map((x) => x.tier || "U").sort((a, b) => tierRank(a) - tierRank(b))[0];
    return {
      k,
      c,
      name: coName(c[0].company),
      best,
      st,
      rank: STAGES.findIndex((x) => x[0] === st.cls),
      owners: [...new Set(c.map((x) => assignedTo(x)).filter(Boolean))] as string[],
      day: c.map(rosterDay).sort().reverse()[0] || "",
      nJ: X.D.journeys.filter((j) => c.some((x) => x.id === j.lead_id)).length,
      pr: accountPriority(X, c, best),
    };
  };
  const accts: Acct[] = [...groups.entries()].map(([k, c]) => toAcct(k, c));
  const cmp: Record<string, (a: Acct, b: Acct) => number> = {
    tier: (a, b) => tierRank(a.best) - tierRank(b.best),
    priority: (a, b) => priorityRank(a.pr.p) - priorityRank(b.pr.p),
    company: (a, b) => a.name.localeCompare(b.name),
    contacts: (a, b) => b.c.length - a.c.length,
    stage: (a, b) => b.rank - a.rank,
    owner: (a, b) => (a.owners.length ? pname(X, a.owners[0]) : "~").localeCompare(b.owners.length ? pname(X, b.owners[0]) : "~"),
    next: (a, b) => (a.st.next || "~").localeCompare(b.st.next || "~"),
    day: (a, b) => b.day.localeCompare(a.day),
  };
  accts.sort((a, b) => S.f.dir * (cmp[S.f.sort] || cmp.tier)(a, b) || tierRank(a.best) - tierRank(b.best) || a.name.localeCompare(b.name));

  const setF = (k: keyof typeof S.f, v: any) => {
    (S.f as any)[k] = v;
    X.rerender();
  };
  const setView = (v: "table" | "board") => {
    S.acctView = v;
    S.panel = null;
    S.panelFull = false;
    try {
      localStorage.setItem("roster.acctView", v);
    } catch (_) {}
    smooth(X.rerender);
  };
  const sortBy = (k: string) => {
    if (S.f.sort === k) S.f.dir = (S.f.dir === 1 ? -1 : 1) as 1 | -1;
    else {
      S.f.sort = k;
      S.f.dir = 1;
    }
    X.rerender();
  };
  const bounds = rangeBounds(S.f.range, S.f.from, S.f.to);
  const tiersHere = new Set(visibleLeads(X).map((l) => l.tier || "U"));
  const controls = (
    <div className="controls">
      <div className="seg" role="group" aria-label="Layout">
        <button aria-pressed={S.acctView === "table"} onClick={() => setView("table")} title="Table">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
            <path d="M4 6h16M4 12h16M4 18h16" />
          </svg>
          Table
        </button>
        <button aria-pressed={S.acctView === "board"} onClick={() => setView("board")} title="Board">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
            <path d="M5 4h4v16H5zM10 4h4v10h-4zM15 4h4v13h-4z" />
          </svg>
          Board
        </button>
      </div>
      <label className={"range" + (S.f.range !== "all" ? " on" : "")}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
          <path d="M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zM4 10h16M8 3v4M16 3v4" />
        </svg>
        <select id="f-range" aria-label="Roster date" value={S.f.range} onChange={(e) => setF("range", e.target.value)}>
          {RANGES.map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </select>
        {bounds && S.f.range !== "custom" ? <span className="range-cap">{fmtRange(bounds)}</span> : null}
      </label>
      {S.f.range === "custom" ? (
        <span className="range-custom">
          <DateTimeField id="a-from" mode="date" label="From" clearable value={S.f.from} max={S.f.to || undefined} onChange={(v) => setF("from", v)} />
          <span className="muted">to</span>
          <DateTimeField id="a-to" mode="date" label="To" clearable value={S.f.to} min={S.f.from || undefined} onChange={(v) => setF("to", v)} />
        </span>
      ) : null}
      <TierFilter X={X} present={tiersHere} />
      <select id="f-appr" className={S.f.appr !== "all" ? "on" : ""} aria-label="Filter by status" value={S.f.appr} onChange={(e) => setF("appr", e.target.value)}>
        <option value="all">All contacts</option>
        <option value="mine">Assigned to me</option>
        {can(X, "assign_leads") ? <option value="unassigned">Unassigned</option> : null}
        <option value="pending">Not approved</option>
        <option value="approved">Approved</option>
        <option value="callback">Open callback</option>
        <option value="meeting">Meeting booked</option>
        <option value="dq">Disqualified</option>
      </select>
      <select id="f-scope" className={S.f.scope !== "all" ? "on" : ""} aria-label="Filter by persona" value={S.f.scope} onChange={(e) => setF("scope", e.target.value)}>
        <option value="all">All personas</option>
        {readIcp(X.D.settings.icp).personas.map((p) => (
          <option key={p.key} value={p.key}>
            {p.name}
          </option>
        ))}
      </select>
      <input id="f-q" type="search" placeholder="Search accounts and contacts" aria-label="Search accounts, contacts and angles" value={S.f.q} onChange={(e) => setF("q", e.target.value)} />
    </div>
  );
  // An account opened from its own link (or expanded) shows even when the filters would hide it.
  let panelAcct: Acct | undefined;
  if (S.panel && (S.acctView === "board" || S.panelFull)) {
    panelAcct = accts.find((a) => a.k === S.panel);
    if (!panelAcct && S.panelFull) {
      const all = visibleLeads(X).filter((l) => coName(l.company).toLowerCase() === S.panel);
      if (all.length) panelAcct = toAcct(S.panel, all);
    }
  }
  const moveAcct = S.move ? accts.find((a) => a.k === S.move!.k) : undefined;
  const overlays = (
    <>
      {panelAcct ? <Panel X={X} a={panelAcct} /> : null}
      {moveAcct && S.move ? <MoveDialog X={X} a={moveAcct} to={S.move.to} /> : null}
    </>
  );
  const reqs = <Requests X={X} />;
  if (!X.D.leads.length)
    return (
      <>
        {reqs}
        <GettingStarted
          X={X}
          onAdd={can(X, "add_company") ? () => ((X.S.modal = { type: "add", company: "", domain: "", name: "", title: "", linkedin: "", mode: "next" }), X.rerender()) : undefined}
        />
      </>
    );
  if (!accts.length)
    return (
      <>
        {reqs}
        {controls}
        <div className="empty">
          No accounts match these filters.{" "}
          <button
            className="linkbtn"
            onClick={() => {
              S.f = { ...S.f, range: "all", from: "", to: "", tiers: [], appr: "all", scope: "all", q: "" };
              X.rerender();
            }}
          >
            Clear filters
          </button>
        </div>
        {overlays}
      </>
    );
  const toggle = (k: string) => {
    S.openAcct.has(k) ? S.openAcct.delete(k) : S.openAcct.add(k);
    X.rerender();
  };
  const collapse = (k: string) => {
    S.openAcct.delete(k);
    X.rerender();
    setTimeout(() => {
      const el = document.querySelector(`details[data-acct="${CSS.escape(k)}"]`) as HTMLElement | null;
      if (el) {
        el.scrollIntoView({ block: "nearest" });
        (el.querySelector("summary") as HTMLElement | null)?.focus();
      }
    }, 0);
  };
  const selectable = S.acctView === "table" && can(X, "assign_leads");
  const sel: Set<string> = S.forms["acct:sel"] || (S.forms["acct:sel"] = new Set<string>());
  for (const k of [...sel]) if (!accts.some((a) => a.k === k)) sel.delete(k);
  const allSel = accts.length > 0 && accts.every((a) => sel.has(a.k));
  const pick = (k: string, on: boolean) => {
    on ? sel.add(k) : sel.delete(k);
    X.rerender();
  };
  return (
    <>
      <NextUp
        X={X}
        accts={accts}
        onOpen={(k) => {
          S.openAcct.add(k);
          X.rerender();
          setTimeout(() => {
            const el = document.querySelector(`details[data-acct="${CSS.escape(k)}"]`) as HTMLElement | null;
            if (el) el.scrollIntoView({ block: "start", behavior: "smooth" });
          }, 0);
        }}
      />
      {reqs}
      {controls}
      {selectable ? <BulkBar X={X} accts={accts} sel={sel} /> : null}
      <p className="note">
        {plural(accts.length, "account")} · {plural(ls.length, "contact")}.{" "}
        {S.acctView === "board" ? "Open a card for its journey and contacts, or drag it forward to the next stage." : "Open an account to see its deal journey and contacts."}
      </p>
      {S.acctView === "board" ? (
        <Board X={X} accts={accts} />
      ) : (
        <div className={"list stack atable" + (selectable ? " selectable" : "")}>
          <div className="thead" role="group" aria-label="Sort accounts">
            {selectable ? (
              <span className="c-sel">
                <input
                  type="checkbox"
                  aria-label={allSel ? "Clear selection" : "Select every account shown"}
                  checked={allSel}
                  onChange={(e) => {
                    accts.forEach((a) => (e.target.checked ? sel.add(a.k) : sel.delete(a.k)));
                    X.rerender();
                  }}
                />
              </span>
            ) : null}
            {COLS.map(([k, l]) => (
              <span key={k} className={"c-" + k}>
                <button
                  className={"sorter" + (S.f.sort === k ? " on" : "")}
                  onClick={() => sortBy(k)}
                  aria-pressed={S.f.sort === k}
                  aria-label={`Sort by ${l}` + (S.f.sort === k ? (S.f.dir === 1 ? ", sorted" : ", reversed") : "")}
                >
                  {l}
                  <span className="sort-ic" aria-hidden="true">{S.f.sort === k ? (S.f.dir === 1 ? "↓" : "↑") : "↕"}</span>
                </button>
              </span>
            ))}
            <span className="c-act" aria-hidden="true" />
          </div>
          {accts.map((a) => {
            const c = a.c[0],
              open = S.openAcct.has(a.k),
              adj = a.c.find((x) => x.adjacency && x.adjacency !== "none"),
              emp = fmtEmployees(c.employees);
            return (
              <details key={a.k} className="card acct" data-acct={a.k} open={open}>
                <summary
                  onClick={(e) => {
                    e.preventDefault();
                    toggle(a.k);
                  }}
                >
                  {selectable ? (
                    <span className="c-sel" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" aria-label={`Select ${a.name}`} checked={sel.has(a.k)} onChange={(e) => pick(a.k, e.target.checked)} />
                    </span>
                  ) : null}
                  <span className="c-tier">
                    <TierTag X={X} a={a} />
                  </span>
                  <span className="c-priority">
                    <PriorityMark pr={a.pr} />
                  </span>
                  <span className="c-company">
                    <strong>{a.name}</strong>
                    {adj ? <span className="pill adj">adjacency</span> : null}
                    <span className="sub2">
                      {c.segment || ""}
                      {emp ? ` · ${emp}` : ""}
                      {c.domain ? ` · ${c.domain}` : ""}
                    </span>
                  </span>
                  <span className="c-contacts acct-angle">
                    <b>{a.c.length}</b> {a.c.map((x) => splitName(x.name).first).join(", ")}
                  </span>
                  <span className="c-stage">
                    <span className={"stage " + a.st.cls} title={a.st.label}>{STAGES[a.rank]?.[1] || a.st.label}</span>
                  </span>
                  <span className="c-owner">
                    <Owners X={X} a={a} short />
                  </span>
                  <span className="c-next">
                    {a.st.next ? (
                      <>
                        <span className="nx-day">{fmtDay(a.st.next)}</span>
                        <span className="sub2">{fmtTime(a.st.next)}</span>
                      </>
                    ) : a.nJ ? (
                      <span className="sub2">{plural(a.nJ, "call note")}</span>
                    ) : (
                      <span className="faint">—</span>
                    )}
                  </span>
                  <span className="c-day">{a.day ? fmtDay(a.day) : "—"}</span>
                  <span className="c-act">
                    <AltContactsBtn X={X} a={a} compact />
                  </span>
                </summary>
                {open ? (
                  <div className="acct-open">
                    <AccountBody X={X} a={a} />
                    <div className="acct-foot">
                      <button
                        className="btn ghost small"
                        onClick={() => {
                          S.panel = a.k;
                          S.panelFull = true;
                          X.rerender();
                        }}
                      >
                        Expand
                      </button>
                      <button className="btn ghost small" aria-label={`Minimise ${a.name}`} onClick={() => collapse(a.k)}>
                        ▲ Minimise {a.name}
                      </button>
                    </div>
                  </div>
                ) : null}
              </details>
            );
          })}
        </div>
      )}
      {overlays}
    </>
  );
}
