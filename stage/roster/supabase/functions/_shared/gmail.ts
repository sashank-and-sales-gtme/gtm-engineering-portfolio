// Roster emails (invitations) go out through the Gmail API from a real mailbox. From is the team address in
// app_settings.invite_sender when one is set (the connected mailbox must have it as a "Send mail as" alias), otherwise
// the connected mailbox itself. One org-level OAuth connection with only the gmail.send scope; tokens live in Vault.
// No SMTP server or password involved.
import { fetchWithTimeout, HttpError } from "./cors.ts";
import { adminClient } from "./supabase.ts";
import { markConnection, setSecret, vaultGet } from "./secrets.ts";
import { googleApp, googleTokenRequest, type GoogleTokens } from "./google.ts";

export const SENDER_SCOPES = ["openid", "email", "https://www.googleapis.com/auth/gmail.send"];
export const SENDER_SECRET = "int_gmail_sender_tokens" as const;
export const DEFAULT_SENDER = "";

/** The team address invitations come from (app_settings.invite_sender.email), or "" to send as the connected mailbox. */
export async function senderAddress(): Promise<string> {
  const { data } = await adminClient().from("app_settings").select("value").eq("key", "invite_sender").maybeSingle();
  return String((data?.value as { email?: string } | null)?.email || DEFAULT_SENDER).toLowerCase();
}

export async function senderTokens(): Promise<GoogleTokens | null> {
  const raw = await vaultGet(SENDER_SECRET).catch(() => null);
  if (!raw) return null;
  try {
    const t = JSON.parse(raw) as GoogleTokens;
    return t.refresh_token ? t : null;
  } catch {
    return null;
  }
}

/** A fresh access token for the sender mailbox. */
export async function senderAccessToken(force = false): Promise<{ token: string; email: string }> {
  const t = await senderTokens();
  if (!t) throw new HttpError(409, "The invite mailbox isn't connected");
  if (!force && t.access_token && Number(t.expires_at ?? 0) > Date.now() + 60_000) return { token: t.access_token, email: t.email || "" };
  const app = await googleApp();
  if (!app) throw new HttpError(409, "The Google OAuth client is not set up");
  try {
    const r = await googleTokenRequest({ grant_type: "refresh_token", client_id: app.client_id, client_secret: app.client_secret, refresh_token: t.refresh_token });
    const next: GoogleTokens = { ...t, access_token: r.access_token, refresh_token: r.refresh_token || t.refresh_token, expires_at: Date.now() + (r.expires_in ?? 3600) * 1000 };
    await setSecret(SENDER_SECRET, JSON.stringify(next));
    return { token: r.access_token, email: t.email || "" };
  } catch (e) {
    const code = (e as Error & { googleCode?: string }).googleCode;
    if (code === "invalid_grant" || code === "unauthorized_client" || code === "invalid_client") {
      await markConnection("gmail_sender", null, "error", "Google access for the invite mailbox was revoked. Reconnect it.");
      throw new HttpError(409, "The invite mailbox needs reconnecting in Admin > Integrations");
    }
    throw e;
  }
}

const b64url = (s: string) => {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
/** RFC 2047 encoding so names and subjects with any characters survive mail headers. */
const hdr = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(s)))}?=`);

/** Builds the raw MIME message (plain text and HTML alternatives). Pure, so it can be tested. */
export function mimeMessage(m: { from: string; fromName: string; to: string; subject: string; text: string; html: string; replyTo?: string }): string {
  const boundary = "roster-" + crypto.randomUUID();
  const lines = [
    `From: ${hdr(m.fromName)} <${m.from}>`,
    `To: ${m.to}`,
    ...(m.replyTo ? [`Reply-To: ${m.replyTo}`] : []),
    `Subject: ${hdr(m.subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    m.text,
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    m.html,
    `--${boundary}--`,
    "",
  ];
  return lines.join("\r\n");
}

/** Sends one email from the connected mailbox. Retries once with a refreshed token on 401. */
export async function sendFromSender(m: { to: string; subject: string; text: string; html: string; fromName: string; replyTo?: string }): Promise<string> {
  let { token } = await senderAccessToken();
  const from = (await senderAddress()) || (await senderTokens())?.email || "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = b64url(mimeMessage({ ...m, from }));
    const r = await fetchWithTimeout("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ raw }),
    }, 20000);
    if (r.status === 401 && attempt === 0) {
      ({ token } = await senderAccessToken(true));
      continue;
    }
    const t = await r.text();
    if (!r.ok) {
      if (/has not been used|is disabled|SERVICE_DISABLED/i.test(t)) {
        throw new HttpError(503, "The Gmail API is off in the Google Cloud project behind the OAuth client. Enable it (APIs & Services > Library > Gmail API), then send again.");
      }
      throw new HttpError(502, `Gmail ${r.status}: ${t.slice(0, 200)}`);
    }
    try {
      return String(JSON.parse(t).id || "");
    } catch {
      return "";
    }
  }
  throw new HttpError(502, "Gmail refused the message");
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

/** The invitation email: short, from a person, one clear button. */
export function inviteEmail(o: { inviter: string; role: string; link: string; to: string }): { subject: string; text: string; html: string } {
  const subject = `${o.inviter} invited you to Stage Prospect`;
  const text = [
    `Hi,`,
    ``,
    `${o.inviter} added you to Stage Prospect, the SDR Control Tower, as ${o.role}.`,
    `Open this link to choose your password (it works once and expires in 24 hours):`,
    o.link,
    ``,
    `Afterwards, sign in any time with this email address and your password.`,
    ``,
    `Stage Prospect`,
  ].join("\n");
  const html = `<!doctype html><html><body style="margin:0;background:#f3f0e8;font-family:Arial,Helvetica,sans-serif;color:#17150f">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f0e8;padding:32px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fffdf9;border:1px solid #e2ddd1;border-radius:16px">
<tr><td style="padding:28px 32px 8px;font-size:13px;color:#5f5b51">Stage Prospect · SDR Control Tower</td></tr>
<tr><td style="padding:4px 32px 0;font-family:Georgia,serif;font-size:28px;line-height:1.15">You're invited to the roster</td></tr>
<tr><td style="padding:14px 32px 0;font-size:15px;line-height:1.6;color:#3a372f">${esc(o.inviter)} added you as <b>${esc(o.role)}</b>. The roster has your researched accounts, contacts, meetings and tasks for the week.</td></tr>
<tr><td style="padding:22px 32px 6px"><a href="${esc(o.link)}" style="display:inline-block;background:#d9502a;color:#ffffff;text-decoration:none;font-weight:bold;font-size:15px;padding:12px 22px;border-radius:999px">Choose your password</a></td></tr>
<tr><td style="padding:10px 32px 28px;font-size:12px;line-height:1.6;color:#8c877b">The button works once and expires in 24 hours. After that, sign in with this email address and your password, or use Forgot password on the sign-in page. This invite was sent to ${esc(o.to)}.</td></tr>
</table></td></tr></table></body></html>`;
  return { subject, text, html };
}
