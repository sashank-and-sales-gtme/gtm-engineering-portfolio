import { useEffect, useState } from "react";
import { useX, type Ctx } from "../lib/ctx";
import { fmtStamp } from "../lib/format";
import { supabase } from "../lib/supabase";

/* The platform console: every workspace on the platform, and the platform's own settings. Only the product owner
   gets here (the tab is hidden for everyone else, and every database call checks is_product_owner() again). */

type Ws = {
  id: string;
  name: string;
  created_at: string;
  owner_email: string | null;
  owner_joined: string | null;
  members: number;
  pending: number;
  invites: number;
  setup_done: boolean | null;
  documents: number;
  leads: number;
  leads_7d: number;
  calls_7d: number;
  meetings_7d: number;
  queue_open: number;
  queue_failed_7d: number;
  connected: string[];
  errors: string[];
  worker_token: boolean;
  ai_month: { input: number; output: number; searches: number; calls: number };
  ai_budget: { monthly_usd?: number; input_usd_per_mtok?: number; output_usd_per_mtok?: number; web_search_usd?: number } | null;
  last_active: string | null;
};
type Audit = { id: number; at: string; actor: string; action: string; target: string; detail: string };
type Overview = { owner: string; signup: { open: boolean; allow: string[] }; admins: string[]; workspaces: Ws[]; audit: Audit[] };

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PROVIDER: Record<string, string> = { apollo: "Apollo", hubspot: "HubSpot", fullenrich: "FullEnrich", google_calendar: "Calendar", gmail: "Gmail", claude: "Claude" };
const usd = (n: number) => (n >= 100 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`);
const list = (t: string) => [...new Set(t.split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean))];

/** This month's Claude spend for a workspace, priced the way ai_spend_this_month() prices it. */
function spend(w: Ws) {
  const b = w.ai_budget || {};
  const a = w.ai_month || { input: 0, output: 0, searches: 0, calls: 0 };
  return (a.input / 1e6) * (b.input_usd_per_mtok ?? 4) + (a.output / 1e6) * (b.output_usd_per_mtok ?? 20) + a.searches * (b.web_search_usd ?? 0);
}

function errText(e: any) {
  const m = String((e && e.message) || e || "");
  return m.replace(/^.*?ERROR:\s*/, "") || "Something went wrong.";
}

function Health({ w }: { w: Ws }) {
  if (!w.owner_joined) return <span className="pill hold">Waiting for owner</span>;
  if (w.errors.length) return <span className="pill crit" title={w.errors.join(", ")}>Connection error</span>;
  if (w.queue_failed_7d) return <span className="pill warn">{w.queue_failed_7d} failed this week</span>;
  if (!w.setup_done) return <span className="pill off">Setting up</span>;
  return <span className="pill ok">Running</span>;
}

function WorkspaceRow({ X, w, onSaved }: { X: Ctx; w: Ws; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(w.name);
  const [owner, setOwner] = useState(w.owner_email || "");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const budget = w.ai_budget && w.ai_budget.monthly_usd;
  const s = spend(w);
  const save = async () => {
    if (!name.trim()) return setErr("Name the workspace.");
    if (!w.owner_joined && owner.trim() && !EMAIL.test(owner.trim())) return setErr("Use the owner's email address.");
    setBusy(true);
    setErr("");
    const { error } = await supabase.rpc("platform_update_workspace", { p_id: w.id, p_name: name.trim(), p_owner_email: w.owner_joined ? "" : owner.trim() });
    setBusy(false);
    if (error) return setErr(errText(error));
    X.toast("Workspace saved.");
    setOpen(false);
    onSaved();
  };
  return (
    <li className="pw-row">
      <button className="pw-sum" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="pw-name">
          <strong>{w.name}</strong>
          <span className="hint">{w.owner_joined || (w.owner_email ? `Invited: ${w.owner_email}` : "No owner set")}</span>
        </span>
        <span className="pw-health"><Health w={w} /></span>
        <span className="pw-num" title="Active members (pending)">
          <b>{w.members}</b>
          <span className="pw-lbl">{w.pending ? `members · ${w.pending} pending` : w.members === 1 ? "member" : "members"}</span>
        </span>
        <span className="pw-num"><b>{w.leads_7d}</b><span className="pw-lbl">leads, 7 days</span></span>
        <span className="pw-num"><b>{w.calls_7d}</b><span className="pw-lbl">calls, 7 days</span></span>
        <span className="pw-num" title={budget ? `Budget ${usd(budget)} a month` : undefined}>
          <b>{usd(s)}</b>
          <span className="pw-lbl">{budget ? `of ${usd(budget)} AI` : "AI this month"}</span>
        </span>
        <span className="pw-when hint">{w.last_active ? fmtStamp(w.last_active) : "No activity yet"}</span>
      </button>
      {open ? (
        <div className="pw-detail">
          <dl className="pw-facts">
            <div><dt>Setup</dt><dd>{w.setup_done ? "Finished" : "Not finished; research is paused"}</dd></div>
            <div><dt>Library</dt><dd>{w.documents} document{w.documents === 1 ? "" : "s"}</dd></div>
            <div><dt>Connected</dt><dd>{w.connected.length ? w.connected.map((p) => PROVIDER[p] || p).join(", ") : "Nothing yet"}</dd></div>
            <div><dt>Claude worker</dt><dd>{w.worker_token ? "Token issued" : "Not started"}</dd></div>
            <div><dt>Research queue</dt><dd>{w.queue_open} open · {w.queue_failed_7d} failed this week</dd></div>
            <div><dt>Accounts</dt><dd>{w.leads.toLocaleString("en-IN")} leads · {w.meetings_7d} meetings booked this week</dd></div>
            <div><dt>Invites waiting</dt><dd>{w.invites}</dd></div>
            <div><dt>Created</dt><dd>{fmtStamp(w.created_at)}</dd></div>
          </dl>
          <div className="form">
            <label>
              Workspace name
              <input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
            </label>
            <label>
              Owner's email
              <input type="email" value={owner} disabled={!!w.owner_joined} onChange={(e) => setOwner(e.target.value)} />
              <span className="note">{w.owner_joined ? "The owner has joined; ownership moves inside the workspace." : "Whoever signs up with this address becomes the owner."}</span>
            </label>
            {err ? <p className="field-err full" role="alert">{err}</p> : null}
            <div className="row full">
              <button className="btn" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save"}</button>
              <button className="btn ghost" onClick={() => setOpen(false)}>Cancel</button>
              <span className="hint mono">{w.id}</span>
            </div>
          </div>
        </div>
      ) : null}
    </li>
  );
}

function NewWorkspace({ X, onDone }: { X: Ctx; onDone: () => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [tried, setTried] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const errs = { name: name.trim() ? "" : "Name the workspace.", email: EMAIL.test(email.trim()) ? "" : "Use the owner's email address." };
  const create = async () => {
    setTried(true);
    if (errs.name || errs.email) return document.getElementById(errs.name ? "pw-new-name" : "pw-new-email")?.focus();
    setBusy(true);
    setErr("");
    const { error } = await supabase.rpc("platform_create_workspace", { p_name: name.trim(), p_owner_email: email.trim() });
    setBusy(false);
    if (error) return setErr(errText(error));
    X.toast(`${name.trim()} is ready. Ask ${email.trim()} to sign up at ${location.origin}.`);
    setName("");
    setEmail("");
    setTried(false);
    onDone();
  };
  return (
    <div className="form">
      <p className="note full">
        Bring a customer on while sign-up is closed. Whoever signs up with the owner's address lands in this workspace as its owner and
        runs setup from there.
      </p>
      <label>
        Workspace name
        <input id="pw-new-name" value={name} maxLength={120} aria-invalid={(tried && !!errs.name) || undefined} aria-describedby={tried && errs.name ? "pw-new-name-err" : undefined} onChange={(e) => setName(e.target.value)} placeholder="Customer company" />
        {tried && errs.name ? <span className="field-err" id="pw-new-name-err">{errs.name}</span> : null}
      </label>
      <label>
        Owner's email
        <input id="pw-new-email" type="email" value={email} autoComplete="off" aria-invalid={(tried && !!errs.email) || undefined} aria-describedby={tried && errs.email ? "pw-new-email-err" : undefined} onChange={(e) => setEmail(e.target.value)} placeholder="founder@customer.com" />
        {tried && errs.email ? <span className="field-err" id="pw-new-email-err">{errs.email}</span> : null}
      </label>
      {err ? <p className="field-err full" role="alert">{err}</p> : null}
      <div className="row full">
        <button className="btn" disabled={busy} onClick={create}>{busy ? "Creating…" : "Create workspace"}</button>
      </div>
    </div>
  );
}

function SignupCard({ X, o, onDone }: { X: Ctx; o: Overview; onDone: () => void }) {
  const [open, setOpen] = useState(!!o.signup.open);
  const [allow, setAllow] = useState((o.signup.allow || []).join("\n"));
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const emails = list(allow);
    const bad = emails.find((e) => !EMAIL.test(e));
    if (bad) return setErr(`${bad} isn't an email address.`);
    if (open && !o.signup.open && !window.confirm("Open sign-up? Anyone with the link can then create a workspace of their own.")) return;
    setBusy(true);
    setErr("");
    const { error } = await supabase.rpc("platform_set_signup", { p_open: open, p_allow: emails });
    setBusy(false);
    if (error) return setErr(errText(error));
    X.toast(open ? "Sign-up is open." : "Sign-up saved.");
    onDone();
  };
  const dirty = open !== !!o.signup.open || list(allow).join() !== (o.signup.allow || []).join();
  return (
    <div className="card pad pw-card">
      <h3>Sign-up</h3>
      <label className="row">
        <input type="checkbox" checked={open} onChange={(e) => setOpen(e.target.checked)} />
        <span><b>Anyone can sign up</b> and get a workspace of their own</span>
      </label>
      <label className="pw-stack">
        <span>While it's closed, these addresses can still sign up (one per line)</span>
        <textarea rows={4} value={allow} onChange={(e) => setAllow(e.target.value)} placeholder="founder@startup.com" />
      </label>
      <p className="note">Invited people and the owners of workspaces you create can always sign up.</p>
      {err ? <p className="field-err" role="alert">{err}</p> : null}
      <div className="row">
        <button className="btn" disabled={busy || !dirty} onClick={save}>{busy ? "Saving…" : "Save sign-up"}</button>
      </div>
    </div>
  );
}

function AdminsCard({ X, o, onDone }: { X: Ctx; o: Overview; onDone: () => void }) {
  const others = (o.admins || []).filter((e) => e !== o.owner);
  const [text, setText] = useState(others.join("\n"));
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const emails = list(text).filter((e) => e !== o.owner);
    const bad = emails.find((e) => !EMAIL.test(e));
    if (bad) return setErr(`${bad} isn't an email address.`);
    setBusy(true);
    setErr("");
    const { error } = await supabase.rpc("platform_set_admins", { p_emails: emails });
    setBusy(false);
    if (error) return setErr(errText(error));
    X.toast("Platform admins saved.");
    onDone();
  };
  return (
    <div className="card pad pw-card">
      <h3>Platform admins</h3>
      <p className="note">
        <b>{o.owner}</b> is the product owner: always an admin, and the only one who can open this console. It changes only through a
        database migration.
      </p>
      <label className="pw-stack">
        <span>Other platform admins may change the shared Google and HubSpot apps and the scheduled jobs (one per line)</span>
        <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="ops@yourcompany.com" />
      </label>
      {err ? <p className="field-err" role="alert">{err}</p> : null}
      <div className="row">
        <button className="btn" disabled={busy || list(text).join() === others.join()} onClick={save}>{busy ? "Saving…" : "Save admins"}</button>
      </div>
    </div>
  );
}

const ACTION: Record<string, string> = {
  "workspace.create": "Created workspace",
  "workspace.rename": "Renamed workspace",
  "workspace.owner": "Changed owner",
  "signup.set": "Changed sign-up",
  "admins.set": "Changed platform admins",
};

export default function PlatformTab() {
  const X = useX();
  const [o, setO] = useState<Overview | null>(null);
  const [err, setErr] = useState("");
  const [q, setQ] = useState("");
  const load = async () => {
    const { data, error } = await supabase.rpc("platform_overview");
    if (error) return setErr(errText(error));
    setErr("");
    setO(data as Overview);
  };
  useEffect(() => {
    load();
  }, []);

  if (err && !o)
    return (
      <div className="card pad view-err" role="alert">
        <h2>The console couldn't load</h2>
        <p className="note">{err}</p>
        <div className="row"><button className="btn" onClick={load}>Try again</button></div>
      </div>
    );
  if (!o) return <p className="note" role="status">Loading every workspace…</p>;

  const ws = o.workspaces || [];
  const shown = q.trim() ? ws.filter((w) => (w.name + " " + (w.owner_email || "") + " " + (w.owner_joined || "")).toLowerCase().includes(q.trim().toLowerCase())) : ws;
  const sum = (f: (w: Ws) => number) => ws.reduce((n, w) => n + f(w), 0);
  const attention = ws.filter((w) => w.errors.length || w.queue_failed_7d).length;
  const tiles: Array<[string, string, string]> = [
    ["Workspaces", String(ws.length), `${ws.filter((w) => w.setup_done).length} set up · ${ws.filter((w) => !w.owner_joined).length} waiting for their owner`],
    ["People", String(sum((w) => w.members)), `${sum((w) => w.pending)} waiting for a role · ${sum((w) => w.invites)} invites out`],
    ["Leads this week", sum((w) => w.leads_7d).toLocaleString("en-IN"), `${sum((w) => w.calls_7d)} calls · ${sum((w) => w.meetings_7d)} meetings booked`],
    ["AI this month", usd(sum(spend)), `${sum((w) => (w.ai_month ? w.ai_month.calls : 0)).toLocaleString("en-IN")} Claude calls across workspaces`],
  ];
  return (
    <>
      <div className="pw-tiles">
        {tiles.map(([k, v, s]) => (
          <div key={k} className="pw-tile">
            <span className="pw-lbl">{k}</span>
            <b>{v}</b>
            <span className="hint">{s}</span>
          </div>
        ))}
      </div>
      {err ? <p className="note err" role="status">{err} Showing the last successful load.</p> : null}

      <div className="section">
        <div className="section-head">
          <h2>Workspaces</h2>
          <span className="note">{attention ? `${attention} need${attention === 1 ? "s" : ""} attention` : "Nothing needs attention"}</span>
        </div>
        <div className="row pw-tools">
          <input type="search" aria-label="Find a workspace" placeholder="Find a workspace or owner" value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="btn ghost small" onClick={load}>Refresh</button>
        </div>
        {shown.length ? (
          <ul className="pw-list">
            {shown.map((w) => <WorkspaceRow key={w.id + w.name + (w.owner_email || "")} X={X} w={w} onSaved={load} />)}
          </ul>
        ) : (
          <p className="note">{ws.length ? "No workspace matches." : "No workspaces yet."}</p>
        )}
      </div>

      <div className="section">
        <div className="section-head"><h2>New workspace</h2></div>
        <NewWorkspace X={X} onDone={load} />
      </div>

      <div className="section">
        <div className="section-head"><h2>Access</h2></div>
        <div className="pw-cards">
          <SignupCard key={JSON.stringify(o.signup)} X={X} o={o} onDone={load} />
          <AdminsCard key={o.admins.join()} X={X} o={o} onDone={load} />
        </div>
      </div>

      <div className="section">
        <div className="section-head"><h2>Console activity</h2><span className="note">Every change made here</span></div>
        {o.audit.length ? (
          <ul className="pw-audit">
            {o.audit.map((a) => (
              <li key={a.id}>
                <span className="hint">{fmtStamp(a.at)}</span>
                <span><b>{ACTION[a.action] || a.action}</b>{a.target ? ` · ${a.target}` : ""}{a.detail ? ` · ${a.detail}` : ""}</span>
                <span className="hint">{a.actor}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="note">Nothing changed from the console yet.</p>
        )}
      </div>
    </>
  );
}
