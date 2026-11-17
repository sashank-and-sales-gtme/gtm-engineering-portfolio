import { useEffect, useState } from "react";
import { useX, type Ctx } from "../lib/ctx";
import type { Row } from "../lib/data";
import { coName, fmtStamp } from "../lib/format";
import IntegrationsPanel from "./Integrations";
import IcpPanel from "./IcpPanel";
import RepsPanel from "./RepsPanel";
import SetupWizard from "./SetupWizard";
import { activeSupers, assignedTo, can, isAdminAny, myRole, PERMS, pname, roleGuard, roleName, superLimit } from "../lib/perms";
import {
  addInvite, addRole, deleteRole, doDelete, renameRole, setHubspotOwner, setUserRole, togglePerm, toggleSuspend, ownerLeave, resendInvite,
} from "../lib/actions";
import { askDel, MoreMenu, noDel } from "./common";
import { supabase } from "../lib/supabase";

function roleIds(X: Ctx) {
  return ["super_admin", ...X.D.roles.map((r) => r.id).filter((r) => r !== "super_admin")];
}
function RoleOptions({ X }: { X: Ctx }) {
  return (
    <>
      {roleIds(X).map((r) => (
        <option key={r} value={r}>
          {roleName(X, r)}
        </option>
      ))}
    </>
  );
}

function Users({ X }: { X: Ctx }) {
  const S = X.S;
  const manage = can(X, "manage_users");
  const cnt = (id: string) => X.D.leads.filter((l) => assignedTo(l) === id).length;
  const rank = (u: Row) => (u.is_owner ? -1 : u.status === "pending" ? 0 : u.role === "super_admin" ? 1 : 2);
  const users = X.D.profiles.slice().sort((a, b) => rank(a) - rank(b) || pname(X, a.id).localeCompare(pname(X, b.id)));
  const pending = users.filter((u) => u.status === "pending").length;
  const unmapped = users.filter((u) => u.status === "active" && !u.hubspot_owner_id).length;
  const goRemap = () => {
    X.S.adminSec = "integ";
    X.rerender();
    setTimeout(() => {
      const el = document.getElementById("integ-hubspot");
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 80);
  };
  return (
    <div className="section">
      <div className="section-head">
        <h2>Users</h2>
        <span className="note">
          {X.D.profiles.length} people · {activeSupers(X).length} of {superLimit(X)} Super Admins{pending ? ` · ${pending} awaiting approval` : ""}
        </span>
      </div>
      {manage ? (
        <div className="form">
          <p className="note full">
            Invite a colleague by email in any role. The invite comes from {(X.D.settings.invite_sender && X.D.settings.invite_sender.email) || "the mailbox connected under Integrations"}; they open the link and land straight in that role. Sign-in is invite-only, so colleagues need an invite before they can sign in.
          </p>
          <label>
            Work email
            <input
              id="adm-email"
              type="email"
              placeholder="name@company.com"
              value={S.invite.email}
              autoComplete="off"
              onChange={(e) => {
                S.invite.email = e.target.value;
                X.rerender();
              }}
            />
          </label>
          <label>
            Role
            <select
              id="adm-role"
              value={S.invite.role}
              onChange={(e) => {
                S.invite.role = e.target.value;
                X.rerender();
              }}
            >
              <RoleOptions X={X} />
            </select>
          </label>
          <div className="row">
            <button className="btn" disabled={!S.invite.email.trim() || S.busy.has("invite")} onClick={() => addInvite(X)}>
              {S.busy.has("invite") ? "Sending…" : "Send invite"}
            </button>
            {!S.invite.email.trim() ? <span className="hint">Enter a work email first</span> : null}
          </div>
          {X.D.invites.length ? (
            <div className="full cands">
              {X.D.invites.map((v) => (
                <div className="row" key={v.email}>
                  <span className="mono">{v.email}</span>
                  <span className="pill hold">{roleName(X, v.role)} on first sign-in</span>
                  {S.confirmDel === "invite:" + v.email ? (
                    <span className="confirm">
                      Remove this invite?
                      <button className="btn danger small" onClick={() => doDelete(X, "invite:" + v.email)}>Remove</button>
                      <button className="btn ghost small" onClick={() => noDel(X)}>Keep</button>
                    </span>
                  ) : (
                    <button className="btn ghost small" onClick={() => askDel(X, "invite:" + v.email)}>Remove</button>
                  )}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {unmapped ? (
        <p className="hint hs-hint">
          {unmapped === 1 ? "1 active person isn't" : `${unmapped} active people aren't`} mapped to a HubSpot owner, so their notes and contacts won't be owned by them in HubSpot.{" "}
          {manage ? "Paste their HubSpot user ID below, or use " : "Use "}
          <button type="button" className="linkbtn" onClick={goRemap}>
            Integrations &gt; HubSpot &gt; Re-map owners
          </button>
          .
        </p>
      ) : null}
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>Person</th>
              <th>Role</th>
              <th>Status</th>
              <th className="n">Assigned contacts</th>
              <th>HubSpot owner ID</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {users.length ? (
              users.map((u) => {
                const successor = users
                  .filter((x) => x.id !== X.uid && x.role === "super_admin" && x.status === "active")
                  .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))[0];
                const isOwn = !!u.is_owner,
                  locked = !manage || isOwn || u.id === X.uid || (u.role === "super_admin" && myRole(X) !== "super_admin");
                const apKey = "approve:" + u.id;
                const apRole: string = S.forms[apKey] || "";
                const hsId = String(u.hubspot_owner_id || "");
                const showEmail = !!u.email && pname(X, u.id) !== u.email;
                return (
                  <tr key={u.id}>
                    <td>
                      <div className="row" style={{ flexWrap: "nowrap" }}>
                        {u.avatar_url ? <img className="uavatar" src={u.avatar_url} alt="" width={24} height={24} referrerPolicy="no-referrer" onError={(e) => (e.currentTarget.hidden = true)} /> : null}
                        <div>
                          <strong>{pname(X, u.id)}</strong>
                          {isOwn ? <span className="pill adj">owner</span> : null}
                          {u.id === X.uid ? <span className="pill ok">you</span> : null}
                          {u.invited_at && !u.signed_in_at ? (
                            <span className="pill hold" title={`Invite sent ${fmtStamp(u.invited_at)}`}>invite sent</span>
                          ) : null}
                          {showEmail ? <div className="muted small">{u.email}</div> : null}
                        </div>
                      </div>
                    </td>
                    <td>
                      {u.status === "pending" && manage ? (
                        <div className="row adm-approve">
                          <select
                            aria-label="Role to approve with"
                            value={apRole}
                            onChange={(e) => {
                              S.forms[apKey] = e.target.value;
                              X.rerender();
                            }}
                          >
                            <option value="">Choose role</option>
                            <RoleOptions X={X} />
                          </select>
                          <button
                            className="btn small"
                            disabled={!apRole}
                            onClick={() => {
                              if (!apRole) return;
                              const g = roleGuard(X, u, apRole);
                              if (g) return X.toast(g);
                              setUserRole(X, u.id, apRole);
                            }}
                          >
                            Approve
                          </button>
                          {!apRole ? <span className="hint">Pick a role first</span> : null}
                        </div>
                      ) : locked || u.status === "pending" ? (
                        roleName(X, u.role)
                      ) : (
                        <select aria-label="Role" value={u.role || ""} onChange={(e) => setUserRole(X, u.id, e.target.value)}>
                          <RoleOptions X={X} />
                        </select>
                      )}
                    </td>
                    <td>
                      {u.status === "active" ? (
                        <span className="pill ok">active</span>
                      ) : u.status === "pending" ? (
                        <span className="pill hold">awaiting approval</span>
                      ) : (
                        <span className="pill crit">suspended</span>
                      )}
                    </td>
                    <td className="n">{cnt(u.id)}</td>
                    <td>
                      <div className="hs-owner">
                        {manage ? (
                          <input
                            key={u.id + ":" + hsId + ":" + (S.forms["hsv:" + u.id] || 0)}
                            aria-label={`HubSpot owner ID for ${pname(X, u.id)}`}
                            className="mono"
                            style={{ width: 140 }}
                            defaultValue={hsId}
                            placeholder="HubSpot user ID"
                            disabled={S.busy.has("hsowner:" + u.id)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                            }}
                            onBlur={async (e) => {
                              const v = (e.target.value || "").trim();
                              if (v === hsId) return;
                              S.busy.add("hsowner:" + u.id);
                              X.rerender();
                              try {
                                await setHubspotOwner(X, u.id, v);
                                // Read the stored value back so the field shows what was really saved.
                                const { data } = await supabase.from("profiles").select("hubspot_owner_id").eq("id", u.id).maybeSingle();
                                if (data) u.hubspot_owner_id = data.hubspot_owner_id;
                              } finally {
                                S.busy.delete("hsowner:" + u.id);
                                S.forms["hsv:" + u.id] = (S.forms["hsv:" + u.id] || 0) + 1;
                                X.rerender();
                              }
                            }}
                          />
                        ) : (
                          <span className="mono">{hsId || "–"}</span>
                        )}
                        {S.busy.has("hsowner:" + u.id) ? (
                          <span className="hint">Saving…</span>
                        ) : hsId ? (
                          <span className="pill ok">Mapped</span>
                        ) : u.status === "active" ? (
                          <span className="pill warn">Not mapped</span>
                        ) : null}
                      </div>
                    </td>
                    <td>
                      <div className="row" style={{ justifyContent: "flex-end" }}>
                        {isOwn && u.id === X.uid ? (
                          S.confirmDel === "leave" ? (
                            <span className="confirm">
                              {successor
                                ? `Leave the roster? ${pname(X, successor.id)} becomes the owner and you lose access.`
                                : "Make someone else an active Super Admin first. They become the owner when you leave."}
                              {successor ? (
                                <button className="btn danger small" onClick={() => ownerLeave(X)}>Leave</button>
                              ) : null}
                              <button className="btn ghost small" onClick={() => noDel(X)}>{successor ? "Stay" : "OK"}</button>
                            </span>
                          ) : (
                            <MoreMenu label="More actions for your account">
                              <button className="btn ghost small mm-btn mm-danger" onClick={() => askDel(X, "leave")}>
                                <span className="mm-item">
                                  <span>Leave roster</span>
                                  <span className="hint">Only you can remove the owner. Ownership passes to the longest-standing Super Admin.</span>
                                </span>
                              </button>
                            </MoreMenu>
                          )
                        ) : locked ? null : S.confirmDel === "user:" + u.id ? (
                          <span className="confirm">
                            Remove {pname(X, u.id)}'s access? Their records stay.
                            <button className="btn danger small" onClick={() => doDelete(X, "user:" + u.id)}>Remove</button>
                            <button className="btn ghost small" onClick={() => noDel(X)}>Keep</button>
                          </span>
                        ) : (
                          <MoreMenu label={`More actions for ${pname(X, u.id)}`}>
                            {u.invited_at && !u.signed_in_at ? (
                              <button className="btn ghost small mm-btn" onClick={() => resendInvite(X, u.email)}>
                                <span className="mm-item">
                                  <span>Resend invite</span>
                                  <span className="hint">Emails a fresh sign-in link</span>
                                </span>
                              </button>
                            ) : null}
                            {u.status !== "pending" ? (
                              <button className="btn ghost small mm-btn" onClick={() => toggleSuspend(X, u.id)}>
                                <span className="mm-item">
                                  <span>{u.status === "active" ? "Suspend" : "Restore"}</span>
                                  <span className="hint">
                                    {u.status === "active" ? "Blocks sign-in, keeps everything" : "Lets them sign in again"}
                                  </span>
                                </span>
                              </button>
                            ) : null}
                            <button className="btn ghost small mm-btn mm-danger" onClick={() => askDel(X, "user:" + u.id)}>
                              <span className="mm-item">
                                <span>Remove</span>
                                <span className="hint">Deletes their access, keeps their records</span>
                              </span>
                            </button>
                          </MoreMenu>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })
            ) : (
              <tr>
                <td colSpan={6} className="muted">No users yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Roles({ X }: { X: Ctx }) {
  const edit = can(X, "manage_roles");
  const ids = roleIds(X);
  const role = (r: string) => X.D.roles.find((x) => x.id === r);
  const inUse = (r: string) => X.D.profiles.filter((u) => u.role === r).length;
  return (
    <div className="section">
      <div className="section-head">
        <h2>Roles and permissions</h2>
        <span className="note">Super Admin always has every permission.</span>
      </div>
      {edit ? (
        <div className="controls">
          <input
            id="adm-newrole"
            placeholder="New role name, e.g. Team Lead"
            value={X.S.forms.newRole || ""}
            onChange={(e) => {
              X.S.forms.newRole = e.target.value;
              X.rerender();
            }}
          />
          <button className="btn ghost small" onClick={() => addRole(X)}>Add role</button>
        </div>
      ) : null}
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>Permission</th>
              {ids.map((r) => {
                const ro = role(r);
                return (
                  <th key={r} style={{ textAlign: "center" }}>
                    {r === "super_admin" || !edit || (ro && ro.system) ? (
                      roleName(X, r)
                    ) : (
                      <input
                        key={r + ":" + roleName(X, r)}
                        defaultValue={roleName(X, r)}
                        aria-label="Role name"
                        style={{ width: 120 }}
                        onBlur={(e) => {
                          if (e.target.value.trim() && e.target.value.trim() !== roleName(X, r)) renameRole(X, r, e.target.value);
                        }}
                      />
                    )}
                    <div className="note" style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400 }}>
                      {inUse(r)} {inUse(r) === 1 ? "person" : "people"}
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {PERMS.map(([k, label, help]) => (
              <tr key={k}>
                <td>
                  <strong>{label}</strong>
                  {help ? <div className="muted small">{help}</div> : null}
                </td>
                {ids.map((r) => {
                  const on = r === "super_admin" || ((role(r) && role(r)!.perms) || []).includes(k);
                  return (
                    <td key={r} style={{ textAlign: "center" }}>
                      <input
                        type="checkbox"
                        aria-label={`${roleName(X, r)}: ${label}`}
                        checked={on}
                        disabled={r === "super_admin" || !edit}
                        onChange={(e) => togglePerm(X, r, k, e.target.checked, label)}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
            {edit ? (
              <tr>
                <td></td>
                {ids.map((r) => {
                  const ro = role(r);
                  return (
                    <td key={r} style={{ textAlign: "center" }}>
                      {r === "super_admin" || (ro && ro.system) ? null : (
                        <button className="btn danger small" disabled={!!inUse(r)} title={inUse(r) ? "Reassign its users first" : undefined} onClick={() => deleteRole(X, r)}>
                          Delete
                        </button>
                      )}
                    </td>
                  );
                })}
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Audit({ X }: { X: Ctx }) {
  const a = X.D.audit
    .slice()
    .sort((x, y) => String(y.at).localeCompare(String(x.at)))
    .slice(0, 200);
  return (
    <div className="section">
      <h2>Audit log</h2>
      <div className="tablewrap">
        <table style={{ minWidth: 480 }}>
          <thead>
            <tr>
              <th>When</th>
              <th>Who</th>
              <th>Action</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {a.length ? (
              a.map((e) => (
                <tr key={e.id}>
                  <td className="small mono">{fmtStamp(e.at)}</td>
                  <td>{pname(X, e.actor)}</td>
                  <td>{e.action}</td>
                  <td className="small">
                    {e.target ? (pname(X, e.target) !== "Someone" ? pname(X, e.target) + " · " : e.target + " · ") : ""}
                    {e.detail}
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={4} className="muted">No admin activity yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ---------- Rep activity review: what admins should see and reps don't ---------- */
const REVIEW: Record<string, [string, string, string]> = {
  "call.backdated": ["back", "Backdated call", "warn"],
  "note.backdated": ["back", "Backdated call note", "warn"],
  "contact.disqualified": ["dq", "Contact disqualified", "crit"],
  "contact.requalified": ["dq", "Contact requalified", "ok"],
  "company.disqualified": ["dq", "Company disqualified", "crit"],
  "company.requalified": ["dq", "Company requalified", "ok"],
  "account.lost": ["lost", "Closed lost / Cold", "crit"],
  "account.reopened": ["lost", "Reopened", "ok"],
};
function Review({ X }: { X: Ctx }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [kind, setKind] = useState("all");
  const [rep, setRep] = useState("all");
  useEffect(() => {
    supabase
      .from("audit_log")
      .select("*")
      .in("action", Object.keys(REVIEW))
      .order("at", { ascending: false })
      .limit(1000)
      .then(({ data }) => setRows((data || []) as Row[]));
  }, []);
  // Live rows from the audit feed join the fetched history.
  const seen = new Set(rows.map((r) => r.id));
  const all = [...X.D.audit.filter((r) => REVIEW[r.action] && !seen.has(r.id)), ...rows].sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const list = all.filter((r) => (kind === "all" || REVIEW[r.action][0] === kind) && (rep === "all" || r.actor === rep));
  const n = (k: string) => all.filter((r) => REVIEW[r.action][0] === k && (rep === "all" || r.actor === rep)).length;
  const actors = [...new Set(all.map((r) => r.actor).filter(Boolean))];
  return (
    <div className="section">
      <div className="section-head">
        <h2>Rep activity review</h2>
        <span className="note">Calls logged after the fact, disqualifications and closed-lost accounts. Only people with audit access see this.</span>
      </div>
      <div className="controls">
        <div className="seg" role="group" aria-label="Kind">
          {[
            ["all", "Everything", all.filter((r) => rep === "all" || r.actor === rep).length],
            ["back", "Backdated", n("back")],
            ["dq", "Disqualified", n("dq")],
            ["lost", "Closed lost", n("lost")],
          ].map(([k, l, c]) => (
            <button key={k as string} aria-pressed={kind === k} onClick={() => setKind(k as string)}>
              {l} <span className="mono muted">{c}</span>
            </button>
          ))}
        </div>
        <select aria-label="Rep" value={rep} onChange={(e) => setRep(e.target.value)}>
          <option value="all">Every rep</option>
          {actors.map((a) => (
            <option key={a} value={a}>
              {pname(X, a)}
            </option>
          ))}
        </select>
      </div>
      <div className="tablewrap">
        <table style={{ minWidth: 560 }}>
          <thead>
            <tr>
              <th>When</th>
              <th>Rep</th>
              <th>What</th>
              <th>Account</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {list.length ? (
              list.map((e) => {
                const [, label, tone] = REVIEW[e.action];
                return (
                  <tr key={e.id}>
                    <td className="small mono">{fmtStamp(e.at)}</td>
                    <td>{pname(X, e.actor)}</td>
                    <td>
                      <span className={"pill " + tone}>{label}</span>
                    </td>
                    <td>{coName(e.target)}</td>
                    <td className="small">{String(e.detail || "").replace(/ id:[0-9a-f-]+$/, "")}</td>
                  </tr>
                );
              })
            ) : (
              <tr>
                <td colSpan={5} className="muted">Nothing to review here.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function AdminTab() {
  const X = useX();
  if (!isAdminAny(X)) return <IntegrationsPanel X={X} />;
  const secs: Array<[string, string, boolean]> = (
    [
      ["setup", "Setup", can(X, "manage_integrations")],
      ["users", "Users", can(X, "manage_users") || can(X, "view_audit")],
      ["reps", "Reps and segments", can(X, "manage_users")],
      ["icp", "ICP personas", can(X, "manage_users") || can(X, "manage_integrations")],
      ["roles", "Roles and permissions", can(X, "manage_roles") || can(X, "manage_users")],
      ["integ", "Integrations", true],
      ["review", "Rep activity review", can(X, "view_audit")],
      ["audit", "Audit log", can(X, "view_audit")],
    ] as Array<[string, string, boolean]>
  ).filter((s) => s[2]);
  // Until setup is finished, admins who can do it land on it.
  if (!X.D.settings.onboarding && !X.S.forms["setup-seen"] && secs.some((s) => s[0] === "setup")) {
    X.S.forms["setup-seen"] = true;
    X.S.adminSec = "setup";
  }
  if (!secs.some((s) => s[0] === X.S.adminSec)) X.S.adminSec = secs[0][0];
  const sec = X.S.adminSec;
  const openSection = (s: string) => {
    X.S.adminSec = s;
    X.rerender();
  };
  return (
    <>
      <nav className="utabs" aria-label="Admin sections">
        {secs.map((s) => (
          <button
            key={s[0]}
            className="utab"
            aria-current={sec === s[0] ? "page" : undefined}
            onClick={() => {
              X.S.adminSec = s[0];
              X.rerender();
            }}
          >
            {s[1]}
          </button>
        ))}
      </nav>
      {sec === "setup" ? <SetupWizard X={X} openSection={openSection} /> : sec === "users" ? <Users X={X} /> : sec === "reps" ? <RepsPanel X={X} /> : sec === "icp" ? <IcpPanel X={X} /> : sec === "roles" ? <Roles X={X} /> : sec === "integ" ? <IntegrationsPanel X={X} /> : sec === "review" ? <Review X={X} /> : <Audit X={X} />}
    </>
  );
}
