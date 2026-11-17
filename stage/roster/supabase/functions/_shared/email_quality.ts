// How much an enriched email can be trusted, across Apollo and FullEnrich status vocabularies. Pure, so it can be
// unit tested. The frontend mirrors emailRank in src/lib/email.ts; keep the two in step.

/** 3 verified, 2 likely, 1 unverified or unknown, 0 catch-all, -1 invalid. */
export function emailRank(status: unknown): number {
  const s = String(status ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (["verified", "deliverable", "valid"].includes(s)) return 3;
  if (["likely_to_engage", "high_probability", "probable", "likely"].includes(s)) return 2;
  if (["catch_all", "catchall", "accept_all", "risky"].includes(s)) return 0;
  if (["invalid", "invalid_domain", "bounced", "unavailable", "undeliverable"].includes(s)) return -1;
  return 1;
}

/**
 * The waterfall rule: FullEnrich is asked only when Apollo came back empty, meaning no email or one marked invalid.
 * An unverified or catch-all Apollo email is kept and shown with its status; it is not sent to a second provider.
 */
export function apolloEmpty(email: unknown, status: unknown): boolean {
  return !String(email ?? "").trim() || emailRank(status) < 0;
}

/** Older rule (any unverified email went to a second provider). Kept for reference; the waterfall uses apolloEmpty. */
export function needsSecondSource(email: unknown, status: unknown): boolean {
  return !String(email ?? "").trim() || emailRank(status) < 3;
}

export interface EmailCandidate {
  email: string;
  status: string;
  source: string;
}

/** The most trustworthy email of the candidates; on a tie the earlier one (Apollo) wins. Null when none has an email. */
export function choosePrimary(cands: Array<Partial<EmailCandidate> | null | undefined>): EmailCandidate | null {
  let best: EmailCandidate | null = null;
  for (const c of cands) {
    const email = String(c?.email ?? "").trim();
    if (!email) continue;
    const cand = { email, status: String(c?.status ?? ""), source: String(c?.source ?? "") };
    if (!best || emailRank(cand.status) > emailRank(best.status)) best = cand;
  }
  return best;
}
