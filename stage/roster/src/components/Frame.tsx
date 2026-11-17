import { useEffect, useRef, useState } from "react";
import Icon from "./Icon";

export type NavItem = { id: string; label: string; icon: string; count: number | null; key: string };
export type Theme = "system" | "light" | "dark";
export type ProfileItem = { id: string; label: string; icon: string; run: () => void };

/** The profile button at the foot of the sidebar opens account, admin and preference items in one place. */
function ProfileMenu(props: {
  ini: string;
  user: { name: string; email: string; role: string };
  items: ProfileItem[];
  activeItem: string;
  theme: Theme;
  setTheme: (t: Theme) => void;
  onShortcuts: () => void;
  onSignOut: () => void;
  rail: boolean;
}) {
  const p = props;
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    (box.current?.querySelector(".pm-pop button, .pm-pop select") as HTMLElement | null)?.focus();
    const out = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
        btn.current?.focus();
      }
    };
    document.addEventListener("mousedown", out);
    document.addEventListener("keydown", esc, true);
    return () => {
      document.removeEventListener("mousedown", out);
      document.removeEventListener("keydown", esc, true);
    };
  }, [open]);
  const pick = (fn: () => void) => {
    setOpen(false);
    fn();
  };
  return (
    <div className={"pm" + (open ? " is-open" : "")} ref={box}>
      {open ? (
        <div className="pm-pop" id="profile-menu" aria-label="Profile and settings" role="group">
          <div className="pm-id">
            <span className="avatar big" aria-hidden="true">{p.ini || "?"}</span>
            <span className="who">
              <b>{p.user.name}</b>
              <span>{p.user.email}</span>
              <span className="pm-role">{p.user.role}</span>
            </span>
          </div>
          {p.items.length ? (
            <div className="pm-sec">
              <span className="pm-h">{p.items.length > 1 ? "Admin" : "Settings"}</span>
              {p.items.map((it) => (
                <button key={it.id} className="pm-item" aria-current={p.activeItem === it.id ? "page" : undefined} onClick={() => pick(it.run)}>
                  <Icon name={it.icon} size={16} />
                  {it.label}
                </button>
              ))}
            </div>
          ) : null}
          <div className="pm-sec">
            <span className="pm-h">Preferences</span>
            <label className="pm-item pm-theme">
              <Icon name="theme" size={16} />
              <span>Theme</span>
              <select value={p.theme} onChange={(e) => p.setTheme(e.target.value as Theme)} aria-label="Theme">
                <option value="system">System</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </label>
            <button className="pm-item" onClick={() => pick(p.onShortcuts)}>
              <Icon name="keyboard" size={16} />
              Keyboard shortcuts
              <kbd>?</kbd>
            </button>
          </div>
          <div className="pm-sec">
            <button className="pm-item pm-out" onClick={() => pick(p.onSignOut)}>
              <Icon name="signout" size={16} />
              Sign out
            </button>
          </div>
        </div>
      ) : null}
      <button
        ref={btn}
        className="userrow"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls="profile-menu"
        aria-label={`Profile, admin and settings for ${p.user.name}`}
        data-tipr={p.rail ? "Profile & admin" : undefined}
      >
        <span className="avatar" aria-hidden="true">{p.ini || "?"}</span>
        <span className="who">
          <b>{p.user.name}</b>
          <span>{p.user.role}</span>
        </span>
        <Icon name="admin" size={16} />
      </button>
    </div>
  );
}

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const MOD = isMac ? "⌘" : "Ctrl";

function useNarrow(q = "(max-width: 900px)") {
  const [m, setM] = useState(() => typeof window !== "undefined" && window.matchMedia(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const on = () => setM(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [q]);
  return m;
}

function ago(ms: number) {
  if (!ms) return "not yet";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return m + " min ago";
  return Math.round(m / 60) + " h ago";
}

function Sync({ live, syncedAt, onResync, compact }: { live: string; syncedAt: number; onResync: () => void; compact: boolean }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => tick((x) => x + 1), 30000);
    return () => window.clearInterval(t);
  }, []);
  const word = live === "live" ? "Live" : live === "offline" ? "Reconnecting" : "Connecting";
  return (
    <div className={"sync is-" + live}>
      <span className="sync-dot" aria-hidden="true" />
      <span className={"sync-text" + (live === "live" ? " sr-only" : "")} role="status" aria-live="polite" title={`${word} · synced ${ago(syncedAt)}`}>
        <b>{word}</b>
        {compact ? null : <span> · synced {ago(syncedAt)}</span>}
      </span>
      <button className="iconbtn" onClick={onResync} aria-label="Sync now" title="Sync now (R)">
        <Icon name="sync" size={15} />
      </button>
    </div>
  );
}

export function AppFrame(props: {
  nav: NavItem[];
  active: string;
  onNav: (id: string) => void;
  collapsed: boolean;
  setCollapsed: (v: boolean) => void;
  drawer: boolean;
  setDrawer: (v: boolean) => void;
  onSearch: () => void;
  onAdd: (() => void) | null;
  live: string;
  syncedAt: number;
  onResync: () => void;
  calendar: React.ReactNode;
  theme: Theme;
  setTheme: (t: Theme) => void;
  user: { name: string; email: string; role: string };
  workspace: string;
  onSignOut: () => void;
  onShortcuts: () => void;
  profileItems: ProfileItem[];
  activeSection: string;
  page: { eyebrow: string; title: string; accent?: string; sub: string; actions?: React.ReactNode };
  children: React.ReactNode;
}) {
  const p = props;
  const narrow = useNarrow();
  const side = useRef<HTMLElement>(null);
  const rail = p.collapsed && !narrow;
  // Off-canvas sidebar on narrow screens: out of the tab order and hidden from AT while closed.
  useEffect(() => {
    const el = side.current;
    if (!el) return;
    if (narrow && !p.drawer) el.setAttribute("inert", "");
    else el.removeAttribute("inert");
  }, [narrow, p.drawer]);
  useEffect(() => {
    if (!narrow) p.setDrawer(false);
  }, [narrow]);
  // Open drawer: focus lands on the current view's link; Escape closes it and returns focus to the menu button.
  useEffect(() => {
    if (!(narrow && p.drawer)) return;
    (side.current?.querySelector('a[aria-current="page"]') as HTMLElement | null)?.focus();
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      p.setDrawer(false);
      (document.querySelector(".mobilebar .iconbtn") as HTMLElement | null)?.focus();
    };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [narrow, p.drawer]);
  const ini = p.user.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();

  return (
    <div className={"app" + (rail ? " is-rail" : "") + (narrow && p.drawer ? " is-drawer" : "")}>
      <a className="skip" href="#view">Skip to content</a>
      <aside className="side" ref={side} aria-label="Sidebar">
        <div className="side-top">
          <div className="brandrow">
            <img className="brand" src="/icon-512.png" alt="" width={30} height={30} />
            <div className="brandtxt">
              <b>Stage Prospect</b>
              <span title={p.workspace ? "Workspace" : undefined}>{p.workspace || "SDR Control Tower"}</span>
            </div>
            {narrow ? (
              <button className="iconbtn" onClick={() => p.setDrawer(false)} aria-label="Close menu">
                <Icon name="x" />
              </button>
            ) : (
              <button className="iconbtn collapse" onClick={() => p.setCollapsed(!p.collapsed)} aria-label={p.collapsed ? "Expand sidebar" : "Collapse sidebar"} aria-expanded={!p.collapsed} title="Toggle sidebar ([)">
                <Icon name="sidebar" />
              </button>
            )}
          </div>
          <button className="searchbtn" onClick={p.onSearch} aria-label="Search or jump" aria-keyshortcuts="Meta+K Control+K">
            <Icon name="search" size={16} />
            <span className="lbl">Search or jump…</span>
            <span className="keys"><kbd>{MOD}</kbd><kbd>K</kbd></span>
          </button>
        </div>
        <nav className="sidenav" aria-label="Main">
          <ul>
            {p.nav.map((n, i) => (
              <li key={n.id}>
                <a
                  href={"#/" + n.id}
                  aria-current={p.active === n.id ? "page" : undefined}
                  onClick={(e) => {
                    e.preventDefault();
                    p.onNav(n.id);
                  }}
                  data-tipr={rail ? n.label : undefined}
                  aria-keyshortcuts={String(i + 1)}
                >
                  <Icon name={n.icon} />
                  <span className="lbl">{n.label}</span>
                  {n.count ? <span className="ncount">{n.count}</span> : null}
                  <span className="nkey" aria-hidden="true">{i + 1}</span>
                </a>
              </li>
            ))}
          </ul>
          {p.onAdd ? (
            <button className="addbtn" onClick={p.onAdd} data-tipr={rail ? "Add company" : undefined} aria-keyshortcuts="C">
              <Icon name="plus" />
              <span className="lbl">Add company</span>
              <kbd aria-hidden="true">C</kbd>
            </button>
          ) : null}
        </nav>
        <div className="side-foot">
          {narrow ? (
            <>
              <Sync live={p.live} syncedAt={p.syncedAt} onResync={p.onResync} compact={false} />
              <div className="calrow">{p.calendar}</div>
            </>
          ) : null}
          <ProfileMenu
            ini={ini}
            user={p.user}
            items={p.profileItems}
            activeItem={p.active === "admin" || p.active === "platform" ? p.activeSection : ""}
            theme={p.theme}
            setTheme={p.setTheme}
            onShortcuts={p.onShortcuts}
            onSignOut={p.onSignOut}
            rail={rail}
          />
        </div>
      </aside>
      {narrow && p.drawer ? <div className="side-scrim" onClick={() => p.setDrawer(false)} aria-hidden="true" /> : null}

      <div className="main">
        {narrow ? (
          <div className="mobilebar">
            <button className="iconbtn" onClick={() => p.setDrawer(true)} aria-label="Open menu" aria-expanded={p.drawer}>
              <Icon name="menu" />
            </button>
            <img className="brand" src="/icon-512.png" alt="" width={26} height={26} />
            <b>Stage Prospect</b>
            <button className="iconbtn" onClick={p.onSearch} aria-label="Search or jump">
              <Icon name="search" />
            </button>
            {p.onAdd ? (
              <button className="iconbtn" onClick={p.onAdd} aria-label="Add a company">
                <Icon name="plus" />
              </button>
            ) : null}
          </div>
        ) : (
          <div className="topbar">
            <span className="crumb">
              <b>{p.workspace || "Stage Prospect"}</b>
              <span className="sep" aria-hidden="true">/</span>
              <span>{p.page.eyebrow}</span>
            </span>
            <span className="tb-right">
              {p.calendar}
              <Sync live={p.live} syncedAt={p.syncedAt} onResync={p.onResync} compact={false} />
            </span>
          </div>
        )}
        <div className="sheet">
        <div className="page">
          <header className="pagehead">
            <div className="ph-text">
              {narrow ? <p className="eyebrow">{p.page.eyebrow}</p> : null}
              <h1 id="page-title" tabIndex={-1}>
                {p.page.title}
                {p.page.accent ? <em> {p.page.accent}</em> : null}
              </h1>
              <p className="ph-sub">{p.page.sub}</p>
            </div>
            {p.page.actions ? <div className="ph-actions">{p.page.actions}</div> : null}
          </header>
          <main id="view" tabIndex={-1}>
            {p.children}
          </main>
        </div>
        </div>
      </div>
    </div>
  );
}

/** Signed-out and waiting screens: a split hero with the brand statement and one focused card. */
export function AuthFrame({ children, onSignOut }: { children: React.ReactNode; onSignOut?: () => void }) {
  return (
    <div className="auth">
      <a className="skip" href="#view">Skip to content</a>
      <section className="auth-hero" aria-label="About the roster">
        <div className="auth-brand">
          <img className="brand" src="/icon-512.png" alt="" width={36} height={36} />
          <b>Stage Prospect</b>
        </div>
        <h1 className="auth-title">
          Your outreach week, <em>already researched.</em>
        </h1>
        <p className="auth-sub">
          The accounts that fit your ideal customer profile, with the right contacts and their pain points. Screened, tiered and
          briefed before Monday.
        </p>
        <ul className="auth-facts" aria-label="What's inside">
          <li><b>Weekly</b><span>a fresh batch per rep, ready on Monday</span></li>
          <li><b>A·B·C</b><span>tiers by company fit</span></li>
          <li><b>2×</b><span>email checks, Apollo and FullEnrich</span></li>
        </ul>
      </section>
      <main className="auth-main" id="view" tabIndex={-1}>
        {onSignOut ? (
          <button className="btn ghost small auth-out" onClick={onSignOut}>
            Sign out
          </button>
        ) : null}
        <div className="auth-card">{children}</div>
      </main>
    </div>
  );
}
