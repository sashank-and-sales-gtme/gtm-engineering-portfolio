// The only door for the Claude worker (a Claude Code routine or session on your subscription).
// POST {action: "status" | "claim" | "submit" | "release"} with Authorization: Bearer <worker token>.
// The app never calls Claude. The worker claims compact tasks, researches with its own tools, and submits
// JSON that is validated here before anything is written.
import { errMsg, HttpError, json, readJson, serve } from "../_shared/cors.ts";
import { adminClient, audit, nowISO, platformClient } from "../_shared/supabase.ts";
import { setWorkspace } from "../_shared/workspace.ts";
import { rosterSettings } from "../_shared/roster.ts";
import { setupDone } from "../_shared/profile_store.ts";
import { accountTask, applyAccountResult, cleanBrief, finishRow, prepTask, type QueueRow } from "../_shared/research.ts";
import { applyPostCallResult, postCallTask } from "../_shared/postcall.ts";
import { applyRescheduleResult, failDraft, rescheduleTask } from "../_shared/reschedule.ts";

const KINDS = ["prep_brief", "add_request", "account", "post_call_email", "reschedule_email"];

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** The token says which workspace this worker serves; every query after this runs in that workspace. */
async function requireWorker(req: Request): Promise<void> {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token) throw new HttpError(401, "Worker token required");
  const hash = await sha256Hex(token);
  const { data } = await platformClient().from("workspaces").select("id,worker_token_sha256").eq("worker_token_sha256", hash).maybeSingle();
  if (!data || !sameText(hash, String(data.worker_token_sha256 ?? ""))) throw new HttpError(401, "Invalid worker token");
  setWorkspace(data.id);
}

async function heartbeat(patch: Record<string, unknown>) {
  const db = adminClient();
  const { data } = await db.from("app_settings").select("value").eq("key", "claude_worker").maybeSingle();
  const cur = (data?.value ?? {}) as Record<string, unknown>;
  const totals = (cur.totals ?? {}) as Record<string, number>;
  for (const k of ["claimed", "accounts_done", "leads_written", "briefs_done", "drafts_done", "rejected_submits"]) {
    if (typeof patch[k] === "number") totals[k] = (totals[k] ?? 0) + (patch[k] as number);
  }
  const next = { ...cur, ...Object.fromEntries(Object.entries(patch).filter(([k]) => !(k in totals))), totals, last_seen: nowISO() };
  await db.from("app_settings").upsert({ key: "claude_worker", value: next, updated_at: nowISO() });
}

const FEATURE: Record<string, string> = { account: "research", add_request: "add_company", prep_brief: "prep_brief", post_call_email: "post_call_email", reschedule_email: "reschedule_email" };

/** Books the tokens and searches a worker reports for a task (the API worker sends them; Claude Code doesn't). */
// deno-lint-ignore no-explicit-any
async function recordUsage(kind: string, u: any) {
  if (!u || typeof u !== "object") return;
  const n = (v: unknown) => Math.max(0, Math.round(Number(v) || 0));
  if (!n(u.input_tokens) && !n(u.output_tokens)) return;
  const { error } = await adminClient().rpc("claude_usage_add", {
    p_feature: FEATURE[kind] ?? "research", p_in: n(u.input_tokens), p_out: n(u.output_tokens), p_ws: n(u.web_searches),
  });
  if (error) console.error("claude_usage_add", error.message);
}

/** This month's estimated AI spend against the budget in app_settings 'ai_budget' (null limit = no cap). */
async function budget(): Promise<{ spent_usd: number; limit_usd: number | null; over: boolean; warn: boolean }> {
  const { data, error } = await adminClient().rpc("ai_spend_this_month");
  if (error) throw new HttpError(500, `Could not read the AI budget: ${error.message}`);
  const r = (Array.isArray(data) ? data[0] : data) ?? {};
  const spent = Number(r.spent_usd) || 0;
  const limit = r.limit_usd == null ? null : Number(r.limit_usd);
  return { spent_usd: spent, limit_usd: limit, over: limit != null && spent >= limit, warn: limit != null && spent >= limit * (Number(r.warn_at) || 0.8) };
}

async function queueCounts() {
  const db = adminClient();
  const out: Record<string, number> = {};
  await Promise.all(["gating", "held", "pending", "running"].map(async (st) => {
    const { count } = await db.from("research_queue").select("id", { count: "exact", head: true }).eq("status", st);
    out[st] = count ?? 0;
  }));
  return out;
}

serve(async (req) => {
  if (req.method !== "POST") throw new HttpError(405, "Use POST");
  await requireWorker(req);
  // deno-lint-ignore no-explicit-any
  const body = await readJson<Record<string, any>>(req);
  const action = String(body.action ?? "status");
  const worker = String(body.worker ?? "claude").slice(0, 80);
  const db = adminClient();
  const s = await rosterSettings();

  if (action === "status") {
    await heartbeat({ worker });
    return json({ ok: true, queue: await queueCounts(), max_accounts_per_run: s.max_accounts_per_run, budget: await budget() });
  }

  if (action === "claim") {
    // Research and emails need the seller's profile; leave the queue alone until Admin > Setup is finished.
    if (!(await setupDone())) {
      await heartbeat({ worker, last_claim_at: nowISO(), claimed: 0 });
      return json({ ok: true, tasks: [], waiting_for: "setup", queue: await queueCounts() });
    }
    // Hard stop: nothing new is handed out once this month's AI spend reaches the budget.
    const b = await budget();
    if (b.over) {
      await heartbeat({ worker, last_claim_at: nowISO(), claimed: 0 });
      return json({ ok: true, tasks: [], waiting_for: "budget", budget: b, queue: await queueCounts() });
    }
    const n = Math.max(1, Math.min(Number(body.n) || 5, s.max_accounts_per_run));
    const kinds = Array.isArray(body.kinds) ? body.kinds.filter((k: string) => KINDS.includes(k)) : null;
    const { data: rows, error } = await db.rpc("claim_claude_work", { p_n: n, p_worker: worker, p_kinds: kinds?.length ? kinds : null });
    if (error) throw new HttpError(500, `Could not claim work: ${error.message}`);
    const tasks: unknown[] = [];
    for (const r of (rows ?? []) as QueueRow[]) {
      try {
        if (r.kind === "prep_brief") {
          const t = await prepTask(r);
          if (!t) {
            await finishRow(r, "skipped", { error: "meeting no longer exists" });
            continue;
          }
          tasks.push(t);
        } else if (r.kind === "post_call_email") {
          const t = await postCallTask(r);
          if (!t) {
            await finishRow(r, "skipped", { error: "the note, draft or contact no longer exists" });
            continue;
          }
          tasks.push(t);
        } else if (r.kind === "reschedule_email") {
          const t = await rescheduleTask(r);
          if (!t) {
            await finishRow(r, "skipped", { error: "the meeting or draft no longer exists" });
            continue;
          }
          tasks.push(t);
        } else tasks.push(await accountTask(r));
      } catch (e) {
        await db.from("research_queue").update({ status: "pending", lease_until: null, error: errMsg(e).slice(0, 300) }).eq("id", r.id);
      }
    }
    await heartbeat({ worker, last_claim_at: nowISO(), claimed: tasks.length });
    return json({ ok: true, tasks, queue: await queueCounts() });
  }

  const id = String(body.id ?? "");
  if (!id) throw new HttpError(400, "id is required");
  const { data: row } = await db.from("research_queue").select("id,kind,payload,batch,rep_id,status,submits,attempts,worker,lease_until").eq("id", id).maybeSingle();
  if (!row) throw new HttpError(404, "Task not found");
  if (row.status !== "running") throw new HttpError(409, `Task is ${row.status}, not running. Claim again.`);
  if (row.worker && row.worker !== worker) throw new HttpError(409, "Another worker holds this task now. Claim again.");

  await recordUsage(row.kind, body.usage);

  if (action === "release") {
    const giveUp = body.give_up === true;
    const reason = String(body.reason ?? "released by worker").slice(0, 300);
    if (giveUp) {
      await finishRow(row as QueueRow, "failed", { error: reason });
      if (row.kind === "reschedule_email") await failDraft(String(row.payload?.draft_id ?? ""), reason);
    }
    else await db.from("research_queue").update({ status: "pending", lease_until: null, worker: null, error: reason }).eq("id", id);
    return json({ ok: true, status: giveUp ? "failed" : "pending" });
  }

  if (action !== "submit") throw new HttpError(400, "Unknown action");
  const lease = Math.max(Date.parse(row.lease_until ?? "") || 0, Date.now() + 20 * 60e3);
  await db.from("research_queue").update({ submits: (row.submits ?? 0) + 1, lease_until: new Date(lease).toISOString() }).eq("id", id);
  const lastSubmit = (row.submits ?? 0) >= 2;
  const giveUp = async (problems: Record<string, string[]>) => {
    const summary = Object.entries(problems).map(([k, v]) => `${k}: ${v.join("; ")}`).join(" | ").slice(0, 400);
    await finishRow(row as QueueRow, "failed", { error: `rejected after 3 submits: ${summary}` });
    await heartbeat({ worker, rejected_submits: 1 });
    return json({ ok: false, retry: false, error: "Rejected after 3 submits; the task is closed.", problems }, 422);
  };

  if (row.kind === "prep_brief") {
    const brief = cleanBrief(body.result?.brief ?? body.result);
    if (brief.length < 200) {
      if (lastSubmit) return await giveUp({ brief: ["brief is missing or too short"] });
      await heartbeat({ worker, rejected_submits: 1 });
      return json({ ok: false, retry: true, problems: { brief: ["brief is missing or too short"] } }, 422);
    }
    const meetingId = String(row.payload?.meeting_id ?? "");
    const at = nowISO();
    const { error } = await db.from("meetings").update({ prep: brief.slice(0, 12000), prep_at: at, prep_status: "ready" }).eq("id", meetingId);
    if (error) throw new HttpError(500, "Brief received but could not be saved");
    await finishRow(row as QueueRow, "done", { note: "brief saved" });
    await heartbeat({ worker, briefs_done: 1, last_submit_at: at });
    return json({ ok: true, status: "done" });
  }

  if (row.kind === "post_call_email") {
    const pc = await applyPostCallResult({ ...(row as QueueRow), submits: row.submits ?? 0 }, body.result);
    if (pc.status === "retry") {
      await heartbeat({ worker, rejected_submits: 1 });
      return json({ ok: false, retry: true, submits_left: Math.max(0, 2 - (row.submits ?? 0)), problems: pc.problems }, 422);
    }
    if (pc.status === "failed") {
      await finishRow(row as QueueRow, "failed", { error: pc.error ?? "draft rejected" });
      await heartbeat({ worker, rejected_submits: 1 });
      return json({ ok: false, retry: false, error: pc.error ?? "Draft rejected; the task is closed." }, 422);
    }
    await finishRow(row as QueueRow, "done", { note: "draft saved" });
    await heartbeat({ worker, drafts_done: 1, last_submit_at: nowISO() });
    return json({ ok: true, status: "done" });
  }

  if (row.kind === "reschedule_email") {
    const rs = await applyRescheduleResult({ ...(row as QueueRow), submits: row.submits ?? 0 }, body.result);
    if (rs.status === "retry") {
      await heartbeat({ worker, rejected_submits: 1 });
      return json({ ok: false, retry: true, submits_left: Math.max(0, 2 - (row.submits ?? 0)), problems: rs.problems }, 422);
    }
    if (rs.status === "failed") {
      await failDraft(String(row.payload?.draft_id ?? ""), rs.error ?? "reply rejected");
      await finishRow(row as QueueRow, "failed", { error: rs.error ?? "reply rejected" });
      await heartbeat({ worker, rejected_submits: 1 });
      return json({ ok: false, retry: false, error: rs.error ?? "Reply rejected; the task is closed." }, 422);
    }
    await finishRow(row as QueueRow, "done", { note: "reschedule reply saved" });
    await heartbeat({ worker, drafts_done: 1, last_submit_at: nowISO() });
    return json({ ok: true, status: "done" });
  }

  const out = await applyAccountResult({ ...(row as QueueRow), submits: row.submits ?? 0 }, body.result);
  if (out.status === "retry") {
    if (lastSubmit) return await giveUp(out.problems ?? {});
    await heartbeat({ worker, rejected_submits: 1 });
    return json({ ok: false, retry: true, submits_left: Math.max(0, 2 - (row.submits ?? 0)), problems: out.problems }, 422);
  }
  await finishRow(row as QueueRow, "done", { leads: out.leads, excluded: out.excluded, note: out.note });
  await heartbeat({ worker, accounts_done: 1, leads_written: out.leads?.length ?? 0, last_submit_at: nowISO() });
  if (out.leads?.length && row.kind === "add_request") {
    await audit(null, "claude_worker.add_company", String(row.payload?.company ?? ""), `${out.leads.length} leads`);
  }
  return json({ ok: true, status: "done", leads: out.leads?.length ?? 0, excluded: out.excluded ?? [], note: out.note ?? null });
});
