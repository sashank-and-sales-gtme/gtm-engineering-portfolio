// Email and password sign-in. Accounts are invite-only (the database refuses anyone who isn't the owner or invited),
// so "Create account" is for the owner's first sign-in and for invited people who'd rather type a password than use
// the invite link. Invite and reset links land signed in and then ask for a password (SetPassword).
import { useState, type FormEvent } from "react";
import { MIN_PASSWORD, supabase } from "../lib/supabase";

type Mode = "signin" | "signup" | "forgot";

/** Supabase's error text, made readable for the cases people actually hit. */
function authMessage(m: string): string {
  if (/invalid login credentials/i.test(m)) return "That email and password don't match. Try again or reset your password.";
  if (/email not confirmed/i.test(m)) return "Confirm your email first: open the link we sent you, then sign in.";
  if (/invitation only|database error saving new user/i.test(m)) return "Stage Prospect is invite-only. Ask your workspace admin to invite this email address.";
  if (/already registered/i.test(m)) return "This email already has an account. Sign in, or reset your password.";
  if (/rate limit/i.test(m)) return "Too many emails were sent just now. Wait a few minutes and try again.";
  // Supabase's built-in sender only mails addresses on the Supabase team until custom SMTP is set up.
  if (/not authorized|error sending/i.test(m)) return "We couldn't email this address yet. Ask your workspace admin to send you a sign-in link from Admin > Users.";
  return m;
}

export function SignInForm({ linkError }: { linkError?: string }) {
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(linkError ? authMessage(linkError) : "");
  const [note, setNote] = useState("");

  const go = (m: Mode) => {
    setMode(m);
    setErr("");
    setNote("");
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    const addr = email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) return setErr("Enter your email address.");
    if (mode !== "forgot" && password.length < MIN_PASSWORD) return setErr(`Passwords have at least ${MIN_PASSWORD} characters.`);
    setBusy(true);
    setErr("");
    setNote("");
    try {
      if (mode === "signin") {
        const { error } = await supabase.auth.signInWithPassword({ email: addr, password });
        if (error) setErr(authMessage(error.message));
      } else if (mode === "signup") {
        const { data, error } = await supabase.auth.signUp({ email: addr, password, options: { emailRedirectTo: window.location.origin } });
        if (error) setErr(authMessage(error.message));
        else if (!data.session) setNote(`Check ${addr} for a confirmation link, then sign in.`);
      } else {
        const { error } = await supabase.auth.resetPasswordForEmail(addr, { redirectTo: window.location.origin });
        if (error) setErr(authMessage(error.message));
        else setNote(`If ${addr} has an account, a reset link is on its way.`);
      }
    } finally {
      setBusy(false);
    }
  }

  const title = mode === "signin" ? "Sign in" : mode === "signup" ? "Create your account" : "Reset your password";
  return (
    <form className="auth-form" onSubmit={submit} noValidate>
      <h2>{title}</h2>
      <p>
        {mode === "signin"
          ? "Welcome back to Stage Prospect."
          : mode === "signup"
            ? "For the workspace owner and invited people. Use the email address your invite went to."
            : "We'll email you a link to choose a new password."}
      </p>
      <label>
        Email
        <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
      </label>
      {mode !== "forgot" ? (
        <label>
          Password
          <input
            type="password"
            autoComplete={mode === "signup" ? "new-password" : "current-password"}
            minLength={MIN_PASSWORD}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
      ) : null}
      {err ? <p className="err" role="alert">{err}</p> : null}
      {note ? <p role="status">{note}</p> : null}
      <button className="btn big wide" type="submit" disabled={busy}>
        {busy ? "One moment…" : mode === "signin" ? "Sign in" : mode === "signup" ? "Create account" : "Send reset link"}
      </button>
      <div className="auth-links">
        {mode !== "signin" ? <button type="button" className="linkbtn" onClick={() => go("signin")}>Back to sign in</button> : null}
        {mode === "signin" ? <button type="button" className="linkbtn" onClick={() => go("forgot")}>Forgot password?</button> : null}
        {mode === "signin" ? <button type="button" className="linkbtn" onClick={() => go("signup")}>Invited? Create your account</button> : null}
      </div>
    </form>
  );
}

/** Shown after an invite or password-reset link: the person is signed in and picks a password. */
export function SetPasswordForm({ invited, onDone }: { invited: boolean; onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password.length < MIN_PASSWORD) return setErr(`Use at least ${MIN_PASSWORD} characters.`);
    if (password !== again) return setErr("The two passwords don't match.");
    setBusy(true);
    setErr("");
    const { error } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (error) return setErr(authMessage(error.message));
    onDone();
  }

  return (
    <form className="auth-form" onSubmit={submit} noValidate>
      <h2>{invited ? "Welcome aboard" : "Choose a new password"}</h2>
      <p>{invited ? "Choose a password. You'll sign in with your email and this password from now on." : "Pick a new password for your account."}</p>
      <label>
        New password
        <input type="password" autoComplete="new-password" minLength={MIN_PASSWORD} value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus />
      </label>
      <label>
        Repeat it
        <input type="password" autoComplete="new-password" minLength={MIN_PASSWORD} value={again} onChange={(e) => setAgain(e.target.value)} required />
      </label>
      {err ? <p className="err" role="alert">{err}</p> : null}
      <button className="btn big wide" type="submit" disabled={busy}>
        {busy ? "Saving…" : "Save password"}
      </button>
    </form>
  );
}
