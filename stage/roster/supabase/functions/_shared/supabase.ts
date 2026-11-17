import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { fetchWithTimeout, HttpError, json } from "./cors.ts";
import { currentWorkspace, maybeWorkspace, setWorkspace } from "./workspace.ts";

export function env(name: string, required = true): string {
  const v = Deno.env.get(name) ?? "";
  if (!v && required) throw new HttpError(500, `Server is missing the ${name} secret`);
  return v;
}

let _platform: SupabaseClient | null = null;
/** Unscoped service-role client. Only for platform work: finding the caller's or worker's workspace, listing
 *  workspaces for cron jobs, claiming queue rows across workspaces, platform settings and platform secrets. */
export function platformClient(): SupabaseClient {
  if (!_platform) {
    _platform = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return _platform;
}

/** Tables without workspace_id. */
const PLATFORM_TABLES = new Set(["workspaces", "platform_settings"]);
/** Functions that take the workspace as p_workspace; the scoped client always passes the current one. */
const WORKSPACE_RPCS = new Set([
  "claude_usage_add", "claim_claude_work", "claim_gate_rows", "archive_stale_leads", "ai_spend_this_month",
  "research_should_wake", "research_reset_wake", "post_call_should_wake", "post_call_reset_wake",
]);

type Row = Record<string, unknown>;
function tag<T>(values: T, ws: string): T {
  const one = (v: Row) => {
    if (v.workspace_id !== undefined && v.workspace_id !== ws) throw new Error("Row belongs to another workspace");
    return { ...v, workspace_id: ws };
  };
  return (Array.isArray(values) ? values.map(one) : one(values as Row)) as T;
}

// deno-lint-ignore no-explicit-any
function scopedTable(raw: SupabaseClient, table: string, ws: string): any {
  const qb = raw.from(table);
  return {
    // deno-lint-ignore no-explicit-any
    select: (columns?: string, options?: any) => qb.select(columns, options).eq("workspace_id", ws),
    // deno-lint-ignore no-explicit-any
    insert: (values: any, options?: any) => qb.insert(tag(values, ws), options),
    // deno-lint-ignore no-explicit-any
    upsert: (values: any, options?: any) => qb.upsert(tag(values, ws), options),
    // deno-lint-ignore no-explicit-any
    update: (values: any, options?: any) => {
      if (values && "workspace_id" in values) throw new Error("A row cannot move to another workspace");
      return qb.update(values, options).eq("workspace_id", ws);
    },
    // deno-lint-ignore no-explicit-any
    delete: (options?: any) => qb.delete(options).eq("workspace_id", ws),
  };
}

/** Service-role client scoped to the request's workspace (see workspace.ts): reads, updates and deletes are
 *  filtered to it, inserts and upserts are tagged with it. Throws when the request has no workspace. */
export function adminClient(): SupabaseClient {
  const raw = platformClient();
  return new Proxy(raw, {
    get(target, prop, receiver) {
      if (prop === "from") {
        return (table: string) => PLATFORM_TABLES.has(table) ? target.from(table) : scopedTable(target, table, currentWorkspace());
      }
      if (prop === "rpc") {
        // deno-lint-ignore no-explicit-any
        return (fn: string, args: Record<string, unknown> = {}, options?: any) =>
          target.rpc(fn, WORKSPACE_RPCS.has(fn) ? { ...args, p_workspace: currentWorkspace() } : args, options);
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

/** Every workspace id, oldest first (cron jobs run each one with inWorkspace). */
export async function listWorkspaces(): Promise<string[]> {
  const { data, error } = await platformClient().from("workspaces").select("id").order("created_at");
  if (error) throw new Error(`Could not list workspaces: ${error.message}`);
  return (data ?? []).map((w) => w.id as string);
}

/** The workspace a person belongs to. */
export async function workspaceOfUser(userId: string): Promise<string | null> {
  const { data } = await platformClient().from("profiles").select("workspace_id").eq("id", userId).maybeSingle();
  return (data?.workspace_id as string | undefined) ?? null;
}

/** Client that acts as the caller, so RLS and auth.uid() apply. */
export function userClient(req: Request): SupabaseClient {
  const auth = req.headers.get("Authorization") ?? "";
  return createClient(env("SUPABASE_URL"), env("SUPABASE_ANON_KEY"), {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export interface Caller {
  id: string;
  workspace_id: string;
  email: string;
  role: string | null;
  perms: string[];
  hubspot_owner_id: string | null;
  full_name: string | null;
  can: (p: string) => boolean;
  client: SupabaseClient;
}

/** Resolves the signed-in caller and their active role. Throws 401/403 otherwise. */
export async function getCaller(req: Request): Promise<Caller> {
  const auth = req.headers.get("Authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token) throw new HttpError(401, "Sign in required");
  const admin = platformClient();
  const { data: u, error } = await admin.auth.getUser(token);
  if (error || !u?.user) throw new HttpError(401, "Session expired. Sign in again.");
  const { data: prof, error: pe } = await admin
    .from("profiles")
    .select("id,workspace_id,email,role,status,is_owner,hubspot_owner_id,full_name")
    .eq("id", u.user.id)
    .maybeSingle();
  if (pe) throw new HttpError(500, "Could not load your profile");
  if (!prof || prof.status !== "active") throw new HttpError(403, "Your access is not active yet");
  setWorkspace(prof.workspace_id);
  const role: string | null = prof.is_owner ? "super_admin" : prof.role;
  let perms: string[] = [];
  if (role && role !== "super_admin") {
    const { data: r } = await admin.from("roles").select("perms").eq("workspace_id", prof.workspace_id).eq("id", role).maybeSingle();
    perms = (r?.perms as string[]) ?? [];
  }
  return {
    id: prof.id,
    workspace_id: prof.workspace_id,
    email: prof.email,
    role,
    perms,
    hubspot_owner_id: prof.hubspot_owner_id ?? null,
    full_name: prof.full_name ?? null,
    can: (p: string) => role === "super_admin" || perms.includes(p),
    client: userClient(req),
  };
}

export function requirePerm(c: Caller, ...perms: string[]): void {
  for (const p of perms) if (!c.can(p)) throw new HttpError(403, `Your role does not allow this (${p})`);
}

/** Cron and internal calls authenticate with the CRON_SECRET bearer. */
export function isCron(req: Request): boolean {
  const secret = Deno.env.get("CRON_SECRET") ?? "";
  if (!secret) return false;
  return (req.headers.get("Authorization") ?? "") === `Bearer ${secret}`;
}

export function requireCron(req: Request): void {
  if (!Deno.env.get("CRON_SECRET")) throw new HttpError(500, "Server is missing the CRON_SECRET secret");
  if (!isCron(req)) throw new HttpError(401, "Invalid cron secret");
}

/** Invoke another edge function with the cron secret. Waits at most `waitMs` for the reply. */
export async function invokeInternal(name: string, body: unknown = {}, waitMs = 5000): Promise<unknown> {
  const url = `${env("SUPABASE_URL")}/functions/v1/${name}`;
  // The called function works for the same workspace as this one.
  const ws = maybeWorkspace();
  if (ws && body && typeof body === "object" && !Array.isArray(body) && !("workspace_id" in body)) body = { ...body, workspace_id: ws };
  const p = fetchWithTimeout(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${env("CRON_SECRET")}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, 400000).then(async (r) => {
    const t = await r.text();
    try {
      return JSON.parse(t);
    } catch {
      return { status: r.status, body: t.slice(0, 500) };
    }
  });
  const timer = new Promise((res) => setTimeout(() => res({ started: true }), waitMs));
  return await Promise.race([p.catch((e) => ({ error: String(e) })), timer]);
}

/** Cron entry for a scheduled function. With body.workspace_id (set by the fan-out below, behind the cron secret)
 *  it runs that one workspace; otherwise it starts one run per workspace, each in its own invocation and time limit. */
export async function cronFanOut(name: string, opts: Record<string, unknown>, run: () => Promise<Response>): Promise<Response> {
  const ws = typeof opts.workspace_id === "string" ? opts.workspace_id : "";
  if (ws) {
    setWorkspace(ws);
    return await run();
  }
  const ids = await listWorkspaces();
  const started = await Promise.all(ids.map((id) => invokeInternal(name, { ...opts, workspace_id: id }, 1500)));
  return json({ ok: true, workspaces: ids.length, runs: Object.fromEntries(ids.map((id, i) => [id, started[i]])) });
}

export async function audit(actor: string | null, action: string, target: string, detail: string): Promise<void> {
  try {
    await adminClient().from("audit_log").insert({ actor, action, target, detail });
  } catch {
    // audit is best effort
  }
}

export const coName = (s: unknown) => String(s ?? "").replace(/\s*\(.*?\)/g, "").trim();

export function splitName(n: unknown): { first: string; last: string; masked: boolean } {
  const p = String(n ?? "").replace(/\s*\(.*?\)/g, "").trim().split(/\s+/);
  const first = p.shift() || "";
  const last = p.join(" ");
  return { first, last: /\*/.test(last) ? "" : last, masked: /\*/.test(last) };
}

export const nowISO = () => new Date().toISOString();
