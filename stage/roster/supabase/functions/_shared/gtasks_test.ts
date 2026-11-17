// Run: deno test roster/supabase/functions/_shared/gtasks_test.ts
import { completedIds, dueFor } from "./gtasks.ts";

function assertEquals(a: unknown, b: unknown) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
}
Deno.test("a due date is the IST calendar day, even late in the evening", () => {
  assertEquals(dueFor("2026-10-15T12:00:00Z"), "2026-10-15T00:00:00.000Z");
  assertEquals(dueFor("2026-10-15T20:00:00Z"), "2026-10-16T00:00:00.000Z"); // 1:30 am IST on the 16th
});
Deno.test("only completed, not deleted, tasks count as done", () => {
  const ids = completedIds([{ id: "a", status: "completed" }, { id: "b", status: "needsAction" }, { id: "c", status: "completed", deleted: true }]);
  assertEquals([...ids], ["a"]);
});
