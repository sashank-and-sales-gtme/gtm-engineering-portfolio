// Run: deno test roster/supabase/functions/_shared/gmail_test.ts
import { inviteEmail, mimeMessage } from "./gmail.ts";

function assert(c: unknown, msg: string) {
  if (!c) throw new Error(msg);
}
Deno.test("the invite names the inviter and role, links once, and escapes HTML", () => {
  const m = inviteEmail({ inviter: "Sashank <K>", role: "SDR", link: "https://x.supabase.co/auth/v1/verify?token=a&type=invite", to: "new@example.com" });
  assert(m.subject.includes("Sashank <K>"), "subject names the inviter");
  assert(m.text.includes("https://x.supabase.co/auth/v1/verify?token=a&type=invite"), "plain text carries the raw link");
  assert(m.html.includes("Sashank &lt;K&gt;") && !m.html.includes("Sashank <K>"), "html escapes names");
  assert(m.html.includes("token=a&amp;type=invite"), "html escapes the link");
});
Deno.test("the MIME message has both parts, a From name and encoded non-ASCII headers", () => {
  const raw = mimeMessage({ from: "sales@example.com", fromName: "Stage Prospect", to: "a@example.com", subject: "Café invite", text: "hi", html: "<p>hi</p>", replyTo: "s@example.com" });
  assert(raw.includes("From: Stage Prospect <sales@example.com>"), "from header");
  assert(raw.includes("Reply-To: s@example.com"), "reply-to header");
  assert(/Subject: =\?UTF-8\?B\?/.test(raw), "subject is RFC 2047 encoded");
  assert(raw.includes("text/plain") && raw.includes("text/html"), "both parts");
  assert(raw.includes("\r\n"), "CRLF line endings");
});
