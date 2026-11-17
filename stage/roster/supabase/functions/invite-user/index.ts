// POST {email, role, resend?}: email an invitation to join the roster. Needs manage_users.
// Preferred path: Supabase Auth makes a one-time sign-in link (creating the account, so the sign-up trigger applies the
// role from the invites table) and the email goes out from the team mailbox (sales@ by default) through the Gmail API.
// Fallback when no mailbox is connected: Supabase Auth sends its own invite through the project's SMTP settings.
//   resend: true  sends a fresh link to someone invited earlier who hasn't signed in yet.
import { errMsg, HttpError, json, readJson, serve } from "../_shared/cors.ts";
import { adminClient, audit, getCaller, nowISO } from "../_shared/supabase.ts";
import { inviteEmail, sendFromSender, senderTokens } from "../_shared/gmail.ts";

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Where the link in the email lands: the page the admin sent it from, when Supabase allows that address. */
function landing(req: Request): string | undefined {
  const o = req.headers.get("origin") || "";
  return /^https?:\/\//.test(o) ? o + "/" : undefined;
}

/** Turns Auth's mail errors into something an admin can act on. */
function mailError(e: unknown): HttpError {
  const m = errMsg(e);
  if (/smtp|sending|send .*email|rate limit|email rate|not authorized/i.test(m)) {
    return new HttpError(
      503,
      "The invite email couldn't be sent. Connect the invite mailbox in Admin > Integrations > Invite email, then send again. " + `(${m})`,
    );
  }
  return new HttpError(400, m);
}

serve(async (req) => {
  const me = await getCaller(req);
  if (!me.can("manage_users")) throw new HttpError(403, "Your role can't invite people");
  const body = await readJson<{ email?: string; role?: string; resend?: boolean }>(req);
  const email = String(body.email ?? "").trim().toLowerCase();
  const role = String(body.role ?? "").trim();
  if (!EMAIL.test(email)) throw new HttpError(400, "Enter a valid email address");

  const db = adminClient();
  const { data: dom } = await db.from("app_settings").select("value").eq("key", "allowed_domain").maybeSingle();
  const domain = String((dom?.value as { domain?: string } | null)?.domain || "").trim().toLowerCase();
  if (domain && !email.endsWith("@" + domain)) throw new HttpError(400, `Only @${domain} addresses can join the roster`);

  const viaGmail = !!(await senderTokens());
  const inviter = me.full_name || me.email;
  const { data: roleNames } = await db.from("roles").select("id,name");
  const roleName = (id: string) => (id === "super_admin" ? "Super Admin" : (roleNames ?? []).find((r) => r.id === id)?.name || id);

  /** Makes a one-time link and mails it from the team mailbox. */
  const mailLink = async (type: "invite" | "magiclink", roleId: string) => {
    const { data, error } = await db.auth.admin.generateLink({ type, email, options: { redirectTo: landing(req), data: type === "invite" ? { invited_by: me.email } : undefined } });
    if (error) throw new HttpError(400, error.message);
    const link = data?.properties?.action_link;
    if (!link) throw new HttpError(500, "Supabase did not return a sign-in link");
    const m = inviteEmail({ inviter, role: roleName(roleId), link, to: email });
    await sendFromSender({ ...m, to: email, fromName: "Stage Prospect", replyTo: me.email });
    return data?.user?.id ?? null;
  };

  const { data: existing } = await db.from("profiles").select("id,status,role,invited_at,signed_in_at").eq("email", email).maybeSingle();

  if (body.resend) {
    if (!existing) throw new HttpError(404, "No invite to resend for that address");
    if (existing.signed_in_at) throw new HttpError(409, "They've already signed in");
    if (viaGmail) await mailLink("magiclink", existing.role || role);
    else {
      const { error } = await db.auth.signInWithOtp({ email, options: { shouldCreateUser: false, emailRedirectTo: landing(req) } });
      if (error) throw mailError(error);
    }
    await db.from("profiles").update({ invited_at: nowISO() }).eq("id", existing.id);
    await audit(me.id, "invite resent", existing.id, email);
    return json({ ok: true, resent: true, via: viaGmail ? "gmail" : "supabase" });
  }

  if (existing) throw new HttpError(409, "That person already has an account. Change their role in the Users table.");
  if (!role) throw new HttpError(400, "Pick a role");
  if (!(roleNames ?? []).some((r) => r.id === role)) throw new HttpError(400, "That role doesn't exist");
  if (role === "super_admin" && me.role !== "super_admin") throw new HttpError(403, "Only a Super Admin can invite a Super Admin");

  // The sign-up trigger reads this row when Auth creates the account, and applies the role.
  const { error: ie } = await db.from("invites").upsert({ email, role, created_by: me.id });
  if (ie) throw new HttpError(500, "Could not record the invite: " + ie.message);

  let uid: string | null = null;
  try {
    if (viaGmail) uid = await mailLink("invite", role);
    else {
      const { data, error } = await db.auth.admin.inviteUserByEmail(email, { redirectTo: landing(req), data: { invited_by: me.email } });
      if (error) throw mailError(error);
      uid = data?.user?.id ?? null;
    }
  } catch (e) {
    // Nothing was sent: undo the account and the pending role so the admin can simply try again.
    const { data: u } = await db.from("profiles").select("id,signed_in_at").eq("email", email).maybeSingle();
    if (u && !u.signed_in_at) await db.auth.admin.deleteUser(u.id).catch(() => null);
    await db.from("invites").delete().eq("email", email);
    throw e;
  }
  if (uid) await db.from("profiles").update({ invited_at: nowISO() }).eq("id", uid);
  await audit(me.id, "user invited", uid ?? email, `${email} · ${role} · via ${viaGmail ? "gmail" : "supabase"}`);
  return json({ ok: true, user_id: uid, via: viaGmail ? "gmail" : "supabase" });
});
