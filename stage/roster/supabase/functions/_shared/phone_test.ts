// Run: deno test roster/supabase/functions/_shared/phone_test.ts
import { extractPhones } from "./phone.ts";

function assertEquals(a: unknown, b: unknown) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
}
Deno.test("finds phones in a sync match and prefers mobiles", () => {
  const sync = { person: { contact: { phone_numbers: [{ raw_number: "+91 80 4000 1000", sanitized_number: "+918040001000", type: "work_hq" }, { sanitized_number: "+919800011122", type: "mobile" }] } } };
  assertEquals(extractPhones(sync).map((p) => p.number), ["+919800011122", "+918040001000"]);
});
Deno.test("reads a webhook body with people[] and skips duplicates", () => {
  const hook = { status: "success", people: [{ id: "1", status: "success", phone_numbers: [{ sanitized_number: "+919800011122", type_cd: "mobile" }, { sanitized_number: "+919800011122" }] }] };
  assertEquals(extractPhones(hook), [{ number: "+919800011122", type: "mobile" }]);
});
Deno.test("an empty reveal has no phones", () => assertEquals(extractPhones({ people: [{ phone_numbers: [] }] }), []));
