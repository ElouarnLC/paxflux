import { describe, expect, it } from 'vitest';
import { AnalyticsResponse } from '@paxflux/shared';
import { formatNetDelta, operationalSpaces } from './analytics-presentation.js';

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
