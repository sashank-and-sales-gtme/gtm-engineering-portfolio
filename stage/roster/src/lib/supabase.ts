import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabaseConfigured = !!(url && key);

/** What an emailed auth link was for ("invite", "recovery", "signup", "magiclink"), read before the client clears the hash. */
export const authLinkType = (() => {
  try {
    return new URLSearchParams(window.location.hash.replace(/^#/, "")).get("type") || "";
  } catch (_) {
    return "";
  }
})();

export const supabase = createClient(url || "https://missing.supabase.co", key || "missing-anon-key", {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

/** Shortest password the forms accept. */
export const MIN_PASSWORD = 8;

/** Invoke an edge function and surface its error body as a readable message. */
export async function invokeFn<T = any>(name: string, body?: unknown, method: "POST" | "GET" = "POST"): Promise<T> {
  const { data, error } = await supabase.functions.invoke(name, method === "GET" ? { method: "GET" } : { body: body as any });
  if (error) {
    let msg = error.message || "Request failed";
    try {
      const ctx: any = (error as any).context;
      if (ctx && typeof ctx.json === "function") {
        const j = await ctx.json();
        if (j && (j.error || j.message)) msg = j.error || j.message;
      }
    } catch (_) {}
    throw { code: "function_error", message: msg };
  }
  return data as T;
}
