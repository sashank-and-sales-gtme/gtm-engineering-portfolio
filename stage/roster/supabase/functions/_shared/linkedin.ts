// Finds a contact's LinkedIn profile when Apollo's search hid it (masked surnames like "Kavya Me***a"). One Exa
// people search per contact; a candidate is accepted only when the name fits (first name, and the visible letters of
// a masked surname) and the profile names the company or shares the role. Pure matching is exported for tests.
import { fetchWithTimeout } from "./cors.ts";
import { getSecret } from "./secrets.ts";

export interface LiCandidate {
  url: string;
  name: string;
  text: string;
}
export interface LiPerson {
  name: string;
  title: string;
  company: string;
  domain?: string;
}

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const STOP = new Set(["of", "and", "the", "at", "head", "director", "vp", "senior", "sr", "lead", "manager", "global", "india", "&"]);

/** "Sa***m" -> /^sa\w*m$/ ; a plain surname must match exactly. Null when there is no surname to check. */
function surnameRule(last: string): RegExp | null {
  const l = last.trim().toLowerCase();
  if (!l) return null;
  if (l.includes("*")) {
    const [pre, post] = [l.split("*")[0], l.split("*").filter(Boolean).pop() ?? ""];
    return new RegExp(`^${pre.replace(/[^a-z]/g, "")}[a-z]*${post.replace(/[^a-z]/g, "")}$`);
  }
  return new RegExp(`^${norm(l).split(" ")[0]}`);
}

/** The best candidate for the person, or null. */
export function pickProfile(p: LiPerson, cands: LiCandidate[]): (LiCandidate & { fullName: string }) | null {
  const parts = p.name.replace(/\s*\(.*?\)/g, "").trim().split(/\s+/);
  const first = norm(parts[0] ?? "");
  const rule = surnameRule(parts.slice(1).join(" "));
  const company = norm(p.company).split(" ").filter((w) => w.length > 2);
  const domainRoot = (p.domain ?? "").toLowerCase().split(".")[0];
  const roleWords = norm(p.title).split(" ").filter((w) => w.length > 2 && !STOP.has(w));
  for (const c of cands) {
    if (!/linkedin\.com\/in\//i.test(c.url)) continue;
    const cn = norm(c.name).split(" ");
    if (!first || cn[0] !== first) continue;
    if (rule && !(cn.length > 1 && rule.test(cn[cn.length - 1]) || cn.slice(1).some((w) => rule.test(w)))) continue;
    const text = norm(c.text);
    const companyHit = (company.length && company.every((w) => text.includes(w))) || (domainRoot.length > 3 && text.includes(domainRoot));
    const roleHits = roleWords.filter((w) => text.includes(w)).length;
    if (!companyHit && roleHits < 2) continue;
    return { ...c, fullName: c.name.replace(/\s*[,|].*$/, "").trim() };
  }
  return null;
}

/** One Exa people search; returns the matched profile URL and full name, or null. Throws on transport errors. */
export async function findLinkedIn(p: LiPerson): Promise<{ url: string; fullName: string; cost: number } | null> {
  const key = await getSecret("int_exa_key");
  if (!key) throw new Error("Exa isn't connected");
  const visible = p.name.replace(/\*+/g, "").replace(/\s*\(.*?\)/g, "").trim();
  const r = await fetchWithTimeout("https://api.exa.ai/search", {
    method: "POST",
    headers: { "x-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({ query: `${visible} ${p.title} at ${p.company}`, category: "people", numResults: 8, contents: { text: { maxCharacters: 1200 } } }),
  }, 30000);
  if (!r.ok) throw new Error(`Exa ${r.status}`);
  // deno-lint-ignore no-explicit-any
  const d: any = await r.json();
  // deno-lint-ignore no-explicit-any
  const cands: LiCandidate[] = (d.results ?? []).map((x: any) => ({ url: String(x.url ?? ""), name: String(x.title ?? ""), text: String(x.text ?? "") }));
  const hit = pickProfile(p, cands);
  const cost = Number(d.costDollars?.total ?? 0);
  return hit ? { url: hit.url.replace(/^http:/, "https:").replace(/^https:\/\/linkedin/, "https://www.linkedin"), fullName: hit.fullName, cost } : null;
}
