/**
 * Serialization for the operations that decide an event's shape.
 *
 * PaxFlux runs one Node process against one SQLite file, so the only
 * concurrency that exists here is interleaving between `await` points in the
 * same event loop. That is enough to break two invariants:
 *
 *  - `POST /start` reads the topology, validates it, takes the pre-live
 *    backup and only then flips the status. Every one of those steps is
 *    awaited, so a topology mutation can commit in between — making an event
 *    live on a topology nobody validated, whose pre-live recovery point does
 *    not describe it;
 *  - a topology mutation reads `status = 'draft'` and then writes. `/start`
 *    can flip the status in between, so the write lands past the lock.
 *
 * A SQLite transaction cannot fix this on its own: `/start` has to await a
 * `VACUUM INTO` backup, and holding a write transaction open across
 * arbitrary awaited work would block every other writer for the duration and
 * risks `VACUUM` inside a transaction, which SQLite refuses outright.
 *
 * So the boundary is serialized in-process, per event, and the *decision*
 * inside each critical section is then made in one synchronous SQLite
 * transaction (see `domain/draft-topology.ts`). The lock orders the awaited
 * work; the synchronous transaction makes each individual check-and-write
 * indivisible even against callers that do not take the lock — device
 * pairing, which runs its own synchronous `BEGIN IMMEDIATE`.
 *
 * Per event rather than global: two different events share no topology, and
 * a global lock would serialize every admin action in the instance behind
 * one event's pre-live backup.
 */

type Release = () => void;

/**
 * The tail of each event's queue.
 *
 * A key exists only while something is queued on it: the last holder deletes
 * it, so a long-lived instance does not accumulate one entry per event ever
 * edited.
 */
const tails = new Map<string, Promise<void>>();

function noop(): void {
  /* the queue only orders work; it never inspects its outcome */
}

/**
 * Runs `fn` with exclusive access to `eventId`, in call order.
 *
 * A rejection propagates to the caller but does not break the chain: the
 * next waiter runs regardless of whether the previous one succeeded, so one
 * failed edit cannot wedge an event forever.
 */
export async function withEventLock<T>(eventId: string, fn: () => Promise<T>): Promise<T> {
  const previous = tails.get(eventId) ?? Promise.resolve();

  let release: Release = noop;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });

  const myTail = previous.then(() => held);
  tails.set(eventId, myTail);

  await previous;
  try {
    return await fn();
  } finally {
    release();
    // Only the current tail may clear the key: if someone queued behind us
    // while we ran, the map must keep pointing at *their* promise.
    void myTail.then(() => {
      if (tails.get(eventId) === myTail) tails.delete(eventId);
    }, noop);
  }
}

/** Test-only: how many events currently have work queued. */
export function pendingEventLocks(): number {
  return tails.size;
}
