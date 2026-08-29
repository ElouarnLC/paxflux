import { triggerFlush, getPendingActionsCount } from './outbox.js';

let retryTimer: NodeJS.Timeout | null = null;
let currentBackoffMs = 500;
const MAX_BACKOFF_MS = 5000;

export function initOfflineSyncEngine() {
  if (typeof window === 'undefined') return;

  // 1. Online event listener
  window.addEventListener('online', () => {
    currentBackoffMs = 500;
    triggerFlush();
  });

  // 2. Focus event listener
  window.addEventListener('focus', () => {
    triggerFlush();
  });

  // 3. Visibility change listener
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      triggerFlush();
    }
  });

  // 4. Periodic check timer if pending actions exist
  const scheduleNextCheck = () => {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(async () => {
      try {
        const pending = await getPendingActionsCount();
        if (pending > 0 && navigator.onLine) {
          triggerFlush();
          currentBackoffMs = Math.min(currentBackoffMs * 1.5, MAX_BACKOFF_MS);
        } else {
          currentBackoffMs = 500;
        }
      } catch {
        // ignore
      }
      scheduleNextCheck();
    }, currentBackoffMs);
  };

  scheduleNextCheck();
}
