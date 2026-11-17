import { lazy, Suspense, useEffect, useReducer, useRef, useState } from "react";
import { smooth } from "./lib/motion";
import type { Session } from "@supabase/supabase-js";
import { authLinkType, supabase, supabaseConfigured } from "./lib/supabase";
import { SetPasswordForm, SignInForm } from "./components/AuthForms";
import { connectGoogleCalendar, googleEmail, googleState, loadCalState, onGoogleChange, onNeedsConnect, resetCalState } from "./lib/google";
import { resyncNow, useRosterData, type Row } from "./lib/data";
import { AppCtx, initialUI, type Ctx, type UI } from "./lib/ctx";
import { can, isAdminAny, roleName, seeAllWork, visibleLeads, vMeetings } from "./lib/perms";
import { coName, dayKey, dk } from "./lib/format";
import Toast, { type ToastAction, type ToastState } from "./components/Toast";
import AccountsTab from "./components/AccountsTab";
import TaskCenterTab, { taskItems } from "./components/TaskCenterTab";
import ConnectedCallModal, { closeCtx } from "./components/ConnectedCallModal";
import AddCompanyModal from "./components/AddCompanyModal";
import CommandPalette, { type Command } from "./components/CommandPalette";
import ViewBoundary from "./components/ViewBoundary";
import { useDialog } from "./lib/useDialog";
import { AppFrame, AuthFrame, MOD, type NavItem, type Theme } from "./components/Frame";

// Heavier views load on first visit, so the first paint only carries Accounts and the Task Center.
const MeetingsTab = lazy(() => import("./components/MeetingsTab"));
const DashboardTab = lazy(() => import("./components/DashboardTab"));
const AdminTab = lazy(() => import("./components/AdminTab"));
const PlatformTab = lazy(() => import("./components/PlatformTab"));

const SUB = "India-based Demand Gen, Growth and Digital leaders at 250–2500 person B2B Tech and SaaS companies.";
const VIEWS = ["accounts", "meetings", "dashboard", "tasks", "admin", "platform"];
const GO: Record<string, string> = { a: "accounts", m: "meetings", d: "dashboard", t: "tasks", s: "admin" };

const lsGet = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch (_) {
    return null;
  }
};
const lsSet = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch (_) {}
};
/** The view named in the URL (#/meetings), or "" when the hash is not a view route. */
const readRoute = () => {
  const m = /^#\/([a-z]+)(?:\/(.+))?$/.exec(window.location.hash);
  if (!m || !VIEWS.includes(m[1])) return { tab: "", acct: "" };
  let acct = "";
  try {
    acct = m[1] === "accounts" && m[2] ? decodeURIComponent(m[2]) : "";
  } catch (_) {}
  return { tab: m[1], acct };
};
const readHash = () => readRoute().tab;
const typing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
};

function Gate({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <>
      <h2>{title}</h2>
      {children}
    </>
  );
}
function Skeleton({ label }: { label: string }) {
  return (
    <div className="skel" role="status">
      <span className="sr-only">{label}</span>
      <div className="skel-row" />
      <div className="skel-row" />
      <div className="skel-row" />
      <div className="skel-row" />
    </div>
  );
}

const KEYS: Array<[string[], string]> = [
  [[MOD, "K"], "Search, jump to an account, or run an action"],
  [["1–4"], "Go to a view in the sidebar"],
  [["G", "A"], "Accounts"],
  [["G", "M"], "Meetings"],
  [["G", "D"], "Dashboard"],
  [["G", "T"], "Task Center"],
  [["G", "S"], "Admin and settings (also in your profile menu)"],
  [["/"], "Search accounts"],
  [["C"], "Add a company"],
  [["R"], "Sync now"],
  [["["], "Collapse or expand the sidebar"],
  [["?"], "This list"],
  [["Esc"], "Close a dialog"],
];
function KeysDialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const box = useDialog<HTMLDivElement>(onClose);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div className="modal" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog keys" role="dialog" aria-modal="true" aria-labelledby="keys-h" ref={box}>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 id="keys-h">Keyboard shortcuts</h2>
          <button ref={ref} className="btn ghost small" onClick={onClose}>
            Close
          </button>
        </div>
        <dl className="keylist">
          {KEYS.map(([k, d]) => (
            <div key={d}>
              <dt>
                {k.map((x) => (
                  <kbd key={x}>{x}</kbd>
                ))}
              </dt>
              <dd>{d}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

const PROVIDER_NAMES: Record<string, string> = {
  hubspot: "HubSpot",
  hubspot_user: "HubSpot",
  google_calendar: "Google Calendar",
  apollo: "Apollo",
  fullenrich: "FullEnrich",
};

/** Read ?connected= / ?connect_error= left by the OAuth callback, then clean the URL. */
function readConnectResult(): { ok: boolean; text: string } | null {
  const p = new URLSearchParams(window.location.search);
  const ok = p.get("connected"),
    bad = p.get("connect_error");
  if (!ok && !bad) return null;
  p.delete("connected");
  p.delete("connect_error");
  const q = p.toString();
  try {
    window.history.replaceState(null, "", window.location.pathname + (q ? "?" + q : "") + window.location.hash);
  } catch (_) {}
  if (ok) return { ok: true, text: `${PROVIDER_NAMES[ok] || ok} connected.` };
  return { ok: false, text: "Could not connect. " + bad };
}

function readAuthError(): string {
  const p = new URLSearchParams(window.location.search + "&" + window.location.hash.replace(/^#/, ""));
  return p.get("error_description") || p.get("error") || "";
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [authErr] = useState(readAuthError);
  // Invite and reset links sign the person in; they choose a password before going further.
  const [needPassword, setNeedPassword] = useState(["invite", "recovery", "magiclink"].includes(authLinkType));
  const [selfProfile, setSelfProfile] = useState<Row | null | undefined>(undefined);
  // The profile read failed (server error, timeout, offline): not the same as having no profile.
  const [selfErr, setSelfErr] = useState(false);
  const [selfTry, setSelfTry] = useState(0);
  const [, bump] = useReducer((x: number) => x + 1, 0);
  const uiRef = useRef<UI>(null as unknown as UI);
  if (!uiRef.current) {
    uiRef.current = initialUI();
    const rt = readRoute();
    uiRef.current.tab = rt.tab || "accounts";
    if (rt.acct) {
      uiRef.current.panel = rt.acct;
      uiRef.current.panelFull = true;
    }
  }
  const [toastS, setToastS] = useState<ToastState>({ text: "", undo: null, action: null, shown: false });
  const connectAt = useRef(0);
  const toastRef = useRef(toastS);
  toastRef.current = toastS;
  const [connectResult] = useState(readConnectResult);
  const toastTimer = useRef<number | undefined>(undefined);
  const tipRef = useRef<HTMLDivElement>(null);
  const [palette, setPalette] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [collapsed, setCollapsedS] = useState(() => lsGet("roster.rail") === "1");
  const setCollapsed = (v: boolean) => {
    setCollapsedS(v);
    lsSet("roster.rail", v ? "1" : "0");
  };
  const [theme, setTheme] = useState<Theme>(() => (lsGet("roster.theme") as Theme) || "system");
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
    lsSet("roster.theme", theme);
  }, [theme]);

  useEffect(() => {
    if (!supabaseConfigured) {
      setAuthReady(true);
      return;
    }
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setAuthReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((e, s) => {
      if (e === "PASSWORD_RECOVERY") setNeedPassword(true);
      setSession(s);
    });
    const off = onGoogleChange(() => bump());
    onNeedsConnect((e) => {
      connectAt.current = Date.now();
      const cur = toastRef.current;
      // Keep an open Undo toast (for example "Meeting saved") and add the Connect action to it.
      if (cur.shown && cur.undo) return ctxRef.current.toast(cur.text, cur.undo);
      ctxRef.current.toast(e.code === "reconnect" ? "Google Calendar needs reconnecting." : "Connect your Google Calendar to add calendar blocks.");
    });
    if (connectResult && connectResult.ok) {
      uiRef.current.tab = "admin";
      uiRef.current.adminSec = "integ";
    }
    return () => {
      sub.subscription.unsubscribe();
      off();
      onNeedsConnect(null);
    };
  }, []);

  const uid = session ? session.user.id : "";

  // Read my own profile (works while pending only if RLS allows reading your own row). Poll until active.
  useEffect(() => {
    setSelfProfile(undefined);
    setSelfErr(false);
    if (!uid) return;
    let stop = false;
    const load = async () => {
      const { data, error } = await supabase.from("profiles").select("*").eq("id", uid).maybeSingle();
      if (stop) return data;
      if (error) {
        setSelfErr(true);
        return null;
      }
      setSelfErr(false);
      setSelfProfile(data || null);
      return data;
    };
    load();
    const t = window.setInterval(async () => {
      const d = await load();
      if (d && d.status === "active") window.clearInterval(t);
    }, 30000);
    return () => {
      stop = true;
      window.clearInterval(t);
    };
  }, [uid, selfTry]);

  // The workspace's name for the sidebar (RLS returns only your own workspace).
  // The product owner (fixed in the database) also gets the platform console.
  // null while it's being checked, so a reload on #/platform isn't bounced to Accounts before the answer arrives.
  const [isOwner, setIsOwner] = useState<boolean | null>(null);
  const signedInActive = !!(selfProfile && (selfProfile.status === "active" || selfProfile.is_owner));
  useEffect(() => {
    setIsOwner(null);
    if (!uid || !signedInActive) return;
    supabase.rpc("is_product_owner").then(({ data, error }) => setIsOwner(!error && data === true));
  }, [uid, signedInActive]);

  const [workspaceName, setWorkspaceName] = useState("");
  useEffect(() => {
    setWorkspaceName("");
    if (!uid) return;
    supabase.from("workspaces").select("name").maybeSingle().then(({ data }) => setWorkspaceName((data && data.name) || ""));
  }, [uid]);

  const selfActive = !!(selfProfile && (selfProfile.status === "active" || selfProfile.is_owner));
  // The role is part of the key: a role change (seen live in profiles) re-subscribes with the right filters.
  const [liveRole, setLiveRole] = useState("");
  const D = useRosterData(uid || null, selfActive, liveRole || (selfProfile && selfProfile.role) || "");
  const me = (uid && D.profiles.find((p) => p.id === uid)) || selfProfile || null;
  const meRole = (me && me.role) || "";
  useEffect(() => {
    if (D.loaded && meRole && meRole !== liveRole) setLiveRole(meRole);
  }, [D.loaded, meRole]);

  // Show the OAuth callback result once the roster is on screen.
  const resultShown = useRef(false);
  useEffect(() => {
    if (connectResult && !resultShown.current && D.loaded) {
      resultShown.current = true;
      ctxRef.current.toast(connectResult.text);
    }
  }, [D.loaded]);

  // Current user's Google Calendar connection, for the header note.
  useEffect(() => {
    if (uid && selfActive) loadCalState();
    else resetCalState();
  }, [uid, selfActive]);

  useEffect(() => {
    uiRef.current.orderLocal = null;
  }, [D.order]);

  const toast = (text: string, undo?: (() => any) | null, action?: ToastAction | null) => {
    window.clearTimeout(toastTimer.current);
    // A calendar call just reported "not connected": keep a Connect action on whatever toast follows.
    if (!action && Date.now() - connectAt.current < 4000) action = { label: "Connect", fn: () => startCalConnect() };
    setToastS({ text, undo: undo || null, action: action || null, shown: true });
    toastTimer.current = window.setTimeout(
      () => setToastS((t) => ({ ...t, shown: false, undo: null, action: null })),
      undo || action ? 8000 : 3200
    );
  };
  const startCalConnect = async () => {
    try {
      await connectGoogleCalendar();
    } catch (e: any) {
      connectAt.current = 0;
      toast("Could not start Google Calendar connect. " + ((e && e.message) || ""));
    }
  };
  const onAction = async () => {
    const a = toastS.action;
    window.clearTimeout(toastTimer.current);
    setToastS({ text: "", undo: null, action: null, shown: false });
    connectAt.current = 0;
    if (a) await a.fn();
  };
  const onUndo = async () => {
    const f = toastS.undo;
    window.clearTimeout(toastTimer.current);
    setToastS({ text: "", undo: null, action: null, shown: false });
    if (f) {
      try {
        await f();
        toast("Restored.");
      } catch (_) {
        toast("Could not undo.");
      }
    }
  };

  const ctxRef = useRef<Ctx>(null as unknown as Ctx);
  ctxRef.current = { S: uiRef.current, D, session: session as Session, uid, me, rerender: bump, toast };
  const X = ctxRef.current;

  // Chart tooltips and Escape to close modals.
  useEffect(() => {
    const move = (e: MouseEvent) => {
      const tip = tipRef.current;
      if (!tip) return;
      const t = (e.target as Element | null)?.closest?.("[data-tip]");
      if (!t) {
        tip.hidden = true;
        return;
      }
      tip.textContent = t.getAttribute("data-tip");
      tip.hidden = false;
      const x = Math.min(e.clientX + 12, innerWidth - tip.offsetWidth - 8),
        y = Math.max(8, e.clientY - tip.offsetHeight - 10);
      tip.style.left = x + "px";
      tip.style.top = y + "px";
    };
    const key = (e: KeyboardEvent) => {
      const X = ctxRef.current;
      if (e.key === "Escape" && X.S.modal) {
        if (X.S.modal.type === "ctx") closeCtx(X);
        else {
          X.S.modal = null;
          X.rerender();
        }
      }
    };
    const focus = (e: FocusEvent) => {
      const tip = tipRef.current;
      const t = (e.target as Element | null)?.closest?.("[data-tip]") as HTMLElement | null;
      if (!tip) return;
      if (!t) {
        tip.hidden = true;
        return;
      }
      tip.textContent = t.getAttribute("data-tip");
      tip.hidden = false;
      const r = t.getBoundingClientRect();
      tip.style.left = Math.min(r.left, innerWidth - tip.offsetWidth - 8) + "px";
      tip.style.top = Math.max(8, r.top - tip.offsetHeight - 8) + "px";
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("focusin", focus);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("focusin", focus);
      document.removeEventListener("keydown", key);
    };
  }, []);

  const signOut = async () => {
    resetCalState();
    await supabase.auth.signOut();
  };
  const overlays = (
    <>
      <div id="tip" className="tip" ref={tipRef} hidden></div>
      <Toast t={toastS} onUndo={onUndo} onAction={onAction} />
    </>
  );

  // Views live in the URL (#/meetings): reload keeps your place, Back and Forward move between views.
  const go = (t: string) => {
    if (uiRef.current.tab !== t) {
      uiRef.current.tab = t;
      uiRef.current.panelFull = false;
      uiRef.current.panel = null;
      smooth(bump);
    }
    setDrawer(false);
    window.scrollTo({ top: 0 });
    requestAnimationFrame(() => document.getElementById("page-title")?.focus({ preventScroll: true }));
  };
  useEffect(() => {
    const on = () => {
      const { tab: t, acct } = readRoute();
      const S = uiRef.current;
      if (acct) {
        S.tab = "accounts";
        S.panel = acct;
        S.panelFull = true;
        smooth(bump);
      } else if (t === "accounts" && S.panelFull) {
        S.panel = null;
        S.panelFull = false;
        smooth(bump);
      } else if (t && t !== S.tab) go(t);
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  // Until setup is finished, the admin who can finish it lands on Admin > Setup once per sign-in (unless the link
  // asked for a view).
  const setupOpened = useRef(false);
  useEffect(() => {
    if (!D.loaded || setupOpened.current) return;
    setupOpened.current = true;
    if (!D.settings.onboarding && can(ctxRef.current, "manage_integrations") && !readHash()) {
      uiRef.current.adminSec = "setup";
      go("admin");
    }
  }, [D.loaded]);
  const routed = !!session && D.loaded;
  useEffect(() => {
    if (!routed) return;
    const S = uiRef.current;
    const want = "#/" + S.tab + (S.tab === "accounts" && S.panel && S.panelFull ? "/" + encodeURIComponent(S.panel) : "");
    if (window.location.hash === want) return;
    const url = window.location.pathname + window.location.search + want;
    if (readHash()) window.history.pushState(null, "", url);
    else window.history.replaceState(null, "", url);
  });

  const openAccount = (k: string) => {
    const S = uiRef.current;
    S.tab = "accounts";
    S.f = { ...S.f, range: "all", from: "", to: "", tiers: [] as string[], appr: "all", scope: "all", q: "" };
    S.panel = null;
    S.openAcct.add(k);
    bump();
    setTimeout(() => {
      const el = document.querySelector(`details[data-acct="${CSS.escape(k)}"]`) as HTMLElement | null;
      if (!el) return;
      el.scrollIntoView({ block: "start", behavior: "smooth" });
      (el.querySelector("summary") as HTMLElement | null)?.focus({ preventScroll: true });
    }, 60);
  };
  const addCompany = () => {
    if (!can(ctxRef.current, "add_company")) return;
    uiRef.current.modal = { type: "add", company: "", domain: "", name: "", title: "", linkedin: "", mode: "next" };
    bump();
  };

  // Global shortcuts. Single keys only fire outside text fields; Cmd/Ctrl+K works everywhere.
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  const gAt = useRef(0);
  keyRef.current = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      if (!routed) return;
      e.preventDefault();
      setPalette((v) => !v);
      return;
    }
    if (!routed || palette || keysOpen || uiRef.current.modal || e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
    const k = e.key;
    const visible = VIEWS.filter((v) => v !== "admin" && tabOKRef.current[v]);
    if (Date.now() - gAt.current < 1200 && GO[k.toLowerCase()]) {
      gAt.current = 0;
      const t = GO[k.toLowerCase()];
      if (visible.includes(t) || t === "admin") go(t);
      e.preventDefault();
      return;
    }
    if (k === "g" || k === "G") gAt.current = Date.now();
    else if (/^[1-4]$/.test(k) && visible[+k - 1]) go(visible[+k - 1]);
    else if (k === "?") setKeysOpen(true);
    else if (k === "[") setCollapsed(!collapsedRef.current);
    else if (k === "c" || k === "C") addCompany();
    else if (k === "r" || k === "R") {
      resyncNow();
      ctxRef.current.toast("Syncing…");
    } else if (k === "/") {
      e.preventDefault();
      if (uiRef.current.tab === "accounts") (document.getElementById("f-q") as HTMLInputElement | null)?.focus();
      else setPalette(true);
    } else return;
    // The key opened something or moved focus; don't let it also type into whatever now has focus.
    e.preventDefault();
  };
  const tabOKRef = useRef<Record<string, boolean>>({});
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;
  useEffect(() => {
    const on = (e: KeyboardEvent) => keyRef.current(e);
    document.addEventListener("keydown", on);
    return () => document.removeEventListener("keydown", on);
  }, []);

  if (!supabaseConfigured)
    return (
      <AuthFrame>
        <Gate title="The roster isn't available right now">
          <p>It hasn't finished setting up. Let the workspace owner know.</p>
          <details className="hint">
            <summary>Details for whoever runs the deployment</summary>
            <p>Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in Vercel, then redeploy.</p>
          </details>
        </Gate>
      </AuthFrame>
    );
  if (!authReady)
    return (
      <AuthFrame>
        <p className="muted" role="status">Checking your access…</p>
      </AuthFrame>
    );
  if (!session)
    return (
      <AuthFrame>
        <SignInForm linkError={authErr} />
      </AuthFrame>
    );
  if (needPassword)
    return (
      <AuthFrame>
        <SetPasswordForm invited={authLinkType !== "recovery"} onDone={() => setNeedPassword(false)} />
      </AuthFrame>
    );

  const email = String(session.user.email || "").toLowerCase();
  const domain = (D.settings.allowed_domain && D.settings.allowed_domain.domain) || "";
  const ownerEmail = (D.settings.owner_email && D.settings.owner_email.email) || "";
  const askOwner = ownerEmail ? ` Ask the workspace owner (${ownerEmail}).` : " Ask the workspace owner.";
  let why = "";
  if (domain && !email.endsWith("@" + domain)) why = `This workspace is limited to @${domain} email addresses. You're signed in as ${email}.`;
  else if (selfProfile === undefined && selfErr)
    return (
      <AuthFrame onSignOut={signOut}>
        <Gate title="We couldn't reach the server">
          <p>Your access couldn't be checked just now. This is usually a brief outage or a lost connection, not a change to your access.</p>
          <p className="row">
            <button className="btn" onClick={() => setSelfTry((n) => n + 1)}>Try again</button>
            <span className="note" role="status">{navigator.onLine ? "Online, the server didn't answer." : "You're offline."}</span>
          </p>
        </Gate>
      </AuthFrame>
    );
  else if (selfProfile === undefined)
    return (
      <AuthFrame>
        <p className="muted" role="status">Checking your access…</p>
      </AuthFrame>
    );
  else if (!selfProfile)
    why = "You don't have an active role on this roster yet. New sign-ins wait for a Super Admin to approve them by assigning a role." + askOwner;
  else if (selfProfile.status === "pending" && !selfProfile.is_owner)
    why = "Your sign-in worked and is waiting for approval. A Super Admin approves you by assigning a role. This page updates on its own once you're in." + askOwner;
  else if (selfProfile.status === "suspended" && !selfProfile.is_owner) why = "Your access to this roster is suspended." + askOwner;
  if (why)
    return (
      <>
        <AuthFrame onSignOut={signOut}>
          <Gate title="Access needed">
            <p>{why}</p>
          </Gate>
        </AuthFrame>
        {overlays}
      </>
    );

  const S = X.S;
  const g = googleState();
  const tabOK: Record<string, boolean> = {
    accounts: true,
    meetings: can(X, "manage_meetings") || seeAllWork(X),
    dashboard: can(X, "view_dashboard"),
    tasks: can(X, "manage_tasks") || seeAllWork(X),
    admin: true,
    platform: isOwner !== false,
  };
  tabOKRef.current = tabOK;
  if (!tabOK[S.tab]) S.tab = "accounts";
  const today = dayKey(new Date());
  const leadsV = visibleLeads(X);
  const counts = {
    accounts: new Set(leadsV.map((l) => coName(l.company))).size,
    meetings: vMeetings(X).filter((m) => m.status !== "done").length,
    tasks: taskItems(X).filter((it) => {
      const d = dk(it.when);
      if (it.kind === "ct" && it.ref.done) return false;
      if (it.kind === "mt") return d === today;
      return d <= today;
    }).length,
  };
  const admin = isAdminAny(X);
  const nav: NavItem[] = (
    [
      { id: "accounts", label: "Accounts", icon: "accounts", count: null, key: "a" },
      { id: "meetings", label: "Meetings", icon: "meetings", count: counts.meetings, key: "m" },
      { id: "dashboard", label: "Dashboard", icon: "dashboard", count: null, key: "d" },
      { id: "tasks", label: "Task Center", icon: "tasks", count: counts.tasks, key: "t" },
    ] as NavItem[]
  ).filter((n) => tabOK[n.id]);

  // Admin lives in the profile menu: one item per section this role can open.
  const adminSecs: Array<[string, string, string, boolean]> = admin
    ? [
        ["setup", "Setup", "spark", can(X, "manage_integrations")],
        ["users", "Users", "accounts", can(X, "manage_users") || can(X, "view_audit")],
        ["reps", "Reps and segments", "dashboard", can(X, "manage_users")],
        ["icp", "ICP personas", "company", can(X, "manage_users") || can(X, "manage_integrations")],
        ["roles", "Roles and permissions", "admin", can(X, "manage_roles") || can(X, "manage_users")],
        ["integ", "Integrations", "plug", true],
        ["review", "Rep activity review", "spark", can(X, "view_audit")],
        ["audit", "Audit log", "tasks", can(X, "view_audit")],
      ]
    : [["integ", "Connections", "plug", true]];
  const openAdmin = (sec: string) => {
    S.adminSec = sec;
    if (S.tab === "admin") bump();
    go("admin");
  };
  const profileItems = [
    ...(isOwner === true ? [{ id: "platform", label: "Platform console", icon: "admin", run: () => go("platform") }] : []),
    ...adminSecs.filter((x) => x[3]).map(([id, label, icon]) => ({ id, label, icon, run: () => openAdmin(id) })),
  ];

  const dateLine = new Intl.DateTimeFormat("en-IN", { weekday: "long", day: "numeric", month: "long", timeZone: "Asia/Kolkata" }).format(new Date());
  const tierA = new Set(leadsV.filter((l) => l.tier === "A").map((l) => coName(l.company))).size;
  const PAGES: Record<string, { title: string; accent?: string; sub: string }> = {
    accounts: { title: "Accounts", accent: "in play", sub: `${counts.accounts} accounts, ${tierA} in tier A. ${SUB}` },
    meetings: { title: "Meetings", accent: "& prep", sub: "Booked demos, their prep briefs, and anything that needs a reschedule." },
    dashboard: { title: "Dashboard", accent: "at a glance", sub: "Calls, connects and meetings against the previous period." },
    tasks: { title: "Task Center", accent: "today", sub: "Callbacks, meetings and your own to-dos, in the order you'll work them." },
    platform: { title: "Platform console", sub: "Every workspace on Stage Prospect, who can sign up, and who runs the platform." },
    admin: admin
      ? { title: "Admin", accent: "& settings", sub: "Setup, users, reps and segments, personas, roles, integrations and the audit log." }
      : { title: "Connections", sub: "Connect your calendar and the tools the roster uses." },
  };
  const page = PAGES[S.tab];

  const calendar = !(can(X, "manage_tasks") || can(X, "manage_meetings")) ? null : g === "connected" ? (
    <span className="calchip ok" title={googleEmail() ? `Calendar connected. Blocks go to ${googleEmail()}` : "Calendar connected"}>
      Calendar connected
    </span>
  ) : g === "unknown" ? (
    <span className="calchip">Checking calendar…</span>
  ) : g === "unavailable" ? (
    <button className="calchip warn" title="The status check failed. Calls and tasks still save." onClick={() => loadCalState()}>
      Calendar status unavailable · Retry
    </button>
  ) : (
    <button className="calchip warn" title="Calls and tasks still save without it." onClick={() => startCalConnect()}>
      {g === "reconnect" ? "Reconnect calendar" : "Connect calendar"}
    </button>
  );

  let commands: Command[] = [];
  if (palette) {
    commands = [
      ...nav.map((n, i) => ({ id: "go-" + n.id, group: "Go to", label: n.label, icon: n.icon, keys: [String(i + 1)], run: () => go(n.id) })),
      ...profileItems.map((it) => ({ id: "adm-" + it.id, group: "Go to", label: (admin ? "Admin: " : "") + it.label, icon: it.icon, keywords: "settings profile", run: it.run })),
      ...(can(X, "add_company") ? [{ id: "add", group: "Actions", label: "Add a company", icon: "plus", keys: ["C"], run: addCompany }] : []),
      { id: "sync", group: "Actions", label: "Sync now", icon: "sync", keys: ["R"], keywords: "refresh reload", run: () => resyncNow() },
      ...(g !== "connected" && (can(X, "manage_tasks") || can(X, "manage_meetings"))
        ? [{ id: "cal", group: "Actions", label: "Connect Google Calendar", icon: "calendar", run: () => startCalConnect() }]
        : []),
      { id: "rail", group: "Actions", label: collapsed ? "Expand sidebar" : "Collapse sidebar", icon: "sidebar", keys: ["["], run: () => setCollapsed(!collapsed) },
      { id: "th-l", group: "Actions", label: "Use light theme", icon: "theme", keywords: "appearance mode", run: () => setTheme("light") },
      { id: "th-d", group: "Actions", label: "Use dark theme", icon: "theme", keywords: "appearance mode", run: () => setTheme("dark") },
      { id: "th-s", group: "Actions", label: "Match system theme", icon: "theme", keywords: "appearance mode auto", run: () => setTheme("system") },
      { id: "keys", group: "Actions", label: "Keyboard shortcuts", icon: "keyboard", keys: ["?"], run: () => setKeysOpen(true) },
      { id: "out", group: "Actions", label: "Sign out", icon: "signout", run: signOut },
    ];
    const seen = new Map<string, Row>();
    leadsV.forEach((l) => {
      const k = coName(l.company).toLowerCase();
      const cur = seen.get(k);
      if (!cur || String(l.tier || "U") < String(cur.tier || "U")) seen.set(k, l);
    });
    [...seen.entries()]
      .sort((a, b) => String(a[1].tier || "U").localeCompare(String(b[1].tier || "U")) || a[0].localeCompare(b[0]))
      .forEach(([k, l]) => {
        const people = leadsV.filter((x) => coName(x.company).toLowerCase() === k).map((x) => x.name).join(" ");
        commands.push({
          id: "acct-" + k,
          group: "Accounts",
          label: coName(l.company),
          hint: [l.tier ? "Tier " + l.tier : "", l.domain || ""].filter(Boolean).join(" · "),
          icon: "company",
          keywords: [l.segment, people].join(" "),
          run: () => openAccount(k),
        });
      });
  }

  return (
    <AppCtx.Provider value={ctxRef}>
      <AppFrame
        nav={nav}
        active={S.tab}
        onNav={go}
        collapsed={collapsed}
        setCollapsed={setCollapsed}
        drawer={drawer}
        setDrawer={setDrawer}
        onSearch={() => setPalette(true)}
        onAdd={can(X, "add_company") ? addCompany : null}
        live={D.live}
        syncedAt={D.syncedAt}
        onResync={() => {
          resyncNow();
          toast("Syncing…");
        }}
        calendar={calendar}
        theme={theme}
        setTheme={setTheme}
        user={{ name: (me && (me.name || me.full_name)) || email.split("@")[0], email, role: roleName(X, me && me.role) || "" }}
        workspace={workspaceName}
        onSignOut={signOut}
        onShortcuts={() => setKeysOpen(true)}
        profileItems={profileItems}
        activeSection={S.tab === "platform" ? "platform" : S.adminSec}
        page={{
          eyebrow: dateLine,
          ...page,
        }}
      >
        {!D.loaded ? (
          <Skeleton label="Loading the roster" />
        ) : (
          <Suspense fallback={<Skeleton label="Loading view" />}>
            <ViewBoundary key={S.tab}>
            <div className="view-in">
              {S.tab === "accounts" ? (
                <AccountsTab />
              ) : S.tab === "meetings" ? (
                <MeetingsTab />
              ) : S.tab === "dashboard" ? (
                <DashboardTab />
              ) : S.tab === "platform" ? (
                isOwner ? <PlatformTab /> : <Skeleton label="Checking access" />
              ) : S.tab === "admin" ? (
                <AdminTab />
              ) : (
                <TaskCenterTab />
              )}
            </div>
            </ViewBoundary>
          </Suspense>
        )}
      </AppFrame>
      <div id="modal-root">
        {S.modal && S.modal.type === "ctx" ? <ConnectedCallModal /> : null}
        {S.modal && S.modal.type === "add" ? <AddCompanyModal /> : null}
      </div>
      <CommandPalette open={palette} onClose={() => setPalette(false)} commands={commands} />
      {keysOpen ? <KeysDialog onClose={() => setKeysOpen(false)} /> : null}
      {overlays}
    </AppCtx.Provider>
  );
}
