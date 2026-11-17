// Run: deno test roster/supabase/functions/_shared/documents_test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import { strToU8, zipSync } from "npm:fflate@0.8.2";
import { decodeEntities, docxText, documentExcerpts, htmlToText, kindOf, pptxText, publicUrl, tidy } from "./documents.ts";

Deno.test("kindOf reads MIME types and falls back to the extension", () => {
  assertEquals(kindOf("application/pdf", "x"), "pdf");
  assertEquals(kindOf("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "x"), "docx");
  assertEquals(kindOf("", "Deck.PPTX"), "pptx");
  assertEquals(kindOf("application/octet-stream", "notes.md"), "text");
  assertEquals(kindOf("", "call.wav"), "audio");
  assertEquals(kindOf("video/quicktime", "demo.mov"), "video");
  assertEquals(kindOf("", "logo.gif"), null);
});

Deno.test("docx: paragraphs become lines and entities decode", () => {
  const xml = `<w:document><w:body><w:p><w:r><w:t>Acme &amp; Co</w:t></w:r></w:p><w:p><w:r><w:t>Second</w:t><w:tab/><w:t>line</w:t></w:r></w:p></w:body></w:document>`;
  const bytes = zipSync({ "word/document.xml": strToU8(xml), "word/styles.xml": strToU8("<x/>") });
  assertEquals(tidy(docxText(bytes)), "Acme & Co\nSecond line");
});

Deno.test("pptx: slides in number order, with speaker notes", () => {
  const slide = (t: string) => strToU8(`<p:sld><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:sld>`);
  const bytes = zipSync({
    "ppt/slides/slide10.xml": slide("Ten"),
    "ppt/slides/slide2.xml": slide("Two"),
    "ppt/notesSlides/notesSlide2.xml": slide("Say the pipeline number"),
  });
  const t = tidy(pptxText(bytes));
  assert(t.indexOf("Two") < t.indexOf("Ten"), t);
  assert(t.includes("Slide 1:\nTwo\nSpeaker notes: Say the pipeline number"), t);
});

Deno.test("htmlToText drops scripts and navigation, keeps title and description", () => {
  const h = `<html><head><title>Acme | Ledger</title><meta name="description" content="Books in minutes"></head>
    <body><nav>Home About</nav><script>var x=1</script><h1>Close faster</h1><p>Teams&nbsp;close in 2 days.</p><footer>© Acme</footer></body></html>`;
  const r = htmlToText(h);
  assertEquals(r.title, "Acme | Ledger");
  assert(r.text.startsWith("Books in minutes"), r.text);
  assert(r.text.includes("Close faster\nTeams close in 2 days."), r.text);
  assert(!/Home About|var x|© Acme/.test(r.text), r.text);
});

Deno.test("decodeEntities", () => {
  assertEquals(decodeEntities("&#8217;s &#x2014; &lt;b&gt; &bogus;"), "’s — <b> &bogus;");
});

Deno.test("publicUrl refuses private and odd hosts", () => {
  assert(publicUrl("https://acme.example/case-study"));
  for (const bad of ["ftp://acme.example", "http://localhost:3000", "http://127.0.0.1", "http://10.0.0.4/x", "http://192.168.1.2",
    "http://169.254.169.254/latest", "http://[::1]/", "https://user:pw@acme.example", "https://acme.example:8443/", "http://intranet"]) {
    assertEquals(publicUrl(bad), null, bad);
  }
});

Deno.test("excerpts share the budget and pass unused room on", () => {
  const row = (name: string, n: number) => ({ name, kind: "file" as const, url: null, status: "ready", extracted_text: "word ".repeat(n).trim() });
  const ex = documentExcerpts([row("long", 4000), row("short", 10), { ...row("skip", 5), status: "stored" }], 1000);
  assertEquals(ex.map((e) => e.name), ["long", "short"]);
  assertEquals(ex[1].text.length, 49);
  assert(!ex[1].truncated && ex[0].truncated);
  assert(ex[0].text.length <= 1000 - 49 && ex[0].text.length > 900, String(ex[0].text.length));
});
