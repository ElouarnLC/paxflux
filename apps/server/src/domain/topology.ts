import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { AppDb } from '../db/index.js';
import { events, spaces, spaceState, checkpoints } from '../db/schema.js';
import { eq } from 'drizzle-orm';
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
  | ({ ok: false; status: 400 | 500 } & TopologyRejection);

class TopologyValidationFailure extends Error {
  constructor(public code: ErrorCode, public detail: string) {
    super(detail);
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
 * checkpoints), rather than relying on a compensating cleanup step.
 */
export async function createEventDraftAtomic(
  sqlite: DatabaseSync,
  db: AppDb,
  payload: CreateEventDraftRequest,
  actorUserId: string
): Promise<CreateEventDraftResult> {
  const resolved = resolveDraftTopologyReferences(payload);
  if (!resolved.ok) {
    return { ok: false, status: 400, code: resolved.code, detail: resolved.detail };
  }

  const { spaces: resolvedSpaces, checkpoints: resolvedCheckpoints } = resolved;

  sqlite.exec('BEGIN IMMEDIATE;');
  try {
    const now = Date.now();
    const eventId = crypto.randomUUID();
    const { name, timezone, capacity, warningRatio1, warningRatio2, startsAtMs, endsAtMs } = payload.event;
    const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')}-${Date.now().toString(36)}`;

    await db.insert(events).values({
      id: eventId,
      name: name.trim(),
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

      await db.insert(spaces).values({
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
        await db.insert(spaceState).values({
          eventId,
          spaceId: space.id,
          occupancy: 0,
          updatedAtMs: now,
        });
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
      await db.insert(checkpoints).values({
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

    const createdEvent = await db.select().from(events).where(eq(events.id, eventId)).get();
    sqlite.exec('COMMIT;');

    return { ok: true, event: createdEvent as EventModel, spaces: insertedSpaces, checkpoints: insertedCheckpoints };
  } catch (err) {
    sqlite.exec('ROLLBACK;');
    if (err instanceof TopologyValidationFailure) {
      return { ok: false, status: 400, code: err.code, detail: err.detail };
    }
    // Never leak raw SQL/driver details to the client.
    return { ok: false, status: 500, code: 'INTERNAL_ERROR', detail: 'Une erreur interne est survenue lors de la création de la topologie.' };
  }
}
