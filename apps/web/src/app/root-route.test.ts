import { describe, expect, it } from 'vitest';
import {
  LocalDeviceIdentity,
  MetaOutcome,
  destinationPath,
  hasLocalDeviceIdentity,
  resolveRootDestination,
} from './root-route.js';

/**
 * The root-route decision table.
 *
 * Written as a table because that is what it is: two inputs, four outcomes,
 * and the field failures were both wrong cells rather than wrong code. A
 * paired phone reached `/admin` — and from there a staff login form — and an
 * unreachable server was read as an uninitialized one.
 */

const paired: LocalDeviceIdentity = { hasBootstrap: true, hasPendingSession: false };
const pairedAwaitingConfig: LocalDeviceIdentity = { hasBootstrap: false, hasPendingSession: true };
const neverPaired: LocalDeviceIdentity = { hasBootstrap: false, hasPendingSession: false };

const initialized: MetaOutcome = { kind: 'initialized' };
const uninitialized: MetaOutcome = { kind: 'uninitialized' };
const unreachable: MetaOutcome = { kind: 'unreachable' };

describe('local device identity', () => {
  it('counts a completed pairing', () => {
    expect(hasLocalDeviceIdentity(paired)).toBe(true);
  });

  it('counts a pairing whose configuration has not arrived', () => {
    // `beginPairingHandoff` records this the instant `/device/pair`
    // succeeds. It is a paired phone in a recoverable state, and CounterView
    // has a screen for exactly it — sending it to admin or setup would hide
    // that behind a screen meant for somebody else.
    expect(hasLocalDeviceIdentity(pairedAwaitingConfig)).toBe(true);
  });

  it('does not count a browser that has neither', () => {
    expect(hasLocalDeviceIdentity(neverPaired)).toBe(false);
  });

  it('does not count a browser whose storage could not be read', () => {
    // Treated as unpaired rather than as an error: this is almost always a
    // staff browser in a private window, and one storage exception must not
    // become a permanent spinner on the application root.
    expect(hasLocalDeviceIdentity(null)).toBe(false);
  });
});

describe('resolveRootDestination', () => {
  it('sends a paired phone to the counter whatever the server says', () => {
    // Including when the server was never asked. This is the launch path of
    // an installed counter in a dead spot: no request is made at all.
    for (const meta of [initialized, uninitialized, unreachable]) {
      expect(resolveRootDestination(paired, meta).kind, `meta=${meta.kind}`).toBe('counter');
      expect(resolveRootDestination(pairedAwaitingConfig, meta).kind, `meta=${meta.kind}`).toBe('counter');
    }
  });

  it('sends an unpaired browser to admin on an initialized instance', () => {
    expect(resolveRootDestination(neverPaired, initialized).kind).toBe('admin');
  });

  it('sends an unpaired browser to setup on an uninitialized instance', () => {
    expect(resolveRootDestination(neverPaired, uninitialized).kind).toBe('setup');
  });

  it('never reads an unreachable server as an uninitialized one', () => {
    // The second field defect. A failed `/meta` left the response null, and
    // `!meta?.isInitialized` then offered to create a first administrator on
    // an instance that already had one.
    const destination = resolveRootDestination(neverPaired, unreachable);
    expect(destination.kind).not.toBe('setup');
    expect(destination.kind).toBe('server-unavailable');
  });

  it('treats an unreadable local store like an unpaired browser', () => {
    expect(resolveRootDestination(null, initialized).kind).toBe('admin');
    expect(resolveRootDestination(null, uninitialized).kind).toBe('setup');
    expect(resolveRootDestination(null, unreachable).kind).toBe('server-unavailable');
  });
});

describe('destinationPath', () => {
  it('navigates for the three routable outcomes', () => {
    expect(destinationPath({ kind: 'counter' })).toBe('/counter');
    expect(destinationPath({ kind: 'admin' })).toBe('/admin');
    expect(destinationPath({ kind: 'setup' })).toBe('/setup');
  });

  it('renders in place when the server could not be reached', () => {
    // Null rather than a path: there is nowhere honest to send this browser,
    // so it is told what happened and offered a retry.
    expect(destinationPath({ kind: 'server-unavailable' })).toBeNull();
  });
});
