import { useEffect, useReducer } from "react";
import { supabase } from "./supabase";

export type Row = Record<string, any>;

export type Data = {
  leads: Row[];
  calls: Row[];
  callbacks: Row[];
  meetings: Row[];
  tasks: Row[];
  journeys: Row[];
  drafts: Row[];
  rdrafts: Row[];
  addreqs: Row[];
  profiles: Row[];
  roles: Row[];
  invites: Row[];
  audit: Row[];
  reps: Row[];
  settings: Record<string, any>;
  order: string[];
  loaded: boolean;
  /** Realtime link: "connecting" until subscribed, "live" while events flow, "offline" when the channel drops. */
  live: "connecting" | "live" | "offline";
  /** When the working set was last fully read from the database (ms). */
  syncedAt: number;
};

type TableKey = Exclude<keyof Data, "settings" | "order" | "loaded" | "live" | "syncedAt">;

export const TABLES: Array<{ table: string; key: TableKey | "settings" | "order"; pk: string }> = [
  { table: "leads", key: "leads", pk: "id" },
  { table: "calls", key: "calls", pk: "id" },
  { table: "callbacks", key: "callbacks", pk: "id" },
  { table: "meetings", key: "meetings", pk: "id" },
  { table: "tasks", key: "tasks", pk: "id" },
  { table: "journeys", key: "journeys", pk: "id" },
  { table: "email_drafts", key: "drafts", pk: "id" },
  { table: "reschedule_drafts", key: "rdrafts", pk: "id" },
  { table: "add_requests", key: "addreqs", pk: "id" },
  { table: "profiles", key: "profiles", pk: "id" },
  { table: "roles", key: "roles", pk: "id" },
  { table: "invites", key: "invites", pk: "email" },
  { table: "audit_log", key: "audit", pk: "id" },
  { table: "rep_settings", key: "reps", pk: "user_id" },
  { table: "app_settings", key: "settings", pk: "key" },
  { table: "task_order", key: "order", pk: "user_id" },
];

export const emptyData: Data = {
  leads: [], calls: [], callbacks: [], meetings: [], tasks: [], journeys: [], drafts: [], rdrafts: [], addreqs: [],
  profiles: [], roles: [], invites: [], audit: [], reps: [], settings: {}, order: [], loaded: false,
  live: "connecting", syncedAt: 0,
};

type Action =
  | { type: "reset" }
  | { type: "load"; table: string; rows: Row[] }
  | { type: "upsert"; table: string; row: Row }
  | { type: "remove"; table: string; row: Row }
  | { type: "loaded" }
  | { type: "live"; live: Data["live"] };

function apply(state: Data, table: string, fn: (rows: Row[], pk: string) => Row[]): Data {
  const t = TABLES.find((x) => x.table === table);
  if (!t) return state;
  if (t.key === "settings") {
    const rows = fn(Object.entries(state.settings).map(([key, value]) => ({ key, value })), "key");
    const settings: Record<string, any> = {};
    rows.forEach((r) => (settings[r.key] = r.value));
    return { ...state, settings };
  }
  if (t.key === "order") {
    const rows = fn(state.order.length ? [{ user_id: "me", order: state.order }] : [], "user_id");
    const last = rows.slice(-1)[0];
    return { ...state, order: last && Array.isArray(last.order) ? last.order : [] };
  }
  return { ...state, [t.key]: fn(state[t.key] as Row[], t.pk) };
}

function reducer(state: Data, a: Action): Data {
  switch (a.type) {
    case "reset":
      return emptyData;
    case "loaded":
      return { ...state, loaded: true, syncedAt: Date.now() };
    case "live":
      return state.live === a.live ? state : { ...state, live: a.live };
    case "load":
      return apply(state, a.table, () => a.rows);
    case "upsert":
      // An archived lead leaves the working set (it stays in the database for dedupe).
      if (a.table === "leads" && a.row.archived === true) return apply(state, a.table, (rows, pk) => rows.filter((r) => r[pk] !== a.row[pk]));
      return apply(state, a.table, (rows, pk) => {
        const i = rows.findIndex((r) => r[pk] === a.row[pk]);
        if (i < 0) return [...rows, a.row];
        const next = rows.slice();
        next[i] = { ...rows[i], ...a.row };
        return next;
      });
    case "remove":
      return apply(state, a.table, (rows, pk) => rows.filter((r) => r[pk] !== a.row[pk]));
  }
}

const PAGE = 1000;

/** Reads every row of a query, a page at a time. PostgREST caps a single response at 1000 rows. */
async function fetchAll(build: () => any, order: string, ascending = true): Promise<Row[]> {
  const out: Row[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().order(order, { ascending }).range(from, from + PAGE - 1);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

async function loadTable(table: string, userId: string): Promise<Row[]> {
  const q = () => supabase.from(table).select("*");
  switch (table) {
    case "leads":
      return fetchAll(() => q().eq("archived", false), "id");
    case "calls":
      return fetchAll(q, "at", false);
    case "audit_log": {
      const { data, error } = await supabase.from(table).select("*").order("at", { ascending: false }).limit(500);
      if (error) throw error;
      return (data || []) as Row[];
    }
    case "task_order": {
      const { data, error } = await supabase.from(table).select("*").eq("user_id", userId);
      if (error) throw error;
      return (data || []) as Row[];
    }
    default: {
      const pk = (TABLES.find((t) => t.table === table) || { pk: "id" }).pk;
      return fetchAll(q, pk);
    }
  }
}

let liveDispatch: ((a: Action) => void) | null = null;

/** Applies a write to the local working set right away, so the UI does not wait for Realtime (which can lag or drop). */
export function syncLocal(table: string, row: Row, removed = false) {
  if (liveDispatch) liveDispatch({ type: removed ? "remove" : "upsert", table, row });
}

// Tables whose rows belong to one person through an `owner` column.
const OWNED = ["calls", "callbacks", "meetings", "tasks", "journeys", "email_drafts", "reschedule_drafts", "add_requests"];

/** The permissions of the signed-in user's role, read once per subscription. Super Admin has all of them. */
async function myPerms(userId: string): Promise<{ all: boolean; has: (p: string) => boolean }> {
  const { data: me } = await supabase.from("profiles").select("role").eq("id", userId).maybeSingle();
  const role = me?.role || "";
  if (role === "super_admin") return { all: true, has: () => true };
  const { data: r } = await supabase.from("roles").select("perms").eq("id", role).maybeSingle();
  const set = new Set<string>(Array.isArray(r?.perms) ? r!.perms : []);
  return { all: false, has: (p) => set.has(p) };
}

/**
 * The Realtime filter for a table, so people only receive changes they can act on: "" for every change row
 * security lets through, a column filter for their own rows, or null to not listen at all. Row security still
 * applies on top; this only cuts the traffic each browser receives as the team grows.
 */
export function liveFilter(table: string, uid: string, has: (p: string) => boolean): string | null {
  if (table === "task_order") return `user_id=eq.${uid}`;
  if (table === "audit_log") return has("view_audit") ? "" : null;
  if (table === "rep_settings" || table === "invites") return has("manage_users") ? "" : null;
  if (table === "leads") return has("view_all_accounts") ? "" : `assigned_to=eq.${uid}`;
  if (OWNED.includes(table)) return has("view_all_meetings") ? "" : `owner=eq.${uid}`;
  return "";
}

let liveResync: (() => void) | null = null;
/** Re-reads the whole working set now (the sidebar's sync button and the command palette use it). */
export function resyncNow() {
  if (liveResync) liveResync();
}

/**
 * Loads the working set the signed-in user can read (RLS decides) and keeps it live with Realtime.
 * Realtime can drop events while a laptop sleeps or the network blips, so the set is re-read when the
 * channel resubscribes, when the browser comes back online, and when the tab returns after 30s away.
 */
export function useRosterData(userId: string | null, active: boolean, roleKey = "") {
  const [data, dispatch] = useReducer(reducer, emptyData);
  liveDispatch = dispatch;

  useEffect(() => {
    dispatch({ type: "reset" });
    if (!userId || !active) return;
    let cancelled = false;
    let loading = false;
    let wasOffline = false;
    let hiddenAt = 0;

    const loadAll = async () => {
      if (loading) return;
      loading = true;
      try {
        await Promise.all(
          TABLES.map(async ({ table }) => {
            try {
              const rows = await loadTable(table, userId);
              if (!cancelled) dispatch({ type: "load", table, rows });
            } catch (e) {
              console.error("Could not load " + table, e);
            }
          })
        );
        if (!cancelled) dispatch({ type: "loaded" });
      } finally {
        loading = false;
      }
    };

    let channel: ReturnType<typeof supabase.channel> | null = null;
    const subscribe = (has: (p: string) => boolean) => {
      if (cancelled) return;
      channel = supabase.channel("roster-" + userId);
      TABLES.forEach(({ table }) => {
        const filter = liveFilter(table, userId, has);
        if (filter === null) return;
        const spec: Record<string, string> = { event: "*", schema: "public", table };
        if (filter) spec.filter = filter;
        channel!.on("postgres_changes" as any, spec, (p: any) => {
          if (p.eventType === "DELETE") dispatch({ type: "remove", table, row: p.old || {} });
          else dispatch({ type: "upsert", table, row: p.new || {} });
        });
      });
      channel.subscribe(onStatus);
    };
    const onStatus = (status: string) => {
      if (cancelled) return;
      if (status === "SUBSCRIBED") {
        dispatch({ type: "live", live: "live" });
        if (wasOffline) loadAll();
        wasOffline = false;
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        wasOffline = true;
        dispatch({ type: "live", live: "offline" });
      }
    };
    myPerms(userId)
      .then((p) => subscribe(p.has))
      .catch(() => subscribe(() => true));

    const onVis = () => {
      if (document.visibilityState === "hidden") hiddenAt = Date.now();
      else if (hiddenAt && Date.now() - hiddenAt > 30000) loadAll();
    };
    const onOnline = () => loadAll();
    const onOffline = () => dispatch({ type: "live", live: "offline" });
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    liveResync = loadAll;
    loadAll();

    return () => {
      cancelled = true;
      liveResync = null;
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      if (channel) supabase.removeChannel(channel);
    };
  }, [userId, active, roleKey]);

  return data;
}
