import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiFetch, setCsrfToken } from '../api/client.js';
import { Lock, Loader2, AlertCircle } from 'lucide-react';
import { AuthSessionResponse } from '@paxflux/shared';

export const LoginPage: React.FC = () => {
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const res = await apiFetch<AuthSessionResponse>('/api/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username: username.trim(), password }),
      });

      setCsrfToken(res.csrfToken);
      navigate('/admin', { replace: true });
    } catch (err: any) {
      setError(err.detail || 'Identifiants incorrects.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-full flex items-center justify-center p-4 sm:p-6 bg-slate-950 text-slate-100">
      <div className="max-w-md w-full bg-slate-900 border border-slate-800 rounded-3xl p-6 sm:p-8 shadow-2xl">
        <div className="w-14 h-14 rounded-2xl bg-indigo-950/80 border border-indigo-500/30 flex items-center justify-center mx-auto mb-6 text-indigo-400">
          <Lock className="w-8 h-8" />
        </div>

        <h1 className="text-2xl font-bold text-center text-white mb-2">Espace Responsable</h1>
        <p className="text-slate-400 text-xs text-center mb-6">
          Supervision et administration de l'événement.
        </p>

        {error ? (
          <div className="mb-6 p-3.5 rounded-2xl bg-rose-950/50 border border-rose-500/40 text-rose-300 text-xs flex gap-2.5 items-start">
            <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5 text-rose-400" />
            <span>{error}</span>
          </div>
        ) : null}

        <form onSubmit={handleLogin} className="space-y-4 text-left">
          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1.5">Nom d'utilisateur</label>
            <input
              type="text"
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="admin"
              className="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-white text-base md:text-sm focus:border-indigo-500 transition-colors"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1.5">Mot de passe</label>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••••••"
              className="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-white text-base md:text-sm focus:border-indigo-500 transition-colors"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full min-h-11 mt-6 py-3 px-4 rounded-xl bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 text-white font-bold text-sm shadow-lg shadow-indigo-950/60 transition-all flex items-center justify-center gap-2"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
            Connexion
          </button>
        </form>
      </div>
    </div>
  );
};
