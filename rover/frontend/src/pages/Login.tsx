import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError, session } from '../lib/api';

const input = 'w-full border border-gray-300 rounded px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent';

export default function Login() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [needsMfa, setNeedsMfa] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { access_token } = await api.login(email, password, needsMfa ? mfaCode : undefined);
      session.set(access_token);
      navigate('/dashboard');
    } catch (err) {
      if (err instanceof ApiError && err.message === 'mfa_required') {
        setNeedsMfa(true);
      } else {
        setError(err instanceof Error ? err.message : 'Sign-in failed');
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <h1 className="text-2xl font-bold text-ink">Sign in</h1>
      {error && <p role="alert" className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded">{error}</p>}
      <input className={input} type="email" required autoComplete="email" placeholder="Email"
        value={email} onChange={(e) => setEmail(e.target.value)} />
      <input className={input} type="password" required autoComplete="current-password" placeholder="Password"
        value={password} onChange={(e) => setPassword(e.target.value)} />
      {needsMfa && (
        <input className={input} inputMode="numeric" autoComplete="one-time-code" placeholder="6-digit code from your authenticator"
          value={mfaCode} onChange={(e) => setMfaCode(e.target.value)} autoFocus required />
      )}
      <button type="submit" disabled={loading}
        className="w-full bg-ink hover:bg-accent disabled:bg-gray-400 text-white font-semibold rounded py-2 transition">
        {loading ? 'Signing in…' : needsMfa ? 'Verify and sign in' : 'Sign in'}
      </button>
      <p className="text-sm text-center">
        No account? <Link className="text-accent hover:underline" to="/signup">Create one</Link>
      </p>
    </form>
  );
}
