import {
  flushOutbox,
  getRetryableActionsCount,
  onOutboxChanged,
  recoverInFlightActions,
} from './outbox.js';

/**
 * The offline sync engine: when the outbox is allowed to try again.
 *
 * Properties it is written to guarantee:
 *
 *  - it only ever sends *retryable* actions. A refused or quarantined one is
 *    never retried on a timer — retrying changes nothing until a human
 *    addresses the cause, and the previous engine turned exactly that into a
 *    100 ms hot loop against the server;
 *  - one attempt at a time, and one timer at a time. `flushOutbox` reports
 *    `busy` rather than queueing a second request;
 *  - backoff grows only on real transport failures and resets on success,
 *    so a flaky network is paced but a working one is not penalised;
 *  - with nothing retryable, it idles at a long interval instead of
 *    spinning;
 *  - `navigator.onLine` is an optimisation, never the mechanism. It says the
 *    interface is up, not that this server is reachable, so the timer keeps
 *    running regardless and a false negative can only delay a flush by one
 *    tick, never strand it.
 */

const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 8_000;
/** Interval used when there is nothing the engine may send. */
const IDLE_POLL_MS = 20_000;

let retryTimer: ReturnType<typeof setTimeout> | null = null;
let currentBackoffMs = INITIAL_BACKOFF_MS;
let started = false;

/** Exposed for the counter's "réessayer" affordance and for tests. */
export function resetBackoff() {
  currentBackoffMs = INITIAL_BACKOFF_MS;
}

async function attemptFlush(): Promise<void> {
  const retryable = await getRetryableActionsCount();
  if (retryable === 0) {
    resetBackoff();
    return;
  }

  const outcome = await flushOutbox();
  switch (outcome.kind) {
    case 'sent':
      // Progress was made — even a batch that came back entirely refused is
      // progress, since those actions are now parked instead of retried.
      resetBackoff();
      break;
    case 'failed':
      currentBackoffMs = Math.min(Math.round(currentBackoffMs * 1.5), MAX_BACKOFF_MS);
      break;
    case 'idle':
    case 'busy':
      break;
  }
}

/**
 * Recursive timer rather than an interval: the next tick is scheduled from
 * the end of the previous one, so a slow flush can never let two overlap.
 */
function scheduleNextCheckIn(delayMs: number) {
  if (retryTimer) clearTimeout(retryTimer);

  retryTimer = setTimeout(async () => {
    retryTimer = null;

    try {
      await attemptFlush();
    } catch (err) {
      // Never let one failed tick kill the loop, and never swallow the
      // reason it failed.
      console.debug('Offline sync tick failed, continuing:', err);
    }

    let nextDelay = IDLE_POLL_MS;
    try {
      nextDelay = (await getRetryableActionsCount()) > 0 ? currentBackoffMs : IDLE_POLL_MS;
    } catch (err) {
      console.debug('Could not read the outbox to pace the next tick:', err);
    }
    scheduleNextCheckIn(nextDelay);
  }, delayMs);
}

/**
 * An external signal that now is a good moment to try again: the network
 * came back, the tab regained focus, or the outbox gained an action.
 *
 * Re-arms the timer rather than flushing on the side, so there is still only
 * ever one loop and the next delay is recomputed from the new situation.
 */
export function nudgeSyncEngine() {
  resetBackoff();
  scheduleNextCheckIn(0);
}

export function initOfflineSyncEngine() {
  if (typeof window === 'undefined') return;
  if (started) return;
  started = true;

  // Anything the previous run left mid-flight is an uncertain ACK. Recover
  // it *before* the first flush, while `sending` cannot mean "in flight
  // right now".
  void recoverInFlightActions()
    .then((recovered) => {
      if (recovered > 0) {
        console.debug(`Recovered ${recovered} action(s) left in flight by a previous run`);
      }
      scheduleNextCheckIn(0);
    })
    .catch((err) => {
      console.debug('In-flight recovery failed; the engine still starts:', err);
      scheduleNextCheckIn(currentBackoffMs);
    });

  // Enqueueing, undoing and an operator retry all land here, so a new
  // action is attempted immediately instead of waiting out the idle delay
  // the engine picked while the outbox was empty.
  onOutboxChanged(nudgeSyncEngine);

  window.addEventListener('online', nudgeSyncEngine);
  window.addEventListener('focus', nudgeSyncEngine);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') nudgeSyncEngine();
  });
}

export function stopOfflineSyncEngine() {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  started = false;
}
