import type { Ctx } from "../lib/ctx";
import type { Row } from "../lib/data";
import { draftEmail, saveDraft } from "../lib/actions";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The draft's light markdown (bold, links, "* " bullets) as email-safe HTML. Input is escaped first. */
export function draftHtml(md: string): string {
  const inline = (s: string) =>
    esc(s)
      .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
  return md
    .trim()
    .split(/\n{2,}/)
    .map((block) => {
      const lines = block.split("\n");
      if (lines.every((l) => /^\* /.test(l))) return "<ul>" + lines.map((l) => "<li>" + inline(l.slice(2)) + "</li>").join("") + "</ul>";
      return "<p>" + lines.map(inline).join("<br>") + "</p>";
    })
    .join("");
}
const draftText = (md: string) => md.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1 ($2)");

export async function copyDraft(X: Ctx, d: Row) {
  const html = draftHtml(d.body || ""), text = draftText(d.body || "");
  try {
    if (window.ClipboardItem && navigator.clipboard.write) {
      await navigator.clipboard.write([
        new ClipboardItem({ "text/html": new Blob([html], { type: "text/html" }), "text/plain": new Blob([text], { type: "text/plain" }) }),
      ]);
    } else await navigator.clipboard.writeText(text);
    X.toast("Email copied. Paste it into your mail client.");
  } catch (_) {
    X.toast("Couldn't copy. Select the text and copy it instead.");
  }
}
export async function copySubject(X: Ctx, d: Row) {
  try {
    await navigator.clipboard.writeText(d.subject || "");
    X.toast("Subject copied.");
  } catch (_) {
    X.toast("Couldn't copy the subject.");
  }
}

export default function DraftBox({ X, j }: { X: Ctx; j: Row }) {
  const d = X.D.drafts.find((x) => x.journey_id === j.id);
  const busy = X.S.busy.has("draft:" + j.id);
  const fk = "draftedit:" + (d ? d.id : "");
  const editing = d && fk in X.S.forms;
  const rerender = () => X.rerender();

  if (!d)
    return (
      <div className="draft draft-empty">
        <button className="btn ghost small" disabled={busy} onClick={() => draftEmail(X, j.id)}>
          {busy ? "Starting…" : "Draft follow-up email"}
        </button>
      </div>
    );
  if (d.status === "drafting" || busy)
    return (
      <div className="draft draft-wait" role="status">
        Queued for the Claude worker. The draft appears here when it runs.
      </div>
    );
  if (d.status === "failed")
    return (
      <div className="draft draft-failed">
        <p className="err small">The draft didn't finish. {d.error || ""}</p>
        <button className="btn ghost small" onClick={() => draftEmail(X, j.id)}>Try again</button>
      </div>
    );

  const flags: string[] = Array.isArray(d.flags) ? d.flags : [];
  const startEdit = () => {
    X.S.forms[fk] = { subject: d.subject || "", body: d.body || "" };
    rerender();
  };
  const stopEdit = async (save: boolean) => {
    const f = X.S.forms[fk];
    delete X.S.forms[fk];
    rerender();
    if (save && f && (f.subject !== d.subject || f.body !== d.body)) await saveDraft(X, d.id, { subject: f.subject, body: f.body });
  };

  return (
    <section className="draft" aria-label="Follow-up email draft">
      <header className="draft-head">
        <span className="draft-kind">
          Follow-up {d.format === "brief" ? "brief" : "note"}
          {d.words ? `, ${d.words} words` : ""}
          {d.edited ? ", edited" : ""}
        </span>
      </header>

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
          <label className="note" htmlFor={"ds-" + d.id}>Subject</label>
          <input
            id={"ds-" + d.id}
            value={X.S.forms[fk].subject}
            onChange={(e) => {
              X.S.forms[fk].subject = e.target.value;
              rerender();
            }}
          />
          <label className="note" htmlFor={"db-" + d.id}>Body</label>
          <textarea
            id={"db-" + d.id}
            style={{ minHeight: 180 }}
            value={X.S.forms[fk].body}
            onChange={(e) => {
              X.S.forms[fk].body = e.target.value;
              rerender();
            }}
          />
          <p className="note">**bold** and [text](link) stay formatted when you copy.</p>
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
            <button className="btn small" onClick={() => copyDraft(X, d)}>Copy email</button>
            <button className="btn ghost small" onClick={() => copySubject(X, d)}>Copy subject</button>
            <button className="btn ghost small" onClick={startEdit}>Edit</button>
            <button className="btn ghost small" disabled={busy} onClick={() => draftEmail(X, j.id)}>Regenerate</button>
          </div>
        </>
      )}
    </section>
  );
}
