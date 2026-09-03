/**
 * Where the application root sends this browser.
 *
 * The field failure this exists for: a phone paired at a door, added to the
 * home screen, and reopened the next morning. `/` knew nothing about local
 * pairing, asked the server whether the instance was initialized, and sent
 * an initialized one to `/admin` — which has no staff session on a field
 * handset, so the operator was shown a **staff login form** instead of their
 * counter. Reproduced on the RC2-C baseline before this was written.
 *
 * The rule is that local device identity is read first and decides alone.
 * The server is consulted only when this browser has never been paired.
 * That ordering is load-bearing rather than an optimisation: an installed
 * counter launched in a dead spot must reach its counter with no network at
 * all, and a request that cannot be answered must never be mistaken for an
 * answer.
 */

/** What this browser knows about itself, read from IndexedDB. */
export interface LocalDeviceIdentity {
  /** A completed pairing: configuration in hand. */
  hasBootstrap: boolean;
  /**
   * A pairing whose configuration has not arrived.
   *
   * Deliberately still a counter. `beginPairingHandoff` records this the
   * instant `/device/pair` succeeds, and CounterView already has a
   * fail-closed screen for it. Sending such a phone to `/admin` or `/setup`
   * would hide a real, recoverable state behind a screen for someone else.
   */
  hasPendingSession: boolean;
}

/** What the server says, when it was asked and answered. */
export type MetaOutcome =
  | { kind: 'initialized' }
  | { kind: 'uninitialized' }
  /**
   * Asked and not answered.
   *
   * Kept distinct from `uninitialized` because conflating them was the
   * second field defect: a failed `/meta` left the response null and the
   * check `!meta?.isInitialized` then sent the browser to `/setup`, offering
   * to create a first administrator on an instance that already had one and
   * was merely unreachable.
   */
  | { kind: 'unreachable' };

export type RootDestination =
  | { kind: 'counter' }
  | { kind: 'admin' }
  | { kind: 'setup' }
  | { kind: 'server-unavailable' };

/**
 * True when this browser has an identity of its own to act on.
 *
 * Either half is enough. A pending session with no bootstrap is still a
 * paired phone — see `LocalDeviceIdentity.hasPendingSession`.
 */
export function hasLocalDeviceIdentity(identity: LocalDeviceIdentity | null): boolean {
  return identity !== null && (identity.hasBootstrap || identity.hasPendingSession);
}

/**
 * The whole decision, as a function of what was read.
 *
 * `identity` is `null` when the local read itself failed. That is treated as
 * "no device identity" rather than as an error state: a browser that cannot
 * read IndexedDB is almost always a staff browser in a private window, and
 * turning one storage exception into a permanent spinner would strand it.
 * A paired phone whose storage is unreadable has lost its pairing anyway and
 * has to pair again, which is what the admin/setup path leads to.
 *
 * `meta` is only consulted when there is no local identity, so a paired
 * phone never waits on the network to find out it is a counter.
 */
export function resolveRootDestination(
  identity: LocalDeviceIdentity | null,
  meta: MetaOutcome
): RootDestination {
  if (hasLocalDeviceIdentity(identity)) return { kind: 'counter' };

  switch (meta.kind) {
    case 'uninitialized':
      return { kind: 'setup' };
    case 'initialized':
      return { kind: 'admin' };
    case 'unreachable':
      // Not `setup`. Not a guess in either direction: the browser is told
      // the server could not be reached and offered a retry.
      return { kind: 'server-unavailable' };
  }
}

/** The path a destination navigates to, or null when it renders in place. */
export function destinationPath(destination: RootDestination): string | null {
  switch (destination.kind) {
    case 'counter':
      return '/counter';
    case 'admin':
      return '/admin';
    case 'setup':
      return '/setup';
    case 'server-unavailable':
      return null;
  }
}
