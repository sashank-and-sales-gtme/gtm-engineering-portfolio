const API_URL = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/+$/, '') || 'http://localhost:8000';
const TOKEN_KEY = 'rover_token';

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const session = {
  get: () => sessionStorage.getItem(TOKEN_KEY),
  set: (token: string) => sessionStorage.setItem(TOKEN_KEY, token),
  clear: () => sessionStorage.removeItem(TOKEN_KEY),
};

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const token = session.get();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !(init.body instanceof URLSearchParams)) headers.set('Content-Type', 'application/json');
  const res = await fetch(`${API_URL}${path}`, { ...init, headers });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && path !== '/token') session.clear();
    const detail = Array.isArray(body.detail) ? body.detail.map((d: { msg: string }) => d.msg).join('; ') : body.detail;
    throw new ApiError(res.status, detail || `Request failed (${res.status})`);
  }
  return body as T;
}

export interface Provider {
  name: string;
  label: string;
  category: 'crm' | 'chat';
  configured: boolean;
  connected: boolean;
}

export interface Credential {
  id: number;
  provider: string;
  provider_account: string | null;
  scope: string | null;
  expires_at: string | null;
  n8n_credential_id: string | null;
  n8n_credential_type: string | null;
  n8n_sync_error: string | null;
  created_at: string;
}

export const api = {
  login: (email: string, password: string, mfaCode?: string) => {
    const form = new URLSearchParams({ username: email, password });
    if (mfaCode) form.set('mfa_code', mfaCode);
    return request<{ access_token: string }>('/token', { method: 'POST', body: form });
  },
  signup: (email: string, password: string) =>
    request('/users', { method: 'POST', body: JSON.stringify({ email, password }) }),
  providers: () => request<Provider[]>('/oauth/providers'),
  credentials: () => request<Credential[]>('/oauth/credentials'),
  authorize: (provider: string) =>
    request<{ authorization_url: string }>(`/oauth/${provider}/authorize`, { method: 'POST' }),
  callback: (code: string, state: string) =>
    request<Credential>('/oauth/callback', { method: 'POST', body: JSON.stringify({ code, state }) }),
  disconnect: (id: number) => request<void>(`/oauth/credentials/${id}`, { method: 'DELETE' }),
};
