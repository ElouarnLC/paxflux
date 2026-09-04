import { describe, expect, it } from 'vitest';
import {
  describeAnomalyForCounter,
  describeAnomalyForSupervisor,
  describeAuthoritative,
  describePendingDelta,
  formatCount,
  formatSignedDelta,
  readOccupancyTruth,
  readPendingDisclosure,
  ZONE_PENDING_ONLY_MESSAGE,
} from './occupancy-truth.js';

/**
 * The counter's truth model, argued with directly.
 *
 * ADR-004 is the invariant under test throughout: a movement is recorded as
 * it was counted, and an incoherent total is *reported*, never corrected. So
 * every case here checks the number survives as well as the wording.
 */

describe('the gauge is a sum, and says so only when it is one', () => {
  it('keeps the projected value as the number on screen', () => {
    // Optimistic counting is deliberate and unchanged: the tap moves the
    // gauge, the disclosure explains it.
    const truth = readOccupancyTruth({ authoritative: 101, pendingDelta: 3, capacity: 1500 });
    expect(truth.displayed).toBe(104);
    expect(truth.authoritative).toBe(101);
    expect(truth.disclosePending).toBe(true);
    expect(describeAuthoritative(truth)).toBe('Serveur : 101');
    expect(describePendingDelta(truth)).toBe('+3 en attente sur cet appareil');
  });

  it('says nothing about a delta of zero', () => {
    // An internal transfer is pending but moves the global gauge by nothing.
    // "+0 en attente" would be noise, and would imply the transfer is not
    // pending at all — the sync badge is what shows those.
    const truth = readOccupancyTruth({ authoritative: 40, pendingDelta: 0, capacity: 100 });
    expect(truth.displayed).toBe(40);
    expect(truth.disclosePending, 'a zero delta is not a disclosure').toBe(false);
  });

  it('writes a negative delta as a signed number, not a subtraction', () => {
    const truth = readOccupancyTruth({ authoritative: 10, pendingDelta: -2, capacity: 100 });
    expect(truth.displayed).toBe(8);
    expect(describePendingDelta(truth)).toBe('−2 en attente sur cet appareil');
  });

  it('uses the same minus sign the count buttons use', () => {
    // U+2212, matching `SORTIE −1`: at arm's length a hyphen and a minus are
    // not equally legible.
    expect(formatSignedDelta(-2)).toBe('−2');
    expect(formatSignedDelta(2)).toBe('+2');
    expect(formatSignedDelta(0)).toBe('+0');
    expect(formatSignedDelta(-2).charCodeAt(0)).toBe(0x2212);
  });

  it('never describes a projected value as synchronised', () => {
    const truth = readOccupancyTruth({ authoritative: 101, pendingDelta: 3, capacity: 1500 });
    for (const text of [describeAuthoritative(truth), describePendingDelta(truth)]) {
      expect(text.toLowerCase()).not.toContain('synchronis');
    }
  });
});

describe('anomalies are reported, never corrected', () => {
  it('reports a server occupancy below zero without clamping it', () => {
    const truth = readOccupancyTruth({ authoritative: -1, pendingDelta: 0, capacity: 10 });
    expect(truth.displayed, 'the value stands as counted').toBe(-1);
    expect(truth.anomaly).toEqual({ kind: 'negative', scope: 'authoritative', value: -1 });
  });

  it('reports a projected negative as projected, not as the server’s', () => {
    // The server holds 0; only this device's unacknowledged exit gets to −1.
    // Saying the server accepted it would be a lie.
    const truth = readOccupancyTruth({ authoritative: 0, pendingDelta: -1, capacity: 10 });
    expect(truth.displayed).toBe(-1);
    expect(truth.authoritative).toBe(0);
    expect(truth.anomaly).toEqual({ kind: 'negative', scope: 'projected', value: -1 });

    const message = describeAnomalyForCounter(truth.anomaly!, truth.capacity);
    expect(message).toContain('projetée');
    expect(message).toContain('en attente du serveur');
    expect(message.toLowerCase(), 'never claims the server holds this').not.toContain('serveur conserve');
  });

  it('reports an occupancy above capacity without clamping it', () => {
    const truth = readOccupancyTruth({ authoritative: 11, pendingDelta: 0, capacity: 10 });
    expect(truth.displayed, 'not clamped to capacity').toBe(11);
    expect(truth.anomaly).toEqual({ kind: 'over-capacity', scope: 'authoritative', value: 11 });
  });

  it('treats an unconfigured capacity as no ceiling at all', () => {
    // Capacity 0 means "not set", not "everyone is over".
    const truth = readOccupancyTruth({ authoritative: 5, pendingDelta: 0, capacity: 0 });
    expect(truth.anomaly).toBeNull();
  });

  it('never lets a local delta conceal an anomaly the server already holds', () => {
    // The sharp case: the server is at −1, this device has counted one
    // entry, and the displayed value is a perfectly ordinary 0. Reporting
    // nothing would make a real recorded incoherence vanish behind this
    // handset's own arithmetic.
    const truth = readOccupancyTruth({ authoritative: -1, pendingDelta: 1, capacity: 10 });
    expect(truth.displayed).toBe(0);
    expect(truth.anomaly, 'the server’s anomaly still surfaces').toEqual({
      kind: 'negative',
      scope: 'authoritative',
      value: -1,
    });
  });

  it('is silent when nothing is incoherent', () => {
    expect(readOccupancyTruth({ authoritative: 5, pendingDelta: 2, capacity: 10 }).anomaly).toBeNull();
    expect(readOccupancyTruth({ authoritative: 10, pendingDelta: 0, capacity: 10 }).anomaly).toBeNull();
  });
});

describe('what each surface is told', () => {
  it('asks a counter operator to report, never to perform an admin action', () => {
    const truth = readOccupancyTruth({ authoritative: -1, pendingDelta: 0, capacity: 10 });
    const message = describeAnomalyForCounter(truth.anomaly!, truth.capacity);

    expect(message).toContain('Occupation négative (−1)');
    // ADR-004 in two words, because this sits between the gauge and the
    // count buttons on a 320px handset.
    expect(message).toContain('comptages conservés');
    expect(message).toContain('signalez-le à la supervision');
    // A counter operator cannot make a supervised adjustment.
    expect(message.toLowerCase()).not.toContain('ajustement');
  });

  it('points a supervisor at the workflow they actually have', () => {
    const truth = readOccupancyTruth({ authoritative: -1, pendingDelta: 0, capacity: 10 });
    const message = describeAnomalyForSupervisor(truth.anomaly!, truth.capacity);

    expect(message).toContain('Occupation négative (−1)');
    expect(message).toContain('conservé tel quel');
    expect(message).toContain('ajustement supervisé');
  });

  it('writes every negative with the same minus, wherever it appears', () => {
    // The one that got away: `(-1).toLocaleString('fr-FR')` returns an ASCII
    // hyphen, because CLDR gives French `-` and not `−`. So a message built
    // straight from `toLocaleString` renders a different glyph from the
    // `SORTIE −1` button beside it, and from `formatSignedDelta` above.
    // Every rendered count goes through `formatCount` for that reason.
    const truth = readOccupancyTruth({ authoritative: -1, pendingDelta: 0, capacity: 10 });
    const rendered = [
      formatCount(-1),
      describeAuthoritative(truth),
      describeAnomalyForCounter(truth.anomaly!, truth.capacity),
      describeAnomalyForSupervisor(truth.anomaly!, truth.capacity),
    ];

    for (const text of rendered) {
      expect(text, `${text} must not carry an ASCII hyphen`).not.toContain('-1');
      expect(text).toContain('−1');
    }
    expect(describeAuthoritative(truth)).toBe('Serveur : −1');
  });

  it('names both numbers when capacity is exceeded', () => {
    const truth = readOccupancyTruth({ authoritative: 11, pendingDelta: 0, capacity: 10 });
    expect(describeAnomalyForCounter(truth.anomaly!, truth.capacity)).toContain('(11 / 10)');
    expect(describeAnomalyForSupervisor(truth.anomaly!, truth.capacity)).toContain('(11 / 10)');
  });
});

describe('acknowledgement converges without a second jump', () => {
  it('holds the displayed number still while the server catches up', () => {
    // Before: server 10, one projected entry, gauge 11.
    const before = readOccupancyTruth({ authoritative: 10, pendingDelta: 1, capacity: 100 });
    expect(before.displayed).toBe(11);
    expect(before.disclosePending).toBe(true);

    // The ACK lands: the server is now 10 + 1, and the action leaves the
    // outbox in the same breath.
    const after = readOccupancyTruth({ authoritative: 11, pendingDelta: 0, capacity: 100 });

    expect(after.displayed, 'the number the operator is looking at does not move').toBe(before.displayed);
    expect(after.disclosePending, 'the explanation goes away').toBe(false);
    // And the delta is never applied twice: 12 would mean the acknowledged
    // action was still being projected on top of the server's own total.
    expect(after.displayed).not.toBe(12);
  });
});

describe('one sentence about what is pending, not one per number', () => {
  it('names the delta when the global gauge is the thing that moved', () => {
    expect(readPendingDisclosure(3, [1, 2])).toBe('global');
    expect(readPendingDisclosure(-2, [null, -2])).toBe('global');
  });

  it('still speaks up when only the zones moved', () => {
    // The sharp case. An internal transfer is −1 here and +1 there: the
    // global gauge is at the server's own figure and correct, while both
    // zone badges under it are projected. Saying nothing would present them
    // as confirmed.
    expect(readPendingDisclosure(0, [-1, 1])).toBe('zones-only');
  });

  it('says nothing when nothing is pending', () => {
    expect(readPendingDisclosure(0, [0, 0])).toBe('none');
    // No projection yet, or an `external` endpoint that holds no occupancy.
    expect(readPendingDisclosure(0, [null, null])).toBe('none');
  });

  it('puts no figure on the zones-only sentence', () => {
    // Any number here would be read as a change to the global gauge, which
    // is exactly what has *not* happened.
    expect(ZONE_PENDING_ONLY_MESSAGE).not.toMatch(/[0-9+−-]/);
    expect(ZONE_PENDING_ONLY_MESSAGE).toContain('sur cet appareil');
  });
});
