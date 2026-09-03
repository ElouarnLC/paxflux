import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiFetch } from '../api/client.js';
import { beginPairingHandoff, persistBootstrap, persistCurrentDeviceLabel } from '../offline/snapshot.js';
import { Loader2, AlertCircle, CheckCircle, Smartphone } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CenteredPanel } from '@/components/paxflux/layout';
import {
  DEVICE_LABEL_MAX_LENGTH,
  DeviceBootstrapResponse,
  DeviceSessionModel,
  ProblemDetails,
  RenameDeviceResponse,
} from '@paxflux/shared';
import { CLIENT_APP_VERSION } from '../version.js';
import { useInstallPrompt } from '../pwa/useInstallPrompt.js';
import { shouldOfferInstall } from '../pwa/install-state.js';
import { HAPTIC_TEST_PATTERN, HapticReport, describeHapticOutcome, vibrate } from './haptics.js';
import { Download, Vibrate } from 'lucide-react';

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

  /**
   * The identity this phone was given, and what the operator may rename it
   * to.
   *
   * Pairing is already complete by the time any of this is on screen. The
   * naming step is a courtesy afterwards, never a condition: the previous
   * version navigated away on an 800ms timer, which gave a field operator no
   * chance to say which handset this is and no way to read the name it got.
   */
  const [pairedSession, setPairedSession] = useState<Pick<DeviceSessionModel, 'id' | 'label'> | null>(null);
  const [label, setLabel] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);

  /**
   * The browser's own install offer, if it made one.
   *
   * Progressive enhancement: no install API, an insecure origin, or an
   * already-installed window all produce no button, and pairing and counting
   * work identically either way. PaxFlux cannot make a browser install
   * anything and does not pretend to — the CTA appears only when the browser
   * has handed over a real prompt.
   */
  const { state: installState, promptToInstall } = useInstallPrompt();

  /**
   * The result of the last `Tester la vibration`, if it was pressed.
   *
   * Pairing is the one moment an operator is holding the phone, not yet at a
   * door, and can find out whether it buzzes — before a shift where a silent
   * handset would be read as a missed tap. It is a diagnostic and nothing
   * more: no state is stored, the answer is not sent anywhere, and counting
   * is unaffected either way.
   */
  const [hapticReport, setHapticReport] = useState<HapticReport | null>(null);

  const testVibration = () => {
    // Synchronous, inside the click handler: the API requires user
    // activation, and deferring the call past it is itself a refusal.
    setHapticReport(describeHapticOutcome(vibrate(HAPTIC_TEST_PATTERN)));
  };

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

          setPairedSession(res.deviceSession);
          setLabel(res.deviceSession.label);
          setStatus('success');
        }
      } catch (err) {
        setStatus('error');
        setErrorMessage(
          errorDetail(err, 'Impossible d’appairer cet appareil. Le QR code a peut-être expiré ou été utilisé.')
        );
      }
    }

    // Runs once. `navigate` is deliberately not a dependency any more: the
    // pairing effect no longer navigates — the operator does, from the
    // completion step below.
    handlePairing();
  }, []);

  const continueToCounter = () => navigate('/counter', { replace: true });

  /**
   * Saves the name, then continues — and continues anyway if it fails.
   *
   * Pairing succeeded before this button existed. A rename that the server
   * refuses is a naming problem, not a pairing problem, so it is shown and
   * the operator can go on counting under the generated label. Nothing here
   * re-consumes the QR token, re-runs the handoff or creates a session: it
   * is one authenticated PATCH against the session this phone already holds.
   */
  const saveNameAndContinue = async () => {
    if (!pairedSession) return;
    const trimmed = label.trim();

    // Nothing to say to the server if the name is unchanged.
    if (trimmed === pairedSession.label) {
      continueToCounter();
      return;
    }

    setRenaming(true);
    setRenameError(null);
    try {
      const res = await apiFetch<RenameDeviceResponse>('/api/v1/device/session', {
        method: 'PATCH',
        body: JSON.stringify({ label: trimmed }),
      });
      // The canonical label the server stored, into the local bootstrap the
      // counter reads. Identity-guarded inside: if the bootstrap pre-fill
      // never landed there is nothing to update, and the counter's own
      // bootstrap fetch will carry the new label instead.
      await persistCurrentDeviceLabel(res.deviceSession.id, res.deviceSession.label);
      continueToCounter();
    } catch (err) {
      setRenameError(errorDetail(err, 'Ce nom n’a pas pu être enregistré.'));
    } finally {
      setRenaming(false);
    }
  };

  const trimmedLabel = label.trim();
  const labelIsValid = trimmedLabel.length > 0 && trimmedLabel.length <= DEVICE_LABEL_MAX_LENGTH;

  return (
    <div className="flex-1 flex items-center justify-center p-4 sm:p-6">
      <CenteredPanel
        icon={Smartphone}
        title="Appairage compteur"
        description="Configuration de l’appareil de comptage terrain..."
        className="text-center"
      >
        {status === 'reading' || status === 'pairing' ? (
          <div className="flex flex-col items-center justify-center gap-3 py-8">
            <Loader2 className="size-8 animate-spin text-primary-accent" />
            <span className="text-sm font-medium text-foreground/90">Connexion et enregistrement...</span>
          </div>
        ) : null}

        {status === 'success' && pairedSession ? (
          <div className="flex flex-col gap-4 py-6 text-left">
            <div className="flex flex-col items-center gap-2 text-success">
              <CheckCircle className="size-10" />
              <span className="text-base font-semibold">Appairage réussi</span>
            </div>

            {/* Naming is optional and says so. The generated name is already
                stored and already works; this only exists so the operator
                can say which physical phone this is. */}
            <div className="space-y-1.5">
              <Label htmlFor="device-label">Nom de cet appareil</Label>
              <Input
                id="device-label"
                value={label}
                maxLength={DEVICE_LABEL_MAX_LENGTH}
                autoComplete="off"
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Ex : téléphone entrée nord"
              />
              <p className="text-xs text-muted-foreground">
                Ce nom identifie le téléphone, pas la porte. Il reste modifiable plus tard.
              </p>
            </div>

            {renameError ? (
              <Alert tone="danger" className="text-left">
                <AlertCircle />
                <div className="min-w-0">
                  <AlertTitle>Nom non enregistré</AlertTitle>
                  <AlertDescription>
                    {renameError} L’appairage reste valide : vous pouvez continuer avec «&nbsp;
                    {pairedSession.label}&nbsp;».
                  </AlertDescription>
                </div>
              </Alert>
            ) : null}

            {shouldOfferInstall(installState) ? (
              <Button
                variant="secondary"
                onClick={promptToInstall}
                data-testid="install-app"
                block
              >
                <Download />
                Installer l’application
              </Button>
            ) : null}

            <div className="flex flex-col gap-2">
              <Button onClick={saveNameAndContinue} disabled={renaming || !labelIsValid} block>
                {renaming ? <Loader2 className="animate-spin" /> : null}
                Continuer avec ce nom
              </Button>
              <Button variant="secondary" onClick={continueToCounter} disabled={renaming} block>
                Continuer sans renommer
              </Button>
            </div>

            {/* Below the way out, on purpose. This is a diagnostic — it
                re-pairs nothing, counts nothing and navigates nowhere — and
                on a 320px handset a secondary action that pushes `Continuer`
                off the fold has made the screen worse to reach a phone's
                vibration motor. */}
            <Button variant="ghost" onClick={testVibration} data-testid="test-haptics" block>
              <Vibrate />
              Tester la vibration
            </Button>

            {hapticReport ? (
              <Alert
                tone={hapticReport.tone}
                className="text-left"
                data-testid="haptic-result"
                data-haptic-outcome={hapticReport.outcome}
              >
                <Vibrate />
                <AlertDescription>{hapticReport.message}</AlertDescription>
              </Alert>
            ) : null}
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
