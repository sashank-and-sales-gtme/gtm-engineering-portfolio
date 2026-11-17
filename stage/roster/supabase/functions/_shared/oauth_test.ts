// Run: deno test roster/supabase/functions/_shared/oauth_test.ts
import { toUrl, withResult } from "./oauth.ts";

function assertEquals(a: unknown, b: unknown) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
}
Deno.test("an app address saved without https:// still works", () => {
  assertEquals(toUrl("stage-prospect.vercel.app"), "https://stage-prospect.vercel.app/");
  assertEquals(toUrl("localhost:5173"), "http://localhost:5173/");
  assertEquals(toUrl("https://x.vercel.app/a"), "https://x.vercel.app/a");
  assertEquals(toUrl(""), null);
  assertEquals(toUrl("javascript:alert(1)"), null);
  assertEquals(withResult("x.vercel.app", { connected: "gmail_sender" }), "https://x.vercel.app/?connected=gmail_sender");
});
