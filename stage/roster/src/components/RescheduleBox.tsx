import type { Ctx } from "../lib/ctx";
import type { Row } from "../lib/data";
import { draftReschedule, saveRescheduleDraft } from "../lib/actions";
import { shortName } from "../lib/format";
import { copyDraft, copySubject, draftHtml } from "./DraftBox";

const READ_LABEL: Array<[string, string]> = [
  ["reason", "Why it moved"],
  ["constraints", "Timing they asked for"],
  ["tone", "Their tone"],
  ["timezone", "Timezone"],
];

/** A reply for a meeting in the reschedule queue: 5 new times from the rep's calendar, fitted to what the prospect wrote. */
export default function RescheduleBox({ X, m }: { X: Ctx; m: Row }) {
  const d = X.D.rdrafts.find((x) => x.meeting_id === m.id);
  const busy = X.S.busy.has("rsd:" + m.id);
  const fk = "rsedit:" + (d ? d.id : "");
  const editing = d && fk in X.S.forms;
  const who = shortName(m.contact).split(" ")[0] || "them";

  if (!d)
    return (
      <div className="draft draft-empty rs-start">
        <button className="btn small" disabled={busy} onClick={() => draftReschedule(X, m.id)}>
          {busy ? "Reading your inbox…" : "Draft reply with 5 new times"}
        </button>
        <span className="note">
          Reads your recent emails with {who} and your calendar, then writes a reply they can answer with one time. No booking link.
        </span>
      </div>
    );
  if (d.status === "drafting" || busy)
    return (
      <div className="draft draft-wait" role="status">
        {busy ? "Reading your inbox and calendar…" : "Queued for the Claude worker. The reply appears here when it runs."}
      </div>
    );
  if (d.status === "failed")
    return (
      <div className="draft draft-failed">
        <p className="err small">The reply didn't finish. {d.error || ""}</p>
        <button className="btn ghost small" onClick={() => draftReschedule(X, m.id)}>Try again</button>
      </div>
    );

  const flags: string[] = Array.isArray(d.flags) ? d.flags : [];
  const read = (d.read || {}) as Record<string, string>;
  const readRows = READ_LABEL.filter(([k]) => read[k] && String(read[k]).trim());
  const startEdit = () => {
    X.S.forms[fk] = { subject: d.subject || "", body: d.body || "" };
    X.rerender();
  };
  const stopEdit = async (save: boolean) => {
    const f = X.S.forms[fk];
    delete X.S.forms[fk];
    X.rerender();
    if (save && f && (f.subject !== d.subject || f.body !== d.body)) await saveRescheduleDraft(X, d.id, { subject: f.subject, body: f.body });
  };
  return (
    <section className="draft rs-draft" aria-label="Reschedule reply">
      <header className="draft-head">
        <span className="draft-kind">
          Reply with 5 new times{d.edited ? ", edited" : ""}
        </span>
      </header>
      {readRows.length ? (
        <dl className="rs-read">
          {readRows.map(([k, l]) => (
            <div key={k}>
              <dt>{l}</dt>
              <dd>{read[k]}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {flags.length > 0 && (
        <div className="draft-flags">
          <b>Check before sending</b>
          <ul>
            {flags.map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ul>
        </div>
      )}
      {editing ? (
        <div className="draft-edit">
          <label className="note" htmlFor={"rss-" + d.id}>Subject</label>
          <input
            id={"rss-" + d.id}
            value={X.S.forms[fk].subject}
            onChange={(e) => {
              X.S.forms[fk].subject = e.target.value;
              X.rerender();
            }}
          />
          <label className="note" htmlFor={"rsb-" + d.id}>Body</label>
          <textarea
            id={"rsb-" + d.id}
            style={{ minHeight: 200 }}
            value={X.S.forms[fk].body}
            onChange={(e) => {
              X.S.forms[fk].body = e.target.value;
              X.rerender();
            }}
          />
          <div className="row draft-actions">
            <button className="btn ghost small" onClick={() => stopEdit(false)}>Cancel</button>
            <button className="btn small" onClick={() => stopEdit(true)}>Save</button>
          </div>
        </div>
      ) : (
        <>
          <p className="draft-subject">
            <span className="note">Subject</span> {d.subject}
          </p>
          <div className="draft-body" dangerouslySetInnerHTML={{ __html: draftHtml(d.body || "") }} />
          <div className="row draft-actions">
            <button className="btn small" onClick={() => copyDraft(X, d)}>Copy reply</button>
            <button className="btn ghost small" onClick={() => copySubject(X, d)}>Copy subject</button>
            <button className="btn ghost small" onClick={startEdit}>Edit</button>
            <button className="btn ghost small" disabled={busy} onClick={() => draftReschedule(X, m.id)}>Redraft</button>
          </div>
          <p className="note">When they pick a time, enter it above and press Rebook.</p>
        </>
      )}
    </section>
  );
}
