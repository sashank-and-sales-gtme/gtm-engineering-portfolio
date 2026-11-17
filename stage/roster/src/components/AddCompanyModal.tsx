import { useEffect, useRef } from "react";
import { useDialog } from "../lib/useDialog";
import { useX } from "../lib/ctx";
import { submitAdd } from "../lib/actions";
import { can, pname, runsOthersAdds } from "../lib/perms";

export default function AddCompanyModal() {
  const X = useX();
  const a = X.S.modal;
  const ref = useRef<HTMLInputElement>(null);
  const box = useDialog<HTMLDivElement>(() => {
    X.S.modal = null;
    X.rerender();
  });
  useEffect(() => {
    ref.current && ref.current.focus();
  }, []);
  if (!a || a.type !== "add") return null;
  const set = (k: "company" | "domain" | "name" | "title" | "linkedin", v: string) => {
    a[k] = v;
    X.rerender();
  };
  const close = () => {
    X.S.modal = null;
    X.rerender();
  };
  const busy = X.S.busy.has("add");
  const domainOk = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(a.domain.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, ""));
  const errs = {
    company: a.company.trim() ? "" : "Add the company's name.",
    domain: !a.domain.trim() ? "Add the company's website domain." : domainOk ? "" : "Use a domain like example.com.",
  };
  const shown = (k: "company" | "domain") => (a.tried ? errs[k] : "");
  const submit = () => {
    const bad = (["company", "domain"] as const).find((k) => errs[k]);
    if (bad) {
      a.tried = true;
      X.rerender();
      document.getElementById("ad-" + bad)?.focus();
      return;
    }
    submitAdd(X);
  };
  return (
    <div
      className="modal"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="add-h" ref={box}>
        <h2 id="add-h">Add a company</h2>
        <p className="hint" style={{ margin: 0 }}>
          Fields marked <span className="req-mark" aria-hidden="true">*</span> are required.
        </p>
        <div className="form" style={{ background: "none", border: 0, padding: 0 }}>
          <label>
            <span>
              Company name <span className="req-mark" aria-hidden="true">*</span>
            </span>
            <input id="ad-company" ref={ref} required aria-required="true" aria-invalid={!!shown("company") || undefined} aria-describedby={shown("company") ? "ad-company-err" : undefined} value={a.company} onChange={(e) => set("company", e.target.value)} />
            {shown("company") ? <span className="field-err" id="ad-company-err">{shown("company")}</span> : null}
          </label>
          <label>
            <span>
              Website domain <span className="req-mark" aria-hidden="true">*</span>
            </span>
            <input id="ad-domain" required aria-required="true" aria-invalid={!!shown("domain") || undefined} aria-describedby={shown("domain") ? "ad-domain-err" : undefined} value={a.domain} placeholder="example.com" onChange={(e) => set("domain", e.target.value)} />
            {shown("domain") ? <span className="field-err" id="ad-domain-err">{shown("domain")}</span> : null}
          </label>
          <label>
            Contact name (optional)
            <input id="ad-name" value={a.name} onChange={(e) => set("name", e.target.value)} />
          </label>
          <label>
            Title (optional)
            <input id="ad-title" value={a.title} onChange={(e) => set("title", e.target.value)} />
          </label>
          <label className="full">
            LinkedIn URL (optional)
            <input id="ad-li" value={a.linkedin} onChange={(e) => set("linkedin", e.target.value)} />
          </label>
        </div>
        {runsOthersAdds(X) ? (
          <div className="form" style={{ background: "none", border: 0, padding: 0 }}>
            <label className="full">
              Add for
              <select
                id="ad-for"
                value={a.for || X.uid}
                onChange={(e) => {
                  a.for = e.target.value;
                  X.rerender();
                }}
              >
                {X.D.profiles
                  .filter((u) => u.status === "active" && (u.role || u.is_owner))
                  .sort((x, y) => (x.id === X.uid ? -1 : y.id === X.uid ? 1 : pname(X, x.id).localeCompare(pname(X, y.id))))
                  .map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.id === X.uid ? `Me (${pname(X, u.id)})` : pname(X, u.id)}
                    </option>
                  ))}
              </select>
              <span className="note">The account and its leads go to this person, in their batch.</span>
            </label>
          </div>
        ) : null}
        <fieldset style={{ border: "1px solid var(--line)", borderRadius: 8, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
          <legend className="note">When</legend>
          <label className="row">
            <input
              type="radio"
              name="ad-mode"
              id="ad-next"
              value="next"
              checked={a.mode === "next"}
              onChange={() => {
                a.mode = "next";
                X.rerender();
              }}
            />
            Schedule for the next batch <span className="note">(Friday's build researches it in {a.for && a.for !== X.uid ? pname(X, a.for) + "'s" : "your"} batch)</span>
          </label>
          <label className="row">
            <input
              type="radio"
              name="ad-mode"
              id="ad-now"
              value="now"
              checked={a.mode === "now"}
              disabled={!can(X, "enrich_now")}
              onChange={() => {
                a.mode = "now";
                X.rerender();
              }}
            />
            Enrich now and run the research gates
            {!can(X, "enrich_now") ? <span className="note">(your role can't enrich now)</span> : null}
          </label>
        </fieldset>
        {a.mode === "now" ? (
          <div className="preview" role="note">
            <strong>{a.name.trim() ? "Uses about 1 Apollo credit." : "Search is free. Credits only when you enrich."}</strong>{" "}
            {a.name.trim()
              ? `Enriching ${a.name.trim()} uses about 1 Apollo credit (standard match, work email only, no phone or waterfall). HubSpot is checked first, then the Claude worker researches it on its next run and the lead lands in Accounts as approved.`
              : `No contact named: a free Apollo search lists India-based marketing leaders at ${a.domain || "this domain"}. You pick who to enrich, and see the credit cost before anything is spent.`}
          </div>
        ) : null}
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button className="btn ghost" onClick={close}>Cancel</button>
          <button className="btn" disabled={busy} onClick={submit}>
            {a.mode === "now" && a.name.trim() ? "Confirm and enrich" : a.mode === "now" ? "Find contacts" : "Add to next batch"}
          </button>
        </div>
      </div>
    </div>
  );
}
