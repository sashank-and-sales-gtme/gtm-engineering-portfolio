// The workspace's document library. The browser uploads files straight to Storage ('workspace-docs/<workspace>/...')
// and inserts a 'pending' workspace_documents row; this function reads it.
//   POST {action: 'extract', id}         reads one file or link and stores its text (status ready, stored or failed)
//   POST {action: 'add_links', links}    adds links (website, case studies) the library doesn't have yet, then reads them
import { errMsg, HttpError, json, readJson, serve } from "../_shared/cors.ts";
import { adminClient, audit, getCaller, nowISO, platformClient, requirePerm } from "../_shared/supabase.ts";
import { fileText, kindOf, linkText, publicUrl } from "../_shared/documents.ts";

const BUCKET = "workspace-docs";
const MAX_LINKS = 12;

serve(async (req) => {
  if (req.method !== "POST") throw new HttpError(405, "Use POST");
  const caller = await getCaller(req);
  requirePerm(caller, "manage_integrations");
  const body = await readJson<{ action?: string; id?: string; links?: Array<{ url?: string; name?: string }> }>(req);

  if (body.action === "extract") {
    if (!body.id) throw new HttpError(400, "id is required");
    return json({ ok: true, document: await extract(caller.workspace_id, String(body.id)) });
  }

  if (body.action === "add_links") {
    const db = adminClient();
    const want = (Array.isArray(body.links) ? body.links : []).slice(0, MAX_LINKS)
      .map((l) => ({ u: publicUrl(String(l?.url ?? "")), name: String(l?.name ?? "").trim() }))
      .filter((l) => l.u);
    if (!want.length) return json({ ok: true, added: [] });
    const { data: have } = await db.from("workspace_documents").select("url").eq("kind", "link");
    const known = new Set((have ?? []).map((r) => String(r.url)));
    const added = [];
    for (const l of want) {
      const url = l.u!.toString();
      if (known.has(url)) continue;
      known.add(url);
      const { data: row, error } = await db.from("workspace_documents")
        .insert({ kind: "link", name: (l.name || url).slice(0, 300), url, created_by: caller.id })
        .select("id").single();
      if (error) throw new HttpError(500, "Could not add the link");
      added.push(await extract(caller.workspace_id, row.id));
    }
    if (added.length) await audit(caller.id, "documents.add_links", "", `${added.length} link${added.length > 1 ? "s" : ""}`);
    return json({ ok: true, added });
  }

  throw new HttpError(400, "Send {action: 'extract', id} or {action: 'add_links', links}");
});

async function extract(workspace: string, id: string) {
  const db = adminClient();
  const { data: doc, error } = await db.from("workspace_documents").select("*").eq("id", id).maybeSingle();
  if (error) throw new HttpError(500, "Could not load the document");
  if (!doc) throw new HttpError(404, "Document not found");

  let patch: Record<string, unknown>;
  try {
    if (doc.kind === "link") {
      const { title, text } = await linkText(doc.url);
      if (text.length < 40) throw new Error("The page had almost no readable text (it may need JavaScript to show its content)");
      patch = { status: "ready", extracted_text: text, chars: text.length, error: null, ...(doc.name === doc.url && title ? { name: title.slice(0, 300) } : {}) };
    } else {
      // The path's first folder is the workspace (Storage policies enforce it on upload); check it again here.
      if (String(doc.path).split("/")[0] !== workspace) throw new Error("The file is outside this workspace's folder");
      const kind = kindOf(doc.mime, doc.name);
      if (!kind) throw new Error("This kind of file isn't supported");
      if (kind === "image" || kind === "audio" || kind === "video") {
        patch = { status: "stored", extracted_text: null, chars: 0, error: null };
      } else {
        const { data: blob, error: de } = await platformClient().storage.from(BUCKET).download(doc.path);
        if (de || !blob) throw new Error("Could not read the uploaded file");
        const text = await fileText(new Uint8Array(await blob.arrayBuffer()), kind);
        if (!text || text.length < 10) throw new Error(kind === "pdf" ? "No text found; it may be a scanned PDF" : "No text found in the file");
        patch = { status: "ready", extracted_text: text, chars: text.length, error: null };
      }
    }
  } catch (e) {
    patch = { status: "failed", extracted_text: null, chars: 0, error: errMsg(e).slice(0, 300) };
  }
  const { data: out, error: ue } = await db.from("workspace_documents").update({ ...patch, updated_at: nowISO() }).eq("id", id)
    .select("id,kind,name,path,url,mime,size_bytes,status,chars,error,created_at").single();
  if (ue) throw new HttpError(500, "Could not save what was read");
  return out;
}
