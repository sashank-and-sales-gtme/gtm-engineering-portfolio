import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import type { ReactElement } from 'react';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import Login from './pages/Login';
import OAuthCallback from './pages/OAuthCallback';
import Signup from './pages/Signup';
import { session } from './lib/api';

function RequireAuth({ children }: { children: ReactElement }) {
  return session.get() ? children : <Navigate to="/login" replace />;
}

export default function App() {
  return (
    <BrowserRouter>
      <Layout>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/signup" element={<Signup />} />
          <Route path="/dashboard" element={<RequireAuth><Dashboard /></RequireAuth>} />
          <Route path="/oauth/callback" element={<RequireAuth><OAuthCallback /></RequireAuth>} />
          <Route path="*" element={<Navigate to={session.get() ? '/dashboard' : '/login'} replace />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  );
}
