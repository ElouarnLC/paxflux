import { useCallback, useEffect, useState } from 'react';
import { InstallPromptEvent, InstallState, describeInstallState, detectStandalone } from './install-state.js';

/**
 * Captures the browser's install prompt, if it offers one.
 *
 * Progressive enhancement in the strict sense: a browser with no install API
 * produces `'unavailable'` and no UI, and the counter is fully functional
 * either way. Nothing here tries to provoke a prompt the browser has not
 * offered.
 *
 * The decision itself lives in `install-state.ts` so it can be tested without
 * a browser; this hook only feeds it what the browser said.
 */
export function useInstallPrompt(): { state: InstallState; promptToInstall: () => Promise<void> } {
  const [promptEvent, setPromptEvent] = useState<InstallPromptEvent | null>(null);
  const [standalone, setStandalone] = useState(() =>
    detectStandalone(
      typeof window !== 'undefined' ? (q) => window.matchMedia(q) : undefined,
      typeof navigator !== 'undefined' ? (navigator as unknown as { standalone?: unknown }).standalone : undefined
    )
  );

  useEffect(() => {
    const onBeforeInstallPrompt = (event: Event) => {
      // Chromium shows its own mini-infobar unless the event is cancelled;
      // PaxFlux offers the action in its own flow instead.
      event.preventDefault();
      setPromptEvent(event as InstallPromptEvent);
    };

    // Fired when the browser completes an installation, whether it came from
    // our button or from the browser's own menu. This is the only source of
    // truth for "installed": the CTA disappears when the browser says so,
    // never because a click was made.
    const onInstalled = () => {
      setPromptEvent(null);
      setStandalone(true);
    };

    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const promptToInstall = useCallback(async () => {
    if (!promptEvent) return;
    try {
      await promptEvent.prompt();
      // A prompt can only be shown once, whatever the operator chose. It is
      // dropped either way: keeping it would leave a button that silently
      // does nothing the second time.
      await promptEvent.userChoice;
    } catch (err) {
      console.debug('Install prompt could not be shown:', err);
    } finally {
      setPromptEvent(null);
    }
  }, [promptEvent]);

  return {
    state: describeInstallState({ standalone, promptAvailable: promptEvent !== null }),
    promptToInstall,
  };
}
