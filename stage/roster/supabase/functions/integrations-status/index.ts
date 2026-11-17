// GET: secret presence (booleans only; env or connected in Admin > Integrations), last HubSpot sync, cron jobs.
// POST {job, enabled}: toggle a cron job.  POST {run: 'weekly-roster'|'hubspot-sync'|'queue-gate'}: run a job now.
import { HttpError, json, readJson, serve } from "../_shared/cors.ts";
import { adminClient, audit, getCaller, invokeInternal, requirePerm } from "../_shared/supabase.ts";
import { secretSource } from "../_shared/secrets.ts";
import { hubspotConfigured } from "../_shared/hubspot.ts";

const SECRETS = [
  "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ANON_KEY", "CRON_SECRET", "CLAUDE_WORKER_TOKEN",
];
const RUNNABLE = new Set(["weekly-roster", "hubspot-sync", "queue-gate"]);

serve(async (req) => {
  const caller = await getCaller(req);

  if (req.method === "GET") {
    const secrets: Record<string, boolean> = {};
    for (const s of SECRETS) secrets[s] = !!Deno.env.get(s);
    // Keys and tokens connected in the app (Vault) count as configured too.
    const [hub, apollo, fe, exa] = await Promise.all([
      hubspotConfigured().catch(() => false),
      secretSource("int_apollo_key").catch(() => null),
      secretSource("int_fullenrich_key").catch(() => null),
      secretSource("int_exa_key").catch(() => null),
    ]);
    const configured = { hubspot: hub, apollo: !!apollo, fullenrich: !!fe, exa: !!exa };
    // Data keys only count when connected in the app; env vars are never used for them.
    secrets.HUBSPOT_TOKEN = hub;
    secrets.APOLLO_API_KEY = !!apollo;
    secrets.FULLENRICH_API_KEY = !!fe;
    const db = adminClient();
    const { data: sync } = await db.from("app_settings").select("value,updated_at").eq("key", "hubspot_sync").maybeSingle();
    const queue: Record<string, number> = {};
    await Promise.all(["gating", "held", "pending", "running", "done", "failed"].map(async (st) => {
      const { count } = await db.from("research_queue").select("id", { count: "exact", head: true }).eq("status", st);
      queue[st] = count ?? 0;
    }));
    let cron_jobs: unknown = null;
    let cron_error: string | null = null;
    const platformAdmin = (await caller.client.rpc("is_platform_admin")).data === true;
    if (!platformAdmin) {
      cron_error = "Scheduled jobs are shared by every workspace, so only platform admins manage them";
    } else if (caller.can("manage_integrations")) {
      const { data, error } = await caller.client.rpc("list_cron_jobs");
      if (error) cron_error = error.message;
      else cron_jobs = data;
    } else {
      cron_error = "Your role cannot view scheduled jobs";
    }
    return json({
      ok: true,
      secrets,
      configured,
      hubspot_sync: sync?.value ?? null,
      research_queue: queue,
      cron_jobs,
      cron_error,
    });
  }

  if (req.method !== "POST") throw new HttpError(405, "Use GET or POST");
  requirePerm(caller, "manage_integrations");
  const body = await readJson<{ job?: string; enabled?: boolean; run?: string; rep_id?: string }>(req);

  if (body.run) {
    if (!RUNNABLE.has(body.run)) throw new HttpError(400, "Unknown job");
    const rep: { rep_id?: string } = body.run === "weekly-roster" && body.rep_id ? { rep_id: String(body.rep_id) } : {};
    await audit(caller.id, "integrations.run", body.run, rep.rep_id ? `manual run for ${rep.rep_id}` : "manual run");
    const result = await invokeInternal(body.run, { source: "manual", ...rep }, 8000);
    return json({ ok: true, run: body.run, result });
  }

  if (body.job && typeof body.enabled === "boolean") {
    const { data, error } = await caller.client.rpc("set_cron_job_active", { jobname: body.job, active: body.enabled });
    if (error) throw new HttpError(400, error.message);
    await audit(caller.id, "integrations.cron_toggle", body.job, body.enabled ? "enabled" : "disabled");
    return json({ ok: true, job: body.job, enabled: body.enabled, result: data ?? null });
  }

  throw new HttpError(400, "Send {job, enabled} or {run}");
});
