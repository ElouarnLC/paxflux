import { describe, expect, it } from 'vitest';
import { AnalyticsResponse } from '@paxflux/shared';
import { LoadedAnalytics, analyticsForEvent, formatNetDelta, operationalSpaces } from './analytics-presentation.js';

type SpaceStat = AnalyticsResponse['spaceStats'][number];

const SPACES: SpaceStat[] = [
  { spaceId: 'ext', spaceName: 'Extérieur', kind: 'external', occupancy: 0, capacity: null },
  { spaceId: 'site', spaceName: 'Site', kind: 'leaf', occupancy: 120, capacity: 500 },
  { spaceId: 'vip', spaceName: 'VIP', kind: 'leaf', occupancy: 12, capacity: null },
  { spaceId: 'all', spaceName: 'Ensemble', kind: 'aggregate', occupancy: 132, capacity: 600 },
];

describe('operationalSpaces', () => {
  it('drops the external sentinel so it is never shown as an empty zone', () => {
    const shown = operationalSpaces(SPACES);
    expect(shown.map((s) => s.spaceId)).toEqual(['site', 'vip', 'all']);
  });

  it('keeps leaf and aggregate zones, including one with no capacity', () => {
    const shown = operationalSpaces(SPACES);
    expect(shown.find((s) => s.spaceId === 'vip')?.capacity).toBeNull();
    expect(shown.find((s) => s.spaceId === 'all')?.kind).toBe('aggregate');
  });

  it('decides on kind, not on the name an operator happened to choose', () => {
    // A leaf that someone named "Extérieur" is still a real zone, and the
    // sentinel is still the sentinel whatever it is called.
    const renamed: SpaceStat[] = [
      { spaceId: 'a', spaceName: 'Extérieur', kind: 'leaf', occupancy: 7, capacity: 10 },
      { spaceId: 'b', spaceName: 'Parvis', kind: 'external', occupancy: 0, capacity: null },
    ];
    expect(operationalSpaces(renamed).map((s) => s.spaceId)).toEqual(['a']);
  });
});

describe('formatNetDelta', () => {
  it('signs a positive balance', () => {
    expect(formatNetDelta(12)).toBe('+12');
  });

  it('signs a negative balance with a real minus sign', () => {
    expect(formatNetDelta(-4)).toBe('−4');
  });

  it('leaves zero unsigned', () => {
    expect(formatNetDelta(0)).toBe('0');
  });
});

describe('analyticsForEvent — the identity boundary between two events', () => {
  const EVENT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const EVENT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  const loadedForA: LoadedAnalytics = {
    eventId: EVENT_A,
    data: { currentOccupancy: 120 } as unknown as AnalyticsResponse,
    updatedAtMs: 1_000,
  };

  it('keeps the last good figures while their own event is on screen', () => {
    // A refresh for event A has just failed; nothing was replaced, so the
    // held value is still A's and must stay visible.
    expect(analyticsForEvent(loadedForA, EVENT_A)).toBe(loadedForA);
  });

  it('never shows event A’s figures while event B is loading', () => {
    // The operator opened B. Nothing has arrived for B yet, and A's
    // occupancy under B's heading would read as B's.
    expect(analyticsForEvent(loadedForA, EVENT_B)).toBeNull();
  });

  it('shows nothing when there is no event at all', () => {
    expect(analyticsForEvent(loadedForA, undefined)).toBeNull();
    expect(analyticsForEvent(null, EVENT_A)).toBeNull();
  });

  it('shows B once B’s own figures have arrived', () => {
    const loadedForB: LoadedAnalytics = {
      eventId: EVENT_B,
      data: { currentOccupancy: 3 } as unknown as AnalyticsResponse,
      updatedAtMs: 2_000,
    };
    expect(analyticsForEvent(loadedForB, EVENT_B)?.data.currentOccupancy).toBe(3);
    // ...and A is not resurrected by going back without a fresh load.
    expect(analyticsForEvent(loadedForB, EVENT_A)).toBeNull();
  });
});
