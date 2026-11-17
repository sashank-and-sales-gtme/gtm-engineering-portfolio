// The workspace's document library (workspace_documents + the 'workspace-docs' Storage bucket): turning uploads and
// links into plain text, and the excerpts researchers and writers read as the seller's insider context.
// PDFs go through unpdf; DOCX and PPTX are zip files of XML, read with fflate. Images, audio and video are kept but
// not read yet (no OCR or speech-to-text), and are marked 'stored' so the library says so plainly.
import { unzipSync } from "npm:fflate@0.8.2";
import { extractText as pdfText, getDocumentProxy } from "npm:unpdf@0.12.1";
import { fetchWithTimeout } from "./cors.ts";
import { adminClient } from "./supabase.ts";

export type DocKind = "pdf" | "docx" | "pptx" | "text" | "image" | "audio" | "video";

/** Longest text kept per document; the brief takes excerpts from it. */
export const MAX_DOC_CHARS = 200_000;
/** Largest web page read for a link. */
const MAX_PAGE_BYTES = 3_000_000;

const EXT: Record<string, DocKind> = {
  pdf: "pdf", docx: "docx", pptx: "pptx", csv: "text", md: "text", markdown: "text", txt: "text",
  png: "image", jpg: "image", jpeg: "image", mov: "video", mp4: "video", wav: "audio", mp3: "audio",
};

/** What kind of file this is, from its MIME type or else its extension. Null when the library doesn't take it. */
export function kindOf(mime: string | null | undefined, name: string): DocKind | null {
  const m = String(mime ?? "").toLowerCase();
  if (m === "application/pdf") return "pdf";
  if (m.includes("wordprocessingml")) return "docx";
  if (m.includes("presentationml")) return "pptx";
  if (m.startsWith("text/")) return "text";
  if (m === "image/png" || m === "image/jpeg") return "image";
  if (m.startsWith("audio/")) return "audio";
  if (m.startsWith("video/")) return "video";
  const ext = String(name ?? "").toLowerCase().split(".").pop() ?? "";
  return EXT[ext] ?? null;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : all;
    }
    return ENTITIES[e.toLowerCase()] ?? all;
  });
}

/** Collapses runs of spaces and blank lines, and caps the length. */
export function tidy(s: string, max = MAX_DOC_CHARS): string {
  const t = s.replace(/\r\n?/g, "\n").replace(/[ \t\f\v ]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return t.length > max ? t.slice(0, max) : t;
}

/** Text of an Office XML part: paragraph and line breaks become newlines, tags go. */
function officeXmlText(xml: string): string {
  return decodeEntities(
    xml
      .replace(/<w:tab\/>|<a:tab\/>/g, "\t")
      .replace(/<w:br[^>]*\/>|<a:br[^>]*\/>/g, "\n")
      .replace(/<\/w:p>|<\/a:p>/g, "\n")
      .replace(/<[^>]+>/g, ""),
  );
}

const dec = new TextDecoder();
const byNumber = (re: RegExp) => (a: string, b: string) => Number(a.match(re)?.[1] ?? 0) - Number(b.match(re)?.[1] ?? 0);

export function docxText(bytes: Uint8Array): string {
  const files = unzipSync(bytes, { filter: (f) => /^word\/(document|footnotes|header\d*|footer\d*)\.xml$/.test(f.name) });
  const body = files["word/document.xml"];
  if (!body) throw new Error("This doesn't look like a Word document");
  const rest = Object.keys(files).filter((k) => k !== "word/document.xml").sort();
  return [body, ...rest.map((k) => files[k])].map((f) => officeXmlText(dec.decode(f))).join("\n");
}

export function pptxText(bytes: Uint8Array): string {
  const files = unzipSync(bytes, { filter: (f) => /^ppt\/(slides\/slide|notesSlides\/notesSlide)\d+\.xml$/.test(f.name) });
  const slides = Object.keys(files).filter((k) => k.startsWith("ppt/slides/")).sort(byNumber(/slide(\d+)\.xml$/));
  if (!slides.length) throw new Error("This doesn't look like a PowerPoint deck");
  return slides.map((k, i) => {
    const n = k.match(/slide(\d+)\.xml$/)?.[1];
    const notes = files[`ppt/notesSlides/notesSlide${n}.xml`];
    const text = officeXmlText(dec.decode(files[k])).trim();
    const note = notes ? officeXmlText(dec.decode(notes)).replace(/^\s*\d+\s*$/m, "").trim() : "";
    return `Slide ${i + 1}:\n${text}${note ? `\nSpeaker notes: ${note}` : ""}`;
  }).join("\n\n");
}

export async function pdfToText(bytes: Uint8Array): Promise<string> {
  const pdf = await getDocumentProxy(bytes);
  const { text } = await pdfText(pdf, { mergePages: true });
  return Array.isArray(text) ? text.join("\n\n") : String(text ?? "");
}

/** The readable text of a web page: title, then the body without scripts, styles, navigation and footers. */
export function htmlToText(html: string): { title: string; text: string } {
  const title = decodeEntities((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/\s+/g, " ").trim());
  const desc = decodeEntities(html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i)?.[1] ?? "").trim();
  const body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|nav|footer|template|iframe)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|header|main|blockquote)>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<[^>]+>/g, " ");
  return { title, text: tidy([desc, decodeEntities(body)].filter(Boolean).join("\n\n")) };
}

/** Extracts text from an uploaded file. Null for kinds that can't be read yet (images, audio, video). */
export async function fileText(bytes: Uint8Array, kind: DocKind): Promise<string | null> {
  switch (kind) {
    case "pdf":
      return tidy(await pdfToText(bytes));
    case "docx":
      return tidy(docxText(bytes));
    case "pptx":
      return tidy(pptxText(bytes));
    case "text":
      return tidy(dec.decode(bytes));
    default:
      return null;
  }
}

/** Plain http(s) URLs to public hosts only: no credentials, no localhost, no private or link-local addresses. */
export function publicUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(String(raw ?? "").trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password) return null;
  if (u.port && u.port !== "80" && u.port !== "443") return null;
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!h.includes(".") || h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local")) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    const [a, b] = h.split(".").map(Number);
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224) return null;
  }
  if (h.includes(":")) return null; // IPv6 literals: none of the sources people paste need one.
  return u;
}

/** Fetches a link and returns its readable text (HTML pages, PDFs and plain text). */
export async function linkText(raw: string): Promise<{ title: string; text: string }> {
  const u = publicUrl(raw);
  if (!u) throw new Error("Only public http(s) links can be read");
  const r = await fetchWithTimeout(u.toString(), {
    redirect: "follow",
    headers: { "User-Agent": "StageProspect/1.0 (+document library)", Accept: "text/html,application/pdf,text/plain;q=0.9,*/*;q=0.5" },
  }, 20_000);
  if (!r.ok) throw new Error(`The page answered ${r.status}`);
  if (!publicUrl(r.url || u.toString())) throw new Error("The link redirected somewhere that can't be read");
  const len = Number(r.headers.get("content-length") ?? 0);
  if (len > MAX_PAGE_BYTES * 4) throw new Error("The page is too large to read");
  const buf = new Uint8Array(await r.arrayBuffer());
  const type = (r.headers.get("content-type") ?? "").toLowerCase();
  if (type.includes("application/pdf")) return { title: u.pathname.split("/").pop() || u.hostname, text: tidy(await pdfToText(buf)) };
  const body = dec.decode(buf.slice(0, MAX_PAGE_BYTES));
  if (type.startsWith("text/plain") || type.startsWith("text/markdown")) return { title: u.hostname + u.pathname, text: tidy(body) };
  return htmlToText(body);
}

export interface DocRow {
  name: string;
  kind: "file" | "link";
  url: string | null;
  status: string;
  extracted_text: string | null;
}

/** Share of the brief each ready document gets: equal shares of `budget`, with short documents' unused room passed
    on to the longer ones. */
export function documentExcerpts(rows: DocRow[], budget = 20_000): Array<{ name: string; source: string; text: string; truncated: boolean }> {
  const ready = rows.filter((r) => r.status === "ready" && r.extracted_text);
  const cut = new Array<string>(ready.length);
  let left = budget;
  const order = ready.map((_, i) => i).sort((a, b) => ready[a].extracted_text!.length - ready[b].extracted_text!.length);
  order.forEach((idx, n) => {
    const share = Math.floor(left / (order.length - n));
    const t = ready[idx].extracted_text!;
    const text = t.length > share ? t.slice(0, Math.max(0, share - 1)).replace(/\s+\S*$/, "") + "…" : t;
    left -= Math.min(text.length, left);
    cut[idx] = text;
  });
  // The library's own order (newest first).
  return ready.map((r, i) => ({
    name: r.name,
    source: r.kind === "link" ? r.url ?? "" : "uploaded file",
    text: cut[i],
    truncated: cut[i].length < r.extracted_text!.length,
  }));
}

/** The workspace's insider context for a task: excerpts of every ready document, newest first. */
export async function loadDocuments(budget = 20_000) {
  const { data } = await adminClient().from("workspace_documents").select("name,kind,url,status,extracted_text")
    .eq("status", "ready").order("created_at", { ascending: false }).limit(40);
  return documentExcerpts((data ?? []) as DocRow[], budget);
}
