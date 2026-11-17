import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';

export default function OAuthCallback() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const sent = useRef(false);

  useEffect(() => {
    if (sent.current) return; // StrictMode runs effects twice in development; the state value is single-use
    sent.current = true;
    const code = params.get('code');
    const state = params.get('state');
    const denied = params.get('error_description') || params.get('error');
    if (denied) return setError(`The provider did not grant access: ${denied}`);
    if (!code || !state) return setError('The provider returned no authorization code.');
    api.callback(code, state)
      .then(() => navigate('/dashboard', { replace: true }))
      .catch((err) => setError(err instanceof Error ? err.message : 'Connection failed'));
  }, [params, navigate]);

  if (error) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-bold text-ink">Connection failed</h1>
        <p className="text-red-700">{error}</p>
        <Link className="text-accent hover:underline" to="/dashboard">Back to connections</Link>
      </div>
    );
  }
  return <p className="text-ink font-semibold">Finishing the connection…</p>;
}
