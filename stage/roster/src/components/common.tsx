import type { ReactNode } from "react";
import DateTimeField from "./DateTimeField";
import type { Ctx } from "../lib/ctx";
import { can, bookingLink } from "../lib/perms";
import { dnpRetryWall, doDelete, formFor, nowWall, OUTCOMES, submitOutcome } from "../lib/actions";

export async function copyText(X: Ctx, txt: string) {
  try {
    await navigator.clipboard.writeText(txt);
    X.toast("Copied.");
  } catch (_) {
    X.toast("Copy blocked here. Select the text and copy it.");
  }
}

export function askDel(X: Ctx, k: string) {
  X.S.confirmDel = k;
  X.rerender();
}
export function noDel(X: Ctx) {
  X.S.confirmDel = null;
  X.rerender();
}

/** Delete button with an inline confirm, shown only with delete_records. */
export function DelConfirm({ X, kind, id, label }: { X: Ctx; kind: string; id: string; label: string }) {
  if (!can(X, "delete_records")) return null;
  const k = kind + ":" + id;
  if (X.S.confirmDel === k)
    return (
      <div className="confirm">
        Delete this {label}?
        <button className="btn danger small" onClick={() => doDelete(X, k)}>Delete</button>
        <button className="btn ghost small" onClick={() => noDel(X)}>Keep</button>
      </div>
    );
  return (
    <button className="btn danger small" aria-label={`Delete ${label}`} onClick={() => askDel(X, k)}>
      Delete
    </button>
  );
}

/** Overflow menu ("⋯") for secondary and destructive actions. Closes on outside click via <details>. */
export function MoreMenu({ label, children }: { label: string; children: ReactNode }) {
  return (
    <details className="more">
      <summary aria-label={label} title={label}>
        <span aria-hidden="true">⋯</span>
      </summary>
      <div className="more-menu" role="menu">
        {children}
      </div>
    </details>
  );
}

/** Opens the shared HubSpot booking link in a new tab, with a copy fallback. */
export function BookSlot({ X, small = true }: { X: Ctx; small?: boolean }) {
  const link = bookingLink(X);
  if (!link) return <span className="note">Add a booking link in Admin &gt; Setup to book from here.</span>;
  return (
    <span className="book-slot">
      <a className={"btn" + (small ? " small" : "")} href={link} target="_blank" rel="noopener">
        Book a slot
      </a>
      <button className={"btn ghost" + (small ? " small" : "")} onClick={() => copyText(X, link)}>
        Copy link
      </button>
    </span>
  );
}

/** "When did the call happen" field: defaults to now, can be set back for calls logged later (admins see backdated logs). */
export function CallTimeField({ id, value, onChange, label = "Call time (IST)" }: { id: string; value: string; onChange: (v: string) => void; label?: string }) {
  const now = nowWall();
  const back = value && value < now.slice(0, 16) && Date.now() - new Date(value + ":00+05:30").getTime() > 30 * 60000;
  return (
    <label>
      {label}
      <DateTimeField id={id} label={label} value={value || now.slice(0, 16)} max={now.slice(0, 16)} onChange={onChange} />
      {back ? <span className="hint">Backdated. Admins see when a call is logged after the fact.</span> : null}
    </label>
  );
}

/** The call outcome cycle: one outcome dropdown plus the form for the chosen outcome. */
export function outcomeUI(X: Ctx, leadId: string, cbId: string | null): { control: ReactNode; form: ReactNode } {
  const key = cbId ? "cb:" + cbId : "ld:" + leadId,
    f = formFor(X, key),
    busy = X.S.busy.has(key);
  const id = key.replace(/[^a-z0-9]/gi, "_");
  const set = (field: string, v: string, re = true) => {
    f[field] = v;
    if (re) X.rerender();
  };
  const submit = () => submitOutcome(X, leadId, cbId);
  const control = (
    <label className="outcome">
      <span className="outcome-label">Call outcome</span>
      <select id={`oc-${id}`} aria-label="Call outcome" value={f.outcome} onChange={(e) => set("outcome", e.target.value)} className={f.outcome ? "on" : ""}>
        <option value="">Log an outcome…</option>
        {OUTCOMES.map(([v, l, lcb]) => (
          <option key={v} value={v}>
            {cbId ? lcb : l}
          </option>
        ))}
      </select>
    </label>
  );
  const when = <CallTimeField id={`at-${id}`} value={f.at} onChange={(v) => set("at", v)} />;
  const save = (label: string) => (
    <div className="row full">
      <button className="btn" disabled={busy} onClick={submit}>{busy ? "Saving…" : label}</button>
      <button className="btn ghost" disabled={busy} onClick={() => set("outcome", "")}>Cancel</button>
    </div>
  );
  let form: ReactNode = null;
  if (f.outcome === "yes")
    form = (
      <div className="form">
        <div className="note full">
          Book the slot through HubSpot, then enter the time here. The invite comes from HubSpot, and the Meet link is read from your calendar.{" "}
          <BookSlot X={X} />
        </div>
        {when}
        <label>
          Meeting date and time (IST)
          <DateTimeField id={`w-${id}`} label="Meeting date and time" value={f.when} onChange={(v) => set("when", v)} />
        </label>
        <label>
          Format
          <select id={`m-${id}`} value={f.mode} onChange={(e) => set("mode", e.target.value)}>
            <option value="online">Online (Google Meet)</option>
            <option value="offline">Offline (in person)</option>
          </select>
        </label>
        {f.mode === "offline" ? (
          <label className="full">
            Location
            <input id={`l-${id}`} value={f.location} placeholder="Office address" onChange={(e) => set("location", e.target.value)} />
          </label>
        ) : null}
        {save("Save meeting")}
      </div>
    );
  if (f.outcome === "callback")
    form = (
      <div className="form">
        {when}
        <label>
          Callback date and time (IST)
          <DateTimeField id={`w-${id}`} label="Callback date and time" value={f.when} onChange={(v) => set("when", v)} />
        </label>
        <label className="full">
          Agenda
          <textarea id={`a-${id}`} value={f.agenda} placeholder="What they asked for, what to bring back, who else joins" onChange={(e) => set("agenda", e.target.value)} />
        </label>
        {save("Save callback")}
      </div>
    );
  if (f.outcome === "dnp") {
    if (!f.dnpWhen) f.dnpWhen = dnpRetryWall();
    form = (
      <div className="form">
        {when}
        <label>
          Call back on (IST) <span className="req-mark" aria-hidden="true">*</span>
          <DateTimeField id={`dw-${id}`} label="Call back on" required min={nowWall().slice(0, 16)} value={f.dnpWhen} onChange={(v) => set("dnpWhen", v)} />
        </label>
        <label className="full">
          Note for the retry (optional)
          <input id={`dn-${id}`} value={f.dnpNote} placeholder="e.g. try their mobile, or after 4 PM" onChange={(e) => set("dnpNote", e.target.value)} />
        </label>
        <p className="note full">Every DNP sets a callback. It counts as a dial without a connect, and the retry goes to your callbacks and Google Tasks.</p>
        {save("Log DNP and set callback")}
      </div>
    );
  }
  if (f.outcome === "no" || f.outcome === "wrong_icp")
    form = (
      <div className="form">
        {when}
        <p className="note">
          {f.outcome === "wrong_icp"
            ? "Disqualifies this contact as the wrong person to call. You can then find other marketing leaders at the account."
            : "Logs a connected call with no meeting booked. The contact stays open for another attempt."}
        </p>
        {save(f.outcome === "wrong_icp" ? "Mark Wrong ICP" : "Log call")}
      </div>
    );
  return { control, form };
}
