import type { Ctx } from "./ctx";
import type { Row } from "./data";

export type Priority = "high" | "medium" | "low";
export const PRIORITY_LABEL: Record<Priority, string> = { high: "High", medium: "Medium", low: "Low" };
const RANK: Record<Priority, number> = { high: 0, medium: 1, low: 2 };
export const priorityRank = (p: Priority) => RANK[p];

const TIER_POINTS: Record<string, number> = { S: 3, A: 3, B: 2, C: 1, X: 0 };
// Words in call notes that move an account up or down. Kept short and literal so the reason is easy to read back.
const WARM = /\b(interested|keen|budget|pricing|proposal|pilot|evaluat\w*|timeline|decision|demo|next step|follow[ -]?up|send (?:it )?over|loop in|introduce)\b/i;
const COLD = /\b(not interested|no budget|not a fit|no need|already (?:using|have)|stop calling|unsubscribe|bad time|not now|no bandwidth)\b/i;
const DAY = 864e5;

/**
 * An account's priority from its tier, how far the deal has moved, recent activity and what the call notes say.
 * Returns the reasons so the marker can explain itself. A manual override on any contact wins.
 */
export function accountPriority(X: Ctx, contacts: Row[], tier: string): { p: Priority; reasons: string[]; manual: boolean } {
  const pinned = contacts.map((c) => c.priority_override).find((v) => v === "high" || v === "medium" || v === "low") as Priority | undefined;
  if (pinned) return { p: pinned, reasons: ["Set by hand"], manual: true };
  if (contacts.some((c) => c.lost_at)) return { p: "low", reasons: ["Closed lost / cold"], manual: false };
  if (contacts.length && contacts.every((c) => c.dq_at)) return { p: "low", reasons: ["Disqualified"], manual: false };
  const ids = new Set(contacts.map((c) => c.id));
  const now = Date.now();
  const reasons: string[] = [];
  let score = TIER_POINTS[tier] ?? 0;
  if (score >= 3) reasons.push(`Tier ${tier}`);

  const meetings = X.D.meetings.filter((m) => ids.has(m.lead_id));
  const callbacks = X.D.callbacks.filter((c) => ids.has(c.lead_id) && c.status === "open");
  const calls = X.D.calls.filter((c) => ids.has(c.lead_id));
  const notes = X.D.journeys.filter((j) => ids.has(j.lead_id));

  if (meetings.some((m) => m.status === "scheduled")) {
    score += 3;
    reasons.push("Demo booked");
  } else if (meetings.some((m) => m.status === "rescheduling")) {
    score += 2;
    reasons.push("Demo needs rebooking");
  } else if (meetings.some((m) => m.status === "done")) {
    score += 1;
    reasons.push("Demo done");
  }
  if (callbacks.length) {
    const soon = callbacks.some((c) => Date.parse(c.when) - now < 3 * DAY);
    score += soon ? 3 : 2;
    reasons.push(soon ? "Callback due within 3 days" : "Open callback");
  }
  if (!meetings.length && !callbacks.length && contacts.some((c) => c.approved)) {
    score += 1;
    reasons.push("Approved for calling");
  }
  const lastTouch = Math.max(0, ...calls.map((c) => Date.parse(c.at) || 0), ...notes.map((j) => Date.parse(j.at) || 0));
  if (lastTouch && now - lastTouch < 7 * DAY) {
    score += 1;
    reasons.push("Touched in the last 7 days");
  }
  // Email engagement HubSpot tracked: a reply is the strongest signal, a recent open or click a nudge.
  const mail = contacts.map((c) => c.email_activity || {});
  if (mail.some((m) => m.replied && now - Date.parse(m.replied) < 30 * DAY)) {
    score += 3;
    reasons.push("Replied to an email");
  } else if (mail.some((m) => (m.opened && now - Date.parse(m.opened) < 7 * DAY) || (m.clicked && now - Date.parse(m.clicked) < 7 * DAY))) {
    score += 1;
    reasons.push("Opened an email this week");
  }
  const text = notes.filter((j) => j.kind !== "hubspot" || !String(j.stage || "").startsWith("email")).map((j) => String(j.text || "")).join(" \n ");
  if (COLD.test(text)) {
    score -= 3;
    reasons.push("Notes sound cold");
  } else if (WARM.test(text)) {
    score += 2;
    reasons.push("Notes show buying signals");
  }
  const last = calls.slice().sort((a, b) => String(b.at).localeCompare(String(a.at)))[0];
  if (last && last.outcome === "no" && !callbacks.length && !meetings.length) {
    score -= 1;
    reasons.push("Last call booked nothing");
  } else if (last && last.outcome === "dnp" && !callbacks.length && !meetings.length) {
    reasons.push("Last call wasn't picked up");
  }
  const p: Priority = score >= 6 ? "high" : score >= 3 ? "medium" : "low";
  if (!reasons.length) reasons.push("No activity yet");
  return { p, reasons, manual: false };
}
