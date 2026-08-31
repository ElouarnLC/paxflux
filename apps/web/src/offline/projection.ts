import { CompactEventState, OutboxActionRecord } from '@paxflux/shared';

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

/**
 * Resolves an action to the movement the server would record for it, or
 * `null` when it cannot be resolved locally.
 */
function resolveMovement(
  action: OutboxActionRecord,
  checkpoint: ProjectionCheckpoint,
  byId: Map<string, OutboxActionRecord>
): Movement | null {
  if (action.type === 'count') {
    return action.direction === 'a_to_b'
      ? { fromSpaceId: checkpoint.spaceAId, toSpaceId: checkpoint.spaceBId }
      : { fromSpaceId: checkpoint.spaceBId, toSpaceId: checkpoint.spaceAId };
  }

  // A reversal inverts the movement it targets. The target must still be in
  // the local set: once the original has been acknowledged and deleted, its
  // effect is already inside the authoritative state, and the reversal's own
  // effect only becomes visible when the server applies it.
  const target = byId.get(action.targetClientActionId);
  if (!target || target.type !== 'count') return null;

  const original = resolveMovement(target, checkpoint, byId);
  if (!original) return null;
  return { fromSpaceId: original.toSpaceId, toSpaceId: original.fromSpaceId };
}

export function projectPendingActions(
  state: CompactEventState,
  checkpoint: ProjectionCheckpoint,
  actions: OutboxActionRecord[]
): ProjectionResult {
  const kindById = new Map(state.spaces.map((s) => [s.id, s.kind]));
  const byId = new Map(actions.map((a) => [a.clientActionId, a]));

  const spaceDeltas = new Map<string, number>();
  const unprojectableActionIds: string[] = [];

  const bump = (spaceId: string, delta: number) => {
    // Only leaf occupancy moves — the server's rule, verbatim.
    if (kindById.get(spaceId) !== 'leaf') return;
    spaceDeltas.set(spaceId, (spaceDeltas.get(spaceId) ?? 0) + delta);
  };

  for (const action of actions) {
    const movement = resolveMovement(action, checkpoint, byId);
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
