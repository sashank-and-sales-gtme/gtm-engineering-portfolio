import type { Ctx } from "./ctx";
import type { Row } from "./data";
import { coName } from "./format";
import { readProfile } from "./profile";

export const PERMS: Array<[string, string, string]> = [
  ["view_all_accounts", "See all accounts and leads", "Without it, people see only accounts that hold contacts assigned to them."],
  ["work_leads", "Approve and call assigned contacts", "Approve, log outcomes and connected calls on their own contacts."],
  ["work_any_lead", "Act on any contact", "Approve and log calls on contacts assigned to someone else or to no one."],
  ["assign_leads", "Assign contacts to people", ""],
  ["add_company", "Add companies", ""],
  ["enrich_now", "Enrich now (spends Apollo credits)", ""],
  ["hubspot_notes", "Save call context to HubSpot", "Without it, call context stays in the roster journey only."],
  ["manage_meetings", "Book and manage own meetings and callbacks", ""],
  ["view_all_meetings", "See and manage everyone's meetings, callbacks and tasks", ""],
  ["view_dashboard", "View the dashboard", ""],
  ["edit_tiers", "Edit account tiers", "Re-tag an account's tier (S, A, B, C, X). Research never overwrites a manual tag."],
  ["manage_tasks", "Use the Task Center for own work", ""],
  ["delete_records", "Delete and undo entries", ""],
  ["manage_users", "Add, edit and remove users", "Super Admin roles stay reserved for Super Admins."],
  ["manage_roles", "Create, edit and delete roles and permissions", ""],
  ["manage_integrations", "Manage integrations and scheduled tasks", ""],
  ["view_audit", "View the audit log", ""],
];

export const ownerId = (X: Ctx) => (X.D.profiles.find((p) => p.is_owner) || {}).id || "";
export function myRole(X: Ctx): string | null {
  const r = X.me;
  if (r && r.is_owner) return "super_admin";
  return r && r.status === "active" ? r.role : null;
}
export function can(X: Ctx, p: string): boolean {
  const r = myRole(X);
  if (!r) return false;
  if (r === "super_admin") return true;
  const role = X.D.roles.find((x) => x.id === r);
  return !!(role && (role.perms || []).includes(p));
}
export const ownerOf = (X: Ctx, d: Row | null | undefined) => (d && d.owner) || ownerId(X);
export const mine = (X: Ctx, d: Row | null | undefined) => (!X.uid ? false : ownerOf(X, d) === X.uid);
export const seeAllWork = (X: Ctx) => can(X, "view_all_meetings");
export const workVisible = (X: Ctx, d: Row | null | undefined) => seeAllWork(X) || mine(X, d);
export const assignedTo = (l: Row) => l.assigned_to || "";
export const canActOn = (X: Ctx, l: Row) => can(X, "work_any_lead") || (can(X, "work_leads") && assignedTo(l) === X.uid);
export function pname(X: Ctx, id: string | null | undefined): string {
  const p = X.D.profiles.find((x) => x.id === id);
  if (p) return p.full_name || p.email || "Someone";
  return id && id === X.uid ? (X.me && (X.me.full_name || X.me.email)) || "You" : "Someone";
}
/** Super admins and admins can add companies for other reps and run their add-company requests. */
export const runsOthersAdds = (X: Ctx) => ["super_admin", "admin"].includes(myRole(X) || "") || can(X, "manage_users");
export const isAdminAny = (X: Ctx) => ["manage_users", "manage_roles", "manage_integrations", "view_audit"].some((p) => can(X, p));
export const roleName = (X: Ctx, r: string | null | undefined) =>
  !r ? "No role" : r === "super_admin" ? "Super Admin" : (X.D.roles.find((x) => x.id === r) || {}).name || r;
export const superLimit = (X: Ctx) => (X.D.settings.super_admin_limit && X.D.settings.super_admin_limit.limit) || 2;
export const activeSupers = (X: Ctx) => X.D.profiles.filter((u) => u.role === "super_admin" && u.status === "active");

/** Mirrors the guard_profiles() trigger so the UI explains a refusal before the database does. */
export function roleGuard(X: Ctx, target: Row | null, newRole: string | null): string {
  const me = myRole(X);
  if (target && target.is_owner && newRole !== "super_admin") return "The owner is always a Super Admin.";
  if (target && target.id === X.uid) return "You can't change your own role.";
  if ((newRole === "super_admin" || (target && target.role === "super_admin")) && me !== "super_admin")
    return "Only a Super Admin can grant or remove Super Admin.";
  const limit = superLimit(X);
  if (newRole === "super_admin" && (!target || target.role !== "super_admin" || target.status !== "active") && activeSupers(X).length >= limit)
    return `There can be at most ${limit} Super Admins.`;
  return "";
}

/* ---------- lead lookups ---------- */
export const leadById = (X: Ctx, id: string | null | undefined) => X.D.leads.find((l) => l.id === id);
export const openCallback = (X: Ctx, leadId: string) =>
  X.D.callbacks.filter((c) => c.lead_id === leadId && c.status === "open").sort((a, b) => String(a.when).localeCompare(String(b.when)))[0];
export const meetingFor = (X: Ctx, leadId: string) =>
  X.D.meetings.filter((m) => m.lead_id === leadId && m.status !== "canceled").sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
export const contextFor = (X: Ctx, leadId: string) =>
  X.D.journeys.filter((j) => j.lead_id === leadId).sort((a, b) => String(b.at).localeCompare(String(a.at)));
export function visibleLeads(X: Ctx) {
  if (can(X, "view_all_accounts")) return X.D.leads;
  const mineCo = new Set(X.D.leads.filter((l) => assignedTo(l) === X.uid).map((l) => coName(l.company).toLowerCase()));
  return X.D.leads.filter((l) => mineCo.has(coName(l.company).toLowerCase()));
}
export const vMeetings = (X: Ctx) => X.D.meetings.filter((m) => m.status !== "canceled" && workVisible(X, m));
export const vCallbacks = (X: Ctx) => X.D.callbacks.filter((c) => workVisible(X, c));
export const vTasks = (X: Ctx) => X.D.tasks.filter((t) => ownerOf(X, t) === X.uid || seeAllWork(X));
export const bookingLink = (X: Ctx) =>
  (X.D.settings.booking_link && X.D.settings.booking_link.url) || readProfile(X.D.settings.profile).booking_link || "";
