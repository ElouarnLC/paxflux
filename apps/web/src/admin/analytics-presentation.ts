import { AnalyticsResponse } from '@paxflux/shared';

/**
 * Presentation decisions for the analytics screen, kept pure.
 *
 * Both of these are about not misleading an operator, so both are worth
 * checking without a DOM.
 */

type SpaceStat = AnalyticsResponse['spaceStats'][number];

/**
 * The zones an operator can actually act on.
 *
 * `external` is dropped. It is a sentinel that exists to give a boundary
 * movement a counterpart — its occupancy is structurally always 0 and is
 * never part of `eventOccupancy` — so rendering it beside real zones invites
 * reading "the outside holds 0 people". It is filtered on `kind`, never on
 * its name: the name is operator-chosen text and "Extérieur" is a
 * convention, not a contract.
 */
export function operationalSpaces(spaceStats: SpaceStat[]): SpaceStat[] {
  return spaceStats.filter((space) => space.kind !== 'external');
}

/**
 * A net figure with an explicit sign, so a positive balance never reads as a
 * bare number that could be mistaken for a total.
 *
 * Zero is rendered without a sign: "±0" and "+0" both suggest a movement
 * that did not happen.
 */
export function formatNetDelta(value: number): string {
  if (value > 0) return `+${value}`;
  if (value < 0) return `−${Math.abs(value)}`;
  return '0';
}
