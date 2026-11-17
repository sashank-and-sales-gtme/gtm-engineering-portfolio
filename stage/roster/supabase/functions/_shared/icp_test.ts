// Run: deno test roster/supabase/functions/_shared/icp_test.ts
import { scanCopy } from "./icp.ts";

function assert(c: unknown, msg = "assertion failed"): asserts c {
  if (!c) throw new Error(msg);
}
const triad = (t: string) => scanCopy(t).includes("reads like a rule-of-three list");

Deno.test("rule of three: real short lists are caught", () => {
  assert(triad("You own pipeline, conversion and CPA for India."));
  assert(triad("Leads, demos, or revenue all suffer."));
});
Deno.test("rule of three: a clause before a comma is not a list", () => {
  assert(!triad("In 5 weeks, Northwind moved conversion and pipeline."));
  assert(!triad("When planners land on cvent.com, every buyer type goes to one demo form and waits."));
  assert(!triad("Your team runs demand gen for India and APAC."));
});
