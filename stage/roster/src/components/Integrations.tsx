import { useEffect, type ReactNode } from "react";
import Icon from "./Icon";
import type { Ctx } from "../lib/ctx";
import type { Row } from "../lib/data";
import { fmtStamp } from "../lib/format";
import { invokeFn, supabase } from "../lib/supabase";
import { connectGoogleCalendar, setCalFromStatus } from "../lib/google";
import { bookingLink, can } from "../lib/perms";
import { audit, saveLink } from "../lib/actions";
import { copyText } from "./common";

/* Admin > Integrations: one card per provider. Secrets go to the `integrations` edge function, which validates
   them live and stores them in Supabase Vault. The browser never reads a stored key back. */

type Entry = {
  connected?: boolean;
  status?: "connected" | "error" | "disconnected";
  account_label?: string | null;
  error?: string | null;
  last_checked_at?: string | null;
  configured_via?: "app" | "env" | null;
  owner_id?: string | null;
};

const errMsg = (e: any) => (e && e.message) || "Request failed.";
const F = (X: Ctx, k: string) => X.S.forms["int:" + k] || (X.S.forms["int:" + k] = {});

export async function loadInteg(X: Ctx, quiet = false) {
  const I = X.S.integ;
  if (!quiet) {
    I.loading = true;
    I.err = "";
    X.rerender();
  }
  try {
    const d = await invokeFn("integrations", { action: "status" });
    I.data = d;
    I.err = "";
    setCalFromStatus(d);
  } catch (e: any) {
    // Keep whatever status was read before; never stand in an empty one, which would read as "nothing connected".
    I.err = "Could not read integration status. " + errMsg(e);
  }
  I.loading = false;
  X.rerender();
}

async function loadJobs(X: Ctx) {
  try {
    X.S.integ.jobs = await invokeFn("integrations-status", undefined, "GET");
  } catch (e: any) {
    X.S.integ.jobs = { cron_jobs: [], cron_error: "Could not read scheduled tasks. " + errMsg(e) };
  }
  X.rerender();
}

/** Run an integrations action with a busy flag, toast the result, then refresh status. */
async function act(X: Ctx, key: string, body: Record<string, unknown>, ok: (r: any) => string, after?: (r: any) => void) {
  if (X.S.busy.has(key)) return;
  X.S.busy.add(key);
  X.rerender();
  try {
    const r = await invokeFn("integrations", { action: body.action, ...body });
    if (after) after(r);
    X.toast(ok(r));
    await loadInteg(X, true);
  } catch (e: any) {
    X.toast(errMsg(e));
  } finally {
    X.S.busy.delete(key);
    X.rerender();
  }
}

async function startOAuth(X: Ctx, provider: "hubspot" | "hubspot_user" | "google_calendar" | "gmail_sender") {
  const key = provider + ":oauth";
  X.S.busy.add(key);
  X.rerender();
  try {
    if (provider === "google_calendar") await connectGoogleCalendar();
    else {
      const r = await invokeFn("integrations", { action: "oauth_start", provider, return_to: window.location.origin });
      if (r && r.url) window.location.href = r.url;
      else throw { message: "No sign-in link came back." };
    }
  } catch (e: any) {
    X.toast(errMsg(e));
    X.S.busy.delete(key);
    X.rerender();
  }
}

function StatusPill({ e }: { e: Entry | undefined }) {
  if (!e) return <span className="pill off">Not connected</span>;
  if (e.status === "error") return <span className="pill crit">Needs attention</span>;
  if (e.connected || e.status === "connected") return <span className="pill ok">Connected</span>;
  return <span className="pill off">Not connected</span>;
}

function Meta({ e }: { e: Entry | undefined }) {
  if (!e) return null;
  const bits: ReactNode[] = [];
  if (e.configured_via === "env") bits.push(<span key="env">Using a key from server settings</span>);
  else if (e.account_label && e.status !== "disconnected") bits.push(<span key="l" className="mono">{e.account_label}</span>);
  if (e.last_checked_at) bits.push(<span key="c">Last checked {fmtStamp(e.last_checked_at)}</span>);
  return (
    <>
      {bits.length ? (
        <p className="note">
          {bits.map((b, i) => (
            <span key={i}>
              {i ? " · " : ""}
              {b}
            </span>
          ))}
        </p>
      ) : null}
      {e.status === "error" && e.error ? <p className="note err">{e.error}</p> : null}
    </>
  );
}

function Card({ id, title, sub, entry, children, pill }: { id?: string; title: string; sub?: ReactNode; entry?: Entry; children?: ReactNode; pill?: ReactNode }) {
  return (
    <div className="card pad icard" id={id}>
      <div className="icard-head">
        <div>
          <h3 className="icard-title">{title}</h3>
          {sub ? <p className="note">{sub}</p> : null}
        </div>
        {pill !== undefined ? pill : <StatusPill e={entry} />}
      </div>
      {entry ? <Meta e={entry} /> : null}
      {children}
    </div>
  );
}

function CopyRow({ X, label, value }: { X: Ctx; label: string; value: string }) {
  return (
    <div className="full">
      <div className="note">{label}</div>
      <div className="row">
        <span className="mono copyval">{value || "Not available yet"}</span>
        {value ? (
          <button className="btn ghost small" onClick={() => copyText(X, value)}>
            Copy
          </button>
        ) : null}
      </div>
    </div>
  );
}

function ScopeList({ label, scopes }: { label: string; scopes: string[] }) {
  if (!scopes || !scopes.length) return null;
  return (
    <div className="full">
      <div className="note">{label}</div>
      <div className="scopes">
        {scopes.map((s) => (
          <span key={s} className="mono scope">
            {s}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Masked key input with Save and test, Test and Disconnect. */
function KeyControls({ X, provider, entry, placeholder }: { X: Ctx; provider: "apollo" | "fullenrich"; entry?: Entry; placeholder: string }) {
  const f = F(X, "key:" + provider);
  const busy = (a: string) => X.S.busy.has(provider + ":" + a);
  const connected = !!entry && entry.status !== "disconnected" && (entry.connected || entry.status === "error");
  return (
    <div className="form">
      <label className="full">
        {connected ? "Replace API key" : "API key"}
        <div className="row" style={{ flexWrap: "nowrap" }}>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            aria-label={`${provider} API key`}
            placeholder={placeholder}
            value={f.v || ""}
            style={{ flex: 1 }}
            onChange={(e) => {
              f.v = e.target.value;
              X.rerender();
            }}
          />
          <button
            className="btn small"
            disabled={!String(f.v || "").trim() || busy("save")}
            onClick={() =>
              act(X, provider + ":save", { action: "save_key", provider, api_key: String(f.v || "").trim() }, (r) => `Saved and verified. ${r.account_label || ""}`.trim(), () => {
                f.v = "";
              })
            }
          >
            {busy("save") ? "Checking…" : "Save and test"}
          </button>
        </div>
        {!String(f.v || "").trim() ? <span className="hint">Paste a key first</span> : null}
      </label>
      {connected ? (
        <div className="row full">
          <button
            className="btn ghost small"
            disabled={busy("test")}
            onClick={() => act(X, provider + ":test", { action: "test", provider }, (r) => (r.status === "connected" ? "Connection works." : "Check failed. " + (r.error || "")))}
          >
            {busy("test") ? "Testing…" : "Test"}
          </button>
          {entry && entry.configured_via === "app" ? (
            <button className="btn danger small" disabled={busy("disc")} onClick={() => act(X, provider + ":disc", { action: "disconnect", provider }, () => "Disconnected.")}>
              Disconnect
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** The Claude worker: a Claude Code routine (or a local Claude Code session) on a Claude subscription. It claims
    research and prep-brief tasks from the claude-work function with a worker token. The app never calls Claude. */
function ClaudeWorkerCard({ X, d }: { X: Ctx; d: any }) {
  // The worker's heartbeat (app_settings.claude_worker) arrives live over Realtime; queue counts refresh every minute.
  const live = (X.D.settings && X.D.settings.claude_worker) || {};
  const lastSeen = live.last_seen || (d.worker && d.worker.last_seen) || null;
  const active = !!lastSeen && Date.now() - Date.parse(lastSeen) < 26 * 3600e3;
  const w = { ...(d.worker || {}), ...live, last_seen: lastSeen, active };
  useEffect(() => {
    const t = setInterval(() => loadInteg(X, true), 60000);
    return () => clearInterval(t);
  }, []);
  const q = (d.worker && d.worker.queue) || {};
  const t = w.totals || {};
  const f = F(X, "worker");
  const entry: Entry = {
    connected: !!w.active,
    status: w.active ? "connected" : w.has_token ? "error" : "disconnected",
    account_label: w.worker ? `Worker: ${w.worker}` : null,
    error: w.has_token && !w.active ? (w.last_seen ? "No worker run in the last 26 hours." : "Token created. Waiting for the first worker run.") : null,
    last_checked_at: w.last_seen || null,
    configured_via: w.has_token ? "app" : null,
  };
  const makeToken = () =>
    act(X, "worker:token", { action: "worker_token" }, () => "New worker token created. Copy it now; it is shown once.", (r) => {
      f.token = r.token;
      f.endpoint = r.endpoint;
    });
  return (
    <Card id="integ-claude" title="Claude worker" sub="Research, tiering, outreach angles and prep briefs run in Claude Code on your Claude subscription. Supabase queues the work and checks every result." entry={entry}>
      <p className="note">
        Queue: {q.pending ?? 0} ready · {q.running ?? 0} in progress · {q.held ?? 0} in reserve · {q.gating ?? 0} waiting on the CRM check{q.failed ? ` · ${q.failed} failed` : ""}
      </p>
      <p className="note">
        Last claim {w.last_claim_at ? fmtStamp(w.last_claim_at) : "never"} · last result {w.last_submit_at ? fmtStamp(w.last_submit_at) : "never"} · {t.accounts_done ?? 0} accounts researched, {t.leads_written ?? 0} leads written, {t.briefs_done ?? 0} briefs
        {t.rejected_submits ? ` · ${t.rejected_submits} results sent back for fixes` : ""}
      </p>
      {f.token ? (
        <div className="form">
          <p className="note full err">Copy the token now. It is not stored and won't be shown again. Paste it into a network secret on the routine's environment, never into its environment variables.</p>
          <CopyRow X={X} label="Worker token (network secret value)" value={f.token} />
          <CopyRow X={X} label="ROSTER_WORKER_URL" value={f.endpoint || w.endpoint || ""} />
          <div className="row">
            <button className="btn ghost small" onClick={() => { delete f.token; X.rerender(); }}>I've saved it</button>
          </div>
        </div>
      ) : (
        <>
          {w.endpoint ? <CopyRow X={X} label="ROSTER_WORKER_URL" value={w.endpoint} /> : null}
          <div className="row">
            <button className="btn small" disabled={X.S.busy.has("worker:token")} onClick={makeToken}>
              {w.has_token ? "Replace worker token" : "Create worker token"}
            </button>
            {w.has_token ? <span className="hint">Replacing stops the current routine until you replace its network secret.</span> : null}
          </div>
        </>
      )}
      <details style={{ marginTop: 8 }}>
        <summary>Set up the routine</summary>
        <ol className="note">
          <li>Push the repository to GitHub with <span className="mono">.claude/</span> at the repository root (the skill and its agents) and the app in <span className="mono">roster/</span>. Folders starting with a dot are skipped by drag-and-drop uploads, so check they arrived.</li>
          <li>At claude.ai/code/routines, create a routine on that repository. Prompt: <span className="mono">Run the roster-research skill. Follow it exactly and stop when the queue is empty or you reach max_accounts_per_run.</span> Schedule: hourly.</li>
          <li>Give it its own environment with network access set to Full, so researchers can read company websites, and one environment variable: <span className="mono">ROSTER_WORKER_URL</span> (above).</li>
          <li>
            In the environment's settings, under <b>Network secrets</b>, add a secret: type Bearer, allowed website{" "}
            <span className="mono">{(() => { try { return new URL(f.endpoint || w.endpoint || "").host; } catch { return "your-project.supabase.co"; } })()}</span>, header{" "}
            <span className="mono">Authorization</span> with prefix <span className="mono">Bearer</span>, value = the worker token. Anthropic's proxy adds it to the worker's requests after they leave the session, so Claude never sees the token. Delete any old <span className="mono">ROSTER_WORKER_TOKEN</span> variable.
          </li>
          <li>To run it by hand instead, open the repository in Claude Code with <span className="mono">ROSTER_WORKER_URL</span> and <span className="mono">ROSTER_WORKER_TOKEN</span> set and ask it to run the roster-research skill.</li>
        </ol>
        <p className="note">Each run handles up to the "Accounts per Claude worker run" setting in Admin &gt; Reps and segments, which keeps usage inside your plan's limits.</p>
      </details>
    </Card>
  );
}

const WAKES: Array<["research" | "post_call", string, string]> = [
  ["research", "Research routine", "Wakes the main routine when accounts or prep briefs are queued, at most every 10 minutes."],
  ["post_call", "Post-call routine", "Wakes a routine that only drafts post-call and reschedule emails, so drafts arrive within minutes."],
];

/** This workspace's routine API triggers. Without them, work waits for the routine's schedule. */
function WakeCard({ X, d }: { X: Ctx; d: any }) {
  const on = d.wake || {};
  return (
    <Card id="integ-wake" title="Routine wake-ups" sub="Optional. Paste a routine's API trigger URL and token (claude.ai/code/routines > the routine > API trigger) so queued work starts right away instead of on the next scheduled run.">
      {WAKES.map(([kind, label, help]) => {
        const f = F(X, "wake:" + kind);
        const key = "wake:" + kind;
        const busy = X.S.busy.has(key);
        const save = (url: string, token: string) =>
          act(X, key, { action: "save_wake", kind, url, token }, (r) => (r.configured ? `${label} wake-up saved.` : `${label} wake-up turned off.`), () => {
            delete X.S.forms["int:wake:" + kind];
            loadInteg(X, true);
          });
        return (
          <div className="form" key={kind}>
            <p className="full" style={{ margin: 0 }}>
              <strong>{label}</strong> {on[kind] ? <span className="pill ok">On</span> : <span className="pill off">Off</span>}
            </p>
            <p className="note full">{help}</p>
            <label>
              Trigger URL
              <input autoComplete="off" spellCheck={false} placeholder="https://api.anthropic.com/v1/claude_code/routines/…/fire" value={f.url || ""} onChange={(e) => { f.url = e.target.value; X.rerender(); }} />
            </label>
            <label>
              Token
              <input type="password" autoComplete="off" spellCheck={false} value={f.token || ""} onChange={(e) => { f.token = e.target.value; X.rerender(); }} />
            </label>
            <div className="row">
              <button className="btn small" disabled={busy || !String(f.url || "").trim() || !String(f.token || "").trim()} onClick={() => save(String(f.url).trim(), String(f.token).trim())}>
                {busy ? "Saving…" : "Save"}
              </button>
              {on[kind] ? (
                <button className="btn ghost small" disabled={busy} onClick={() => save("", "")}>
                  Turn off
                </button>
              ) : null}
            </div>
          </div>
        );
      })}
    </Card>
  );
}

/** Client ID and secret form shared by the HubSpot app and the Google OAuth client. */
function AppForm({ X, provider, title, children, idHint }: { X: Ctx; provider: "hubspot_app" | "google_app"; title: string; children?: ReactNode; idHint: string }) {
  const f = F(X, "app:" + provider);
  const busy = X.S.busy.has(provider + ":save");
  if (X.S.integ.data && X.S.integ.data.platform_admin === false) {
    return <p className="note">{title}: this app is shared by every workspace, so the platform admin sets it up.</p>;
  }
  return (
    <div className="form">
      <p className="full" style={{ margin: 0 }}>
        <strong>{title}</strong>
      </p>
      {children}
      <label>
        Client ID
        <input
          autoComplete="off"
          spellCheck={false}
          placeholder={idHint}
          value={f.id || ""}
          onChange={(e) => {
            f.id = e.target.value;
            X.rerender();
          }}
        />
      </label>
      <label>
        Client secret
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={f.secret || ""}
          onChange={(e) => {
            f.secret = e.target.value;
            X.rerender();
          }}
        />
      </label>
      <div className="row">
        <button
          className="btn small"
          disabled={busy || !String(f.id || "").trim() || !String(f.secret || "").trim()}
          onClick={() =>
            act(X, provider + ":save", { action: "save_app", provider, client_id: String(f.id).trim(), client_secret: String(f.secret).trim() }, () => "Saved.", () => {
              delete X.S.forms["int:app:" + provider];
              X.S.forms["int:edit:" + provider] = false;
            })
          }
        >
          {busy ? "Saving…" : "Save"}
        </button>
        {!busy && (!String(f.id || "").trim() || !String(f.secret || "").trim()) ? <span className="hint">Enter the client ID and secret first</span> : null}
        {X.S.forms["int:edit:" + provider] ? (
          <button
            className="btn ghost small"
            onClick={() => {
              X.S.forms["int:edit:" + provider] = false;
              X.rerender();
            }}
          >
            Cancel
          </button>
        ) : null}
      </div>
    </div>
  );
}

function AppSummary({ X, provider, entry, what }: { X: Ctx; provider: "hubspot_app" | "google_app"; entry?: Entry; what: string }) {
  return (
    <div className="row">
      <span className="note">
        {what}: {entry && entry.configured_via === "env" ? "from server settings" : (entry && entry.account_label) || "saved"}
      </span>
      <button
        className="btn ghost small"
        onClick={() => {
          X.S.forms["int:edit:" + provider] = true;
          X.rerender();
        }}
      >
        Change
      </button>
      {entry && entry.configured_via === "app" ? (
        <button className="btn danger small" disabled={X.S.busy.has(provider + ":disc")} onClick={() => act(X, provider + ":disc", { action: "disconnect", provider }, () => "Removed.")}>
          Remove
        </button>
      ) : null}
    </div>
  );
}

function HubSpotCard({ X, d }: { X: Ctx; d: any }) {
  const P = d.providers || {};
  const entry: Entry | undefined = P.hubspot;
  const appOk = !!d.hubspot_app_configured;
  const editing = !appOk || !!X.S.forms["int:edit:hubspot_app"];
  const busy = (a: string) => X.S.busy.has("hubspot:" + a);
  const live = !!entry && entry.status !== "disconnected";
  const viaPat = !!(entry && (entry as any).meta && (entry as any).meta.kind === "private_app") || /Private app/.test(String(entry?.account_label || ""));
  const mode: "pat" | "oauth" = X.S.forms["hs:mode"] || (live && !viaPat && appOk ? "oauth" : "pat");
  const setMode = (m: "pat" | "oauth") => {
    X.S.forms["hs:mode"] = m;
    X.rerender();
  };
  const tok: string = X.S.forms["hs:pat"] || "";
  const savePat = () =>
    act(X, "hubspot:pat", { action: "save_hubspot_token", token: tok.trim() }, (r) => {
      delete X.S.forms["hs:pat"];
      const miss: string[] = r.missing_scopes || [];
      return miss.length
        ? `Token saved, but the private app is missing: ${miss.join(", ")}. Add them in HubSpot and save the token again.`
        : `HubSpot connected with the private app.${r.mapped ? ` Mapped ${r.mapped} people to HubSpot owners.` : ""}`;
    });
  return (
    <Card id="integ-hubspot" title="HubSpot" sub="Contacts, call notes, POC deals, owner mapping, email opens and replies, and the meeting sync." entry={entry}>
      {entry && entry.configured_via === "env" ? <p className="note">Using a private app token from server settings. Paste one below to manage it here instead.</p> : null}
      <div className="seg" role="group" aria-label="How to connect HubSpot">
        <button aria-pressed={mode === "pat"} onClick={() => setMode("pat")}>Private app token</button>
        <button aria-pressed={mode === "oauth"} onClick={() => setMode("oauth")}>OAuth app</button>
      </div>
      {mode === "pat" ? (
        <div className="form">
          <p className="note full">
            In HubSpot, open <b>Settings &gt; Integrations &gt; Private Apps</b> (newer accounts: <b>Development &gt; Legacy apps &gt; Create &gt; Private</b>), name it
            "Stage Prospect", tick the scopes below, create it, then copy the access token (it starts with <span className="mono">pat-</span>). A developer API key won't work.
          </p>
          <ScopeList label="Scopes to tick" scopes={d.hubspot_pat_scopes || []} />
          <label className="full">
            Private app access token
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="pat-na2-…"
              value={tok}
              onChange={(e) => {
                X.S.forms["hs:pat"] = e.target.value;
                X.rerender();
              }}
            />
          </label>
          <div className="row full">
            <button className="btn small" disabled={!tok.trim() || busy("pat")} onClick={savePat}>
              {busy("pat") ? "Checking…" : live && viaPat ? "Replace token" : "Save and test"}
            </button>
            <span className="hint">Checked against HubSpot, then stored encrypted in Supabase Vault. Never shown again.</span>
          </div>
        </div>
      ) : null}
      {mode === "oauth" && editing ? (
        <AppForm X={X} provider="hubspot_app" title="Set up HubSpot app" idHint="From your HubSpot developer app, Auth tab">
          <p className="note full">
            Create an app in your HubSpot developer account, paste this Redirect URL on its Auth tab, add the scopes below, then save its client ID and secret here.
          </p>
          <CopyRow X={X} label="Redirect URL" value={(d.redirect_urls && d.redirect_urls.hubspot) || d.callback_url || ""} />
          <ScopeList label="Required scopes" scopes={d.hubspot_scopes || []} />
          <ScopeList label="Optional scopes" scopes={d.hubspot_optional_scopes || []} />
        </AppForm>
      ) : mode === "oauth" ? (
        <AppSummary X={X} provider="hubspot_app" entry={P.hubspot_app} what="HubSpot app" />
      ) : null}
      <div className="row">
        {mode === "oauth" ? (
          <>
            <button className="btn small" disabled={!appOk || busy("oauth")} onClick={() => startOAuth(X, "hubspot")}>
              {busy("oauth") ? "Opening HubSpot…" : live && entry!.configured_via === "app" && !viaPat ? "Reconnect HubSpot" : "Connect HubSpot"}
            </button>
            {!appOk ? <span className="hint">Save the HubSpot app first</span> : null}
          </>
        ) : null}
        {live ? (
          <>
            <button
              className="btn ghost small"
              disabled={busy("test")}
              onClick={() => act(X, "hubspot:test", { action: "test", provider: "hubspot" }, (r) => (r.status === "connected" ? "HubSpot connection works." : "Check failed. " + (r.error || "")))}
            >
              {busy("test") ? "Testing…" : "Test"}
            </button>
            <button
              className="btn ghost small"
              disabled={busy("map")}
              onClick={() =>
                act(X, "hubspot:map", { action: "map_owners" }, (r) => {
                  const un: string[] = r.unmatched || [];
                  return `Mapped ${r.mapped ?? 0} of ${r.checked ?? 0} people to HubSpot owners.` + (un.length ? ` Unmatched: ${un.join(", ")}.` : "");
                })
              }
            >
              {busy("map") ? "Mapping…" : "Re-map owners"}
            </button>
            {entry!.configured_via === "app" ? (
              <button className="btn danger small" disabled={busy("disc")} onClick={() => act(X, "hubspot:disc", { action: "disconnect", provider: "hubspot" }, () => "HubSpot disconnected.")}>
                Disconnect
              </button>
            ) : null}
          </>
        ) : null}
      </div>
      {d.hubspot_app_invalid ? (
        <p className="hint">
          The saved HubSpot app <b>Client ID</b> isn't a HubSpot client ID, so the optional rep sign-in is off. Linking reps to their HubSpot user below works without it.
        </p>
      ) : null}
      {live ? <OwnerRequests X={X} d={d} /> : null}
      {live ? <MyHubSpot X={X} d={d} /> : null}
    </Card>
  );
}

type OwnerOpt = { id: string; name: string; email: string; email_match: boolean; linked_to: { id: string; name: string; me: boolean } | null };

/** Everyone links themselves to their HubSpot owner (through the team's private app token), so contacts they
    create and meetings they book are matched to them. Same email links at once; anything else waits for an admin.
    When a HubSpot OAuth app is set up, reps can also sign in so call notes show them as the author. */
function MyHubSpot({ X, d }: { X: Ctx; d: any }) {
  const me: any = (d.me && d.me.hubspot) || {};
  const signedIn = me.status && me.status !== "disconnected";
  const appOk = !!d.hubspot_app_configured;
  const busy = (a: string) => X.S.busy.has("hubspot_user:" + a);
  const P = X.S.forms["hs:owners"] || (X.S.forms["hs:owners"] = { list: null as OwnerOpt[] | null, q: "", pick: "", loading: false, open: false });
  const load = async () => {
    P.open = true;
    P.loading = true;
    X.rerender();
    try {
      const r = await invokeFn<{ owners: OwnerOpt[] }>("integrations", { action: "hubspot_owners" });
      P.list = r.owners || [];
      const auto = (P.list as OwnerOpt[]).find((o: OwnerOpt) => o.email_match);
      if (auto && !P.pick) P.pick = auto.id;
    } catch (e: any) {
      X.toast(errMsg(e));
      P.open = false;
    } finally {
      P.loading = false;
      X.rerender();
    }
  };
  const q = String(P.q || "").toLowerCase();
  const shown: OwnerOpt[] = (P.list || []).filter((o: OwnerOpt) => !q || o.name.toLowerCase().includes(q) || o.email.toLowerCase().includes(q)).slice(0, 50);
  const chosen: OwnerOpt | undefined = (P.list || []).find((o: OwnerOpt) => o.id === P.pick);
  const link = () =>
    act(X, "hubspot_user:link", { action: "hubspot_link_owner", owner_id: P.pick }, (r) =>
      r.status === "linked" ? `Linked to ${r.owner_label}.` : `Sent to an admin to confirm ${r.owner_label}.`, () => {
      X.S.forms["hs:owners"] = { list: null, q: "", pick: "", loading: false, open: false };
    });
  return (
    <div className="isub">
      <div className="icard-head">
        <div style={{ minWidth: 0 }}>
          <strong>Your HubSpot user</strong>
          <p className="note">
            Link yourself to your HubSpot user so contacts you create and meetings you book are owned by you in HubSpot.
          </p>
        </div>
        {me.owner_id ? <span className="pill ok">Linked</span> : me.owner_pending ? <span className="pill hold">Waiting for admin</span> : <span className="pill off">Not linked</span>}
      </div>
      {me.owner_id ? <p className="note">Linked to <b>{me.owner_label || `HubSpot owner ${me.owner_id}`}</b>.</p> : null}
      {me.owner_pending ? <p className="note">You asked to link <b>{me.owner_pending_label || me.owner_pending}</b>. An admin confirms it because the email doesn't match yours.</p> : null}
      {P.open ? (
        <div className="form" style={{ marginTop: 8 }}>
          <label className="full">
            Find yourself
            <input type="search" value={P.q} placeholder="Name or email" onChange={(e) => ((P.q = e.target.value), X.rerender())} autoFocus />
          </label>
          <div className="full cands" role="radiogroup" aria-label="HubSpot users" style={{ maxHeight: 240, overflowY: "auto" }}>
            {P.loading ? <p className="note">Loading HubSpot users…</p> : null}
            {!P.loading && !shown.length ? <p className="note">No HubSpot user matches.</p> : null}
            {shown.map((o) => (
              <label key={o.id}>
                <input type="radio" name="hs-owner" checked={P.pick === o.id} onChange={() => ((P.pick = o.id), X.rerender())} />
                {o.name} <span className="muted">{o.email}</span>
                {o.email_match ? <span className="pill ok">your email</span> : null}
                {o.linked_to && !o.linked_to.me ? <span className="pill warn">linked to {o.linked_to.name}</span> : null}
                {o.linked_to && o.linked_to.me ? <span className="pill off">you now</span> : null}
              </label>
            ))}
          </div>
          <div className="row full">
            <button className="btn small" disabled={!chosen || busy("link") || (chosen && chosen.linked_to && chosen.linked_to.me) || false} onClick={link}>
              {busy("link") ? "Linking…" : chosen && !chosen.email_match && !d.can_review_owners ? "Ask an admin to link" : "Link"}
            </button>
            <button className="btn ghost small" onClick={() => ((P.open = false), X.rerender())}>Cancel</button>
            {chosen && chosen.linked_to && !chosen.linked_to.me ? <span className="hint">Linking moves this HubSpot user off {chosen.linked_to.name}.</span> : null}
          </div>
        </div>
      ) : (
        <div className="row">
          <button className={me.owner_id ? "btn ghost small" : "btn small"} disabled={!d.providers?.hubspot?.connected} onClick={load}>
            {me.owner_id || me.owner_pending ? "Change" : "Choose your HubSpot user"}
          </button>
          {me.owner_id || me.owner_pending ? (
            <button className="btn ghost small" disabled={busy("unlink")} onClick={() => act(X, "hubspot_user:unlink", { action: "hubspot_unlink_owner" }, () => (me.owner_pending && !me.owner_id ? "Request withdrawn." : "Unlinked from HubSpot."))}>
              {me.owner_pending && !me.owner_id ? "Withdraw" : "Unlink"}
            </button>
          ) : null}
        </div>
      )}
      {appOk ? (
        <div className="row" style={{ marginTop: 10 }}>
          <span className="note">Optional: sign in so call notes show you as the author.</span>
          <button className="btn ghost small" disabled={busy("oauth")} onClick={() => startOAuth(X, "hubspot_user")}>
            {busy("oauth") ? "Opening HubSpot…" : signedIn ? "Sign in again" : "Sign in to HubSpot"}
          </button>
          {signedIn ? (
            <button className="btn danger small" disabled={busy("disc")} onClick={() => act(X, "hubspot_user:disc", { action: "disconnect", provider: "hubspot_user" }, () => "HubSpot login removed. Notes now go in as the team connection.")}>
              Sign out
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Admins confirm owner links whose email didn't match. */
function OwnerRequests({ X, d }: { X: Ctx; d: any }) {
  const rows: any[] = d.hubspot_pending || [];
  if (!d.can_review_owners || !rows.length) return null;
  return (
    <div className="isub">
      <strong>HubSpot links to confirm</strong>
      <p className="note">These reps picked a HubSpot user whose email doesn't match their roster email.</p>
      {rows.map((r) => (
        <div key={r.user_id} className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
          <span>
            <b>{r.name}</b> <span className="muted">wants</span> {r.owner_label || r.owner_id}
            {r.current ? <span className="muted"> (now {r.current})</span> : null}
          </span>
          <span className="row">
            <button className="btn small" disabled={X.S.busy.has("own:" + r.user_id)} onClick={() => act(X, "own:" + r.user_id, { action: "hubspot_review_owner", user_id: r.user_id, approve: true }, () => `Linked ${r.name}.`)}>
              Approve
            </button>
            <button className="btn ghost small" disabled={X.S.busy.has("own:" + r.user_id)} onClick={() => act(X, "own:" + r.user_id, { action: "hubspot_review_owner", user_id: r.user_id, approve: false }, () => "Request rejected.")}>
              Reject
            </button>
          </span>
        </div>
      ))}
    </div>
  );
}

/** Everyone's own calendar. */
function MyCalendar({ X, d }: { X: Ctx; d: any }) {
  const me: Entry | undefined = d.me && d.me.google_calendar;
  const live = !!me && me.status !== "disconnected";
  const busy = (a: string) => X.S.busy.has("google_calendar:" + a);
  return (
    <div className="isub">
      <div className="icard-head">
        <div>
          <strong>Your calendar</strong>
          <p className="note">Callback and task blocks, and Meet link lookups, use your own Google Calendar.</p>
        </div>
        <StatusPill e={me} />
      </div>
      {me ? <Meta e={me} /> : null}
      <div className="row">
        <button className={live ? "btn ghost small" : "btn small"} disabled={busy("oauth")} onClick={() => startOAuth(X, "google_calendar")}>
          {busy("oauth") ? "Opening Google…" : !live ? "Connect my Google Calendar" : "Reconnect"}
        </button>
        {live ? (
          <>
            <button
              className="btn ghost small"
              disabled={busy("test")}
              onClick={() => act(X, "google_calendar:test", { action: "test", provider: "google_calendar" }, (r) => (r.status === "connected" ? "Your calendar connection works." : "Check failed. " + (r.error || "")))}
            >
              {busy("test") ? "Testing…" : "Test"}
            </button>
            <button className="btn danger small" disabled={busy("disc")} onClick={() => act(X, "google_calendar:disc", { action: "disconnect", provider: "google_calendar" }, () => "Google Calendar disconnected.")}>
              Disconnect
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}

function GoogleCard({ X, d, admin }: { X: Ctx; d: any; admin: boolean }) {
  const P = d.providers || {};
  const appOk = !!d.google_app_configured;
  const editing = !appOk || !!X.S.forms["int:edit:google_app"];
  const me: Entry | undefined = d.me && d.me.google_calendar;
  return (
    <Card id="integ-google" title="Google Calendar" sub={admin ? "One Google OAuth client for the team, then each person connects their own calendar." : undefined} entry={undefined} pill={<StatusPill e={me} />}>
      {admin ? (
        editing ? (
          <AppForm X={X} provider="google_app" title="Set up Google OAuth client" idHint="….apps.googleusercontent.com">
            <p className="note full">
              In Google Cloud, open the Web application OAuth client. It needs two Redirect URLs: one for signing in to the roster, and this one for calendars. Add this Redirect URL and keep the sign-in one. Both must be listed or one of them stops working.
            </p>
            <CopyRow X={X} label="Redirect URL for calendars" value={(d.redirect_urls && d.redirect_urls.google) || d.callback_url || ""} />
            <ScopeList label="Scopes" scopes={d.google_scopes || []} />
          </AppForm>
        ) : (
          <AppSummary X={X} provider="google_app" entry={P.google_app} what="Google OAuth client" />
        )
      ) : null}
      <MyCalendar X={X} d={d} />
    </Card>
  );
}

function KeyCard({ X, d, provider, title, sub, placeholder }: { X: Ctx; d: any; provider: "apollo" | "fullenrich"; title: string; sub: string; placeholder: string }) {
  const entry: Entry | undefined = d.providers && d.providers[provider];
  return (
    <Card id={"integ-" + provider} title={title} sub={sub} entry={entry}>
      <KeyControls X={X} provider={provider} entry={entry} placeholder={placeholder} />
    </Card>
  );
}

/** The mailbox invitations are sent from (a team alias if one is set), connected once through Google with send-only access. */
function InviteMailCard({ X, d }: { X: Ctx; d: any }) {
  const P = d.providers || {};
  const entry: Entry | undefined = P.gmail_sender;
  const live = !!(entry && entry.connected);
  const alias = (X.D.settings.invite_sender && X.D.settings.invite_sender.email) || "";
  const appOk = !!(P.google_app && P.google_app.connected);
  const busy = (k: string) => X.S.busy.has("gmail_sender:" + k);
  return (
    <Card
      id="integ-mail"
      title="Invite email"
      sub={alias ? `Invitations go out from ${alias} through Gmail. Connect the mailbox that sends as ${alias}, so invites show in its Sent folder.` : "Invitations go out through Gmail from the mailbox you connect here, so invites show in its Sent folder."}
      entry={entry}
    >
      {!live ? (
        <ol className="note">
          <li>Press Connect and sign in with the Google account {alias ? `that owns the ${alias} alias` : "invites should come from"}. Allow sending email; nothing can be read.</li>
          {alias ? <li>Invites then go out with {alias} as the sender. If that address isn't set up under Gmail Settings &gt; Accounts &gt; Send mail as, Gmail sends from the mailbox address instead.</li> : null}
          <li>If Google says the Gmail API is off, enable it in the Google Cloud project of the OAuth client (APIs &amp; Services &gt; Library &gt; Gmail API) and connect again.</li>
        </ol>
      ) : null}
      <div className="row">
        <button className="btn small" disabled={!appOk || busy("oauth")} onClick={() => startOAuth(X, "gmail_sender")}>
          {busy("oauth") ? "Opening Google…" : live ? "Reconnect" : "Connect mailbox"}
        </button>
        {!appOk ? <span className="hint">Set up the Google OAuth client first (Google Calendar card)</span> : null}
        {live ? (
          <>
            <button
              className="btn ghost small"
              disabled={busy("test")}
              onClick={() => act(X, "gmail_sender:test", { action: "test", provider: "gmail_sender" }, (r) => (r.status === "connected" ? `Mailbox works (${r.account_label || alias || "connected"}).` : "Check failed. " + (r.error || "")))}
            >
              {busy("test") ? "Testing…" : "Test"}
            </button>
            <button className="btn danger small" disabled={busy("disc")} onClick={() => act(X, "gmail_sender:disc", { action: "disconnect", provider: "gmail_sender" }, () => "Invite mailbox disconnected.")}>
              Disconnect
            </button>
          </>
        ) : null}
      </div>
    </Card>
  );
}

const JOB_LABELS: Array<[RegExp, string, string | null]> = [
  [/weekly/i, "Weekly batch build (Fri 8:00 PM IST)", "weekly-roster"],
  [/hubspot/i, "Nightly HubSpot meeting sync (11:22 PM IST)", "hubspot-sync"],
  [/queue-gate/i, "CRM check and quota release (every 5 minutes)", "queue-gate"],
];

function ScheduledTasks({ X }: { X: Ctx }) {
  const J = X.S.integ.jobs;
  useEffect(() => {
    if (!J) loadJobs(X);
  }, []);
  const jobs: Row[] = (J && (J.cron_jobs || J.jobs || J.cron)) || [];
  const sync = (J && J.hubspot_sync) || X.D.settings.hubspot_sync || null;
  const toggle = async (job: string, enabled: boolean, label: string) => {
    try {
      await invokeFn("integrations-status", { job, enabled });
      await audit(enabled ? "scheduled task enabled" : "scheduled task paused", "", label);
      X.toast(enabled ? "Scheduled task on." : "Scheduled task paused.");
      loadJobs(X);
    } catch (e: any) {
      X.toast("Could not change the scheduled task. " + errMsg(e));
    }
  };
  const run = async (fn: string, label: string) => {
    try {
      await invokeFn("integrations-status", { run: fn });
      await audit("scheduled task run", "", label);
      X.toast("Started. It runs in Supabase and updates the roster when done.");
    } catch (e: any) {
      X.toast("Could not start it. " + errMsg(e));
    }
  };
  return (
    <>
      <h2>Scheduled tasks</h2>
      {J && J.cron_error ? <p className={X.S.integ.data && X.S.integ.data.platform_admin === false ? "note" : "note err"}>{J.cron_error}</p> : null}
      {J && J.research_queue ? (
        <p className="note">
          Research queue: {J.research_queue.gating ?? 0} on CRM check · {J.research_queue.held ?? 0} in reserve · {J.research_queue.pending ?? 0} ready for Claude · {J.research_queue.running ?? 0} with Claude · {J.research_queue.failed ?? 0} failed
        </p>
      ) : null}
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>Task</th>
              <th>Last run</th>
              <th>On</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {!J ? (
              <tr>
                <td colSpan={4} className="muted">Loading scheduled tasks…</td>
              </tr>
            ) : jobs.length ? (
              jobs.map((j) => {
                const name = j.jobname || j.name || "";
                const meta = JOB_LABELS.find(([re]) => re.test(name));
                const label = meta ? meta[1] : name;
                const lr = j.last_run || {};
                const lrAt = lr.start_time || lr.fired_at || lr.at || j.last_run_at;
                return (
                  <tr key={name}>
                    <td>
                      <strong>{label}</strong>
                      <div className="muted small mono">{j.schedule || "on demand"} · {name}</div>
                    </td>
                    <td className="small">{lrAt ? `${lr.status || ""} · ${fmtStamp(lrAt)}` : "never"}</td>
                    <td>
                      <input type="checkbox" aria-label="Enabled" checked={!!j.active} onChange={(e) => toggle(name, e.target.checked, label)} />
                    </td>
                    <td>
                      <button className="btn ghost small" disabled={!meta || !meta[2]} title={!meta || !meta[2] ? "Not runnable from here" : undefined} onClick={() => meta && meta[2] && run(meta[2], label)}>
                        Run now
                      </button>
                    </td>
                  </tr>
                );
              })
            ) : (
              <tr>
                <td colSpan={4} className="muted">Scheduled jobs aren't running yet. Ask whoever set up Supabase to finish setup.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="note">
        HubSpot sync:{" "}
        {sync && sync.last_run ? (
          <>
            last run {fmtStamp(sync.last_run)} · {sync.threads_synced ?? ""} demos synced
            {sync.errors && String(sync.errors) !== "0" && !(Array.isArray(sync.errors) && !sync.errors.length) ? (
              <>
                {" "}
                · <span className="err">{JSON.stringify(sync.errors)}</span>
              </>
            ) : null}
          </>
        ) : (
          "no run yet (first run tonight at 11:22 PM IST)"
        )}
      </p>
    </>
  );
}

/** Connected and working (an error state does not count as done). */
const isOn = (e: Entry | undefined) => !!e && e.status !== "disconnected" && e.status !== "error" && (!!e.connected || e.status === "connected");

function scrollToCard(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "start" });
  const f = el.querySelector<HTMLElement>("input, select, button");
  if (f) setTimeout(() => f.focus({ preventScroll: true }), 300);
}

function SetupChecklist({ d }: { d: any }) {
  const P = d.providers || {};
  const items: Array<[string, string, boolean]> = [
    ["integ-claude", "Claude worker", isOn({ connected: !!(d.worker && d.worker.active), status: d.worker && d.worker.active ? "connected" : "disconnected" })],
    ["integ-hubspot", "HubSpot", isOn(P.hubspot)],
    ["integ-google", "Google Calendar", isOn(d.me && d.me.google_calendar)],
    ["integ-apollo", "Apollo", isOn(P.apollo)],
    ["integ-fullenrich", "FullEnrich", isOn(P.fullenrich)],
    ["integ-mail", "Invite email", isOn(P.gmail_sender)],
  ];
  const done = items.filter((i) => i[2]).length;
  return (
    <div className="card pad integ-check" aria-label="Setup checklist">
      <div className="integ-check-head">
        <strong>Setup checklist</strong>
        <span className={done === items.length ? "pill ok" : "pill hold"}>
          {done} of {items.length} connected
        </span>
      </div>
      <ol className="integ-check-list">
        {items.map(([id, label, on]) => (
          <li key={id}>
            <a
              href={"#" + id}
              className={on ? "done" : ""}
              onClick={(e) => {
                e.preventDefault();
                scrollToCard(id);
              }}
            >
              <span className="integ-mark" aria-hidden="true">{on ? <Icon name="check" size={12} /> : ""}</span>
              <span>{label}</span>
              <span className="integ-sr">{on ? " (connected)" : " (not connected)"}</span>
            </a>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** The shared HubSpot meetings link reps use to book demos. */
function BookingLinkCard({ X }: { X: Ctx }) {
  const f = F(X, "booking");
  const cur = bookingLink(X);
  const v: string = f.v === undefined ? cur : f.v;
  const busy = X.S.busy.has("booking:save");
  const changed = v.trim() !== cur;
  return (
    <Card id="integ-booking" title="HubSpot booking link" sub="Reps book demos through this link from Meetings and Accounts." pill={null}>
      <div className="form">
        <label className="full">
          Booking link
          <div className="row" style={{ flexWrap: "nowrap" }}>
            <input
              type="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="https://meetings.hubspot.com/…"
              value={v}
              style={{ flex: 1 }}
              onChange={(e) => {
                f.v = e.target.value;
                X.rerender();
              }}
            />
            <button
              className="btn small"
              disabled={busy || !v.trim() || !changed}
              onClick={async () => {
                X.S.busy.add("booking:save");
                X.rerender();
                try {
                  await saveLink(X, v);
                  // Read the stored link back so the field shows what was really saved.
                  const { data } = await supabase.from("app_settings").select("value").eq("key", "booking_link").maybeSingle();
                  if (data && data.value && data.value.url) {
                    X.D.settings.booking_link = data.value;
                    if (data.value.url === v.trim()) delete f.v;
                  }
                } finally {
                  X.S.busy.delete("booking:save");
                  X.rerender();
                }
              }}
            >
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
          {!busy && !v.trim() ? <span className="hint">Paste the HubSpot meetings link first</span> : !busy && !changed ? <span className="hint">No changes to save</span> : null}
        </label>
      </div>
    </Card>
  );
}

const ORG_READONLY: Array<[string, string]> = [
  ["hubspot", "HubSpot"],
  ["apollo", "Apollo"],
  ["fullenrich", "FullEnrich"],
];

export default function Integrations({ X }: { X: Ctx }) {
  const I = X.S.integ;
  useEffect(() => {
    if (!I.data && !I.loading) loadInteg(X);
  }, []);
  const d = I.data;
  const admin = can(X, "manage_integrations") && !(d && d.is_admin === false);
  const refresh = () => {
    X.S.integ = { data: null, loading: false, err: "", jobs: null };
    loadInteg(X);
    if (admin) loadJobs(X);
  };
  return (
    <div className="section">
      <div className="section-head">
        <h2>Integrations</h2>
        <button className="btn ghost small" disabled={I.loading} onClick={refresh}>
          {I.loading ? "Checking…" : "Refresh"}
        </button>
      </div>
      <p className="note">
        {admin
          ? "Connect each service here. Keys and tokens are checked live, then stored encrypted in Supabase Vault; they are never shown again. Start with HubSpot and Apollo, then the Claude worker."
          : "Connect your own Google Calendar and HubSpot login here. Admins manage the team connections below."}
      </p>
      {I.err && d ? <p className="note err" role="status">{I.err} What's shown is from the last successful check.</p> : null}
      {!d && I.err && !I.loading ? (
        <div className="card pad view-err" role="alert">
          <h2>Connection status is unavailable</h2>
          <p className="note">{I.err} Nothing has been disconnected; the status check itself failed, so keys don't need to be entered again.</p>
          <div className="row">
            <button className="btn" onClick={refresh}>Try again</button>
          </div>
        </div>
      ) : !d ? (
        <div className="empty">Checking connections…</div>
      ) : admin ? (
        <div className="icards">
          <SetupChecklist d={d} />
          <ClaudeWorkerCard X={X} d={d} />
          <WakeCard X={X} d={d} />
          <HubSpotCard X={X} d={d} />
          {can(X, "manage_integrations") ? <BookingLinkCard X={X} /> : null}
          <GoogleCard X={X} d={d} admin />
          <InviteMailCard X={X} d={d} />
          <KeyCard X={X} d={d} provider="apollo" title="Apollo" sub="Weekly people search and Enrich now." placeholder="Apollo API key" />
          <KeyCard X={X} d={d} provider="fullenrich" title="FullEnrich" sub="Optional email fallback when Apollo finds none. Spends FullEnrich credits." placeholder="FullEnrich API key" />
        </div>
      ) : (
        <div className="icards">
          <GoogleCard X={X} d={d} admin={false} />
          {d.providers && d.providers.hubspot && d.providers.hubspot.connected ? (
            <Card title="HubSpot">
              <MyHubSpot X={X} d={d} />
            </Card>
          ) : null}
          <Card title="Team connections" sub="Managed by admins." pill={null}>
            <div className="list">
              {ORG_READONLY.map(([k, label]) => {
                const e = d.providers && d.providers[k];
                return (
                  <div className="row" key={k} style={{ justifyContent: "space-between" }}>
                    <span>{label}</span>
                    {e && e.connected ? <span className="pill ok">Connected</span> : <span className="pill off">Not connected</span>}
                  </div>
                );
              })}
            </div>
          </Card>
        </div>
      )}
      {admin ? <ScheduledTasks X={X} /> : null}
      <p className="note">Sign-in is invite-only: the owner and people invited here can create an account, and only accounts with an active role can open the roster.</p>
    </div>
  );
}
