import { CompactEventState, ConfirmedActionRecord, OutboxActionRecord } from '@paxflux/shared';

/**
 * Optimistic projection of unacknowledged local actions onto the last
 * authoritative state.
 *
 * The rule reproduced here is the server's, not a parallel model of it
 * (`apps/server/src/domain/movements.ts`):
 *
 *  - a count maps to a movement `from → to`, decided by the checkpoint's
 *    endpoints and the tap direction (`a_to_b`: A → B, `b_to_a`: B → A);
 *  - a reversal is the exact inverse of its target movement, endpoints
 *    swapped;
 *  - occupancy moves **only for endpoints whose space is a `leaf`**: −1 on
 *    the origin, +1 on the destination. An `external` endpoint contributes
 *    nothing, which is what makes a boundary crossing change the global
 *    gauge and an internal transfer leave it alone;
 *  - `eventOccupancy` is the sum of the leaf occupancies
 *    (`getCompactEventState`), so the global delta is the sum of the leaf
 *    deltas — it falls out of the rule above rather than being asserted
 *    separately.
 *
 * On aggregates: the server refuses a checkpoint whose endpoint is an
 * aggregate space (`validateCheckpointRules` → `AGGREGATE_SPACE_ENDPOINT`),
 * so a device's own movements can never touch one. An aggregate's occupancy
 * is derived from its leaf descendants, and `CompactSpaceState` carries no
 * parent link, so this projection deliberately leaves aggregate occupancies
 * at their last authoritative value instead of inventing a local derivation.
 * The counter never displays one.
 *
 * This module is pure on purpose: no Dexie, no fetch, no clock. Everything
 * it needs is passed in, so the four directions and the reversals are
 * testable without a browser.
 */

export interface ProjectionCheckpoint {
  spaceAId: string;
  spaceBId: string;
}

export interface ProjectionResult {
  /** Change to the global gauge implied by the unacknowledged actions. */
  globalDelta: number;
  /** Per-space change, keyed by space id. Only leaf spaces ever appear. */
  spaceDeltas: Map<string, number>;
  /** Last authoritative occupancy plus the projected delta. */
  projectedEventOccupancy: number;
  /**
   * Actions that could not be projected, e.g. a reversal whose target is no
   * longer in the outbox. Surfaced rather than silently skipped so a caller
   * can tell "nothing to project" from "something was not understood".
   */
  unprojectableActionIds: string[];
}

interface Movement {
  fromSpaceId: string;
  toSpaceId: string;
}

/** The movement the server records for a count in this direction. */
function movementForCount(
  direction: 'a_to_b' | 'b_to_a',
  endpoints: ProjectionCheckpoint
): Movement {
  return direction === 'a_to_b'
    ? { fromSpaceId: endpoints.spaceAId, toSpaceId: endpoints.spaceBId }
    : { fromSpaceId: endpoints.spaceBId, toSpaceId: endpoints.spaceAId };
}

/**
 * Resolves an action to the movement the server would record for it, or
 * `null` when it cannot be resolved locally.
 */
function resolveMovement(
  action: OutboxActionRecord,
  checkpoint: ProjectionCheckpoint,
  byId: Map<string, OutboxActionRecord>,
  confirmedById: Map<string, ConfirmedActionRecord>
): Movement | null {
  if (action.type === 'count') {
    return movementForCount(action.direction, checkpoint);
  }

  // A reversal inverts the movement it targets.
  //
  // The target is usually still queued locally. When it is not, it may have
  // been acknowledged and deleted — in which case its effect is already
  // inside the authoritative state, and the reversal's own −1/+1 is a real,
  // projectable delta on top of it. A target that is neither queued nor
  // remembered as confirmed cannot be resolved at all, and saying so is
  // better than guessing a direction.
  const queued = byId.get(action.targetClientActionId);
  if (queued && queued.type === 'count') {
    const original = movementForCount(queued.direction, checkpoint);
    return { fromSpaceId: original.toSpaceId, toSpaceId: original.fromSpaceId };
  }

  const confirmed = confirmedById.get(action.targetClientActionId);
  if (confirmed) {
    // Projected across the endpoints as they stood when the count was made,
    // not today's — a re-pairing could have moved this device elsewhere.
    const original = movementForCount(confirmed.direction, {
      spaceAId: confirmed.spaceAId,
      spaceBId: confirmed.spaceBId,
    });
    return { fromSpaceId: original.toSpaceId, toSpaceId: original.fromSpaceId };
  }

  return null;
}

export function projectPendingActions(
  state: CompactEventState,
  checkpoint: ProjectionCheckpoint,
  actions: OutboxActionRecord[],
  confirmed: ConfirmedActionRecord[] = []
): ProjectionResult {
  const kindById = new Map(state.spaces.map((s) => [s.id, s.kind]));
  const byId = new Map(actions.map((a) => [a.clientActionId, a]));
  const confirmedById = new Map(confirmed.map((c) => [c.clientActionId, c]));

  const spaceDeltas = new Map<string, number>();
  const unprojectableActionIds: string[] = [];

  const bump = (spaceId: string, delta: number) => {
    // Only leaf occupancy moves — the server's rule, verbatim.
    if (kindById.get(spaceId) !== 'leaf') return;
    spaceDeltas.set(spaceId, (spaceDeltas.get(spaceId) ?? 0) + delta);
  };

  for (const action of actions) {
    const movement = resolveMovement(action, checkpoint, byId, confirmedById);
    if (!movement) {
      unprojectableActionIds.push(action.clientActionId);
      continue;
    }
    bump(movement.fromSpaceId, -1);
    bump(movement.toSpaceId, +1);
  }

  let globalDelta = 0;
  for (const delta of spaceDeltas.values()) globalDelta += delta;

  return {
    globalDelta,
    spaceDeltas,
    projectedEventOccupancy: state.eventOccupancy + globalDelta,
    unprojectableActionIds,
  };
}

/** Projected occupancy of one space, authoritative value plus local delta. */
export function projectedSpaceOccupancy(
  state: CompactEventState,
  spaceId: string,
  projection: ProjectionResult
): number | null {
  const space = state.spaces.find((s) => s.id === spaceId);
  if (!space) return null;
  return space.occupancy + (projection.spaceDeltas.get(spaceId) ?? 0);
}
