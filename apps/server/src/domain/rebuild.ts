import { AppDb } from '../db/index.js';
import { movements, spaceState, spaces } from '../db/schema.js';
import { eq, asc } from 'drizzle-orm';

export interface RebuildResult {
  eventId: string;
  reconstructedOccupancies: Record<string, number>;
  materializedOccupancies: Record<string, number>;
  isEquivalent: boolean;
  totalMovementsProcessed: number;
}

export async function rebuildSpaceStateFromLedger(
  db: AppDb,
  eventId: string,
  applyToDatabase: boolean = false
): Promise<RebuildResult> {
  const eventSpaces = await db.select().from(spaces).where(eq(spaces.eventId, eventId)).all();
  const leafSpaceIds = new Set(eventSpaces.filter((s) => s.kind === 'leaf').map((s) => s.id));

  // Fetch all movements for this event in server order
  const allMovements = await db
    .select()
    .from(movements)
    .where(eq(movements.eventId, eventId))
    .orderBy(asc(movements.id))
    .all();

  const reconstructedMap: Record<string, number> = {};
  for (const leafId of leafSpaceIds) {
    reconstructedMap[leafId] = 0;
  }

  for (const m of allMovements) {
    if (m.fromSpaceId && leafSpaceIds.has(m.fromSpaceId)) {
      reconstructedMap[m.fromSpaceId] = (reconstructedMap[m.fromSpaceId] || 0) - m.quantity;
    }
    if (m.toSpaceId && leafSpaceIds.has(m.toSpaceId)) {
      reconstructedMap[m.toSpaceId] = (reconstructedMap[m.toSpaceId] || 0) + m.quantity;
    }
  }

  // Fetch current materialized state
  const currentStates = await db.select().from(spaceState).where(eq(spaceState.eventId, eventId)).all();
  const materializedMap: Record<string, number> = {};
  for (const leafId of leafSpaceIds) {
    materializedMap[leafId] = 0;
  }
  for (const state of currentStates) {
    materializedMap[state.spaceId] = state.occupancy;
  }

  // Check equivalence
  let isEquivalent = true;
  for (const leafId of leafSpaceIds) {
    if ((reconstructedMap[leafId] || 0) !== (materializedMap[leafId] || 0)) {
      isEquivalent = false;
      break;
    }
  }

  // Apply to DB if requested
  if (applyToDatabase) {
    const now = Date.now();
    for (const leafId of leafSpaceIds) {
      const occupancy = reconstructedMap[leafId] || 0;
      const existing = await db
        .select()
        .from(spaceState)
        .where(eq(spaceState.spaceId, leafId))
        .get();

      if (existing) {
        await db
          .update(spaceState)
          .set({ occupancy, updatedAtMs: now })
          .where(eq(spaceState.spaceId, leafId));
      } else {
        await db.insert(spaceState).values({
          eventId,
          spaceId: leafId,
          occupancy,
          updatedAtMs: now,
        });
      }
    }
  }

  return {
    eventId,
    reconstructedOccupancies: reconstructedMap,
    materializedOccupancies: materializedMap,
    isEquivalent,
    totalMovementsProcessed: allMovements.length,
  };
}
