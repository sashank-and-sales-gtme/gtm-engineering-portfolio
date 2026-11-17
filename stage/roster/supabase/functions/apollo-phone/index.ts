// POST ?lead&n&sig: Apollo's webhook for phone reveals (verify_jwt = false; trust comes from the signed URL that
// enrich-lead gave Apollo). A number becomes the contact's phone (source Apollo). No number means step 2 of the
// waterfall: a phone-only FullEnrich job. Idempotent: Apollo may retry, and a lead that already has a phone is left alone.
import { corsHeaders, errMsg } from "../_shared/cors.ts";
import { adminClient, audit, nowISO } from "../_shared/supabase.ts";
import { extractPhones, verifyPhoneWebhook } from "../_shared/phone.ts";
import { startPhoneFallback } from "../_shared/phone_fallback.ts";
import { inWorkspace } from "../_shared/workspace.ts";

const ok = (body: unknown = { ok: true }) => new Response(JSON.stringify(body), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const url = new URL(req.url);
  const leadId = url.searchParams.get("lead") ?? "";
  const nonce = url.searchParams.get("n") ?? "";
  const ws = await verifyPhoneWebhook(url.searchParams.get("w") ?? "", leadId, nonce, url.searchParams.get("sig") ?? "");
  if (!ws) return new Response("Forbidden", { status: 403, headers: corsHeaders });
  return inWorkspace(ws, () => handle(req, leadId, nonce));
});

async function handle(req: Request, leadId: string, nonce: string): Promise<Response> {
  // deno-lint-ignore no-explicit-any
  let payload: any = {};
  try {
    payload = await req.json();
  } catch { /* empty body counts as no number */ }

  try {
    const db = adminClient();
    const { data: l } = await db.from("leads").select("id,name,company,enrichment").eq("id", leadId).maybeSingle();
    if (!l) return ok({ ok: true, ignored: "unknown lead" });
    const cur = (l.enrichment ?? {}) as Record<string, string>;
    // Only the request this lead is waiting on counts; a late or replayed webhook is ignored.
    if (cur.phone || cur.phone_nonce !== nonce) return ok({ ok: true, ignored: "not waiting" });
    const best = extractPhones(payload)[0];
    if (best) {
      const next = { ...cur, phone: best.number, phone_source: "Apollo", phone_type: best.type, phone_stage: "done", at: nowISO() };
      delete (next as Record<string, string>).phone_nonce;
      await db.from("leads").update({ enrichment: next }).eq("id", leadId);
      await audit(null, "lead.enrich", l.company ?? "", `${l.name}: phone found (Apollo)`);
      return ok();
    }
    await startPhoneFallback(leadId, "Apollo found no phone number");
    await audit(null, "lead.enrich", l.company ?? "", `${l.name}: Apollo found no phone, FullEnrich started`);
    return ok();
  } catch (e) {
    console.error("apollo-phone:", errMsg(e));
    // A 500 makes Apollo retry, which is what we want for a transient failure.
    return new Response("Error", { status: 500, headers: corsHeaders });
  }
}
