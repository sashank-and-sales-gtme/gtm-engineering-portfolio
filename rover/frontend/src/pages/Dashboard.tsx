import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, session, type Credential, type Provider } from '../lib/api';

const SECTIONS: { key: Provider['category']; title: string }[] = [
  { key: 'crm', title: 'CRMs' },
  { key: 'chat', title: 'Team chat' },
];

export default function Dashboard() {
  const navigate = useNavigate();
  const [providers, setProviders] = useState<Provider[]>([]);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const [p, c] = await Promise.all([api.providers(), api.credentials()]);
      setProviders(p);
      setCredentials(c);
    } catch (err) {
      if (!session.get()) navigate('/login');
      else setError(err instanceof Error ? err.message : 'Could not load connections');
    }
  }, [navigate]);

  useEffect(() => { void load(); }, [load]);

  async function connect(provider: string) {
    setBusy(provider);
    setError('');
    try {
      const { authorization_url } = await api.authorize(provider);
      window.location.assign(authorization_url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the connection');
      setBusy(null);
    }
  }

  async function disconnect(cred: Credential) {
    setBusy(cred.provider);
    try {
      await api.disconnect(cred.id);
      await load();
    } finally {
      setBusy(null);
    }
  }

  function signOut() {
    session.clear();
    navigate('/login');
  }

  const byProvider = Object.fromEntries(credentials.map((c) => [c.provider, c]));

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-ink">Connections</h1>
          <p className="text-gray-600 text-sm mt-1">
            Connect your CRM and team chat once. Rover hands the credentials to n8n so the research and alert workflows run in your accounts.
          </p>
        </div>
        <button onClick={signOut} className="text-sm text-gray-500 hover:text-ink">Sign out</button>
      </div>
      {error && <p role="alert" className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded">{error}</p>}
      {SECTIONS.map(({ key, title }) => (
        <section key={key}>
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-2">{title}</h2>
          <ul className="space-y-2">
            {providers.filter((p) => p.category === key).map((p) => {
              const cred = byProvider[p.name];
              return (
                <li key={p.name} className="border border-gray-200 rounded-lg px-4 py-3 flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="font-semibold text-ink">{p.label}</p>
                    {cred ? (
                      <p className="text-xs text-gray-600 truncate">
                        {cred.provider_account || 'Connected'} ·{' '}
                        {cred.n8n_credential_id
                          ? <span className="text-green-700">in n8n ({cred.n8n_credential_type})</span>
                          : <span className="text-amber-700" title={cred.n8n_sync_error || ''}>not in n8n: {cred.n8n_sync_error}</span>}
                      </p>
                    ) : (
                      <p className="text-xs text-gray-500">{p.configured ? 'Not connected' : 'Not configured on this server'}</p>
                    )}
                  </div>
                  {cred ? (
                    <button disabled={busy === p.name} onClick={() => disconnect(cred)}
                      className="text-sm border border-gray-300 rounded px-3 py-1.5 hover:bg-gray-50 disabled:opacity-50">
                      Disconnect
                    </button>
                  ) : (
                    <button disabled={!p.configured || busy === p.name} onClick={() => connect(p.name)}
                      className="text-sm bg-accent hover:bg-ink text-white rounded px-3 py-1.5 disabled:bg-gray-300">
                      {busy === p.name ? 'Opening…' : 'Connect'}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
