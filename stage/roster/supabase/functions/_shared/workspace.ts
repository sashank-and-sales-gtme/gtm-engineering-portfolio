// Which workspace a request works for. Every request runs in its own context (serve() in cors.ts starts one).
// getCaller() fills it from the signed-in person, the worker from its token, cron jobs per workspace with
// inWorkspace(). adminClient() (supabase.ts) reads it to scope every service-role query, and throws when it is
// missing, so code that forgets to pick a workspace fails instead of reading everyone's data.
import { AsyncLocalStorage } from "node:async_hooks";

interface RequestContext {
  workspace: string | null;
}

const store = new AsyncLocalStorage<RequestContext>();

/** Runs one request in a fresh context with no workspace yet. */
export function withRequestContext<T>(fn: () => Promise<T>): Promise<T> {
  return store.run({ workspace: null }, fn);
}

/** Runs fn for one workspace (cron jobs loop over workspaces with this). */
export function inWorkspace<T>(workspace: string, fn: () => Promise<T>): Promise<T> {
  if (!workspace) throw new Error("inWorkspace needs a workspace id");
  return store.run({ workspace }, fn);
}

/** Pins the current request to a workspace. A request can never switch to a different one. */
export function setWorkspace(workspace: string): void {
  const ctx = store.getStore();
  if (!ctx) throw new Error("setWorkspace called outside a request");
  if (!workspace) throw new Error("setWorkspace needs a workspace id");
  if (ctx.workspace && ctx.workspace !== workspace) throw new Error("This request already belongs to another workspace");
  ctx.workspace = workspace;
}

/** The current workspace, or null outside one. */
export function maybeWorkspace(): string | null {
  return store.getStore()?.workspace ?? null;
}

/** The current workspace. Throws when the request hasn't picked one. */
export function currentWorkspace(): string {
  const ws = maybeWorkspace();
  if (!ws) throw new Error("No workspace selected for this request");
  return ws;
}
