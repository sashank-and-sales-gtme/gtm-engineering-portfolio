import type { Ctx } from "../lib/ctx";
import { can } from "../lib/perms";
import { audit } from "../lib/actions";
import { supabase } from "../lib/supabase";
import { APOLLO_SENIORITIES, DEFAULT_ICP, type Icp, type Pain, type Persona, readIcp, slug, type Trigger, TRIGGER_LABEL, TRIGGERS } from "../lib/icp";
import { proofTexts, readProfile } from "../lib/profile";

/* Admin > ICP personas: who the roster targets at each account. The weekly build and add-company searches use the
   Apollo titles, seniorities and locations; the seniority words filter what Apollo returns; the researcher gets the
   personas (what each owns, which proof points fit) in every task and tags each lead with its persona. */

type PDraft = { key: string; name: string; active: boolean; triggers: Trigger[]; fallback: boolean; match: string; titles: string; proof: string[]; description: string; pains: Pain[]; isNew?: boolean };
type Draft = { locations: string; seniorities: string[]; senior: string; junior: string; excluded: string; personas: PDraft[]; open: string | null };

const csv = (a: string[]) => a.join(", ");
const fromCsv = (s: string) => [...new Set(s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean))];
const fromLines = (s: string) => [...new Set(s.split("\n").map((x) => x.trim().toLowerCase()).filter(Boolean))];

function toDraft(c: Icp): Draft {
  return {
    locations: csv(c.locations),
    seniorities: [...c.apollo_seniorities],
    senior: csv(c.senior_keywords),
    junior: csv(c.junior_keywords),
    excluded: csv(c.excluded_functions),
    personas: c.personas.map((p) => ({
      key: p.key, name: p.name, active: p.active, triggers: [...p.triggers], fallback: p.fallback, match: csv(p.match), titles: p.apollo_titles.join("\n"),
      proof: [...p.proof_points], description: p.description, pains: p.pains.map((x) => ({ ...x, signs: [...x.signs] })),
    })),
    open: null,
  };
}

function fromDraft(d: Draft): Icp {
  return {
    locations: fromCsv(d.locations),
    apollo_seniorities: d.seniorities,
    senior_keywords: fromCsv(d.senior).map((x) => x.toLowerCase()),
    junior_keywords: fromCsv(d.junior).map((x) => x.toLowerCase()),
    excluded_functions: fromCsv(d.excluded),
    personas: d.personas.map((p): Persona => ({
      key: p.key || slug(p.name), name: p.name.trim(), active: p.active, triggers: TRIGGERS.filter((t) => p.triggers.includes(t)), fallback: p.fallback && p.active, match: fromCsv(p.match).map((x) => x.toLowerCase()),
      apollo_titles: fromLines(p.titles), proof_points: p.proof, description: p.description.trim(), pains: p.pains,
    })),
  };
}

function problems(c: Icp): string[] {
  const out: string[] = [];
  const act = c.personas.filter((p) => p.active);
  if (!act.length) out.push("Keep at least one persona active.");
  if (!c.locations.length) out.push("Add at least one location.");
  if (!c.apollo_seniorities.length) out.push("Pick at least one Apollo seniority.");
  if (!c.senior_keywords.length) out.push("Add at least one senior title word.");
  if (!act.some((p) => p.triggers.includes("weekly") && p.apollo_titles.length)) out.push("At least one active persona needs Apollo titles and the weekly roster build ticked.");
  const names = new Set<string>();
  for (const p of c.personas) {
    if (!p.name) out.push("Every persona needs a name.");
    else if (names.has(p.key)) out.push(`Two personas share the name "${p.name}".`);
    names.add(p.key);
    if (p.active && !p.apollo_titles.length) out.push(`${p.name || "A persona"} has no Apollo titles, so searches will never find it.`);
  }
  if (act.filter((p) => p.fallback).length > 1) out.push("Only one persona can be the fallback.");
  for (const p of act) if (!p.fallback && !p.match.length) out.push(`${p.name || "A persona"} has no title words and isn't the fallback, so no lead would be tagged with it.`);
  for (const p of act) if (!p.triggers.length) out.push(`${p.name || "A persona"} isn't used by any event. Tick at least one, or turn it off.`);
  return [...new Set(out)];
}

export default function IcpPanel({ X }: { X: Ctx }) {
  const edit = can(X, "manage_integrations");
  const proofs = proofTexts(readProfile(X.D.settings.profile));
  const saved = readIcp(X.D.settings.icp, proofs);
  const custom = !!X.D.settings.icp;
  const d: Draft = X.S.forms["icp"] || (X.S.forms["icp"] = toDraft(saved));
  const next = fromDraft(d);
  const dirty = JSON.stringify(next) !== JSON.stringify(saved);
  const errs = problems(next);
  const counts = new Map<string, number>();
  for (const l of X.D.leads) if (l.title_scope) counts.set(l.title_scope, (counts.get(l.title_scope) || 0) + 1);

  const re = () => X.rerender();
  const setP = (i: number, patch: Partial<PDraft>) => {
    d.personas[i] = { ...d.personas[i], ...patch };
    re();
  };
  const setFallback = (i: number, on: boolean) => {
    d.personas = d.personas.map((p, j) => ({ ...p, fallback: j === i ? on : on ? false : p.fallback }));
    re();
  };
  const setTrigger = (i: number, t: Trigger, on: boolean) => {
    const cur = d.personas[i].triggers;
    setP(i, { triggers: TRIGGERS.filter((x) => (x === t ? on : cur.includes(x))) });
  };
  const add = () => {
    d.personas.push({ key: "", name: "", active: true, triggers: [...TRIGGERS], fallback: false, match: "", titles: "", proof: [], description: "", pains: [], isNew: true });
    d.open = `#${d.personas.length - 1}`;
    re();
  };
  const remove = (i: number) => {
    const p = d.personas[i];
    const n = counts.get(p.key) || 0;
    if (!window.confirm(`Delete the ${p.name || "new"} persona?${n ? ` ${n} lead${n > 1 ? "s" : ""} keep their tag; new leads won't get it.` : ""}`)) return;
    d.personas.splice(i, 1);
    d.open = null;
    re();
  };
  const save = async () => {
    if (errs.length) return X.toast(errs[0]);
    const value = fromDraft(d);
    const { error } = await supabase.from("app_settings").upsert({ key: "icp", value, updated_at: new Date().toISOString() });
    if (error) return X.toast("Could not save the ICP personas.");
    X.D.settings.icp = value;
    X.S.forms["icp"] = toDraft(readIcp(value, proofs));
    const was = new Set(saved.personas.map((p) => p.key));
    const now = new Set(value.personas.map((p) => p.key));
    const added = value.personas.filter((p) => !was.has(p.key)).map((p) => p.name);
    const gone = saved.personas.filter((p) => !now.has(p.key)).map((p) => p.name);
    await audit("icp personas saved", "", [added.length ? `added ${added.join(", ")}` : "", gone.length ? `removed ${gone.join(", ")}` : "", `${value.personas.filter((p) => p.active).length} active`].filter(Boolean).join("; "));
    X.toast("ICP personas saved. The next roster build and research tasks use them.");
  };
  const discard = () => {
    X.S.forms["icp"] = toDraft(saved);
    re();
  };
  const reset = () => {
    if (!window.confirm("Replace the personas and rules with the defaults? Nothing is saved until you click Save.")) return;
    X.S.forms["icp"] = toDraft(DEFAULT_ICP);
    re();
  };

  return (
    <div className="section">
      <div className="section-head">
        <h2>ICP personas</h2>
        <span className="note">
          {saved.personas.filter((p) => p.active).length} active · {saved.locations.join(", ")} · {custom ? "custom" : "defaults"}
        </span>
      </div>
      <p className="note">
        Who the roster targets at each account. Each persona's pills turn it on or off, make it the fallback, and pick which events use it. Apollo searches use its titles; the researcher checks every contact against these personas, tags the lead with one and picks the proof point from its list. Changes apply to the next roster build and to research tasks claimed after you save; leads already on the roster are not re-researched.
      </p>

      <div className="stack">
        {d.personas.map((p, i) => {
          const id = p.key || `#${i}`;
          const open = d.open === id || d.open === `#${i}`;
          const n = counts.get(p.key) || 0;
          return (
            <div key={id + i} className="card pad">
              <div className="icard-head">
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="row" style={{ gap: 6 }}>
                    <strong>{p.name || "New persona"}</strong>
                    {edit ? (
                      <>
                        <button type="button" className={"pill " + (p.active ? "ok" : "off")} aria-pressed={p.active} title="Turn this persona on or off" onClick={() => setP(i, { active: !p.active, fallback: p.active ? false : p.fallback })}>
                          {p.active ? "Active" : "Off"}
                        </button>
                        <button type="button" className={"pill " + (p.fallback ? "adj" : "off")} aria-pressed={p.fallback} disabled={!p.active} title="The fallback catches titles no other persona's words match" onClick={() => setFallback(i, !p.fallback)}>
                          {p.fallback ? "Fallback" : "Not fallback"}
                        </button>
                        {TRIGGERS.map((t) => (
                          <button type="button" key={t} className={"pill " + (p.triggers.includes(t) ? "hold" : "off")} aria-pressed={p.triggers.includes(t)} title={TRIGGER_LABEL[t][1]} onClick={() => setTrigger(i, t, !p.triggers.includes(t))}>
                            {TRIGGER_LABEL[t][0]}
                          </button>
                        ))}
                      </>
                    ) : (
                      <>
                        <span className={"pill " + (p.active ? "ok" : "off")}>{p.active ? "Active" : "Off"}</span>
                        {p.fallback ? <span className="pill adj">Fallback</span> : null}
                        {p.triggers.map((t) => <span key={t} className="pill hold">{TRIGGER_LABEL[t][0]}</span>)}
                      </>
                    )}
                  </div>
                  <p className="note" style={{ overflowWrap: "anywhere", marginTop: 6 }}>
                    {p.description || "No description yet."} <span className="tag">{p.key || slug(p.name) || "key set on save"}</span>
                    {n ? ` · ${n} lead${n > 1 ? "s" : ""}` : ""}
                  </p>
                </div>
                {edit ? (
                  <div className="row">
                    <button className="btn ghost small" onClick={() => ((d.open = open ? null : id), re())}>{open ? "Close" : "Edit"}</button>
                    <button className="btn danger small" onClick={() => remove(i)}>Delete</button>
                  </div>
                ) : null}
              </div>
              {open && edit ? (
                <div className="form" style={{ marginTop: 12 }}>
                  <label>
                    Name
                    <input value={p.name} onChange={(e) => setP(i, { name: e.target.value, key: p.isNew ? slug(e.target.value) : p.key })} placeholder="e.g. Sales leader" />
                  </label>
                  <label>
                    Title words (comma separated)
                    <input value={p.match} onChange={(e) => setP(i, { match: e.target.value })} placeholder="e.g. sales, revenue" />
                  </label>
                  <label className="full">
                    What the role owns (the researcher reads this)
                    <textarea rows={2} value={p.description} onChange={(e) => setP(i, { description: e.target.value })} />
                  </label>
                  <label className="full">
                    Apollo titles (one per line)
                    <textarea rows={4} value={p.titles} onChange={(e) => setP(i, { titles: e.target.value })} placeholder={"head of sales\nvp sales"} />
                  </label>
                  <fieldset className="full" style={{ border: 0, padding: 0, margin: 0 }}>
                    <legend className="note">Used when</legend>
                    {TRIGGERS.map((t) => (
                      <label key={t} className="tcal-box">
                        <input type="checkbox" checked={p.triggers.includes(t)} onChange={(e) => setTrigger(i, t, e.target.checked)} />
                        {TRIGGER_LABEL[t][1]}
                      </label>
                    ))}
                  </fieldset>
                  <label className="tcal-box">
                    <input type="checkbox" checked={p.fallback} disabled={!p.active} onChange={(e) => setFallback(i, e.target.checked)} />
                    Fallback: catch titles no other persona matches
                  </label>
                  <label className="tcal-box">
                    <input type="checkbox" checked={p.active} onChange={(e) => setP(i, { active: e.target.checked, fallback: e.target.checked ? p.fallback : false })} />
                    Active
                  </label>
                  <fieldset className="full" style={{ border: 0, padding: 0, margin: 0 }}>
                    <legend className="note">Proof points allowed (none ticked = any)</legend>
                    {proofs.map((pp) => (
                      <label key={pp} className="tcal-box">
                        <input
                          type="checkbox"
                          checked={p.proof.includes(pp)}
                          onChange={(e) => setP(i, { proof: e.target.checked ? [...p.proof, pp] : p.proof.filter((x) => x !== pp) })}
                        />
                        {pp}
                      </label>
                    ))}
                  </fieldset>
                  <p className="note full">
                    A title goes to the first active persona whose words it contains; the fallback persona catches the rest. Each event searches Apollo with the titles of the personas ticked for it, and the researcher only suggests contacts who fit a persona ticked for suggestions.
                  </p>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      {edit ? (
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn ghost small" onClick={add}>Add persona</button>
        </div>
      ) : null}

      <h3 style={{ marginTop: 22 }}>Rules for every persona</h3>
      <div className="form">
        <label>
          Locations (comma separated)
          <input value={d.locations} disabled={!edit} onChange={(e) => ((d.locations = e.target.value), re())} />
        </label>
        <label>
          Senior title words
          <input value={d.senior} disabled={!edit} onChange={(e) => ((d.senior = e.target.value), re())} />
        </label>
        <label>
          Junior title words (ruled out unless the title also says Head, Director, Chief or CMO)
          <input value={d.junior} disabled={!edit} onChange={(e) => ((d.junior = e.target.value), re())} />
        </label>
        <label>
          Functions that never fit
          <input value={d.excluded} disabled={!edit} onChange={(e) => ((d.excluded = e.target.value), re())} />
        </label>
        <fieldset className="full" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="note">Apollo seniority filter</legend>
          <div className="row">
            {APOLLO_SENIORITIES.map((s) => (
              <label key={s} className="tcal-box">
                <input
                  type="checkbox"
                  disabled={!edit}
                  checked={d.seniorities.includes(s)}
                  onChange={(e) => ((d.seniorities = e.target.checked ? [...d.seniorities, s] : d.seniorities.filter((x) => x !== s)), re())}
                />
                {s.replace("_", " ")}
              </label>
            ))}
          </div>
        </fieldset>
      </div>

      {edit ? (
        <>
          {dirty && errs.length ? (
            <ul className="hint">
              {errs.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          ) : null}
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn small" disabled={!dirty || errs.length > 0} onClick={save}>Save personas</button>
            <button className="btn ghost small" disabled={!dirty} onClick={discard}>Discard changes</button>
            <button className="btn ghost small" onClick={reset}>Reset to defaults</button>
            {dirty ? <span className="hint">Unsaved changes</span> : null}
          </div>
        </>
      ) : (
        <p className="note">Only admins who manage integrations can change the personas.</p>
      )}
    </div>
  );
}
