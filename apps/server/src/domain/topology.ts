import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { CreateEventDraftRequest, EventModel, SpaceModel, CheckpointModel, ErrorCode } from '@paxflux/shared';
import { validateSpaceRules } from './spaces.js';
import { validateCheckpointRules } from './checkpoints.js';

export interface ResolvedSpace {
  id: string;
  clientId: string;
  parentId: string | null;
  name: string;
  kind: 'leaf' | 'aggregate' | 'external';
  capacity: number | null;
  sortOrder: number;
}

export interface ResolvedCheckpoint {
  name: string;
  spaceAId: string;
  spaceBId: string;
  allowAToB: boolean;
  allowBToA: boolean;
  labelAToB: string;
  labelBToA: string;
  sortOrder: number;
}

export interface TopologyRejection {
  code: ErrorCode;
  detail: string;
}

type ResolveResult =
  | { ok: true; spaces: ResolvedSpace[]; checkpoints: ResolvedCheckpoint[] }
  | ({ ok: false } & TopologyRejection);

/**
 * Pure, DB-free structural resolution of a draft-topology payload: assigns
 * a real id to every client-supplied `clientId` and translates every
 * `parentClientId`/`spaceAClientId`/`spaceBClientId` reference to it, so
 * checkpoints and parent/child links can point at spaces defined anywhere
 * in the same payload — including later in the array — before any of them
 * exist as rows. Only catches malformed *references*; business rules
 * (space kind rules, checkpoint endpoint rules) are re-validated per-item
 * during the actual transactional insert in `createEventDraftAtomic`, so
 * they are re-checked against the same validators the individual
 * POST /spaces and /checkpoints endpoints use — no duplicated invariants.
 */
export function resolveDraftTopologyReferences(payload: CreateEventDraftRequest): ResolveResult {
  const clientIdToRealId = new Map<string, string>();

  for (const space of payload.spaces) {
    if (clientIdToRealId.has(space.clientId)) {
      return { ok: false, code: 'INVALID_TOPOLOGY', detail: `Identifiant client d'espace dupliqué : "${space.clientId}".` };
    }
    clientIdToRealId.set(space.clientId, crypto.randomUUID());
  }

  const resolvedSpaces: ResolvedSpace[] = [];
  for (const space of payload.spaces) {
    let parentId: string | null = null;
    if (space.parentClientId) {
      const resolvedParentId = clientIdToRealId.get(space.parentClientId);
      if (!resolvedParentId) {
        return {
          ok: false,
          code: 'INVALID_TOPOLOGY',
          detail: `L'espace "${space.name}" référence un parent inconnu dans ce payload ("${space.parentClientId}").`,
        };
      }
      parentId = resolvedParentId;
    }

    resolvedSpaces.push({
      id: clientIdToRealId.get(space.clientId)!,
      clientId: space.clientId,
      parentId,
      name: space.name.trim(),
      kind: space.kind,
      capacity: space.capacity ?? null,
      sortOrder: space.sortOrder ?? 0,
    });
  }

  // SPEC: "Il doit toujours y avoir le concept d'Extérieur nécessaire au
  // comptage de frontière." A draft with no external boundary space can
  // never be a coherent PaxFlux topology, regardless of how many internal
  // zones or checkpoints it defines.
  if (!resolvedSpaces.some((s) => s.kind === 'external')) {
    return {
      ok: false,
      code: 'INVALID_TOPOLOGY',
      detail: "La topologie doit comporter au moins un espace de type 'external' (Extérieur).",
    };
  }

  const resolvedCheckpoints: ResolvedCheckpoint[] = [];
  for (const cp of payload.checkpoints) {
    const spaceAId = clientIdToRealId.get(cp.spaceAClientId);
    const spaceBId = clientIdToRealId.get(cp.spaceBClientId);
    if (!spaceAId || !spaceBId) {
      return {
        ok: false,
        code: 'INVALID_TOPOLOGY',
        detail: `Le checkpoint "${cp.name}" référence un espace inconnu dans ce payload.`,
      };
    }

    resolvedCheckpoints.push({
      name: cp.name.trim(),
      spaceAId,
      spaceBId,
      allowAToB: cp.allowAToB,
      allowBToA: cp.allowBToA,
      labelAToB: cp.labelAToB.trim(),
      labelBToA: cp.labelBToA.trim(),
      sortOrder: cp.sortOrder ?? 0,
    });
  }

  return { ok: true, spaces: resolvedSpaces, checkpoints: resolvedCheckpoints };
}

export type CreateEventDraftResult =
  | { ok: true; event: EventModel; spaces: SpaceModel[]; checkpoints: CheckpointModel[] }
  | { ok: false; status: 400; code: ErrorCode; detail: string }
  | { ok: false; status: 500; code: ErrorCode; detail: string; cause: unknown; rollbackError: unknown };

class TopologyValidationFailure extends Error {
  constructor(public code: ErrorCode, public detail: string) {
    super(detail);
  }
}

interface EventRowValues {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  capacity: number;
  status: string;
  warningRatio1: number;
  warningRatio2: number;
  startsAtMs: number | null;
  endsAtMs: number | null;
  version: number;
  createdBy: string;
  createdAtMs: number;
  updatedAtMs: number;
}

interface SpaceRowValues {
  id: string;
  eventId: string;
  parentId: string | null;
  name: string;
  kind: string;
  capacity: number | null;
  sortOrder: number;
  isActive: boolean;
  createdAtMs: number;
  updatedAtMs: number;
}

interface SpaceStateRowValues {
  eventId: string;
  spaceId: string;
  occupancy: number;
  updatedAtMs: number;
}

interface CheckpointRowValues {
  id: string;
  eventId: string;
  name: string;
  spaceAId: string;
  spaceBId: string;
  allowAToB: boolean;
  allowBToA: boolean;
  labelAToB: string;
  labelBToA: string;
  sortOrder: number;
  isActive: boolean;
  createdAtMs: number;
  updatedAtMs: number;
}

// Raw, synchronous inserts (node:sqlite's StatementSync.run is synchronous)
// — deliberately bypassing the drizzle `db` wrapper here, which always
// returns a Promise (even though it resolves synchronously under the hood)
// and would otherwise force an `await` inside the open transaction below.

function insertEventRow(sqlite: DatabaseSync, v: EventRowValues): void {
  sqlite
    .prepare(
      `INSERT INTO events (
        id, name, slug, timezone, capacity, status,
        warning_ratio_1, warning_ratio_2, starts_at_ms, ends_at_ms,
        version, created_by, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      v.id,
      v.name,
      v.slug,
      v.timezone,
      v.capacity,
      v.status,
      v.warningRatio1,
      v.warningRatio2,
      v.startsAtMs,
      v.endsAtMs,
      v.version,
      v.createdBy,
      v.createdAtMs,
      v.updatedAtMs
    );
}

function insertSpaceRow(sqlite: DatabaseSync, v: SpaceRowValues): void {
  sqlite
    .prepare(
      `INSERT INTO spaces (
        id, event_id, parent_id, name, kind, capacity, sort_order, is_active,
        created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      v.id,
      v.eventId,
      v.parentId,
      v.name,
      v.kind,
      v.capacity,
      v.sortOrder,
      v.isActive ? 1 : 0,
      v.createdAtMs,
      v.updatedAtMs
    );
}

function insertSpaceStateRow(sqlite: DatabaseSync, v: SpaceStateRowValues): void {
  sqlite
    .prepare(`INSERT INTO space_state (event_id, space_id, occupancy, updated_at_ms) VALUES (?, ?, ?, ?)`)
    .run(v.eventId, v.spaceId, v.occupancy, v.updatedAtMs);
}

function insertCheckpointRow(sqlite: DatabaseSync, v: CheckpointRowValues): void {
  sqlite
    .prepare(
      `INSERT INTO checkpoints (
        id, event_id, name, space_a_id, space_b_id, allow_a_to_b, allow_b_to_a,
        label_a_to_b, label_b_to_a, sort_order, is_active, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      v.id,
      v.eventId,
      v.name,
      v.spaceAId,
      v.spaceBId,
      v.allowAToB ? 1 : 0,
      v.allowBToA ? 1 : 0,
      v.labelAToB,
      v.labelBToA,
      v.sortOrder,
      v.isActive ? 1 : 0,
      v.createdAtMs,
      v.updatedAtMs
    );
}

/**
 * Everything from `BEGIN IMMEDIATE` to `COMMIT`/`ROLLBACK` in here is
 * strictly synchronous — no `await`, no Promise, anywhere in this call
 * stack. A SQLite transaction belongs to the *connection*, not to a call
 * stack or a request, and every route in this server shares the same
 * `DatabaseSync` connection. If this function yielded to the event loop
 * (via an `await`) while its transaction was open, another request's own
 * SQL could execute against — and silently join — this uncommitted
 * transaction, and would then be rolled back with it on failure even
 * though it has nothing to do with this draft. Keeping the whole section
 * one synchronous call stack makes that structurally impossible: Node
 * never switches to another callback in the middle of it.
 */
function runAtomicInsert(
  sqlite: DatabaseSync,
  resolvedSpaces: ResolvedSpace[],
  resolvedCheckpoints: ResolvedCheckpoint[],
  eventInput: CreateEventDraftRequest['event'],
  actorUserId: string
): CreateEventDraftResult {
  // Tracks whether a transaction is actually open, so the catch block below
  // only ever attempts a ROLLBACK when there is one — never in response to
  // BEGIN itself failing, and never again once COMMIT has already closed it.
  let transactionStarted = false;

  try {
    sqlite.exec('BEGIN IMMEDIATE;');
    transactionStarted = true;

    const now = Date.now();
    const eventId = crypto.randomUUID();
    const { timezone, capacity, warningRatio1, warningRatio2, startsAtMs, endsAtMs } = eventInput;
    const trimmedName = eventInput.name.trim();
    const slug = `${trimmedName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')}-${now.toString(36)}`;

    insertEventRow(sqlite, {
      id: eventId,
      name: trimmedName,
      slug,
      timezone,
      capacity,
      status: 'draft',
      warningRatio1,
      warningRatio2,
      startsAtMs: startsAtMs ?? null,
      endsAtMs: endsAtMs ?? null,
      version: 1,
      createdBy: actorUserId,
      createdAtMs: now,
      updatedAtMs: now,
    });

    const insertedSpaces: SpaceModel[] = [];
    for (const space of resolvedSpaces) {
      const ruleError = validateSpaceRules(
        { kind: space.kind, parentId: space.parentId, capacity: space.capacity },
        resolvedSpaces,
        space.id
      );
      if (ruleError) {
        throw new TopologyValidationFailure('INVALID_TOPOLOGY', `Espace "${space.name}" : ${ruleError.message}`);
      }

      insertSpaceRow(sqlite, {
        id: space.id,
        eventId,
        parentId: space.parentId,
        name: space.name,
        kind: space.kind,
        capacity: space.capacity,
        sortOrder: space.sortOrder,
        isActive: true,
        createdAtMs: now,
        updatedAtMs: now,
      });

      if (space.kind === 'leaf') {
        insertSpaceStateRow(sqlite, { eventId, spaceId: space.id, occupancy: 0, updatedAtMs: now });
      }

      insertedSpaces.push({
        id: space.id,
        eventId,
        parentId: space.parentId,
        name: space.name,
        kind: space.kind,
        capacity: space.capacity,
        sortOrder: space.sortOrder,
        isActive: true,
        createdAtMs: now,
        updatedAtMs: now,
      });
    }

    const spacesMap = new Map(insertedSpaces.map((s) => [s.id, { kind: s.kind }]));

    const insertedCheckpoints: CheckpointModel[] = [];
    for (const cp of resolvedCheckpoints) {
      const cpError = validateCheckpointRules(
        { spaceAId: cp.spaceAId, spaceBId: cp.spaceBId, allowAToB: cp.allowAToB, allowBToA: cp.allowBToA },
        spacesMap
      );
      if (cpError) {
        throw new TopologyValidationFailure('INVALID_TOPOLOGY', `Checkpoint "${cp.name}" : ${cpError.message}`);
      }

      const cpId = crypto.randomUUID();
      insertCheckpointRow(sqlite, {
        id: cpId,
        eventId,
        name: cp.name,
        spaceAId: cp.spaceAId,
        spaceBId: cp.spaceBId,
        allowAToB: cp.allowAToB,
        allowBToA: cp.allowBToA,
        labelAToB: cp.labelAToB,
        labelBToA: cp.labelBToA,
        sortOrder: cp.sortOrder,
        isActive: true,
        createdAtMs: now,
        updatedAtMs: now,
      });

      insertedCheckpoints.push({
        id: cpId,
        eventId,
        name: cp.name,
        spaceAId: cp.spaceAId,
        spaceBId: cp.spaceBId,
        allowAToB: cp.allowAToB,
        allowBToA: cp.allowBToA,
        labelAToB: cp.labelAToB,
        labelBToA: cp.labelBToA,
        sortOrder: cp.sortOrder,
        isActive: true,
        createdAtMs: now,
        updatedAtMs: now,
      });
    }

    sqlite.exec('COMMIT;');
    transactionStarted = false;

    const createdEvent: EventModel = {
      id: eventId,
      name: trimmedName,
      slug,
      timezone,
      capacity,
      status: 'draft',
      warningRatio1,
      warningRatio2,
      startsAtMs: startsAtMs ?? null,
      endsAtMs: endsAtMs ?? null,
      liveStartedAtMs: null,
      closingStartedAtMs: null,
      closedAtMs: null,
      archivedAtMs: null,
      version: 1,
      topologyLockedAtMs: null,
      createdBy: actorUserId,
      createdAtMs: now,
      updatedAtMs: now,
    };

    return { ok: true, event: createdEvent, spaces: insertedSpaces, checkpoints: insertedCheckpoints };
  } catch (err) {
    // A ROLLBACK failure must never mask the original error that triggered
    // it — caught separately so the real cause below is always the one
    // that actually broke the insert, not a secondary rollback failure. It
    // is also only ever attempted when a transaction is actually open:
    // never in response to BEGIN itself failing (there is nothing to roll
    // back), and never after a successful COMMIT (already closed).
    let rollbackError: unknown = null;
    if (transactionStarted) {
      try {
        sqlite.exec('ROLLBACK;');
      } catch (errDuringRollback) {
        rollbackError = errDuringRollback;
      }
    }

    // A business-rule rejection is only safe to report as a normal 400 if
    // the rollback that was supposed to undo everything actually
    // succeeded. If it didn't, atomicity is no longer guaranteed — this is
    // now a server-side integrity problem, not a validation error, and
    // must surface (and be logged) as one.
    if (err instanceof TopologyValidationFailure && !rollbackError) {
      return { ok: false, status: 400, code: err.code, detail: err.detail };
    }

    // Never leak raw SQL/driver details to the client; the real cause (and
    // any rollback failure) is returned only for the route to log
    // server-side.
    return {
      ok: false,
      status: 500,
      code: 'INTERNAL_ERROR',
      detail: 'Une erreur interne est survenue lors de la création de la topologie.',
      cause: err,
      rollbackError,
    };
  }
}

/**
 * Creates a draft event and its full topology (spaces + checkpoints) as a
 * single SQLite transaction on the same connection: either everything
 * commits, or nothing does. Space- and checkpoint-level business rules are
 * checked one item at a time, immediately before each insert — reusing the
 * exact same validators (`validateSpaceRules`, `validateCheckpointRules`)
 * the individual POST /spaces and /checkpoints endpoints already use — so
 * an invalid item later in either list genuinely rolls back everything
 * already inserted before it (the event, and any earlier spaces/
 * checkpoints), rather than relying on a compensating cleanup step. See
 * `runAtomicInsert` for why that whole section is synchronous.
 */
export async function createEventDraftAtomic(
  sqlite: DatabaseSync,
  payload: CreateEventDraftRequest,
  actorUserId: string
): Promise<CreateEventDraftResult> {
  const resolved = resolveDraftTopologyReferences(payload);
  if (!resolved.ok) {
    return { ok: false, status: 400, code: resolved.code, detail: resolved.detail };
  }

  return runAtomicInsert(sqlite, resolved.spaces, resolved.checkpoints, payload.event, actorUserId);
}
