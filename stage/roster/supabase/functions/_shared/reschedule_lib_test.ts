// Run: deno test roster/supabase/functions/_shared/reschedule_lib_test.ts
function assert(c: unknown, msg = "assertion failed") {
  if (!c) throw new Error(msg);
}
function assertEquals(a: unknown, b: unknown) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
import { busyFrom, checkReply, composeReply, freeSlots, messageText, newPart, slotLabel } from "./reschedule_lib.ts";

// Saturday 18 Oct 2026, 22:00 IST
const NOW = Date.parse("2026-10-18T16:30:00Z");

Deno.test("slotLabel formats in IST", () => {
  assertEquals(slotLabel("2026-10-20T05:30:00.000Z"), "Tue, 20 Oct · 11:00 am IST");
  assertEquals(slotLabel("2026-10-20T09:00:00.000Z"), "Tue, 20 Oct · 2:30 pm IST");
});

Deno.test("freeSlots keeps the default 18-hour lead", () => {
  assert(freeSlots([], NOW, { days: 1 }).every((x) => Date.parse(x.iso) >= NOW + 18 * 3600e3));
});

Deno.test("freeSlots skips weekends, the lead time and busy events", () => {
  const busy: Array<[number, number]> = [[Date.parse("2026-10-19T05:30:00Z"), Date.parse("2026-10-19T06:30:00Z")]]; // Mon 11:00-12:00 IST
  const s = freeSlots(busy, NOW, { days: 2, minLeadHours: 1 });
  assert(s.length > 0);
  for (const x of s) {
    const wd = new Date(Date.parse(x.iso) + 5.5 * 3600e3).getUTCDay();
    assert(wd >= 1 && wd <= 5, "no weekend slots");
    assert(Date.parse(x.iso) >= NOW + 3600e3);
  }
  // Monday 11:00 and 12:00 (inside or within the buffer of the busy hour) are gone; 10:00 ends before the buffer.
  assert(!s.some((x) => x.label.startsWith("Mon, 19 Oct · 11:00")));
  assert(!s.some((x) => x.label.startsWith("Mon, 19 Oct · 12:00")));
  assert(s.some((x) => x.label.startsWith("Mon, 19 Oct · 2:30")));
  // Two business days: Monday and Tuesday only.
  assert(s.every((x) => /^(Mon|Tue)/.test(x.label)));
  assertEquals(s[0].id, "s1");
});

Deno.test("busyFrom ignores declined, transparent and all-day events", () => {
  const ev = [
    { start: { dateTime: "2026-10-19T10:00:00+05:30" }, end: { dateTime: "2026-10-19T11:00:00+05:30" } },
    { start: { date: "2026-10-19" }, end: { date: "2026-10-20" } },
    { transparency: "transparent", start: { dateTime: "2026-10-19T12:00:00+05:30" }, end: { dateTime: "2026-10-19T13:00:00+05:30" } },
    { attendees: [{ self: true, responseStatus: "declined" }], start: { dateTime: "2026-10-19T15:00:00+05:30" }, end: { dateTime: "2026-10-19T16:00:00+05:30" } },
  ];
  assertEquals(busyFrom(ev).length, 1);
});

Deno.test("messageText prefers text/plain and newPart drops quoted history", () => {
  const enc = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const payload = {
    mimeType: "multipart/alternative",
    parts: [
      { mimeType: "text/html", body: { data: enc("<p>html</p>") } },
      { mimeType: "text/plain", body: { data: enc("Thursday is packed, next week mornings work.\n\nOn Mon, 13 Oct 2026 at 10:00, Rep <r@x.ai> wrote:\n> earlier text") } },
    ],
  };
  assertEquals(newPart(messageText(payload)), "Thursday is packed, next week mornings work.");
});

const cands = freeSlots([], NOW, { days: 5 });
const good = {
  subject: "re: new time for our demo",
  greeting: "Hi Ankur,",
  opening: "Totally understand the week got away from you. Since mornings suit you better, here are a few options:",
  slots: [cands[0].id, cands[1].id, cands[7].id, cands[8].id, cands[15].id],
  close: "Just reply with the one that works and I'll send the invite.",
  signoff: "Best,\nSashank",
  flags: [],
};

Deno.test("checkReply accepts a good reply and composes it in time order", () => {
  const { problems, picked } = checkReply(good, cands);
  assertEquals(problems, []);
  const body = composeReply(good, picked.slice().reverse());
  assert(body.startsWith("Hi Ankur,"));
  const lines = body.split("\n").filter((l) => l.startsWith("* "));
  assertEquals(lines.length, 5);
  assertEquals(lines[0], "* " + cands[0].label);
});

Deno.test("checkReply rejects times, dates, links and bad slot ids", () => {
  const bad = { ...good, opening: "How about 3pm on 21 Oct? Or pick at https://meetings.hubspot.com/x", slots: ["s1", "s1", "zz"] };
  const { problems } = checkReply(bad, cands);
  assert(problems.some((p) => p.includes("exactly 5")));
  assert(problems.some((p) => p.includes("clock time")));
  assert(problems.some((p) => p.includes("calendar date")));
  assert(problems.some((p) => p.includes("no links")));
  const oneDay = { ...good, slots: cands.filter((c) => c.label.startsWith("Tue, 20 Oct")).slice(0, 5).map((c) => c.id) };
  assert(checkReply(oneDay, cands).problems.some((p) => p.includes("2 days")));
});
