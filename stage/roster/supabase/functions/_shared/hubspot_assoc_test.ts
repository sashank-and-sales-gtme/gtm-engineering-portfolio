import { noteAssociations, targetSummary } from "./hubspot_assoc.ts";

function assertEquals(a: unknown, b: unknown) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

Deno.test("links the note to every record that exists", () => {
  const a = noteAssociations({ deal: "11", contact: "22", company: "33" });
  assertEquals(a.map((x) => [x.to.id, x.types[0].associationTypeId]), [["11", 214], ["22", 202], ["33", 190]]);
});

Deno.test("skips records that are missing", () => {
  const a = noteAssociations({ deal: null, contact: "22", company: undefined });
  assertEquals(a.map((x) => x.to.id), ["22"]);
  assertEquals(noteAssociations({}), []);
});

Deno.test("summarises the linked records", () => {
  assertEquals(targetSummary({ deal: "1", contact: "2", company: "3" }), { kinds: "deal + contact + company", ids: "deal:1 contact:2 company:3" });
  assertEquals(targetSummary({ contact: "2" }), { kinds: "contact", ids: "contact:2" });
});
