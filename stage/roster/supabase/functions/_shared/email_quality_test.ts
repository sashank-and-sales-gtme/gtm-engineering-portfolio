// Run: deno test roster/supabase/functions/_shared/email_quality_test.ts
import { apolloEmpty, choosePrimary, emailRank, needsSecondSource } from "./email_quality.ts";

function assertEquals(a: unknown, b: unknown) {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error(`${x} !== ${y}`);
}

Deno.test("ranks Apollo and FullEnrich statuses on one scale", () => {
  assertEquals([emailRank("verified"), emailRank("DELIVERABLE")], [3, 3]);
  assertEquals([emailRank("likely to engage"), emailRank("HIGH_PROBABILITY")], [2, 2]);
  assertEquals([emailRank("unverified"), emailRank("guessed"), emailRank("")], [1, 1, 1]);
  assertEquals([emailRank("catch_all"), emailRank("CATCH_ALL"), emailRank("accept-all")], [0, 0, 0]);
  assertEquals([emailRank("INVALID"), emailRank("bounced")], [-1, -1]);
});
Deno.test("asks a second source unless the first email is verified", () => {
  assertEquals(needsSecondSource("", ""), true);
  assertEquals(needsSecondSource("a@b.com", "catch_all"), true);
  assertEquals(needsSecondSource("a@b.com", "verified"), false);
});
Deno.test("waterfall: FullEnrich only when Apollo is empty or invalid", () => {
  assertEquals(apolloEmpty("", ""), true);
  assertEquals(apolloEmpty("a@b.com", "invalid"), true);
  assertEquals(apolloEmpty("a@b.com", "verified"), false);
  assertEquals(apolloEmpty("a@b.com", "unverified"), false);
  assertEquals(apolloEmpty("a@b.com", "catch_all"), false);
});
Deno.test("picks the more trustworthy email, Apollo on a tie", () => {
  const apollo = { email: "a@x.com", status: "catch_all", source: "Apollo" };
  const fe = { email: "b@x.com", status: "DELIVERABLE", source: "FullEnrich" };
  assertEquals(choosePrimary([apollo, fe])?.source, "FullEnrich");
  assertEquals(choosePrimary([{ ...apollo, status: "verified" }, fe])?.source, "Apollo");
  assertEquals(choosePrimary([apollo, { email: "", status: "", source: "FullEnrich" }])?.email, "a@x.com");
  assertEquals(choosePrimary([null, undefined]), null);
});
