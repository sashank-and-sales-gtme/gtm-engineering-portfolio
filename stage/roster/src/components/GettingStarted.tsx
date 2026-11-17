import { useEffect } from "react";
import Icon from "./Icon";
import type { Ctx } from "../lib/ctx";
import { can } from "../lib/perms";
import { loadInteg } from "./Integrations";

/* Accounts, before the first batch: what's left before accounts start arriving. Admins get the checklist with a way
   into each step; everyone else is told the workspace is still being set up. */

export default function GettingStarted({ X, onAdd }: { X: Ctx; onAdd?: () => void }) {
  const admin = can(X, "manage_integrations");
  const integ = X.S.integ.data;
  useEffect(() => {
    if (admin && !integ && !X.S.integ.loading) loadInteg(X, true);
  }, []);
  const open = (sec: string) => {
    X.S.adminSec = sec;
    X.S.tab = "admin";
    X.rerender();
  };
  const setup = !!(X.D.settings.onboarding && X.D.settings.onboarding.completed_at);
  const reps = (X.D.reps || []).filter((r: any) => r.in_rotation).length;
  const on = (p: string) => !!(integ && integ.providers && integ.providers[p] && integ.providers[p].connected);
  const worker = !!(integ && integ.worker && integ.worker.active);

  if (!admin) {
    return (
      <div className="first-run">
        <h2>No accounts yet</h2>
        <p className="note">
          {setup
            ? "The first weekly batch lands here, grouped by account, once it's built."
            : "Your workspace is still being set up. Accounts land here once an admin finishes setup and the first weekly batch is built."}
        </p>
        {onAdd && setup ? <button className="btn" onClick={onAdd}>Add a company</button> : null}
      </div>
    );
  }

  const items: Array<{ ok: boolean; title: string; body: string; act: [string, () => void] }> = [
    { ok: setup, title: "Finish setup", body: "Your company, pitch, documents, proof, target companies and each persona's pains. Research waits for it.", act: ["Open setup", () => open("setup")] },
    { ok: on("apollo"), title: "Connect Apollo", body: "The weekly search and contact details come from your Apollo account.", act: ["Open Integrations", () => open("integ")] },
    { ok: worker, title: "Start the Claude worker", body: "It researches each account and drafts the emails.", act: ["Open Integrations", () => open("integ")] },
    { ok: reps > 0, title: "Put a rep in rotation", body: "Each rep in rotation gets a weekly batch from their segment.", act: ["Open reps", () => open("reps")] },
    { ok: on("hubspot"), title: "Connect HubSpot (recommended)", body: "Accounts already in your CRM are skipped before research.", act: ["Open Integrations", () => open("integ")] },
  ];
  const left = items.filter((i) => !i.ok).length;
  return (
    <div className="first-run">
      <h2>{left ? "Get your first batch" : "You're set up"}</h2>
      <p className="note">
        {left
          ? `${left} of ${items.length} left. The weekly batch is built every Friday for Monday; adding a company researches it straight away.`
          : "The next weekly batch lands here on Monday. Add a company to research one now."}
      </p>
      <ol className="setup-checks">
        {items.map((i) => (
          <li key={i.title} className={"setup-check" + (i.ok ? " done" : "")}>
            <span className="setup-mark" aria-hidden="true">{i.ok ? <Icon name="check" size={13} /> : ""}</span>
            <div>
              <strong>{i.title}</strong>
              <span className="sr-only">{!integ && i.title !== "Finish setup" && i.title !== "Put a rep in rotation" ? " (checking)" : i.ok ? " (done)" : " (not done)"}</span>
              <p className="note">{i.body}</p>
            </div>
            {i.ok ? null : <button className="btn ghost small" onClick={i.act[1]}>{i.act[0]}</button>}
          </li>
        ))}
      </ol>
      {onAdd && setup ? (
        <div className="row">
          <button className="btn" onClick={onAdd}>Add a company</button>
        </div>
      ) : null}
    </div>
  );
}
