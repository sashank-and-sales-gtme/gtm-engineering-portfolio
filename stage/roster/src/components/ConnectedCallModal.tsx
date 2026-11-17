import { useDialog } from "../lib/useDialog";
import { useEffect, useRef } from "react";
import { useX, type Ctx } from "../lib/ctx";
import type { Row } from "../lib/data";
import { coName, splitName } from "../lib/format";
import { can, leadById, meetingFor } from "../lib/perms";
import { submitCtx } from "../lib/actions";
import { loadInteg } from "./Integrations";
import { CallTimeField } from "./common";
import { readProfile } from "../lib/profile";

function CtxPreview({ X, l }: { X: Ctx; l: Row }) {
  const m = meetingFor(X, l.id),
    { first, masked } = splitName(l.name);
  if (!can(X, "hubspot_notes")) return <li>The note stays in the roster only. Your role does not save call context to HubSpot.</li>;
  const d = X.S.integ.data;
  const hs = d && d.providers && d.providers.hubspot;
  const hsOn = !!hs && hs.status !== "disconnected" && hs.status !== "error" && (!!hs.connected || hs.status === "connected");
  if (!d)
    return (
      <li className="muted">
        {X.S.integ.err ? "HubSpot's status couldn't be checked; if it isn't connected, this saves in the roster only." : "Checking whether HubSpot is connected…"}
      </li>
    );
  if (!hsOn) return <li>HubSpot isn't connected, so this saves in the roster only.</li>;
  if (m)
    return (
      <li>
        Adds a note to the {coName(l.company)} "&lt;&gt; {readProfile(X.D.settings.profile).company_name || "your company"} POC" deal in HubSpot. If no deal exists yet, the note goes to the contact and is flagged.
      </li>
    );
  if (l.hubspot_contact_id) return <li>Adds a note to the existing HubSpot contact for {l.name}.</li>;
  return (
    <>
      <li>
        Looks for {first} at {coName(l.company)} in HubSpot. If not found, creates the contact (owned by you): {first}
        {masked ? " (last name hidden until enrichment)" : ""}, {l.title}, {coName(l.company)}
        {l.enrichment && l.enrichment.email ? ", " + l.enrichment.email : ""}, linked to the HubSpot company when it exists.
      </li>
      <li>Adds this context as a note on that contact.</li>
    </>
  );
}

export function closeCtx(X: Ctx) {
  const M = X.S.modal;
  if (M && M.type === "ctx") X.S.forms["ctx:" + M.leadId] = M.text;
  X.S.modal = null;
  X.rerender();
}

export default function ConnectedCallModal() {
  const X = useX();
  const M = X.S.modal;
  const ref = useRef<HTMLTextAreaElement>(null);
  const box = useDialog<HTMLDivElement>(() => closeCtx(X));
  useEffect(() => {
    ref.current && ref.current.focus();
    if (!X.S.integ.data && !X.S.integ.loading) loadInteg(X, true);
  }, []);
  if (!M || M.type !== "ctx") return null;
  const l = leadById(X, M.leadId);
  if (!l) return null;
  return (
    <div
      className="modal"
      onClick={(e) => {
        if (e.target === e.currentTarget) closeCtx(X);
      }}
    >
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="ctx-h" ref={box}>
        <h2 id="ctx-h">Connected call: {l.name}</h2>
        <p className="note">
          {l.title} · {coName(l.company)}
        </p>
        <div className="form" style={{ marginBottom: 10 }}>
          <CallTimeField
            id="ctx-at"
            label="When the call happened (IST)"
            value={M.at || ""}
            onChange={(v) => {
              M.at = v;
              X.rerender();
            }}
          />
        </div>
        <label className="note" htmlFor="ctx-text">Conversation context</label>
        <textarea
          id="ctx-text"
          ref={ref}
          style={{ minHeight: 160 }}
          placeholder="What they said, pains raised, objections, who else is involved, agreed next step"
          value={M.text}
          onChange={(e) => {
            M.text = e.target.value;
            X.rerender();
          }}
        />
        <div className="preview">
          <b>On submit</b>
          <ul>
            <li>Saves to the {coName(l.company)} deal journey in this roster.</li>
            <CtxPreview X={X} l={l} />
          </ul>
        </div>
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button className="btn ghost" onClick={() => closeCtx(X)}>Cancel</button>
          <button className="btn" onClick={() => submitCtx(X, l.id, M.text, M.at || "")}>Save context</button>
        </div>
      </div>
    </div>
  );
}
