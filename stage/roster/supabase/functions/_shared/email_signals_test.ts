// Run: deno test roster/supabase/functions/_shared/email_signals_test.ts
import { emailSignals } from "./email_signals.ts";

function assertEquals(a: unknown, b: unknown) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
}
Deno.test("takes the latest of sales and marketing opens, and reads epoch or ISO times", () => {
  const s = emailSignals({ hs_sales_email_last_opened: "2026-10-14T10:00:00Z", hs_email_last_open_date: String(Date.parse("2026-10-15T08:00:00Z")), hs_sales_email_last_replied: null });
  assertEquals(s, { opened: "2026-10-15T08:00:00.000Z" });
});
Deno.test("empty contact has no signals", () => assertEquals(emailSignals({}), {}));
