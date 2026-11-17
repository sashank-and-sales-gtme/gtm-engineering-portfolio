// Reads a finished FullEnrich result. Pure (no imports) so it can be unit tested.
// Accepts both response shapes the API has: v1 (datas[].contact, most_probable_email as a string) and
// v2 (data[].contact_info, most_probable_work_email as {email, status}), so a change on their side does not
// silently turn a found contact into "no email".

export interface FeResult {
  email: string;
  email_status: string;
  phone: string;
  /** Names of the contact fields that had a value, for diagnosing an empty read. */
  seen: string;
}

// deno-lint-ignore no-explicit-any
type J = any;

const emailOf = (v: J): string => (typeof v === "string" ? v : String(v?.email ?? ""));
const statusOf = (v: J): string => (v && typeof v === "object" ? String(v.status ?? "") : "");
const usable = (status: string) => status !== "INVALID" && status !== "INVALID_DOMAIN";
const phoneOf = (v: J): string => (typeof v === "string" ? v : String(v?.number ?? ""));

export function parseFinished(d: J): FeResult {
  const rec = (Array.isArray(d?.datas) ? d.datas[0] : Array.isArray(d?.data) ? d.data[0] : null) ?? {};
  const c: J = rec.contact ?? rec.contact_info ?? {};
  const seen = Object.keys(c).filter((k) => {
    const v = c[k];
    return v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && !v.length);
  }).join(",");

  // Best email first: the "most probable" one, then the first usable one in the lists.
  const lists: J[] = [c.emails, c.work_emails].filter(Array.isArray).flat();
  const top: J[] = [
    { email: emailOf(c.most_probable_email), status: String(c.most_probable_email_status ?? statusOf(c.most_probable_email)) },
    { email: emailOf(c.most_probable_work_email), status: statusOf(c.most_probable_work_email) },
    ...lists.map((e) => ({ email: emailOf(e), status: statusOf(e) })),
  ];
  const best = top.find((e) => e.email && usable(e.status));
  const phone = phoneOf(c.most_probable_phone) || phoneOf(Array.isArray(c.phones) ? c.phones[0] : null);
  return { email: best?.email ?? "", email_status: best?.status ?? "", phone, seen };
}
