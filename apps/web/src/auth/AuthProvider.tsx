import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import { apiFetch, setCsrfToken, setUnauthorizedHandler } from '../api/client.js';
import { AuthSessionResponse, StaffUser } from '@paxflux/shared';
import { RefreshCw } from 'lucide-react';

interface AuthContextValue {
  user: StaffUser;
  refreshSession: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within <AuthProvider>');
  }
  return ctx;
}

/**
 * Router layout element guarding every /admin/* route. Re-hydrates the
 * staff session and CSRF token on mount — regardless of which admin route
 * was loaded directly (bookmark, hard refresh) — so no mutation is ever
 * attempted before a fresh CSRF token is in memory, and any 401 (missing
 * or expired session) sends the user back to /login.
 */
export const AuthProvider: React.FC = () => {
  const navigate = useNavigate();
  const [user, setUser] = useState<StaffUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshSession = useCallback(async () => {
    try {
      const res = await apiFetch<AuthSessionResponse>('/api/v1/auth/session');
      setCsrfToken(res.csrfToken);
      setUser(res.user);
    } catch {
      setCsrfToken(null);
      setUser(null);
      navigate('/login', { replace: true });
    } finally {
      setLoading(false);
    }
  }, [navigate]);

  useEffect(() => {
    refreshSession();
  }, [refreshSession]);

  // While mounted, any API call anywhere under this layout that comes back
  // 401 (session expired mid-use) sends the user back to /login too.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setCsrfToken(null);
      setUser(null);
      navigate('/login', { replace: true });
    });
    return () => setUnauthorizedHandler(null);
  }, [navigate]);

  if (loading) {
    return (
      <div className="min-h-full flex items-center justify-center bg-slate-950 text-slate-400">
        <RefreshCw className="w-8 h-8 animate-spin text-indigo-400" />
      </div>
    );
  }

  if (!user) {
    // refreshSession() already triggered the redirect to /login above;
    // render nothing while that navigation takes effect.
    return null;
  }

  return (
    <AuthContext.Provider value={{ user, refreshSession }}>
      <Outlet />
    </AuthContext.Provider>
  );
};
