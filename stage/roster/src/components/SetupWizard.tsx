import { useEffect } from "react";
import Icon from "./Icon";
import type { Ctx } from "../lib/ctx";
import { can } from "../lib/perms";
import { audit } from "../lib/actions";
import { supabase } from "../lib/supabase";
import { type Adjacency, type Customer, normalizeProfile, type ProofPoint, proofTexts, readProfile, type SellerProfile } from "../lib/profile";
import { type Pain, readIcp } from "../lib/icp";
import Documents, { addLinks, loadDocs } from "./Documents";
import { loadInteg } from "./Integrations";

/* Admin > Setup: the onboarding wizard. It fills the seller's profile (app_settings key 'profile'): who is selling,
   what they sell in their own words, the documents and links that explain it, the customers and proof the
   researchers and writers may quote, the companies to target, each persona's pains and the house style. Each step
   saves on its own, so an admin can stop halfway; finishing records app_settings 'onboarding', and research, the
   weekly build and email drafts wait until then. Reps and integrations have their own panels, which the team step
   links to. */

type AdjDraft = { match: string; hook: string };
type PainDraft = { pain: string; signs: string; proof: string };
type Draft = {
  step: number;
  /** Steps where "Continue" was pressed, so required-field messages show only after a try. */
  tried: number[];
  workspace: string;
  company_name: string;
  website: string;
  product_summary: string;
  pitch: string;
  product_overview: string;
  booking_link: string;
  customers: Customer[];
  proof_points: ProofPoint[];
  icp_description: string;
  min_employees: string;
  max_employees: string;
  exclude: string;
  rules: string;
  never_target: string;
  competitor_categories: string;
  adjacency: AdjDraft[];
  never_call_it: string;
  banned_words: string;
  /** Persona key -> its pains, edited here and saved into app_settings 'icp'. */
  pains: Record<string, PainDraft[]>;
};

const STEPS = [
  ["company", "Company"],
  ["context", "Context"],
  ["proof", "Customers and proof"],
  ["targets", "Target companies"],
  ["personas", "Personas and pains"],
  ["style", "Writing rules"],
  ["team", "Team and tools"],
  ["finish", "Review"],
] as const;
type StepKey = (typeof STEPS)[number][0];
const LAST = STEPS.length - 1;

const csv = (a: string[]) => a.join(", ");
const lines = (a: string[]) => a.join("\n");
const fromCsv = (s: string) => [...new Set(s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean))];
const fromLines = (s: string) => [...new Set(s.split("\n").map((x) => x.trim()).filter(Boolean))];
const isUrl = (s: string) => /^https?:\/\/\S+\.\S+$/.test(s.trim());
const numOrNull = (s: string) => (s.trim() === "" ? null : Number(s));

function toDraft(p: SellerProfile, icpRaw: unknown, workspace: string, step = 0): Draft {
  const icp = readIcp(icpRaw, proofTexts(p));
  return {
    step,
    tried: [],
    workspace,
    company_name: p.company_name,
    website: p.website,
    product_summary: p.product_summary,
    pitch: p.pitch,
    product_overview: p.product_overview,
    booking_link: p.booking_link,
    customers: p.customers.map((c) => ({ ...c })),
    proof_points: p.proof_points.map((x) => ({ ...x })),
    icp_description: p.company_icp.description,
    min_employees: p.company_icp.min_employees == null ? "" : String(p.company_icp.min_employees),
    max_employees: p.company_icp.max_employees == null ? "" : String(p.company_icp.max_employees),
    exclude: lines(p.company_icp.exclude),
    rules: lines(p.company_icp.rules),
    never_target: csv(p.never_target),
    competitor_categories: csv(p.competitor_categories),
    adjacency: p.adjacency.map((a) => ({ match: csv(a.match), hook: a.hook })),
    never_call_it: csv(p.never_call_it),
    banned_words: csv(p.banned_words),
    pains: Object.fromEntries(icp.personas.map((x) => [x.key, x.pains.map((y) => ({ pain: y.pain, signs: lines(y.signs), proof: y.proof }))])),
  };
}

function fromDraft(d: Draft): SellerProfile {
  return normalizeProfile({
    company_name: d.company_name,
    website: d.website,
    product_summary: d.product_summary,
    pitch: d.pitch,
    product_overview: d.product_overview,
    booking_link: d.booking_link.trim(),
    customers: d.customers,
    proof_points: d.proof_points,
    company_icp: {
      description: d.icp_description,
      min_employees: numOrNull(d.min_employees),
      max_employees: numOrNull(d.max_employees),
      exclude: fromLines(d.exclude),
      rules: fromLines(d.rules),
    },
    never_target: fromCsv(d.never_target),
    competitor_categories: fromCsv(d.competitor_categories),
    adjacency: d.adjacency.map((a): Adjacency => ({ match: fromCsv(a.match), hook: a.hook.trim() })),
    never_call_it: fromCsv(d.never_call_it),
    banned_words: fromCsv(d.banned_words),
  });
}

const painsOf = (d: Draft, key: string): Pain[] =>
  (d.pains[key] || []).map((x) => ({ pain: x.pain.trim(), signs: fromLines(x.signs), proof: x.proof })).filter((x) => x.pain);

/** What stops a step from saving, keyed by field so each message sits under its field. `required` messages show
    only after a try; format problems show at once. */
type Problem = { f: string; m: string; required?: boolean };
function problems(d: Draft, key: StepKey, activeKeys: string[]): Problem[] {
  const out: Problem[] = [];
  if (key === "company") {
    if (!d.company_name.trim()) out.push({ f: "company_name", m: "Add your company name.", required: true });
    if (d.product_summary.trim().length < 20) out.push({ f: "product_summary", m: "Describe what you sell in a sentence or two (20 characters or more).", required: true });
    if (d.website.trim() && !isUrl(d.website)) out.push({ f: "website", m: "Start the website with https://" });
    if (d.booking_link.trim() && !isUrl(d.booking_link)) out.push({ f: "booking_link", m: "Start the booking link with https://" });
  }
  if (key === "proof") {
    if (!d.proof_points.some((p) => p.text.trim())) out.push({ f: "proof", m: "Add at least one proof point. Every outreach angle quotes one.", required: true });
    d.customers.forEach((c, i) => c.url.trim() && !isUrl(c.url) && out.push({ f: `cust-${i}`, m: "Start the site with https://" }));
    d.proof_points.forEach((p, i) => p.link.trim() && !isUrl(p.link) && out.push({ f: `proof-${i}`, m: "Start the link with https://" }));
    const texts = d.proof_points.map((p) => p.text.trim()).filter(Boolean);
    if (new Set(texts).size !== texts.length) out.push({ f: "proof", m: "Two proof points have the same wording." });
  }
  if (key === "targets") {
    if (!d.icp_description.trim()) out.push({ f: "icp_description", m: "Describe the companies you sell to.", required: true });
    for (const [k, f, v] of [["Minimum", "min_employees", d.min_employees], ["Maximum", "max_employees", d.max_employees]] as const) {
      if (v.trim() && !(Number.isInteger(Number(v)) && Number(v) >= 0)) out.push({ f, m: `${k} employees must be a whole number.` });
    }
    const lo = numOrNull(d.min_employees), hi = numOrNull(d.max_employees);
    if (lo != null && hi != null && lo > hi) out.push({ f: "max_employees", m: "The maximum is below the minimum." });
    d.adjacency.forEach((a, i) => !!a.match.trim() !== !!a.hook.trim() && out.push({ f: `adj-${i}`, m: "Fill in both the companies and the line to use." }));
  }
  if (key === "personas") {
    if (!activeKeys.some((k) => painsOf(d, k).length)) out.push({ f: "pains", m: "Add at least one pain for one of your personas.", required: true });
  }
  return out;
}

export default function SetupWizard({ X, openSection }: { X: Ctx; openSection: (sec: string) => void }) {
  const workspaceName: string = X.S.forms["setup-ws"] ?? "";
  const edit = can(X, "manage_integrations");
  const owner = X.me && (X.me.is_owner || X.me.role === "super_admin");
  const saved = readProfile(X.D.settings.profile);
  const d: Draft = X.S.forms["setup"] || (X.S.forms["setup"] = toDraft(saved, X.D.settings.icp, workspaceName, X.S.forms["setup-step"] || 0));
  if (!d.workspace && workspaceName) d.workspace = workspaceName;
  const step = d.step;
  const key = STEPS[step][0];
  const icp = readIcp(X.D.settings.icp, proofTexts(saved));
  const active = icp.personas.filter((p) => p.active);
  const errs = problems(d, key, active.map((p) => p.key));
  const shown = errs.filter((e) => !e.required || d.tried.includes(step));
  const blocking = errs.length > 0;
  const profileDirty = JSON.stringify(fromDraft(d)) !== JSON.stringify(saved) || !X.D.settings.profile;
  const painsDirty = active.some((p) => JSON.stringify(painsOf(d, p.key)) !== JSON.stringify(p.pains));
  const wsDirty = owner && d.workspace.trim() !== "" && d.workspace.trim() !== workspaceName;
  const dirty = profileDirty || painsDirty || wsDirty;
  const done = X.D.settings.onboarding?.completed_at as string | undefined;
  const reps = (X.D.reps || []).filter((r: any) => r.in_rotation).length;
  const docs: any[] = (X.S.forms["docs"] && X.S.forms["docs"].rows) || [];
  const integ = X.S.integ.data;
  useEffect(() => {
    if (!X.S.forms["docs"]) loadDocs(X);
    if (!X.S.integ.data && !X.S.integ.loading) loadInteg(X, true);
    if (X.S.forms["setup-ws"] === undefined) {
      supabase.from("workspaces").select("name").maybeSingle().then(({ data }) => {
        X.S.forms["setup-ws"] = (data && data.name) || "";
        re();
      });
    }
  }, []);

  const re = () => X.rerender();
  const set = (patch: Partial<Draft>) => {
    Object.assign(d, patch);
    re();
  };
  const go = (n: number) => {
    set({ step: Math.max(0, Math.min(LAST, n)) });
    requestAnimationFrame(() => document.getElementById("setup-step-title")?.focus({ preventScroll: false }));
  };
  const err = (f: string) => {
    const e = shown.find((x) => x.f === f);
    return e ? <span className="field-err" id={"err-" + f}>{e.m}</span> : null;
  };
  const inv = (f: string) => (shown.some((x) => x.f === f) ? { "aria-invalid": true as const, "aria-describedby": "err-" + f } : {});

  // What each step needs, for the ticks in the progress list and the review step.
  const sp = saved;
  const workerOn = !!(integ && integ.worker && integ.worker.active);
  const on = (p: string) => !!(integ && integ.providers && integ.providers[p] && integ.providers[p].connected);
  const tick: Record<StepKey, boolean> = {
    company: !!sp.company_name && sp.product_summary.length >= 20,
    context: !!sp.pitch || docs.some((x) => x.status === "ready"),
    proof: sp.proof_points.length > 0,
    targets: !!sp.company_icp.description,
    personas: active.some((p) => p.pains.length > 0),
    style: !!X.D.settings.profile,
    team: reps > 0 && on("apollo") && workerOn,
    finish: !!done,
  };
  const required: StepKey[] = ["company", "proof", "targets", "personas"];
  const ready = required.every((k) => tick[k]);

  const save = async (): Promise<boolean> => {
    if (errs.length) {
      if (!d.tried.includes(step)) d.tried.push(step);
      re();
      requestAnimationFrame(() => (document.querySelector(".setup [aria-invalid='true']") as HTMLElement | null)?.focus());
      return false;
    }
    if (!dirty) return true;
    const at = new Date().toISOString();
    if (profileDirty) {
      const value = fromDraft(d);
      const { error } = await supabase.from("app_settings").upsert({ key: "profile", value, updated_at: at });
      if (error) {
        X.toast("Could not save the setup.");
        return false;
      }
      // The app's shared booking link follows the profile.
      if (value.booking_link) await supabase.from("app_settings").upsert({ key: "booking_link", value: { url: value.booking_link }, updated_at: at });
      const before = saved;
      X.D.settings.profile = value;
      if (value.booking_link) X.D.settings.booking_link = { url: value.booking_link };
      await audit("setup saved", STEPS[step][1], `${value.company_name}: ${value.proof_points.length} proof points, ${value.customers.length} customers`);
      // The website and case-study links go into the library so the researchers read them too.
      const links = [
        ...(value.website && value.website !== before.website ? [{ url: value.website, name: `${value.company_name} website` }] : []),
        ...value.proof_points.filter((p) => p.link && !before.proof_points.some((b) => b.link === p.link)).map((p) => ({ url: p.link, name: `Case study: ${p.customer || p.text}`.slice(0, 120) })),
      ];
      if (links.length) addLinks(X, links);
    }
    if (painsDirty) {
      const raw = X.D.settings.icp && typeof X.D.settings.icp === "object" ? X.D.settings.icp : icp;
      const value = { ...raw, personas: icp.personas.map((p) => ({ ...p, pains: p.active ? painsOf(d, p.key) : p.pains })) };
      const { error } = await supabase.from("app_settings").upsert({ key: "icp", value, updated_at: at });
      if (error) {
        X.toast("Could not save the personas' pains.");
        return false;
      }
      X.D.settings.icp = value;
      X.S.forms["icp"] = undefined;
      await audit("setup saved", "Personas and pains", active.map((p) => `${p.name}: ${painsOf(d, p.key).length}`).join(", "));
    }
    if (wsDirty) {
      const name = d.workspace.trim().slice(0, 80);
      const { error } = await supabase.from("workspaces").update({ name }).eq("id", X.me!.workspace_id);
      if (error) X.toast("Saved, but the workspace name could not be changed.");
      else {
        X.S.forms["setup-ws"] = name;
        X.toast("Saved. The new workspace name shows in the sidebar after the next reload.");
      }
    }
    return true;
  };
  const next = async () => {
    if (await save()) go(step + 1);
  };
  const finish = async () => {
    if (!(await save())) return;
    if (!ready) return X.toast("Finish the steps marked required first.");
    const value = { completed_at: new Date().toISOString(), by: X.uid };
    const { error } = await supabase.from("app_settings").upsert({ key: "onboarding", value, updated_at: value.completed_at });
    if (error) return X.toast("Could not mark setup as finished.");
    X.D.settings.onboarding = value;
    await audit("setup finished", "", "");
    X.toast("Setup finished. Research and the weekly build can start.");
    re();
  };
  const discard = () => {
    X.S.forms["setup"] = toDraft(saved, X.D.settings.icp, workspaceName, step);
    re();
  };

  const listRow = <T,>(arr: T[], i: number, patch: Partial<T>) => {
    arr[i] = { ...arr[i], ...patch };
    re();
  };
  const drop = <T,>(arr: T[], i: number) => {
    arr.splice(i, 1);
    re();
  };
  const remaining = required.filter((k) => !tick[k]).length;

  return (
    <div className="section setup">
      <div className="section-head">
        <h2>Setup</h2>
        <span className="note">{done ? `Finished ${new Date(done).toLocaleDateString()}` : remaining ? `${remaining} required step${remaining > 1 ? "s" : ""} left` : "Ready to finish"}</span>
      </div>
      <p className="note setup-lede">
        Tell the roster who you are and who you sell to. Researchers, email writers and the checks on their work all read this, so every angle and draft speaks for your company. Each step saves on its own.
        {done ? null : " Research waits until setup is finished."}
      </p>

      <div className="setup-grid">
        <nav className="setup-steps" aria-label="Setup steps">
          <ol>
            {STEPS.map(([k, label], i) => (
              <li key={k}>
                <button className={"setup-step" + (tick[k] ? " done" : "")} aria-current={i === step ? "step" : undefined} onClick={() => go(i)}>
                  <span className="setup-mark" aria-hidden="true">{tick[k] ? <Icon name="check" size={13} /> : i + 1}</span>
                  <span>
                    {label}
                    {required.includes(k) && !tick[k] ? <span className="setup-req">Required</span> : null}
                  </span>
                  <span className="sr-only">{tick[k] ? " (done)" : " (not done)"}</span>
                </button>
              </li>
            ))}
          </ol>
        </nav>

        <div className="setup-body">
          <h3 className="setup-title" id="setup-step-title" tabIndex={-1}>
            <span className="muted">Step {step + 1} of {STEPS.length}</span> {STEPS[step][1]}
          </h3>

          {key === "company" ? (
            <div className="form">
              <label>
                Company name
                <input value={d.company_name} disabled={!edit} {...inv("company_name")} onChange={(e) => set({ company_name: e.target.value })} />
                {err("company_name")}
              </label>
              <label>
                Website
                <input value={d.website} disabled={!edit} placeholder="https://" {...inv("website")} onChange={(e) => set({ website: e.target.value })} />
                {err("website") || <span className="hint">Read into the library when you save.</span>}
              </label>
              {owner ? (
                <label>
                  Workspace name
                  <input value={d.workspace} disabled={!edit} maxLength={80} onChange={(e) => set({ workspace: e.target.value })} />
                  <span className="hint">Shown in the sidebar for everyone on your team.</span>
                </label>
              ) : null}
              <label>
                Booking link
                <input value={d.booking_link} disabled={!edit} placeholder="https://" {...inv("booking_link")} onChange={(e) => set({ booking_link: e.target.value })} />
                {err("booking_link") || <span className="hint">Emails ask prospects to book here.</span>}
              </label>
              <label className="full">
                What you sell, in a sentence or two
                <textarea rows={2} value={d.product_summary} disabled={!edit} {...inv("product_summary")} onChange={(e) => set({ product_summary: e.target.value })} />
                {err("product_summary") || <span className="hint">The researchers read this for every account.</span>}
              </label>
              <label className="full">
                Your pitch, in your own words
                <textarea rows={6} value={d.pitch} disabled={!edit} placeholder="How you explain it on a call: the problem, who has it, what changes for them, why you and not the alternatives." onChange={(e) => set({ pitch: e.target.value })} />
                <span className="hint">Paste as much as you like. The more the researchers know, the sharper the angles.</span>
              </label>
              <label className="full">
                Product overview for emails
                <textarea rows={3} value={d.product_overview} disabled={!edit} onChange={(e) => set({ product_overview: e.target.value })} />
                <span className="hint">Added word for word to briefs that get shared with prospects.</span>
              </label>
            </div>
          ) : null}

          {key === "context" ? (
            <>
              <p className="note">
                Add everything that explains what you sell and who buys it: sales decks, case studies, call notes, one-pagers, price sheets, battlecards. Researchers and writers read excerpts of all of it with every task.
              </p>
              <Documents X={X} />
            </>
          ) : null}

          {key === "proof" ? (
            <>
              <h4>Proof points</h4>
              <p className="note">Results you can quote. Researchers copy one into every angle word for word, and the checks reject any proof point not on this list.</p>
              {err("proof")}
              <div className="stack">
                {d.proof_points.map((p, i) => (
                  <div key={i} className="card pad">
                    <div className="form">
                      <label className="full">
                        The result, exactly as it may be quoted
                        <input value={p.text} disabled={!edit} placeholder="e.g. $500K+ pipeline in 5 weeks" onChange={(e) => listRow(d.proof_points, i, { text: e.target.value })} />
                      </label>
                      <label>
                        Whose result
                        <input value={p.customer} disabled={!edit} onChange={(e) => listRow(d.proof_points, i, { customer: e.target.value })} />
                      </label>
                      <label>
                        Use it when
                        <input value={p.use_when} disabled={!edit} placeholder="e.g. pipeline or demo volume" onChange={(e) => listRow(d.proof_points, i, { use_when: e.target.value })} />
                      </label>
                      <label className="full">
                        Case study link
                        <input value={p.link} disabled={!edit} placeholder="https://" {...inv(`proof-${i}`)} onChange={(e) => listRow(d.proof_points, i, { link: e.target.value })} />
                        {err(`proof-${i}`) || <span className="hint">Read into the library too.</span>}
                      </label>
                    </div>
                    {edit ? <button className="btn ghost small danger-text" onClick={() => drop(d.proof_points, i)}>Remove proof point</button> : null}
                  </div>
                ))}
              </div>
              {edit ? <button className="btn ghost small add-row" onClick={() => (d.proof_points.push({ text: "", customer: "", use_when: "", link: "" }), re())}>Add proof point</button> : null}

              <h4>Customers</h4>
              <p className="note">Tick "Live" when prospects can see your product working on that customer's site; emails link to those. Customers are never researched as prospects.</p>
              <div className="stack">
                {d.customers.map((c, i) => (
                  <div key={i} className="card pad">
                    <div className="form">
                      <label>
                        Name
                        <input value={c.name} disabled={!edit} onChange={(e) => listRow(d.customers, i, { name: e.target.value })} />
                      </label>
                      <label>
                        Site
                        <input value={c.url} disabled={!edit} placeholder="https://" {...inv(`cust-${i}`)} onChange={(e) => listRow(d.customers, i, { url: e.target.value })} />
                        {err(`cust-${i}`)}
                      </label>
                      <label className="check">
                        <input type="checkbox" checked={c.live_instance} disabled={!edit} onChange={(e) => listRow(d.customers, i, { live_instance: e.target.checked })} />
                        Live on their site
                      </label>
                    </div>
                    {edit ? <button className="btn ghost small danger-text" onClick={() => drop(d.customers, i)}>Remove customer</button> : null}
                  </div>
                ))}
              </div>
              {edit ? <button className="btn ghost small add-row" onClick={() => (d.customers.push({ name: "", url: "", live_instance: false }), re())}>Add customer</button> : null}
            </>
          ) : null}

          {key === "targets" ? (
            <>
              <div className="form">
                <label className="full">
                  Companies you sell to
                  <input value={d.icp_description} disabled={!edit} placeholder="e.g. B2B SaaS selling to mid-market finance teams" {...inv("icp_description")} onChange={(e) => set({ icp_description: e.target.value })} />
                  {err("icp_description")}
                </label>
                <label>
                  Minimum employees
                  <input inputMode="numeric" value={d.min_employees} disabled={!edit} {...inv("min_employees")} onChange={(e) => set({ min_employees: e.target.value })} />
                  {err("min_employees")}
                </label>
                <label>
                  Maximum employees
                  <input inputMode="numeric" value={d.max_employees} disabled={!edit} {...inv("max_employees")} onChange={(e) => set({ max_employees: e.target.value })} />
                  {err("max_employees")}
                </label>
                <label className="full">
                  Kinds of company to exclude, one per line
                  <textarea rows={3} value={d.exclude} disabled={!edit} onChange={(e) => set({ exclude: e.target.value })} />
                </label>
                <label className="full">
                  Other rules the researchers apply as written, one per line
                  <textarea rows={3} value={d.rules} disabled={!edit} placeholder="e.g. IT services only with revenue of $50M or more." onChange={(e) => set({ rules: e.target.value })} />
                </label>
                <label className="full">
                  Never research these companies
                  <input value={d.never_target} disabled={!edit} onChange={(e) => set({ never_target: e.target.value })} />
                  <span className="hint">Comma separated. Your own company and your customers are left out for you.</span>
                </label>
                <label className="full">
                  Kinds of vendor that compete with you
                  <input value={d.competitor_categories} disabled={!edit} onChange={(e) => set({ competitor_categories: e.target.value })} />
                  <span className="hint">Comma separated.</span>
                </label>
              </div>
              <h4>Adjacency hooks</h4>
              <p className="note">An opening line for companies that compete with one of your customers, such as "Northwind already runs Acme" for Northwind's competitors.</p>
              <div className="stack">
                {d.adjacency.map((a, i) => (
                  <div key={i} className="card pad">
                    <div className="form">
                      <label>
                        Companies, comma separated
                        <input value={a.match} disabled={!edit} {...inv(`adj-${i}`)} onChange={(e) => listRow(d.adjacency, i, { match: e.target.value })} />
                        {err(`adj-${i}`)}
                      </label>
                      <label>
                        Line to use
                        <input value={a.hook} disabled={!edit} onChange={(e) => listRow(d.adjacency, i, { hook: e.target.value })} />
                      </label>
                    </div>
                    {edit ? <button className="btn ghost small danger-text" onClick={() => drop(d.adjacency, i)}>Remove hook</button> : null}
                  </div>
                ))}
              </div>
              {edit ? <button className="btn ghost small add-row" onClick={() => (d.adjacency.push({ match: "", hook: "" }), re())}>Add hook</button> : null}
            </>
          ) : null}

          {key === "personas" ? (
            <>
              <p className="note">
                For each person you sell to, list the problems they have, the signs that a company has each one, and the proof point that answers it. When a researcher spots a sign, the angle is built on that pain.{" "}
                <button className="linkbtn" onClick={() => openSection("icp")}>Edit titles, seniority and locations</button>
              </p>
              {err("pains")}
              {active.map((p) => {
                const list = d.pains[p.key] || (d.pains[p.key] = []);
                return (
                  <section key={p.key} className="persona-pains" aria-labelledby={"pp-" + p.key}>
                    <div className="persona-head">
                      <h4 id={"pp-" + p.key}>{p.name}</h4>
                      <span className="hint">{p.description || p.apollo_titles.slice(0, 3).join(", ")}</span>
                    </div>
                    <div className="stack">
                      {list.map((x, i) => (
                        <div key={i} className="card pad">
                          <div className="form">
                            <label className="full">
                              Pain
                              <input value={x.pain} disabled={!edit} placeholder="e.g. Paid traffic lands on the site and leaves without booking a demo" onChange={(e) => listRow(list, i, { pain: e.target.value })} />
                            </label>
                            <label>
                              Signs a company has it, one per line
                              <textarea rows={3} value={x.signs} disabled={!edit} placeholder={"Demo form buried three clicks deep\nHiring for a CRO or growth role"} onChange={(e) => listRow(list, i, { signs: e.target.value })} />
                            </label>
                            <label>
                              Proof that answers it
                              <select value={x.proof} disabled={!edit} onChange={(e) => listRow(list, i, { proof: e.target.value })}>
                                <option value="">Any proof point that fits</option>
                                {saved.proof_points.map((pp) => (
                                  <option key={pp.text} value={pp.text}>{pp.text}{pp.customer ? ` (${pp.customer})` : ""}</option>
                                ))}
                              </select>
                              {!saved.proof_points.length ? <span className="hint">Add proof points on step 3 to pick one here.</span> : null}
                            </label>
                          </div>
                          {edit ? <button className="btn ghost small danger-text" onClick={() => drop(list, i)}>Remove pain</button> : null}
                        </div>
                      ))}
                    </div>
                    {edit ? <button className="btn ghost small add-row" onClick={() => (list.push({ pain: "", signs: "", proof: "" }), re())}>Add a pain for {p.name}</button> : null}
                  </section>
                );
              })}
            </>
          ) : null}

          {key === "style" ? (
            <div className="form">
              <label className="full">
                Never call the product
                <input value={d.never_call_it} disabled={!edit} placeholder="e.g. chatbot, widget, plugin" onChange={(e) => set({ never_call_it: e.target.value })} />
                <span className="hint">Comma separated.</span>
              </label>
              <label className="full">
                Words and phrases the copy must never use
                <input value={d.banned_words} disabled={!edit} placeholder="e.g. leverage, seamless" onChange={(e) => set({ banned_words: e.target.value })} />
                <span className="hint">Comma separated. Angles and drafts that use these go back to the writer. Dashes, rule-of-three lists and "isn't A, it's B" lines are always checked.</span>
              </label>
            </div>
          ) : null}

          {key === "team" ? (
            <ul className="setup-checks">
              <Check ok={reps > 0} title="Reps in rotation" body={reps ? `${reps} rep${reps > 1 ? "s" : ""} get a weekly batch from their segment.` : "No one is in rotation yet, so no weekly batch is built."} act={["Open reps and segments", () => openSection("reps")]} />
              <Check ok={on("apollo")} title="Apollo" body="The weekly search and contact details." act={["Open Integrations", () => openSection("integ")]} pending={!integ} />
              <Check ok={workerOn} title="Claude worker" body="Researches each account and drafts the emails. Create a worker token, then run the worker or the Claude Code routine." act={["Open Integrations", () => openSection("integ")]} pending={!integ} />
              <Check ok={on("hubspot")} title="HubSpot" body="Checks every account against your CRM before research, and saves call notes." act={["Open Integrations", () => openSection("integ")]} pending={!integ} optional />
              <Check ok={!!(integ && integ.me && integ.me.google_calendar && integ.me.google_calendar.connected)} title="Google Calendar" body="Each rep connects their own, for callbacks and meetings." act={["Open Integrations", () => openSection("integ")]} pending={!integ} optional />
              <Check ok={on("fullenrich")} title="FullEnrich" body="A second source for work emails." act={["Open Integrations", () => openSection("integ")]} pending={!integ} optional />
              <li className="setup-check muted">Company research runs on the platform's own research service. There's nothing to connect for it.</li>
            </ul>
          ) : null}

          {key === "finish" ? (
            <>
              <ul className="setup-checks">
                {STEPS.slice(0, LAST).map(([k, label], i) => (
                  <Check key={k} ok={tick[k]} title={label} body={required.includes(k) ? (tick[k] ? "Done." : "Required before research can start.") : tick[k] ? "Done." : "Recommended."} act={["Go to step " + (i + 1), () => go(i)]} optional={!required.includes(k)} />
                ))}
              </ul>
              {done ? <p className="note">Setup was finished on {new Date(done).toLocaleDateString()}. Changes you save from here apply to the next research tasks.</p> : null}
            </>
          ) : null}

          {edit ? (
            <div className="setup-foot">
              {shown.length && d.tried.includes(step) ? <p className="field-err" role="alert">Fix the {shown.length === 1 ? "field" : `${shown.length} fields`} marked above to continue.</p> : null}
              <div className="row">
                {step > 0 ? <button className="btn ghost" onClick={() => go(step - 1)}>Back</button> : null}
                {step < LAST ? (
                  <button className="btn" onClick={next} aria-disabled={blocking && d.tried.includes(step) ? true : undefined}>{dirty ? "Save and continue" : "Continue"}</button>
                ) : (
                  <button className="btn" onClick={finish} disabled={!ready && !dirty}>{done ? "Save" : "Finish setup"}</button>
                )}
                {dirty && X.D.settings.profile ? <button className="btn ghost" onClick={discard}>Discard changes</button> : null}
                {dirty ? <span className="hint">Unsaved changes</span> : null}
              </div>
            </div>
          ) : (
            <p className="note setup-foot">Only admins who manage integrations can change the setup.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function Check({ ok, title, body, act, pending, optional }: { ok: boolean; title: string; body: string; act?: [string, () => void]; pending?: boolean; optional?: boolean }) {
  return (
    <li className={"setup-check" + (ok ? " done" : "")}>
      <span className="setup-mark" aria-hidden="true">{ok ? <Icon name="check" size={13} /> : ""}</span>
      <div>
        <strong>{title}</strong>
        {optional ? <span className="hint"> · optional</span> : null}
        <span className="sr-only">{pending ? " (checking)" : ok ? " (done)" : " (not done)"}</span>
        <p className="note">{pending ? "Checking…" : body}</p>
      </div>
      {act && !ok ? <button className="btn ghost small" onClick={act[1]}>{act[0]}</button> : null}
    </li>
  );
}
