import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import { apiFetch, setCsrfToken, setUnauthorizedHandler } from '../api/client.js';
import { AuthSessionResponse, ProblemDetails, StaffUser } from '@paxflux/shared';
import { AlertTriangle, RefreshCw } from 'lucide-react';

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

function isUnauthorized(err: unknown): err is ProblemDetails {
  return typeof err === 'object' && err !== null && (err as ProblemDetails).status === 401;
}

type BootstrapState =
  | { kind: 'loading' }
  | { kind: 'authenticated'; user: StaffUser }
  | { kind: 'redirecting' }
  | { kind: 'error'; detail: string };

/**
 * Router layout element guarding every /admin/* route. Re-hydrates the
 * staff session and CSRF token on mount — regardless of which admin route
 * was loaded directly (bookmark, hard refresh) — so no mutation is ever
 * attempted before a fresh CSRF token is in memory.
 *
 * Only a real 401 (missing or expired session) sends the user back to
 * /login. A network failure or a 5xx from the server is not a logout: it
 * shows an error state with a Retry action instead, since the session may
 * well still be valid.
 */
export const AuthProvider: React.FC = () => {
  const navigate = useNavigate();
  const [state, setState] = useState<BootstrapState>({ kind: 'loading' });

  const refreshSession = useCallback(async () => {
    setState((prev) => (prev.kind === 'authenticated' ? prev : { kind: 'loading' }));
    try {
      const res = await apiFetch<AuthSessionResponse>('/api/v1/auth/session');
      setCsrfToken(res.csrfToken);
      setState({ kind: 'authenticated', user: res.user });
    } catch (err) {
      if (isUnauthorized(err)) {
        setCsrfToken(null);
        setState({ kind: 'redirecting' });
        navigate('/login', { replace: true });
        return;
      }
      const detail =
        typeof err === 'object' && err !== null && 'detail' in err
          ? String((err as ProblemDetails).detail)
          : 'Impossible de contacter le serveur. Vérifiez votre connexion.';
      setState({ kind: 'error', detail });
    }
  }, [navigate]);

  useEffect(() => {
    refreshSession();
  }, [refreshSession]);

  // While mounted, any API call anywhere under this layout that comes back
  // 401 (session expired mid-use) sends the user back to /login too. A
  // network/5xx failure on a later call is left to that call's own error
  // handling — it doesn't tear down an otherwise-valid session.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setCsrfToken(null);
      setState({ kind: 'redirecting' });
      navigate('/login', { replace: true });
    });
    return () => setUnauthorizedHandler(null);
  }, [navigate]);

  if (state.kind === 'loading' || state.kind === 'redirecting') {
    return (
      <div className="flex-1 flex items-center justify-center bg-slate-950 text-slate-400">
        <RefreshCw className="w-8 h-8 animate-spin text-indigo-400" />
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <div className="flex-1 flex items-center justify-center p-6 bg-slate-950 text-slate-100">
        <div className="max-w-md w-full bg-slate-900 border border-slate-800 rounded-3xl p-8 shadow-2xl text-center">
          <div className="w-14 h-14 rounded-2xl bg-rose-950/80 border border-rose-500/30 flex items-center justify-center mx-auto mb-6 text-rose-400">
            <AlertTriangle className="w-8 h-8" />
          </div>
          <h1 className="text-xl font-bold text-white mb-2">Connexion au serveur impossible</h1>
          <p className="text-slate-400 text-sm mb-6">{state.detail}</p>
          <button
            type="button"
            onClick={() => {
              refreshSession();
            }}
            className="inline-flex items-center justify-center gap-2 min-h-11 px-5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-sm shadow-lg transition-all"
          >
            <RefreshCw className="w-4 h-4" />
            Réessayer
          </button>
        </div>
      </div>
    );
  }

  return (
    <AuthContext.Provider value={{ user: state.user, refreshSession }}>
      <Outlet />
    </AuthContext.Provider>
  );
};
