import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, session } from '../lib/api';

const input = 'w-full border border-gray-300 rounded px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent';

export default function Signup() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (password !== confirm) return setError('Passwords do not match');
    if (password.length < 10) return setError('Use at least 10 characters');
    setLoading(true);
    try {
      await api.signup(email, password);
      const { access_token } = await api.login(email, password);
      session.set(access_token);
      navigate('/dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-up failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <h1 className="text-2xl font-bold text-ink">Create an account</h1>
      {error && <p role="alert" className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded">{error}</p>}
      <input className={input} type="email" required autoComplete="email" placeholder="Work email"
        value={email} onChange={(e) => setEmail(e.target.value)} />
      <input className={input} type="password" required autoComplete="new-password" placeholder="Password (10+ characters)"
        value={password} onChange={(e) => setPassword(e.target.value)} />
      <input className={input} type="password" required autoComplete="new-password" placeholder="Confirm password"
        value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      <button type="submit" disabled={loading}
        className="w-full bg-ink hover:bg-accent disabled:bg-gray-400 text-white font-semibold rounded py-2 transition">
        {loading ? 'Creating account…' : 'Create account'}
      </button>
      <p className="text-sm text-center">
        Already registered? <Link className="text-accent hover:underline" to="/login">Sign in</Link>
      </p>
    </form>
  );
}
