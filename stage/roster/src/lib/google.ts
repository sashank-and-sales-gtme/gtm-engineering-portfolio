import { supabase } from "./supabase";

/* Google Calendar through the `calendar` edge function. Each person connects their own calendar once
   (Admin > Integrations or the header link); the server keeps the refresh token in Vault, so nothing
   about Google tokens lives in the browser. */

export type CalState = "unknown" | "unavailable" | "connected" | "reconnect" | "not_connected";
export type CalError = { code: string; message?: string };

let state: CalState = "unknown";
let email = "";
let listeners: Array<() => void> = [];
let connectHandler: ((e: CalError) => void) | null = null;

function emit() {
  listeners.forEach((f) => f());
}
export function onGoogleChange(f: () => void) {
  listeners.push(f);
  return () => {
    listeners = listeners.filter((x) => x !== f);
  };
}
export function googleState(): CalState {
  return state;
}
export function googleEmail(): string {
  return email;
}

/** Apply `me.google_calendar` from an integrations status response. */
export function setCalFromStatus(data: any) {
  const g = data && data.me && data.me.google_calendar;
  if (!g) return;
  state = g.connected ? "connected" : g.status === "error" ? "reconnect" : "not_connected";
  email = g.account_label || "";
  emit();
}
/** Reads the calendar's status. A failed or slow status call (8s) ends in 'unavailable', never in an endless check. */
export async function loadCalState() {
  if (state === "unavailable") {
    state = "unknown";
    emit();
  }
  const slow = window.setTimeout(() => {
    if (state === "unknown") {
      state = "unavailable";
      emit();
    }
  }, 8000);
  try {
    const { data, error } = await supabase.functions.invoke("integrations", { body: { action: "status" } });
    if (error) throw error;
    setCalFromStatus(data);
  } catch (_) {
    if (state === "unknown") {
      state = "unavailable";
      emit();
    }
  } finally {
    window.clearTimeout(slow);
  }
}
export function resetCalState() {
  state = "unknown";
  email = "";
  emit();
}

/** App registers this to show a toast with a "Connect" action when a calendar call needs a connection. */
export function onNeedsConnect(f: ((e: CalError) => void) | null) {
  connectHandler = f;
}
export const needsConnect = (e: any) => !!e && (e.code === "not_connected" || e.code === "reconnect");

/** Start the Google Calendar OAuth flow in the same tab. */
export async function connectGoogleCalendar() {
  const r = await call("integrations", { action: "oauth_start", provider: "google_calendar", return_to: window.location.origin });
  if (r && r.url) window.location.href = r.url;
  else throw { code: "no_url", message: "No sign-in link came back." } as CalError;
}

async function call(name: string, body: unknown): Promise<any> {
  const { data, error } = await supabase.functions.invoke(name, { body: body as any });
  if (error) {
    let code = "upstream_error",
      message = error.message || "Request failed";
    try {
      const ctx: any = (error as any).context;
      if (ctx && typeof ctx.json === "function") {
        const j = await ctx.json();
        if (j && j.error) code = String(j.error);
        if (j && (j.message || j.error)) message = j.message || j.error;
      }
    } catch (_) {}
    throw { code, message } as CalError;
  }
  return data;
}

async function cal(body: Record<string, unknown>): Promise<any> {
  try {
    const r = await call("calendar", body);
    if (state !== "connected") {
      state = "connected";
      emit();
    }
    return r;
  } catch (e: any) {
    if (needsConnect(e)) {
      const next: CalState = e.code === "reconnect" ? "reconnect" : "not_connected";
      if (state !== next) {
        state = next;
        emit();
      }
      if (connectHandler) connectHandler(e);
    }
    throw e;
  }
}

export async function createEvent(ev: { summary: string; start: string; end: string; description?: string }): Promise<string> {
  const r = await cal({
    action: "create",
    summary: ev.summary,
    start_iso: new Date(ev.start).toISOString(),
    end_iso: new Date(ev.end).toISOString(),
    description: ev.description || "",
  });
  return (r && r.id) || "";
}

export async function deleteEvent(id: string) {
  if (!id) return;
  await cal({ action: "delete", event_id: id });
}

/** A Google Task in the user's default list (shows in Google Calendar and Gmail). Google keeps the date only. */
export async function createGTask(t: { title: string; notes?: string; due: string }): Promise<string> {
  const r = await cal({ action: "task_create", title: t.title, notes: t.notes || "", due_iso: new Date(t.due).toISOString() });
  return (r && r.id) || "";
}
export async function patchGTask(id: string, p: { title?: string; notes?: string; due?: string; completed?: boolean }) {
  if (!id) return;
  await cal({ action: "task_patch", task_id: id, title: p.title, notes: p.notes, due_iso: p.due ? new Date(p.due).toISOString() : undefined, completed: p.completed });
}
export async function deleteGTask(id: string) {
  if (!id) return;
  await cal({ action: "task_delete", task_id: id });
}
/** Closes roster items the user ticked off in Google. Quiet: never prompts to connect. */
export async function syncGTasks(): Promise<{ callbacks: number; tasks: number } | null> {
  try {
    return await call("calendar", { action: "task_sync" });
  } catch (_) {
    return null;
  }
}

export async function listEvents(timeMin: string, timeMax: string): Promise<any[]> {
  const r = await cal({ action: "list", time_min: new Date(timeMin).toISOString(), time_max: new Date(timeMax).toISOString() });
  return (r && r.events) || [];
}

export function calErr(e: any): string {
  const c = e && e.code;
  if (c === "not_connected") return "Connect Google to add this to Google Tasks.";
  if (c === "reconnect") return "Reconnect Google (allow Tasks) to add this to Google Tasks.";
  if (c === "upstream_error") return "Google refused the request: " + (e.message || "");
  // Server errors arrive with the message as the code (e.g. "The Google Tasks API is off…"): show it as is.
  if (e && e.message && e.message !== "Request failed") return String(e.message);
  return "Google is unavailable right now.";
}
