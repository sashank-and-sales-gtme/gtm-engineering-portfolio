// Dev-only: renders the Accounts tab with made-up data at /?harness, so layout can be checked without signing in.
// /?harness=setup&step=N opens Admin > Setup at step N (0-based); /?harness=empty shows Accounts before the first batch.
// /?harness=platform shows the platform console with canned workspaces. &theme=dark renders the dark theme.
import { useReducer, useRef, useState } from "react";
import { AppCtx, initialUI, type Ctx } from "../lib/ctx";
import { emptyData, type Row } from "../lib/data";
import AccountsTab from "../components/AccountsTab";
import AdminTab from "../components/AdminTab";
import { AppFrame, type NavItem, type Theme } from "../components/Frame";
import PlatformTab from "../components/PlatformTab";
import { supabase } from "../lib/supabase";

const day = (n: number) => new Date(Date.now() - n * 864e5).toISOString();
const ws = (id: string, name: string, o: Record<string, unknown>) => ({
  id, name, created_at: day(40), owner_email: null, owner_joined: null, members: 0, pending: 0, invites: 0, setup_done: false, documents: 0,
  leads: 0, leads_7d: 0, calls_7d: 0, meetings_7d: 0, queue_open: 0, queue_failed_7d: 0, connected: [], errors: [], worker_token: false,
  ai_month: { input: 0, output: 0, searches: 0, calls: 0 }, ai_budget: { monthly_usd: 50 }, last_active: null, ...o,
});
const OVERVIEW = {
  owner: "sashankandsales@gmail.com",
  signup: { open: false, allow: ["founder@ledgerline.example"] },
  admins: ["sashankandsales@gmail.com"],
  workspaces: [
    ws("w1", "Tallyfold", { owner_email: "sashankandsales@gmail.com", owner_joined: "sashankandsales@gmail.com", members: 4, pending: 1, setup_done: true, documents: 6, leads: 412, leads_7d: 96, calls_7d: 140, meetings_7d: 5, queue_open: 3, connected: ["apollo", "hubspot", "fullenrich"], worker_token: true, ai_month: { input: 5_800_000, output: 640_000, searches: 310, calls: 488 }, last_active: day(0.1) }),
    ws("w2", "Northwind Logistics", { owner_email: "ops@northwind.example", owner_joined: "ops@northwind.example", members: 2, setup_done: true, documents: 2, leads: 120, leads_7d: 40, calls_7d: 22, queue_failed_7d: 3, connected: ["apollo"], errors: ["hubspot"], worker_token: true, ai_month: { input: 1_900_000, output: 210_000, searches: 90, calls: 140 }, last_active: day(1.4) }),
    ws("w3", "Qubeline", { owner_email: "cto@qubeline.example", owner_joined: "cto@qubeline.example", members: 1, documents: 1, last_active: day(3) }),
    ws("w4", "Helix Learning", { owner_email: "founder@helix.example", invites: 0 }),
  ],
  audit: [
    { id: 3, at: day(0.2), actor: "sashankandsales@gmail.com", action: "workspace.create", target: "Helix Learning", detail: "owner founder@helix.example" },
    { id: 2, at: day(2), actor: "sashankandsales@gmail.com", action: "signup.set", target: "", detail: "closed, 1 allowed" },
  ],
};

const ME = "u-me";
const profiles: Row[] = [
  { id: ME, full_name: "Sashank Koundinya", email: "s@example.com", status: "active", role: "super_admin", is_owner: true },
  { id: "u-k", full_name: "Kousain Rahman", email: "k@example.com", status: "active", role: "sdr" },
  { id: "u-h", full_name: "Harshit Varma", email: "h@example.com", status: "active", role: "sdr" },
];
const co = [
  ["Lumora Health", "lumorahealth.com", "Healthtech SaaS", 640, "A"],
  ["Qubeline", "qubeline.io", "DevOps SaaS", 310, "B"],
  ["Tarsus Payments", "tarsuspay.com", "Fintech", 1800, "A"],
  ["Northwind Logistics Cloud", "northwindcloud.in", "Logistics SaaS", 420, "C"],
  ["Ferrocart", "ferrocart.com", "B2B commerce", 900, "S"],
  ["Helix Learning", "helixlearn.in", "Edtech SaaS", 260, "B"],
] as const;
const people = [
  ["Ananya Iyer", "Head of Demand Generation", "demand_gen"],
  ["Rohit Mehta", "Director, Growth Marketing", "growth"],
  ["Priya Nair", "VP Digital Marketing", "digital"],
];
const leads: Row[] = [];
co.forEach(([company, domain, segment, employees, tier], i) => {
  people.slice(0, 1 + (i % 3)).forEach(([name, title, scope], j) => {
    leads.push({
      id: `l-${i}-${j}`, company, domain, segment, employees, tier, title_scope: scope,
      name: j ? name : name, title, approved: i % 2 === 0 || j === 0 && i === 3,
      assigned_to: [ME, "u-k", "u-h"][i % 3], batch: "2026-10-19", created_at: "2026-10-19T04:00:00Z",
      angle: `Your India pipeline likely leans on paid traffic; ${company} may convert more of it if visitors get a live walkthrough. Northwind closed in 3 days instead of 9.`,
      fit_reason: "Confirmed: B2B SaaS, 250-2500 staff, India GTM team.", status_check: j === 1 ? "unconfirmed" : "current",
      enrichment: i % 2 === 0 ? { email: "x@" + domain, email_status: "verified" } : null,
      source: i === 4 ? "manual" : "apollo", pain_points: [], person_check: null,
    });
  });
});
const callbacks: Row[] = [{ id: "cb1", lead_id: "l-2-0", status: "open", when: "2026-10-23T05:30:00Z", agenda: "Retry after DNP (attempt 1).", cal_status: "added", cal_kind: "task" }];
const meetings: Row[] = [{ id: "m1", lead_id: "l-4-0", status: "scheduled", when: "2026-10-24T08:30:00Z", contact: "Ananya Iyer" }];
const addreqs: Row[] = [
  { id: "r1", company: "Zentrix", domain: "zentrix.ai", status: "pick", mode: "more", owner: "u-k", created_at: "2026-10-22T05:00:00Z",
    candidates: [{ name: "Meera Shah", title: "Head of Growth" }, { name: "Vikram Rao", title: "Director Marketing" }] },
  { id: "r2", company: "Orbitly", domain: "orbitly.com", status: "failed", mode: "now", owner: ME, created_at: "2026-10-21T05:00:00Z", note: "Apollo found no ICP contacts." },
];

const PROFILE = {
  company_name: "Tallyfold",
  website: "https://tallyfold.example",
  product_summary: "Close software for finance teams: reconciliations, accruals and the month-end checklist in one place.",
  proof_points: [
    { text: "Month-end close in 3 days instead of 9", customer: "Northwind", use_when: "slow close", link: "https://tallyfold.example/northwind" },
    { text: "40% fewer manual journal entries", customer: "Contoso", use_when: "manual work", link: "" },
  ],
  customers: [{ name: "Northwind", url: "https://northwind.example", live_instance: true }],
  company_icp: { description: "B2B SaaS with a finance team of 5 or more", min_employees: 200, max_employees: 2500, exclude: [], rules: [] },
};
const DOCS = [
  { id: "d1", kind: "file", name: "Tallyfold sales deck 2026.pptx", path: "w/d1", url: null, mime: "", size_bytes: 4_200_000, status: "ready", chars: 18234, error: null, created_at: "" },
  { id: "d2", kind: "link", name: "Tallyfold website", path: null, url: "https://tallyfold.example", mime: null, size_bytes: null, status: "ready", chars: 6410, error: null, created_at: "" },
  { id: "d3", kind: "file", name: "Discovery call, Globex.wav", path: "w/d3", url: null, mime: "audio/wav", size_bytes: 31_000_000, status: "stored", chars: 0, error: null, created_at: "" },
  { id: "d4", kind: "file", name: "Scanned contract.pdf", path: "w/d4", url: null, mime: "application/pdf", size_bytes: 900_000, status: "failed", chars: 0, error: "No text found; it may be a scanned PDF", created_at: "" },
];

export default function Harness() {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const ref = useRef<Ctx | null>(null);
  if (!ref.current) {
    const S = initialUI();
    const q = new URLSearchParams(location.search);
    const v = q.get("harness");
    if (v === "board") S.acctView = "board";
    try { localStorage.setItem("roster.acctView", S.acctView); } catch (_) {}
    ref.current = {
      S,
      D: { ...emptyData, leads: v === "empty" ? [] : leads, callbacks, meetings, addreqs: v === "empty" ? [] : addreqs, profiles, loaded: true, live: "live", settings: v === "setup" ? { profile: PROFILE } : {} },
      session: {} as any,
      uid: ME,
      me: profiles[0],
      rerender: () => bump(),
      toast: (t) => console.log("toast:", t),
    };
    // Canned answers for what the screens would fetch.
    S.forms["setup-ws"] = "Tallyfold";
    S.forms["docs"] = { rows: DOCS, err: "" };
    S.integ.data = { providers: { apollo: { connected: true }, hubspot: { connected: false } }, me: {}, worker: { active: false } };
    if (v === "platform") (supabase as any).rpc = async () => ({ data: OVERVIEW, error: null });
    if (v === "setup") {
      S.adminSec = "setup";
      S.forms["setup-seen"] = true;
      const n = Number(q.get("step") || 0);
      if (n) S.forms["setup"] = undefined;
      S.forms["setup-step"] = n;
    }
  }
  const mode = new URLSearchParams(location.search).get("harness");
  const setup = mode === "setup";
  const theme = (new URLSearchParams(location.search).get("theme") || "light") as Theme;
  document.documentElement.dataset.theme = theme;
  const [collapsed, setCollapsed] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const nav: NavItem[] = [
    { id: "accounts", label: "Accounts", icon: "accounts", count: setup || mode === "empty" ? null : leads.length, key: "1" },
    { id: "meetings", label: "Meetings", icon: "meetings", count: meetings.length, key: "2" },
    { id: "dashboard", label: "Dashboard", icon: "dashboard", count: null, key: "4" },
  ];
  return (
    <AppCtx.Provider value={ref as { current: Ctx }}>
      <AppFrame
        nav={nav}
        active={mode === "platform" ? "platform" : setup ? "admin" : "accounts"}
        onNav={() => {}}
        collapsed={collapsed}
        setCollapsed={setCollapsed}
        drawer={drawer}
        setDrawer={setDrawer}
        onSearch={() => {}}
        onAdd={() => {}}
        live="live"
        syncedAt={Date.now() - 120000}
        onResync={() => {}}
        calendar={<span className="calchip ok">Calendar connected</span>}
        theme={theme}
        setTheme={() => {}}
        user={{ name: "Sashank K", email: "sashank@tallyfold.example", role: "Super Admin" }}
        workspace="Tallyfold"
        onSignOut={() => {}}
        onShortcuts={() => {}}
        profileItems={[]}
        activeSection={setup ? "setup" : ""}
        page={mode === "platform"
          ? { eyebrow: "Saturday, 25 October", title: "Platform console", sub: "Every workspace on Stage Prospect, who can sign up, and who runs the platform." }
          : setup
          ? { eyebrow: "Saturday, 25 October", title: "Admin", sub: "Setup, people, personas and connections for this workspace." }
          : { eyebrow: "Saturday, 25 October", title: "Accounts", sub: "This week's accounts, grouped by company, with each contact's angle and draft." }}
      >
        <div className="view-in">{mode === "platform" ? <PlatformTab /> : setup ? <AdminTab /> : <AccountsTab />}</div>
      </AppFrame>
    </AppCtx.Provider>
  );
}
