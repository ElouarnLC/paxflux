import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiFetch, setCsrfToken } from '../api/client.js';
import { ShieldCheck, Loader2, AlertCircle } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CenteredPanel } from '@/components/paxflux/layout';

export const SetupPage: React.FC = () => {
  const navigate = useNavigate();
  const [setupToken, setSetupToken] = useState('');
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [instanceName, setInstanceName] = useState('PaxFlux');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSetup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirmPassword) {
      setError('Les mots de passe ne correspondent pas.');
      return;
    }
    if (password.length < 8) {
      setError('Le mot de passe doit comporter au moins 8 caractères.');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const res = await apiFetch<{ user: any; csrfToken: string }>('/api/v1/setup', {
        method: 'POST',
        body: JSON.stringify({
          setupToken: setupToken.trim(),
          username: username.trim(),
          password,
          instanceName: instanceName.trim(),
        }),
      });

      setCsrfToken(res.csrfToken);
      navigate('/admin/events/new', { replace: true });
    } catch (err: any) {
      setError(err.detail || 'Erreur lors de la configuration initiale.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex-1 flex items-center justify-center p-4 sm:p-6">
      <CenteredPanel
        icon={ShieldCheck}
        title="Initialisation PaxFlux"
        description={
          <>
            Saisissez le setup token généré lors du premier démarrage du conteneur (disponible dans les
            logs serveur ou <code className="text-primary-accent">/data/setup-token.txt</code>).
          </>
        }
      >
        {error ? (
          <Alert tone="danger" className="mt-6">
            <AlertCircle />
            <AlertDescription className="mt-0 text-foreground/90">{error}</AlertDescription>
          </Alert>
        ) : null}

        <form onSubmit={handleSetup} className="mt-6 space-y-4 text-left">
          <div className="space-y-1.5">
            <Label htmlFor="setup-token">Setup Token *</Label>
            <Input
              id="setup-token"
              type="text"
              required
              value={setupToken}
              onChange={(e) => setSetupToken(e.target.value)}
              placeholder="f5aa4d232bc..."
              className="font-mono"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="setup-instance">Nom de l'instance</Label>
            <Input
              id="setup-instance"
              type="text"
              value={instanceName}
              onChange={(e) => setInstanceName(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="setup-username">Nom d'administrateur *</Label>
            <Input
              id="setup-username"
              type="text"
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="setup-password">Mot de passe administrateur *</Label>
            <Input
              id="setup-password"
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••••••"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="setup-password-confirm">Confirmer le mot de passe *</Label>
            <Input
              id="setup-password-confirm"
              type="password"
              required
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="••••••••••••"
            />
          </div>

          <Button type="submit" block size="lg" disabled={loading} className="mt-6">
            {loading ? <Loader2 className="animate-spin" /> : null}
            Créer le compte et démarrer
          </Button>
        </form>
      </CenteredPanel>
    </div>
  );
};
