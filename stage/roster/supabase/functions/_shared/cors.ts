import { withRequestContext } from "./workspace.ts";

export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return "Unknown error";
  }
}

/** Wraps a handler with CORS preflight handling and JSON error responses. */
export function serve(handler: (req: Request) => Promise<Response>): void {
  Deno.serve((req: Request) => withRequestContext(async () => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    try {
      return await handler(req);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status >= 500) console.error("function error:", errMsg(e));
      return json({ ok: false, error: errMsg(e) }, status);
    }
  }));
}

export async function readJson<T = Record<string, unknown>>(req: Request): Promise<T> {
  try {
    const text = await req.text();
    return (text ? JSON.parse(text) : {}) as T;
  } catch {
    throw new HttpError(400, "Body must be valid JSON");
  }
}

/** Run work after the response when the edge runtime supports it. */
export function background(p: Promise<unknown>): void {
  const safe = p.catch((e) => console.error("background task failed:", errMsg(e)));
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt && typeof rt.waitUntil === "function") rt.waitUntil(safe);
}

export async function fetchWithTimeout(url: string, init: RequestInit = {}, ms = 30000): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
  } catch (e) {
    if (e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError")) {
      throw new Error(`Request to ${new URL(url).host} timed out after ${Math.round(ms / 1000)}s`);
    }
    throw e;
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
