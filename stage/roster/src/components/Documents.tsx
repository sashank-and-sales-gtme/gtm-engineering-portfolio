import { useEffect, useRef, useState } from "react";
import type { Ctx } from "../lib/ctx";
import { can } from "../lib/perms";
import { audit } from "../lib/actions";
import { invokeFn, supabase } from "../lib/supabase";

/* The workspace's document library (Admin > Setup > Context). Files go straight to the private 'workspace-docs'
   bucket under the workspace's folder; the 'documents' function reads each one and keeps its text, which
   researchers and writers get as insider context with every task. Links (the website, case studies) are read the
   same way. Images, audio and video are kept but can't be read yet. */

export type Doc = {
  id: string;
  kind: "file" | "link";
  name: string;
  path: string | null;
  url: string | null;
  mime: string | null;
  size_bytes: number | null;
  status: "pending" | "ready" | "stored" | "failed";
  chars: number;
  error: string | null;
  created_at: string;
};

const COLS = "id,kind,name,path,url,mime,size_bytes,status,chars,error,created_at";
const BUCKET = "workspace-docs";
const MAX_BYTES = 50 * 1024 * 1024;
export const DOC_TYPES = ["pdf", "docx", "pptx", "csv", "md", "txt", "png", "jpg", "jpeg", "mov", "mp4", "wav", "mp3"];
const ACCEPT = DOC_TYPES.map((x) => "." + x).join(",");
const MIME: Record<string, string> = {
  pdf: "application/pdf", csv: "text/csv", md: "text/markdown", txt: "text/plain",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", mov: "video/quicktime", mp4: "video/mp4", wav: "audio/wav", mp3: "audio/mpeg",
};
const extOf = (n: string) => (n.toLowerCase().split(".").pop() || "");

type State = { rows: Doc[] | null; err: string };
const st = (X: Ctx): State => X.S.forms["docs"] || (X.S.forms["docs"] = { rows: null, err: "" });

export async function loadDocs(X: Ctx) {
  const s = st(X);
  const { data, error } = await supabase.from("workspace_documents").select(COLS).order("created_at", { ascending: false });
  s.rows = error ? s.rows || [] : ((data || []) as Doc[]);
  s.err = error ? "Could not load the library." : "";
  X.rerender();
}

/** Adds links (website, case studies) the library doesn't have yet and reads them. Quiet: failures show in the list. */
export async function addLinks(X: Ctx, links: Array<{ url: string; name?: string }>) {
  const want = links.filter((l) => /^https?:\/\/\S+$/.test(l.url.trim()));
  if (!want.length) return;
  try {
    await invokeFn("documents", { action: "add_links", links: want });
  } catch (_) {
    /* the list shows what was added */
  }
  await loadDocs(X);
}

const kb = (n: number | null) => (n == null ? "" : n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

function statusOf(d: Doc): [string, string] {
  if (d.status === "ready") return ["ok", `Read · ${d.chars.toLocaleString("en-IN")} characters`];
  if (d.status === "stored") return ["hold", "Stored · can't be read yet"];
  if (d.status === "failed") return ["crit", d.error || "Couldn't be read"];
  return ["", "Reading…"];
}

export default function Documents({ X }: { X: Ctx }) {
  const edit = can(X, "manage_integrations");
  const s = st(X);
  const [busy, setBusy] = useState<string[]>([]);
  const [links, setLinks] = useState("");
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!s.rows) loadDocs(X);
  }, []);

  const ws = (X.me && X.me.workspace_id) || "";
  const upload = async (files: FileList | File[]) => {
    const list = [...files];
    if (!list.length) return;
    if (!ws) return X.toast("Your workspace isn't loaded yet. Try again in a moment.");
    for (const f of list) {
      const ext = extOf(f.name);
      if (!DOC_TYPES.includes(ext)) {
        X.toast(`${f.name}: use ${DOC_TYPES.slice(0, -1).join(", ")} or ${DOC_TYPES[DOC_TYPES.length - 1]}.`);
        continue;
      }
      if (f.size > MAX_BYTES) {
        X.toast(`${f.name} is over 50 MB.`);
        continue;
      }
      setBusy((b) => [...b, f.name]);
      try {
        const safe = f.name.replace(/[^\w.-]+/g, "_").slice(-120);
        const path = `${ws}/${crypto.randomUUID()}-${safe}`;
        const mime = f.type || MIME[ext] || "application/octet-stream";
        const up = await supabase.storage.from(BUCKET).upload(path, f, { contentType: mime, upsert: false });
        if (up.error) throw up.error;
        const { data: row, error } = await supabase.from("workspace_documents")
          .insert({ kind: "file", name: f.name.slice(0, 300), path, mime, size_bytes: f.size, created_by: X.uid })
          .select(COLS).single();
        if (error || !row) {
          await supabase.storage.from(BUCKET).remove([path]);
          throw error || new Error("insert failed");
        }
        s.rows = [row as Doc, ...(s.rows || [])];
        X.rerender();
        try {
          const r = await invokeFn<{ document: Doc }>("documents", { action: "extract", id: row.id });
          s.rows = (s.rows || []).map((x) => (x.id === row.id ? r.document : x));
        } catch (e: any) {
          s.rows = (s.rows || []).map((x) => (x.id === row.id ? { ...x, status: "failed", error: (e && e.message) || "Couldn't be read" } : x));
        }
        await audit("document added", f.name, kb(f.size));
      } catch (e: any) {
        X.toast(`Could not upload ${f.name}. ${(e && e.message) || ""}`.trim());
      } finally {
        setBusy((b) => b.filter((x) => x !== f.name));
        X.rerender();
      }
    }
  };

  const remove = async (d: Doc) => {
    if (!window.confirm(`Remove ${d.name} from the library? Research stops using it.`)) return;
    const { error } = await supabase.from("workspace_documents").delete().eq("id", d.id);
    if (error) return X.toast("Could not remove it.");
    if (d.path) await supabase.storage.from(BUCKET).remove([d.path]);
    s.rows = (s.rows || []).filter((x) => x.id !== d.id);
    await audit("document removed", d.name, "");
    X.rerender();
  };

  const retry = async (d: Doc) => {
    setBusy((b) => [...b, d.id]);
    try {
      const r = await invokeFn<{ document: Doc }>("documents", { action: "extract", id: d.id });
      s.rows = (s.rows || []).map((x) => (x.id === d.id ? r.document : x));
    } catch (e: any) {
      X.toast((e && e.message) || "Could not read it.");
    } finally {
      setBusy((b) => b.filter((x) => x !== d.id));
      X.rerender();
    }
  };

  const addTyped = async () => {
    const urls = [...new Set(links.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean))];
    const bad = urls.filter((u) => !/^https?:\/\/\S+\.\S+/.test(u));
    if (bad.length) return X.toast(`${bad[0]}: links must start with https://`);
    if (!urls.length) return;
    setBusy((b) => [...b, "links"]);
    try {
      await invokeFn("documents", { action: "add_links", links: urls.map((url) => ({ url })) });
      setLinks("");
    } catch (e: any) {
      X.toast((e && e.message) || "Could not add the links.");
    } finally {
      setBusy((b) => b.filter((x) => x !== "links"));
      await loadDocs(X);
    }
  };

  const rows = s.rows || [];
  const ready = rows.filter((r) => r.status === "ready").length;
  return (
    <div className="docs">
      {edit ? (
        <div className="docs-add">
          <label
            className={"docs-drop" + (over ? " over" : "")}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(false);
              upload(e.dataTransfer.files);
            }}
          >
            <input ref={input} type="file" multiple accept={ACCEPT} className="sr-only" onChange={(e) => (upload(e.target.files || []), (e.target.value = ""))} />
            <strong>Drop files here, or choose files</strong>
            <span className="hint">PDF, Word, PowerPoint, CSV, Markdown or text are read in full. Images, audio and video are kept for later; they can't be read yet. Up to 50 MB each.</span>
          </label>
          <div className="docs-links">
            <label htmlFor="docs-links">Links to read (case studies, product pages, articles), one per line</label>
            <textarea id="docs-links" rows={3} value={links} placeholder="https://" onChange={(e) => setLinks(e.target.value)} />
            <div className="row">
              <button className="btn ghost small" disabled={!links.trim() || busy.includes("links")} onClick={addTyped}>
                {busy.includes("links") ? "Reading…" : "Add links"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {s.err ? <p className="note err">{s.err}</p> : null}
      {!s.rows ? (
        <p className="note">Loading the library…</p>
      ) : !rows.length && !busy.length ? (
        <p className="note docs-none">Nothing in the library yet. Your website is read once you save it on the Company step.</p>
      ) : (
        <>
          <p className="note">
            {rows.length} item{rows.length === 1 ? "" : "s"}, {ready} read. Researchers and writers get excerpts of everything that's been read.
          </p>
          <ul className="docs-list">
            {busy.filter((b) => b !== "links" && !rows.some((r) => r.id === b)).map((n) => (
              <li key={"up-" + n} className="docs-row">
                <span className="docs-name">{n}</span>
                <span className="pill">Uploading…</span>
              </li>
            ))}
            {rows.map((d) => {
              const [tone, label] = statusOf(d);
              return (
                <li key={d.id} className="docs-row">
                  <span className="docs-name">
                    {d.kind === "link" && d.url ? (
                      <a href={d.url} target="_blank" rel="noreferrer">{d.name}</a>
                    ) : (
                      d.name
                    )}
                    <span className="hint">{d.kind === "link" ? "Link" : [extOf(d.name).toUpperCase(), kb(d.size_bytes)].filter(Boolean).join(" · ")}</span>
                  </span>
                  <span className={"pill " + tone} title={d.status === "failed" ? d.error || "" : undefined}>{busy.includes(d.id) ? "Reading…" : label}</span>
                  {edit ? (
                    <span className="docs-acts">
                      {d.status === "failed" ? <button className="btn ghost small" disabled={busy.includes(d.id)} onClick={() => retry(d)}>Try again</button> : null}
                      <button className="btn ghost small" aria-label={`Remove ${d.name}`} onClick={() => remove(d)}>Remove</button>
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
