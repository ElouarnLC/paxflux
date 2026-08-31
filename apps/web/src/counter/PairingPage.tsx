import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiFetch } from '../api/client.js';
import { persistBootstrap } from '../offline/snapshot.js';
import { Loader2, AlertCircle, CheckCircle, Smartphone } from 'lucide-react';
import { DeviceBootstrapResponse, DeviceSessionModel, ProblemDetails } from '@paxflux/shared';
import { CLIENT_APP_VERSION } from '../version.js';

interface PairDeviceResponse {
  success: boolean;
  deviceSession: Pick<DeviceSessionModel, 'id' | 'label'>;
}

function errorDetail(err: unknown, fallback: string): string {
  if (typeof err === 'object' && err !== null && 'detail' in err) {
    return String((err as ProblemDetails).detail);
  }
  return fallback;
}

export const PairingPage: React.FC = () => {
  const navigate = useNavigate();
  const [status, setStatus] = useState<'reading' | 'pairing' | 'success' | 'error'>('reading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    async function handlePairing() {
      // 1. Read token from URL fragment
      const hash = window.location.hash;
      const rawToken = hash.startsWith('#') ? hash.slice(1).trim() : '';

      // Immediately strip the secret from visible URL and browser history per SPEC §9.2
      window.history.replaceState(null, '', window.location.pathname);

      if (!rawToken) {
        setStatus('error');
        setErrorMessage('Aucun token d’appairage trouvé dans l’URL. Scannez un QR code valide.');
        return;
      }

      setStatus('pairing');

      try {
        // Exchange fragment token for device session cookie
        const res = await apiFetch<PairDeviceResponse>('/api/v1/device/pair', {
          method: 'POST',
          body: JSON.stringify({ token: rawToken, appVersion: CLIENT_APP_VERSION }),
        });

        if (res.success) {
          // Pre-fill the offline cache so the counter opens instantly. This
          // is an optimisation, not part of pairing: /counter fetches its
          // own bootstrap anyway, so a failure here must not turn a
          // successful pairing into an error screen — it is logged and the
          // flow continues.
          try {
            const bootstrap = await apiFetch<DeviceBootstrapResponse>('/api/v1/device/bootstrap');
            // Through the same funnel as every other authoritative state,
            // so this new pairing's identity and its state are stored
            // together and can never describe two different pairings.
            await persistBootstrap(bootstrap);
          } catch (err) {
            console.debug('Bootstrap cache pre-fill failed; the counter will fetch it itself:', err);
          }

          setStatus('success');
          setTimeout(() => {
            navigate('/counter', { replace: true });
          }, 800);
        }
      } catch (err) {
        setStatus('error');
        setErrorMessage(
          errorDetail(err, 'Impossible d’appairer cet appareil. Le QR code a peut-être expiré ou été utilisé.')
        );
      }
    }

    handlePairing();
  }, [navigate]);

  return (
    <div className="min-h-full flex items-center justify-center p-6 bg-slate-950 text-slate-100">
      <div className="max-w-md w-full bg-slate-900 border border-slate-800 rounded-3xl p-8 shadow-2xl text-center">
        <div className="w-16 h-16 rounded-2xl bg-indigo-950/80 border border-indigo-500/30 flex items-center justify-center mx-auto mb-6 text-indigo-400">
          <Smartphone className="w-8 h-8" />
        </div>

        <h1 className="text-2xl font-bold tracking-tight text-white mb-2">Appairage Compteur</h1>
        <p className="text-slate-400 text-sm mb-6">Configuration de l’appareil de comptage terrain...</p>

        {status === 'reading' || status === 'pairing' ? (
          <div className="py-8 flex flex-col items-center justify-center gap-3">
            <Loader2 className="w-8 h-8 animate-spin text-indigo-400" />
            <span className="text-sm font-medium text-slate-300">Connexion et enregistrement...</span>
          </div>
        ) : null}

        {status === 'success' ? (
          <div className="py-8 flex flex-col items-center justify-center gap-3 text-emerald-400">
            <CheckCircle className="w-10 h-10 animate-bounce" />
            <span className="text-base font-semibold">Appairage réussi !</span>
            <span className="text-xs text-slate-400">Ouverture de l’interface de comptage...</span>
          </div>
        ) : null}

        {status === 'error' ? (
          <div className="p-4 rounded-2xl bg-rose-950/40 border border-rose-500/30 text-rose-300 text-sm text-left flex gap-3 items-start my-4">
            <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5 text-rose-400" />
            <div>
              <p className="font-semibold text-rose-200">Erreur d’appairage</p>
              <p className="text-xs text-rose-300/80 mt-1">{errorMessage}</p>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
};
