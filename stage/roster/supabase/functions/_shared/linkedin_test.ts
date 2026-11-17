// Run: deno test roster/supabase/functions/_shared/linkedin_test.ts
import { pickProfile } from "./linkedin.ts";

function assertEquals(a: unknown, b: unknown) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
}
const arjun = { name: "Arjun Sh***a", title: "Head of Demand Generation", company: "Northwind Analytics", domain: "northwind.example" };
Deno.test("a masked surname matches its visible letters, and the role confirms it", () => {
  const hit = pickProfile(arjun, [
    { url: "https://linkedin.com/in/someone", name: "Arjun Raman", text: "Demand Generation at Northwind Analytics" },
    { url: "https://linkedin.com/in/arjun-sharma-demo", name: "Arjun Sharma", text: "B2B SaaS Demand Generation and GTM Leader" },
  ]);
  assertEquals(hit?.url, "https://linkedin.com/in/arjun-sharma-demo");
  assertEquals(hit?.fullName, "Arjun Sharma");
});
Deno.test("rejects a namesake whose surname breaks the mask", () => {
  const p = { name: "Kavya Me***a", title: "Head of Growth Marketing", company: "Helix Travel Tech" };
  assertEquals(pickProfile(p, [{ url: "https://linkedin.com/in/kavya-menon-demo", name: "Kavya Menon", text: "Growth Marketing at Helix Travel Tech" }]), null);
});
Deno.test("needs the company or two role words, and a linkedin.com/in URL", () => {
  const p = { name: "Rohan Verma", title: "Director of Performance Marketing", company: "Helix Travel Tech" };
  assertEquals(pickProfile(p, [{ url: "https://linkedin.com/in/rk", name: "Rohan Verma", text: "Chef in Delhi" }]), null);
  assertEquals(pickProfile(p, [{ url: "https://exa.ai/library/person/x", name: "Rohan Verma", text: "Helix Travel Tech" }]), null);
  assertEquals(pickProfile(p, [{ url: "https://linkedin.com/in/rk", name: "Rohan Verma", text: "Performance marketing at Helix Travel Tech" }])?.url, "https://linkedin.com/in/rk");
});
