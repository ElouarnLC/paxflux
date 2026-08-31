import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiFetch, setCsrfToken } from '../api/client.js';
import { Lock, Loader2, AlertCircle } from 'lucide-react';
import { AuthSessionResponse } from '@paxflux/shared';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CenteredPanel } from '@/components/paxflux/layout';

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
    <div className="flex-1 flex items-center justify-center p-4 sm:p-6">
      <CenteredPanel
        icon={Lock}
        title="Espace Responsable"
        description="Supervision et administration de l'événement."
      >
        {error ? (
          <Alert tone="danger" className="mt-6">
            <AlertCircle />
            <AlertDescription className="mt-0 text-foreground/90">{error}</AlertDescription>
          </Alert>
        ) : null}

        <form onSubmit={handleLogin} className="mt-6 space-y-4 text-left">
          <div className="space-y-1.5">
            <Label htmlFor="login-username">Nom d'utilisateur</Label>
            <Input
              id="login-username"
              type="text"
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="admin"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="login-password">Mot de passe</Label>
            <Input
              id="login-password"
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••••••"
            />
          </div>

          <Button type="submit" block size="lg" disabled={loading} className="mt-6">
            {loading ? <Loader2 className="animate-spin" /> : null}
            Connexion
          </Button>
        </form>
      </CenteredPanel>
    </div>
  );
};
