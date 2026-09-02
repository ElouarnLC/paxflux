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

/**
 * Analytics figures together with the event they describe.
 *
 * Kept as one value rather than two pieces of state so the pair can never
 * drift: the figures and the id they belong to are set in the same update.
 */
export interface LoadedAnalytics {
  eventId: string;
  data: AnalyticsResponse;
  updatedAtMs: number;
}

/**
 * The figures that may be displayed for `eventId`, or `null`.
 *
 * Two requirements meet here, and only holding the id alongside the data
 * satisfies both. A refresh that *fails* for the event on screen must leave
 * the last good figures up — blanking a supervisor's statistics because one
 * request timed out is worse than showing figures a few seconds old. But
 * when the operator opens a *different* event, the previous event's figures
 * must disappear at once: an occupancy and a peak from event A, rendered
 * under event B's heading while B loads, are indistinguishable from B's own
 * and would be read as B's.
 *
 * So staleness in time is tolerated and staleness in identity is not.
 */
export function analyticsForEvent(
  loaded: LoadedAnalytics | null,
  eventId: string | undefined
): LoadedAnalytics | null {
  if (!loaded || !eventId) return null;
  return loaded.eventId === eventId ? loaded : null;
}
