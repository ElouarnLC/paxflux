import { AppDb } from '../db/index.js';
import { events, spaces, spaceState, checkpoints, movements } from '../db/schema.js';
import { eq, asc } from 'drizzle-orm';
import { AnalyticsResponse } from '@paxflux/shared';
import { calculateAggregateOccupancy } from './spaces.js';

export async function computeEventAnalytics(db: AppDb, eventId: string): Promise<AnalyticsResponse | null> {
  const eventRecord = await db.select().from(events).where(eq(events.id, eventId)).get();
  if (!eventRecord) return null;

  const allSpaces = await db.select().from(spaces).where(eq(spaces.eventId, eventId)).all();
  const allCheckpoints = await db.select().from(checkpoints).where(eq(checkpoints.eventId, eventId)).all();
  const spaceStates = await db.select().from(spaceState).where(eq(spaceState.eventId, eventId)).all();

  const leafSpaceIds = new Set(allSpaces.filter((s) => s.kind === 'leaf').map((s) => s.id));
  const externalSpaceIds = new Set(allSpaces.filter((s) => s.kind === 'external').map((s) => s.id));

  // Current Occupancies
  const leafMap = new Map<string, number>();
  let currentGlobalOccupancy = 0;

  for (const st of spaceStates) {
    leafMap.set(st.spaceId, st.occupancy);
    if (leafSpaceIds.has(st.spaceId)) {
      currentGlobalOccupancy += st.occupancy;
    }
  }

  const aggMap = calculateAggregateOccupancy(
    allSpaces.map((s) => ({ id: s.id, parentId: s.parentId, kind: s.kind })),
    leafMap
  );

  // All movements chronologically
  const allMovements = await db
    .select()
    .from(movements)
    .where(eq(movements.eventId, eventId))
    .orderBy(asc(movements.id))
    .all();

  let runningOccupancy = 0;
  let peakOccupancy = 0;
  let peakOccupancyTimeMs: number | null = null;
  let totalEntries = 0;
  let totalExits = 0;

  const checkpointCounts = new Map<string, { entries: number; exits: number }>();
  for (const cp of allCheckpoints) {
    checkpointCounts.set(cp.id, { entries: 0, exits: 0 });
  }

  const now = Date.now();
  const fiveMinAgo = now - 5 * 60 * 1000;
  let recent5MinEntries = 0;
  let recent5MinExits = 0;

  // 15-minute timeline buckets
  const bucketIntervalMs = 15 * 60 * 1000;
  const timelineBuckets = new Map<number, { timestampMs: number; occupancy: number; entries: number; exits: number }>();

  for (const m of allMovements) {
    const isFromExternal = !m.fromSpaceId || externalSpaceIds.has(m.fromSpaceId);
    const isToExternal = !m.toSpaceId || externalSpaceIds.has(m.toSpaceId);
    const isFromLeaf = m.fromSpaceId && leafSpaceIds.has(m.fromSpaceId);
    const isToLeaf = m.toSpaceId && leafSpaceIds.has(m.toSpaceId);

    if (isFromExternal && isToLeaf) {
      totalEntries += m.quantity;
      runningOccupancy += m.quantity;
      if (m.serverTimeMs >= fiveMinAgo) {
        recent5MinEntries += m.quantity;
      }
      if (m.checkpointId && checkpointCounts.has(m.checkpointId)) {
        checkpointCounts.get(m.checkpointId)!.entries += m.quantity;
      }
    } else if (isFromLeaf && isToExternal) {
      totalExits += m.quantity;
      runningOccupancy -= m.quantity;
      if (m.serverTimeMs >= fiveMinAgo) {
        recent5MinExits += m.quantity;
      }
      if (m.checkpointId && checkpointCounts.has(m.checkpointId)) {
        checkpointCounts.get(m.checkpointId)!.exits += m.quantity;
      }
    }

    if (runningOccupancy > peakOccupancy) {
      peakOccupancy = runningOccupancy;
      peakOccupancyTimeMs = m.serverTimeMs;
    }

    // Bucket for timeline
    const bucketKey = Math.floor(m.serverTimeMs / bucketIntervalMs) * bucketIntervalMs;
    if (!timelineBuckets.has(bucketKey)) {
      timelineBuckets.set(bucketKey, {
        timestampMs: bucketKey,
        occupancy: runningOccupancy,
        entries: 0,
        exits: 0,
      });
    }
    const bucket = timelineBuckets.get(bucketKey)!;
    bucket.occupancy = runningOccupancy;
    if (isFromExternal && isToLeaf) bucket.entries += m.quantity;
    if (isFromLeaf && isToExternal) bucket.exits += m.quantity;
  }

  const spaceStats = allSpaces.map((s) => {
    let occ = 0;
    if (s.kind === 'leaf') occ = leafMap.get(s.id) || 0;
    else if (s.kind === 'aggregate') occ = aggMap.get(s.id) || 0;
    return {
      spaceId: s.id,
      spaceName: s.name,
      kind: s.kind,
      occupancy: occ,
      capacity: s.capacity,
    };
  });

  const checkpointStats = allCheckpoints.map((c) => {
    const stats = checkpointCounts.get(c.id) || { entries: 0, exits: 0 };
    return {
      checkpointId: c.id,
      checkpointName: c.name,
      entries: stats.entries,
      exits: stats.exits,
    };
  });

  const timeline = Array.from(timelineBuckets.values()).sort((a, b) => a.timestampMs - b.timestampMs);

  return {
    eventId,
    currentOccupancy: currentGlobalOccupancy,
    capacity: eventRecord.capacity,
    peakOccupancy,
    peakOccupancyTimeMs,
    totalEntries,
    totalExits,
    netDelta: totalEntries - totalExits,
    flowRecent5Min: {
      entries: recent5MinEntries,
      exits: recent5MinExits,
      netDelta: recent5MinEntries - recent5MinExits,
    },
    checkpointStats,
    spaceStats,
    timeline,
  };
}
