// Run: deno test roster/supabase/functions/_shared/fullenrich_parse_test.ts
function assertEquals(a: unknown, b: unknown) {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error(`${x} !== ${y}`);
}
import { parseFinished } from "./fullenrich_parse.ts";

Deno.test("v1 shape: string most_probable fields", () => {
  const r = parseFinished({ status: "FINISHED", datas: [{ contact: {
    most_probable_email: "arjun.sharma@northwind.example", most_probable_email_status: "DELIVERABLE", most_probable_phone: "+1 555 010 0199",
  } }] });
  assertEquals([r.email, r.email_status, r.phone], ["arjun.sharma@northwind.example", "DELIVERABLE", "+1 555 010 0199"]);
});
Deno.test("v2 shape: objects under data[].contact_info", () => {
  const r = parseFinished({ status: "FINISHED", data: [{ contact_info: {
    most_probable_work_email: { email: "a@b.com", status: "HIGH_PROBABILITY" }, most_probable_phone: { number: "+1 555-123-4567", region: "US" },
  } }] });
  assertEquals([r.email, r.phone], ["a@b.com", "+1 555-123-4567"]);
});
Deno.test("lists are used when there is no most-probable field, and invalid emails are skipped", () => {
  const r = parseFinished({ datas: [{ contact: { emails: [{ email: "bad@x.com", status: "INVALID" }, { email: "ok@x.com", status: "CATCH_ALL" }], phones: [{ number: "+91 1", region: "IN" }] } }] });
  assertEquals([r.email, r.phone], ["ok@x.com", "+91 1"]);
});
Deno.test("an empty result reports what it did see", () => {
  const r = parseFinished({ status: "FINISHED", datas: [{ contact: { firstname: "Arjun", emails: [], phones: [] } }] });
  assertEquals([r.email, r.phone, r.seen], ["", "", "firstname"]);
  assertEquals(parseFinished({}).seen, "");
});
