import type { Row } from "./data";

/** Mirrors emailRank in supabase/functions/_shared/email_quality.ts: 3 verified, 2 likely, 1 unverified, 0 catch-all, -1 invalid. */
export function emailRank(status: unknown): number {
  const s = String(status ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (["verified", "deliverable", "valid"].includes(s)) return 3;
  if (["likely_to_engage", "high_probability", "probable", "likely"].includes(s)) return 2;
  if (["catch_all", "catchall", "accept_all", "risky"].includes(s)) return 0;
  if (["invalid", "invalid_domain", "bounced", "unavailable", "undeliverable"].includes(s)) return -1;
  return 1;
}

const RANK_WORD: Record<number, string> = { 3: "verified", 2: "likely valid", 1: "unverified", 0: "catch-all", [-1]: "invalid" };
export const statusWord = (status: unknown) => RANK_WORD[emailRank(status)];
export const providerName = (s: unknown) => (/full/i.test(String(s ?? "")) ? "FullEnrich" : "Apollo");

/** One plain sentence about whether the contact's email can be trusted, shown under their name. */
export function emailCheck(l: Row): string {
  const e: Row | null = l.enrichment || null;
  if (!e || (!e.status && !e.email)) return l.approved ? "Email not checked yet" : "Email not checked yet (checked when approved)";
  if (e.status === "enriching") return "Email: checking…";
  if (e.status === "failed") return "Email: check failed, try again";
  if (!e.email) {
    return e.fe_tried ? "Email: none found by Apollo or FullEnrich" : "Email: none found by Apollo (FullEnrich not checked)";
  }
  const rank = emailRank(e.email_status);
  const src = providerName(e.source);
  if (rank >= 3) return `Email: verified by ${src}`;
  if (rank === 2) return `Email: likely valid (${src})`;
  if (rank <= 0) {
    // When the best email is catch-all or invalid, both providers came back faulty.
    return e.fe_tried
      ? `Email: ${rank < 0 ? "invalid" : "catch-all"}. Apollo and FullEnrich both returned faulty emails; confirm another way before emailing`
      : rank < 0
      ? "Email: invalid from Apollo; FullEnrich not connected, so no second source was tried"
      : "Email: catch-all (Apollo). The domain accepts any address, so confirm before relying on it";
  }
  return e.fe_tried ? `Email: unverified (${src}); Apollo had none, so FullEnrich found this one` : `Email: unverified (${src})`;
}
