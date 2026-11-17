import { useEffect } from "react";
import type { Ctx } from "../lib/ctx";
import type { Row } from "../lib/data";
import { can, pname, roleName } from "../lib/perms";
import { audit, distributeLeads, type DistPlan } from "../lib/actions";
import { invokeFn, supabase } from "../lib/supabase";

/* Admin > Reps and segments: who gets a weekly batch, how many accounts, and which slice of the market.
   The weekly build (Friday 8 PM IST) reads these rows; each account goes to one rep only. */

const M = 1_000_000;
type Draft = { in_rotation: boolean; weekly_accounts: string; emin: string; emax: string; rmin: string; rmax: string; fmin: string; fmax: string };

const toStr = (v: any, div = 1) => (v === null || v === undefined || v === "" ? "" : String(+v / div));
const toNum = (s: string, mul = 1): number | null => {
  const t = String(s ?? "").trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * mul) : NaN;
};

function draftFor(X: Ctx, uid: string): Draft {
  const k = "rep:" + uid;
  if (X.S.forms[k]) return X.S.forms[k];
  const r = X.D.reps.find((x) => x.user_id === uid) || {};
  return {
    in_rotation: !!r.in_rotation,
    weekly_accounts: toStr(r.weekly_accounts ?? 100),
    emin: toStr(r.employees_min),
    emax: toStr(r.employees_max),
    rmin: toStr(r.revenue_min, M),
    rmax: toStr(r.revenue_max, M),
    fmin: toStr(r.funding_min, M),
    fmax: toStr(r.funding_max, M),
  };
}

function nextMondayIST(): string {
  const ist = new Date(Date.now() + 5.5 * 3600e3);
  const add = ((8 - ist.getUTCDay()) % 7) || 7;
  ist.setUTCDate(ist.getUTCDate() + add);
  return ist.toISOString().slice(0, 10);
}

function validate(d: Draft): string {
  const q = Number(d.weekly_accounts);
  if (!Number.isInteger(q) || q < 0 || q > 500) return "Accounts per week must be a whole number from 0 to 500.";
  const pairs: Array<[string, string, string]> = [[d.emin, d.emax, "Employees"], [d.rmin, d.rmax, "Revenue"], [d.fmin, d.fmax, "Funding"]];
  for (const [a, b, label] of pairs) {
    const x = toNum(a), y = toNum(b);
    if (Number.isNaN(x as number) || Number.isNaN(y as number)) return `${label} must be a positive number.`;
    if (x !== null && y !== null && x > y) return `${label}: the minimum is above the maximum.`;
  }
  if (toNum(d.emin) === 0) return "Employees minimum must be at least 1.";
  return "";
}

const rangeText = (a: number | null, b: number | null, unit = "") =>
  a == null && b == null ? "any" : `${a == null ? "0" : a.toLocaleString("en-US") + unit}–${b == null ? "no max" : b.toLocaleString("en-US") + unit}`;

function overlaps(reps: Row[]): string[] {
  const out: string[] = [];
  const iv = (r: Row, lo: string, hi: string, dlo: number, dhi: number): [number, number] => [r[lo] ?? dlo, r[hi] ?? dhi];
  const hit = (a: [number, number], b: [number, number]) => a[0] <= b[1] && b[0] <= a[1];
  for (let i = 0; i < reps.length; i++)
    for (let j = i + 1; j < reps.length; j++) {
      const a = reps[i], b = reps[j];
      if (
        hit(iv(a, "employees_min", "employees_max", 250, 2500), iv(b, "employees_min", "employees_max", 250, 2500)) &&
        hit(iv(a, "revenue_min", "revenue_max", 0, Infinity), iv(b, "revenue_min", "revenue_max", 0, Infinity)) &&
        hit(iv(a, "funding_min", "funding_max", 0, Infinity), iv(b, "funding_min", "funding_max", 0, Infinity))
      )
        out.push(`${a.__name} and ${b.__name}`);
    }
  return out;
}

async function saveRep(X: Ctx, uid: string) {
  const d = draftFor(X, uid);
  const err = validate(d);
  if (err) return X.toast(err);
  const row = {
    user_id: uid,
    in_rotation: d.in_rotation,
    weekly_accounts: Number(d.weekly_accounts),
    employees_min: toNum(d.emin),
    employees_max: toNum(d.emax),
    revenue_min: toNum(d.rmin, M),
    revenue_max: toNum(d.rmax, M),
    funding_min: toNum(d.fmin, M),
    funding_max: toNum(d.fmax, M),
  };
  X.S.busy.add("rep:" + uid);
  X.rerender();
  const { error } = await supabase.from("rep_settings").upsert(row);
  X.S.busy.delete("rep:" + uid);
  if (error) {
    X.rerender();
    return X.toast("Could not save. " + (error.message || ""));
  }
  delete X.S.forms["rep:" + uid];
  await audit("rep segment saved", uid,
    `${row.in_rotation ? "in rotation" : "out of rotation"}, ${row.weekly_accounts}/week, employees ${rangeText(row.employees_min, row.employees_max)}, revenue ${rangeText(toNum(d.rmin), toNum(d.rmax), "M")}, funding ${rangeText(toNum(d.fmin), toNum(d.fmax), "M")}`);
  X.toast(row.in_rotation ? `Saved for ${pname(X, uid)}. Unassigned contacts in their segment were handed out.` : `Saved for ${pname(X, uid)}.`);
}

async function buildNow(X: Ctx, uid: string) {
  X.S.busy.add("build:" + uid);
  X.rerender();
  try {
    await invokeFn("integrations-status", { run: "weekly-roster", rep_id: uid });
    X.toast(`Building ${pname(X, uid)}'s batch for ${nextMondayIST()}. Accounts appear after the CRM check and the Claude worker.`);
  } catch (e: any) {
    X.toast("Could not start the build. " + ((e && e.message) || ""));
  } finally {
    X.S.busy.delete("build:" + uid);
    X.rerender();
  }
}

function RosterSettings({ X }: { X: Ctx }) {
  const cur = X.D.settings.roster || {};
  const f = X.S.forms["roster:settings"] || (X.S.forms["roster:settings"] = {});
  const v = (k: string, d: number) => (f[k] === undefined ? String(cur[k] ?? d) : f[k]);
  const set = (k: string) => (e: any) => {
    f[k] = e.target.value;
    X.rerender();
  };
  const save = async () => {
    const next = {
      ...cur,
      contacts_per_account: Math.min(5, Math.max(1, Math.round(+v("contacts_per_account", 2)))),
      max_accounts_per_run: Math.min(25, Math.max(1, Math.round(+v("max_accounts_per_run", 15)))),
      overprovision: Math.min(3, Math.max(1, +v("overprovision", 1.5))),
      crm_recent_days: Math.min(365, Math.max(7, Math.round(+v("crm_recent_days", 90)))),
    };
    if (Object.values(next).some((x) => typeof x === "number" && !Number.isFinite(x))) return X.toast("Enter numbers only.");
    const { error } = await supabase.from("app_settings").upsert({ key: "roster", value: next });
    if (error) return X.toast("Could not save the settings.");
    X.S.forms["roster:settings"] = {};
    await audit("roster settings saved", "", JSON.stringify(next));
    X.toast("Roster settings saved.");
  };
  return (
    <div className="form">
      <label>
        Contacts per account
        <input type="number" min={1} max={5} value={v("contacts_per_account", 2)} onChange={set("contacts_per_account")} />
      </label>
      <label>
        Accounts per Claude worker run
        <input type="number" min={1} max={25} value={v("max_accounts_per_run", 15)} onChange={set("max_accounts_per_run")} />
      </label>
      <label>
        Reserve multiplier
        <input type="number" min={1} max={3} step={0.1} value={v("overprovision", 1.5)} onChange={set("overprovision")} />
      </label>
      <label>
        CRM "recently contacted" window (days)
        <input type="number" min={7} max={365} value={v("crm_recent_days", 90)} onChange={set("crm_recent_days")} />
      </label>
      <div className="row">
        <button className="btn small" onClick={save}>Save settings</button>
      </div>
      <p className="note full">
        The reserve multiplier sets how many extra accounts are found and checked against HubSpot. Claude only researches reserve accounts when earlier ones fail the ICP, so the reserve costs no Claude usage unless it's needed.
      </p>
    </div>
  );
}

/** "Distribute unassigned": preview who gets what, then apply. The same run happens on its own when a segment is
    saved and every morning; this is for doing it now and seeing the split first. */
function Distribute({ X }: { X: Ctx }) {
  const st: { plan: DistPlan | null } = X.S.forms["dist"] || (X.S.forms["dist"] = { plan: null });
  const open = X.D.leads.filter((l) => !l.assigned_to && !l.archived && !l.dq_at && !l.lost_at).length;
  const busy = X.S.busy.has("dist");
  const run = async (apply: boolean) => {
    X.S.busy.add("dist");
    X.rerender();
    const r = await distributeLeads(X, apply);
    X.S.busy.delete("dist");
    if (r && apply) {
      st.plan = null;
      X.toast(r.assigned ? `Assigned ${r.assigned} contact${r.assigned === 1 ? "" : "s"}: ${r.reps.map((x) => `${x.name} ${x.contacts}`).join(", ")}.` : "Nothing to assign.");
    } else if (r) st.plan = r;
    X.rerender();
  };
  const p = st.plan;
  return (
    <div className="dist">
      <div className="row">
        <button className="btn small" disabled={busy || !open} onClick={() => run(false)} title={open ? undefined : "Every active contact has an owner"}>
          {busy && !p ? "Checking…" : "Distribute unassigned"}
        </button>
        <span className="note">{open} unassigned contact{open === 1 ? "" : "s"}. They're also handed out when a segment is saved and every morning.</span>
      </div>
      {p ? (
        <div className="dist-plan">
          {p.assigned ? (
            <>
              <p>
                <strong>{p.assigned}</strong> contact{p.assigned === 1 ? "" : "s"} would be assigned
                {p.by_reason?.company_owner ? ` (${p.by_reason.company_owner} stay with whoever already owns their company)` : ""}:
              </p>
              <ul>
                {p.reps.map((r) => (
                  <li key={r.rep_id}>
                    <strong>{r.name}</strong> · {r.contacts} contact{r.contacts === 1 ? "" : "s"} at {r.accounts} account{r.accounts === 1 ? "" : "s"}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p>No unassigned contact matches a rep in rotation.</p>
          )}
          {p.unmatched ? (
            <p className="note">
              {p.unmatched} match no segment and stay unassigned: {p.unmatched_companies.slice(0, 8).join(", ")}
              {p.unmatched_companies.length > 8 ? ` and ${p.unmatched_companies.length - 8} more` : ""}.
            </p>
          ) : null}
          <div className="row">
            {p.assigned ? (
              <button className="btn small" disabled={busy} onClick={() => run(true)}>
                {busy ? "Assigning…" : `Assign ${p.assigned} contact${p.assigned === 1 ? "" : "s"}`}
              </button>
            ) : null}
            <button className="btn ghost small" disabled={busy} onClick={() => { st.plan = null; X.rerender(); }}>Cancel</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default function RepsPanel({ X }: { X: Ctx }) {
  const manage = can(X, "manage_users");
  const batch = nextMondayIST();
  const P = X.S.forms["reps:progress"] || (X.S.forms["reps:progress"] = { batch: "", rows: null });
  useEffect(() => {
    if (P.batch === batch) return;
    P.batch = batch;
    supabase.rpc("roster_progress", { p_batch: batch }).then(({ data }) => {
      P.rows = data || [];
      X.rerender();
    });
  }, [batch]);
  const prog = new Map<string, Row>(((P.rows || []) as Row[]).map((r) => [r.rep_id, r]));
  const people = X.D.profiles
    .filter((u) => u.status === "active" && u.role)
    .sort((a, b) => pname(X, a.id).localeCompare(pname(X, b.id)));
  const inRot: Row[] = X.D.reps.filter((r) => r.in_rotation && people.some((p) => p.id === r.user_id)).map((r) => ({ ...r, __name: pname(X, r.user_id) }));
  const total = inRot.reduce((n, r) => n + (r.weekly_accounts || 0), 0);
  const ov = overlaps(inRot);
  return (
    <div className="section">
      <div className="section-head">
        <h2>Reps and segments</h2>
        <span className="note">
          {inRot.length} in rotation · {total.toLocaleString("en-US")} accounts a week · next batch {batch}
        </span>
      </div>
      <p className="note">
        Each rep in the rotation gets their own accounts every Monday, built on Friday evening from their segment. An account belongs to one rep only. Empty fields mean "no limit"; employees default to 250–2500. Revenue and funding are in US$ millions. A funding filter uses Apollo company search (1 credit per 100 companies).
      </p>
      {can(X, "assign_leads") || manage ? <Distribute X={X} /> : null}
      {ov.length ? <p className="hint">Segments overlap for {ov.join("; ")}. Accounts in an overlap go to whichever rep's search reaches them first.</p> : null}
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>Person</th>
              <th>In rotation</th>
              <th className="n">Accounts / week</th>
              <th>Employees</th>
              <th>Revenue ($M)</th>
              <th>Funding ($M)</th>
              <th>Batch {batch}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {people.map((u) => {
              const d = draftFor(X, u.id);
              const edit = (k: keyof Draft) => (e: any) => {
                X.S.forms["rep:" + u.id] = { ...d, [k]: k === "in_rotation" ? e.target.checked : e.target.value };
                X.rerender();
              };
              const dirty = !!X.S.forms["rep:" + u.id];
              const err = dirty ? validate(d) : "";
              const pr = prog.get(u.id);
              const saved = X.D.reps.find((r) => r.user_id === u.id);
              const pair = (a: keyof Draft, b: keyof Draft, ph: [string, string]) => (
                <div className="row" style={{ flexWrap: "nowrap", gap: 4 }}>
                  <input type="number" min={0} aria-label="minimum" placeholder={ph[0]} value={d[a] as string} disabled={!manage} onChange={edit(a)} style={{ width: 84 }} />
                  <span className="muted">–</span>
                  <input type="number" min={0} aria-label="maximum" placeholder={ph[1]} value={d[b] as string} disabled={!manage} onChange={edit(b)} style={{ width: 84 }} />
                </div>
              );
              return (
                <tr key={u.id}>
                  <td>
                    <strong>{pname(X, u.id)}</strong>
                    <div className="muted small">{roleName(X, u.role)}{u.hubspot_owner_id ? "" : " · no HubSpot owner id"}</div>
                  </td>
                  <td>
                    <input type="checkbox" aria-label="In rotation" checked={d.in_rotation} disabled={!manage} onChange={edit("in_rotation")} />
                  </td>
                  <td className="n">
                    <input type="number" min={0} max={500} value={d.weekly_accounts} disabled={!manage} onChange={edit("weekly_accounts")} style={{ width: 72 }} />
                  </td>
                  <td>{pair("emin", "emax", ["250", "2500"])}</td>
                  <td>{pair("rmin", "rmax", ["any", "any"])}</td>
                  <td>{pair("fmin", "fmax", ["any", "any"])}</td>
                  <td className="small">
                    {pr ? (
                      <>
                        <strong>{pr.qualified}</strong> of {saved?.weekly_accounts ?? "?"} ready
                        <div className="muted">{pr.in_research} in research · {pr.in_reserve} in reserve · {pr.excluded} dropped</div>
                      </>
                    ) : saved?.in_rotation ? (
                      <span className="muted">not built yet</span>
                    ) : (
                      <span className="muted">not in rotation</span>
                    )}
                  </td>
                  <td>
                    {manage ? (
                      <div className="row" style={{ flexWrap: "nowrap" }}>
                        <button className="btn small" disabled={!dirty || !!err || X.S.busy.has("rep:" + u.id)} title={err || undefined} onClick={() => saveRep(X, u.id)}>
                          {X.S.busy.has("rep:" + u.id) ? "Saving…" : "Save"}
                        </button>
                        {dirty ? (
                          <button className="btn ghost small" onClick={() => { delete X.S.forms["rep:" + u.id]; X.rerender(); }}>Cancel</button>
                        ) : saved?.in_rotation && can(X, "manage_integrations") ? (
                          <button className="btn ghost small" disabled={X.S.busy.has("build:" + u.id)} title="Find accounts for this rep's next batch now (tops up to their quota)" onClick={() => buildNow(X, u.id)}>
                            Build now
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                    {err ? <div className="hint err">{err}</div> : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {can(X, "manage_integrations") ? (
        <>
          <h3 style={{ marginTop: 16 }}>Roster settings</h3>
          <RosterSettings X={X} />
        </>
      ) : null}
    </div>
  );
}
