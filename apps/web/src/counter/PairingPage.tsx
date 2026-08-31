import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiFetch } from '../api/client.js';
import { beginPairingHandoff, persistBootstrap } from '../offline/snapshot.js';
import { Loader2, AlertCircle, CheckCircle, Smartphone } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { CenteredPanel } from '@/components/paxflux/layout';
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
          // The cookie now names a different device session, so the stored
          // configuration no longer describes this browser. Retire it
          // immediately — before the bootstrap that would replace it — so a
          // bootstrap that never succeeds cannot leave the previous
          // identity running the counter. The outbox is untouched: those
          // are real counts, and ownership parks them rather than deleting
          // them.
          await beginPairingHandoff(res.deviceSession.id);

          // Pre-fill the offline cache so the counter opens instantly. This
          // is an optimisation, not part of pairing: /counter fetches its
          // own bootstrap anyway, so a failure here must not turn a
          // successful pairing into an error screen — it is logged and the
          // flow continues.
          try {
            const bootstrap = await apiFetch<DeviceBootstrapResponse>('/api/v1/device/bootstrap');
            // Through the same funnel as every other authoritative state,
            // so this new pairing's identity and its state are stored
            // together and can never describe two different pairings. The
            // funnel refuses a response describing an identity this device
            // is no longer waiting for — a bootstrap in flight when another
            // pairing happens must not put the retired one back in charge.
            const accepted = await persistBootstrap(bootstrap);
            if (!accepted) {
              console.debug('Bootstrap ignored: it does not describe the pairing this device awaits');
            }
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
    <div className="flex-1 flex items-center justify-center p-4 sm:p-6">
      <CenteredPanel
        icon={Smartphone}
        title="Appairage Compteur"
        description="Configuration de l’appareil de comptage terrain..."
        className="text-center"
      >
        {status === 'reading' || status === 'pairing' ? (
          <div className="flex flex-col items-center justify-center gap-3 py-8">
            <Loader2 className="size-8 animate-spin text-primary-accent" />
            <span className="text-sm font-medium text-foreground/90">Connexion et enregistrement...</span>
          </div>
        ) : null}

        {status === 'success' ? (
          <div className="flex flex-col items-center justify-center gap-3 py-8 text-success">
            <CheckCircle className="size-10" />
            <span className="text-base font-semibold">Appairage réussi !</span>
            <span className="text-xs text-muted-foreground">Ouverture de l’interface de comptage...</span>
          </div>
        ) : null}

        {status === 'error' ? (
          <Alert tone="danger" className="my-4 text-left">
            <AlertCircle />
            <div className="min-w-0">
              <AlertTitle>Erreur d’appairage</AlertTitle>
              <AlertDescription>{errorMessage}</AlertDescription>
            </div>
          </Alert>
        ) : null}
      </CenteredPanel>
    </div>
  );
};
