// Run: deno test roster/supabase/functions/_shared/postcall_lib_test.ts
function assert(c: unknown, msg = "assertion failed"): asserts c {
  if (!c) throw new Error(msg);
}
function assertEquals(a: unknown, b: unknown) {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error(`${x} !== ${y}`);
}
import { assemble, BANNED, nextStep, prune, situationOf, words } from "./postcall_lib.ts";
import { OVERVIEW } from "./postcall_lib.ts";
import { normalizeDraft } from "./postcall_lib.ts";
import { SAMPLE_PROFILE } from "./sample_profile.ts";

const now = Date.parse("2026-10-15T06:00:00Z");
const note = { at: "2026-10-15T05:30:00Z" };
const iso = (h: number) => new Date(now + h * 3600_000).toISOString();

Deno.test("words ignores link urls and markdown", () => {
  assertEquals(words("See [the Northwind story](https://x.com/a-b-c) **now** - ok"), 6);
});
Deno.test("situation: post demo beats an upcoming meeting", () => {
  const m = [{ status: "done", when: iso(-3) }, { status: "scheduled", when: iso(48) }];
  assertEquals(situationOf(note, m, [], [], now), "post_demo");
});
Deno.test("situation: booked, callback, declined, connected", () => {
  assertEquals(situationOf(note, [{ status: "scheduled", when: iso(24) }], [], [], now), "meeting_booked");
  assertEquals(situationOf(note, [], [{ status: "open", when: iso(5) }], [], now), "callback");
  assertEquals(situationOf(note, [], [], [{ at: iso(-0.4), outcome: "no" }], now), "declined");
  assertEquals(situationOf(note, [], [], [{ at: iso(-30), outcome: "no" }], now), "connected");
});
Deno.test("next step formats IST", () => {
  const n = nextStep([{ status: "scheduled", when: "2026-10-16T09:30:00Z", mode: "online" }], [], now)!;
  assertEquals(n.type, "meeting");
  assert(String(n.when).includes("3:00") && String(n.when).endsWith("IST"), String(n.when));
});
Deno.test("prune drops empties", () => {
  assertEquals(prune({ a: "", b: [], c: { d: null }, e: "x", f: [{ g: "" }, "y"] }), { e: "x", f: ["y"] });
});
Deno.test("assemble brief adds locked parts and counts only the written parts", () => {
  const r = assemble({ format: "brief", greeting: "Hi Ana,", opening: "One two three.", company: "Four five.", ask: "Book here.", signoff: "Best,\nS" }, "Globex", SAMPLE_PROFILE);
  assert(r.body.includes(SAMPLE_PROFILE.product_overview) && r.body.includes("**How Acme Ledger can help Globex:**") && r.body.includes("Northwind - [Here](https://northwind.example)"));
  assertEquals(words(r.counted), 5);
  assertEquals(r.cap, 75);
});
Deno.test("assemble note", () => {
  const r = assemble({ format: "note", greeting: "Hi Ana,", core: "Short core.", ask: "Tue 3 PM works.", signoff: "Warmly,\nS" }, "Acme");
  assertEquals(r.counted, "Short core.");
  assertEquals(r.cap, 50);
  assert(!r.body.includes("Product Overview"));
});
Deno.test("banned terms", () => {
  assert(BANNED.test("our chatbot helps"));
  assert(!BANNED.test("bottom of the funnel"));
});

import { checkDraft, timeMentions, timelineConflicts } from "./postcall_lib.ts";

Deno.test("checkDraft rejects missing parts and flags style misses", () => {
  const bad = checkDraft({ format: "note", subject: "the pricing page" }, "Acme");
  assert(bad.problems.some((p) => p.startsWith("core is required for a note")));
  const ok = checkDraft({
    format: "note", subject: "the pricing page", greeting: "Hi Priya,", core: "You said the pricing page loses visitors.",
    ask: "Does Tuesday at 4 PM IST still work?", signoff: "Thanks,\nSashank", flags: [],
  }, "Acme");
  assertEquals(ok.problems, []);
  assertEquals(ok.style, []);
  const styled = checkDraft({
    format: "note", subject: "The Pricing Page Follow Up Today", greeting: "Hi,", core: "Our chatbot helps — a lot.",
    ask: "Book here.", signoff: "Sashank",
  }, "Acme");
  assertEquals(styled.style.length, 3);
});

// Thu 15 Oct 2026, 11:00 IST. A callback is booked for the same day at 5:30 pm IST.
const refTs = Date.parse("2026-10-15T05:30:00Z");
const booked = nextStep([], [{ status: "open", when: "2026-10-15T12:00:00Z" }], refTs)!;

Deno.test("timeline: note wording that disagrees with the booking is found", () => {
  assertEquals(timelineConflicts("Prospect wanted me to call next week.", refTs, booked).length, 1);
  assertEquals(timelineConflicts("Call tomorrow at 5:30 pm", refTs, booked).length, 1);
  assertEquals(timelineConflicts("Let's speak on Friday", refTs, booked).length, 1);
  assertEquals(timelineConflicts("call on 22nd October at 11am", refTs, booked).length, 2);
});
Deno.test("timeline: wording that matches the booking, and unrelated words, pass", () => {
  assertEquals(timelineConflicts("Does Thu, 15 Oct at 5:30 pm IST still work?", refTs, booked), []);
  assertEquals(timelineConflicts("I will call today at 5:30 pm.", refTs, booked), []);
  assertEquals(timelineConflicts("we sat down and reviewed the site", refTs, booked), []);
  assertEquals(timelineConflicts("anything next week", refTs, undefined), []);
});
Deno.test("timeline: relative wording resolves against the note date", () => {
  assertEquals(timeMentions("next tuesday", refTs).dates[0].days, ["2026-10-20"]);
  assertEquals(timeMentions("in two weeks", refTs).dates[0].days, ["2026-10-29"]);
});
Deno.test("checkDraft rejects an ask whose timing differs from the booking", () => {
  const draft = { format: "note", subject: "platform overview", greeting: "Hi Shaleen,", core: "Thanks for your time.", ask: "I will call you next week.", signoff: "Best,\nS" };
  assertEquals(checkDraft(draft, "C2FO", { next: booked, now: refTs }).style.length, 1);
  assertEquals(checkDraft({ ...draft, ask: "I will call you today at 5:30 pm IST." }, "C2FO", { next: booked, now: refTs }).style, []);
});

Deno.test("normalizeDraft maps body to core and infers a note", () => {
  const d = normalizeDraft({ subject: "quick follow up", greeting: "Hi Shaleen,", body: "You asked for an overview before we talk next week.", ask: "Does Tuesday work?", sign_off: "Sashank" })!;
  assertEquals(d.core, "You asked for an overview before we talk next week.");
  assertEquals(d.signoff, "Sashank");
  assertEquals(d.format, "note");
  assertEquals(checkDraft(d, "C2FO").problems, []);
});
Deno.test("normalizeDraft never overwrites a field the writer set", () => {
  const d = normalizeDraft({ format: "Note", core: "kept", body: "ignored" })!;
  assertEquals(d.core, "kept");
  assertEquals(d.format, "note");
});
Deno.test("normalizeDraft infers a brief and rejects non-objects", () => {
  assertEquals(normalizeDraft({ opening: "a", company: "b" })!.format, "brief");
  assertEquals(normalizeDraft("text"), null);
  assertEquals(normalizeDraft([1]), null);
});
Deno.test("missing core names the field to use", () => {
  assert(checkDraft({ format: "note", subject: "s", greeting: "g", ask: "a", signoff: "x" }, "C").problems[0].includes('field named "core"'));
});
