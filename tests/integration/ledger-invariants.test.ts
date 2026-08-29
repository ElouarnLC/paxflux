import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from '../../apps/server/src/db/index.js';
import { runMigrations } from '../../apps/server/src/db/migrator.js';
import {
  applyCountAction,
  applyReversalAction,
  applySupervisorAdjustment,
} from '../../apps/server/src/domain/movements.js';
import { rebuildSpaceStateFromLedger } from '../../apps/server/src/domain/rebuild.js';
import { calculateAggregateOccupancy, detectParentCycle } from '../../apps/server/src/domain/spaces.js';
import {
  staffUsers,
  events,
  spaces,
  checkpoints,
  spaceState,
  movements,
} from '../../apps/server/src/db/schema.js';
import { eq } from 'drizzle-orm';
import crypto from 'node:crypto';

describe('Movement Ledger & Domain Invariants', () => {
  let sqlite: ReturnType<typeof createDatabase>['sqlite'];
  let db: ReturnType<typeof createDatabase>['db'];

  const adminId = crypto.randomUUID();
  const eventId = crypto.randomUUID();

  const externalSpaceId = crypto.randomUUID();
  const generalSpaceId = crypto.randomUUID();
  const vipSpaceId = crypto.randomUUID();
  const hallSpaceId = crypto.randomUUID();
  const aggregateTotalId = crypto.randomUUID();

  const mainGateCheckpointId = crypto.randomUUID();
  const vipCheckpointId = crypto.randomUUID();

  beforeEach(async () => {
    const conn = createDatabase(':memory:');
    sqlite = conn.sqlite;
    db = conn.db;
    runMigrations(sqlite, ':memory:');

    const now = Date.now();

    // 1. Seed Admin User
    await db.insert(staffUsers).values({
      id: adminId,
      username: 'admin',
      usernameNormalized: 'admin',
      role: 'admin',
      passwordHash: 'dummy_hash',
      isActive: true,
      createdAtMs: now,
      updatedAtMs: now,
    });

    // 2. Seed Event
    await db.insert(events).values({
      id: eventId,
      name: 'Campulsations Test',
      slug: 'campulsations-test',
      capacity: 1000,
      status: 'live',
      version: 1,
      createdBy: adminId,
      createdAtMs: now,
      updatedAtMs: now,
    });

    // 3. Seed Spaces
    // External
    await db.insert(spaces).values({
      id: externalSpaceId,
      eventId,
      parentId: null,
      name: 'Extérieur',
      kind: 'external',
      sortOrder: 0,
      createdAtMs: now,
      updatedAtMs: now,
    });

    // Aggregate space (Site total)
    await db.insert(spaces).values({
      id: aggregateTotalId,
      eventId,
      parentId: null,
      name: 'Site Total (Aggregate)',
      kind: 'aggregate',
      capacity: 1000,
      sortOrder: 1,
      createdAtMs: now,
      updatedAtMs: now,
    });

    // Leaf: Zone Générale (child of aggregate)
    await db.insert(spaces).values({
      id: generalSpaceId,
      eventId,
      parentId: aggregateTotalId,
      name: 'Zone Générale',
      kind: 'leaf',
      capacity: 800,
      sortOrder: 2,
      createdAtMs: now,
      updatedAtMs: now,
    });

    // Leaf: VIP (child of aggregate)
    await db.insert(spaces).values({
      id: vipSpaceId,
      eventId,
      parentId: aggregateTotalId,
      name: 'VIP',
      kind: 'leaf',
      capacity: 100,
      sortOrder: 3,
      createdAtMs: now,
      updatedAtMs: now,
    });

    // Leaf: Salle A (child of aggregate)
    await db.insert(spaces).values({
      id: hallSpaceId,
      eventId,
      parentId: aggregateTotalId,
      name: 'Salle A',
      kind: 'leaf',
      capacity: 100,
      sortOrder: 4,
      createdAtMs: now,
      updatedAtMs: now,
    });

    // 4. Seed Checkpoints
    // Porte A (Extérieur -> Zone Générale)
    await db.insert(checkpoints).values({
      id: mainGateCheckpointId,
      eventId,
      name: 'Porte A',
      spaceAId: externalSpaceId,
      spaceBId: generalSpaceId,
      allowAToB: true,
      allowBToA: true,
      labelAToB: 'ENTRÉE +1',
      labelBToA: 'SORTIE −1',
      sortOrder: 1,
      createdAtMs: now,
      updatedAtMs: now,
    });

    // VIP Gate (Zone Générale -> VIP)
    await db.insert(checkpoints).values({
      id: vipCheckpointId,
      eventId,
      name: 'Entrée VIP',
      spaceAId: generalSpaceId,
      spaceBId: vipSpaceId,
      allowAToB: true,
      allowBToA: true,
      labelAToB: '→ VIP',
      labelBToA: '← RETOUR ZONE',
      sortOrder: 2,
      createdAtMs: now,
      updatedAtMs: now,
    });
  });

  afterEach(() => {
    sqlite.close();
  });

  it('Invariant 6: External to leaf movement increments leaf and changes event total', async () => {
    const actionId = crypto.randomUUID();
    const result = await applyCountAction(sqlite, db, {
      eventId,
      checkpointId: mainGateCheckpointId,
      clientActionId: actionId,
      direction: 'a_to_b',
    });

    expect(result.status).toBe('applied');
    expect(result.isDuplicate).toBe(false);

    // Verify space_state
    const generalState = await db
      .select()
      .from(spaceState)
      .where(eq(spaceState.spaceId, generalSpaceId))
      .get();
    expect(generalState?.occupancy).toBe(1);

    // Verify aggregate projection
    const allSpacesList = await db.select().from(spaces).where(eq(spaces.eventId, eventId)).all();
    const leafMap = new Map([[generalSpaceId, 1], [vipSpaceId, 0], [hallSpaceId, 0]]);
    const aggMap = calculateAggregateOccupancy(allSpacesList, leafMap);

    expect(aggMap.get(aggregateTotalId)).toBe(1);
  });

  it('Invariant 5 & 8: Internal leaf to internal leaf transfer preserves global total', async () => {
    // 1. Enter 5 people into general zone
    for (let i = 0; i < 5; i++) {
      await applyCountAction(sqlite, db, {
        eventId,
        checkpointId: mainGateCheckpointId,
        clientActionId: crypto.randomUUID(),
        direction: 'a_to_b',
      });
    }

    // 2. Transfer 2 people from General to VIP
    for (let i = 0; i < 2; i++) {
      await applyCountAction(sqlite, db, {
        eventId,
        checkpointId: vipCheckpointId,
        clientActionId: crypto.randomUUID(),
        direction: 'a_to_b',
      });
    }

    const generalState = await db.select().from(spaceState).where(eq(spaceState.spaceId, generalSpaceId)).get();
    const vipState = await db.select().from(spaceState).where(eq(spaceState.spaceId, vipSpaceId)).get();

    expect(generalState?.occupancy).toBe(3); // 5 - 2 = 3
    expect(vipState?.occupancy).toBe(2);     // 0 + 2 = 2

    // Total site occupancy remains 5 (3 + 2 = 5)
    const allSpacesList = await db.select().from(spaces).where(eq(spaces.eventId, eventId)).all();
    const leafMap = new Map([[generalSpaceId, generalState?.occupancy || 0], [vipSpaceId, vipState?.occupancy || 0]]);
    const aggMap = calculateAggregateOccupancy(allSpacesList, leafMap);

    expect(aggMap.get(aggregateTotalId)).toBe(5);
  });

  it('Invariant 2 & 4: Exact same client_action_id yields exactly-once business effect', async () => {
    const duplicateActionId = crypto.randomUUID();

    // First attempt
    const res1 = await applyCountAction(sqlite, db, {
      eventId,
      checkpointId: mainGateCheckpointId,
      clientActionId: duplicateActionId,
      direction: 'a_to_b',
    });
    expect(res1.status).toBe('applied');
    expect(res1.isDuplicate).toBe(false);

    // Replay 10 times
    for (let i = 0; i < 10; i++) {
      const resDup = await applyCountAction(sqlite, db, {
        eventId,
        checkpointId: mainGateCheckpointId,
        clientActionId: duplicateActionId,
        direction: 'a_to_b',
      });
      expect(resDup.status).toBe('applied');
      expect(resDup.isDuplicate).toBe(true);
      expect(resDup.movementId).toBe(res1.movementId);
    }

    // Assert only 1 movement in database
    const allMovements = await db.select().from(movements).where(eq(movements.eventId, eventId)).all();
    expect(allMovements.length).toBe(1);

    const generalState = await db.select().from(spaceState).where(eq(spaceState.spaceId, generalSpaceId)).get();
    expect(generalState?.occupancy).toBe(1);
  });

  it('Invariant 14: Counter reversal (Undo) creates a compensating movement and restores state', async () => {
    const originalActionId = crypto.randomUUID();
    await applyCountAction(sqlite, db, {
      eventId,
      checkpointId: mainGateCheckpointId,
      clientActionId: originalActionId,
      direction: 'a_to_b',
    });

    const reversalActionId = crypto.randomUUID();
    const revRes = await applyReversalAction(sqlite, db, {
      eventId,
      clientActionId: reversalActionId,
      targetClientActionId: originalActionId,
    });

    expect(revRes.status).toBe('applied');
    expect(revRes.isDuplicate).toBe(false);

    // Occupancy back to 0
    const generalState = await db.select().from(spaceState).where(eq(spaceState.spaceId, generalSpaceId)).get();
    expect(generalState?.occupancy).toBe(0);

    // Reversing again fails with ALREADY_REVERSED
    const doubleRevRes = await applyReversalAction(sqlite, db, {
      eventId,
      clientActionId: crypto.randomUUID(),
      targetClientActionId: originalActionId,
    });
    expect(doubleRevRes.status).toBe('rejected');
    expect(doubleRevRes.errorCode).toBe('ALREADY_REVERSED');
  });

  it('Invariant 10: Negative occupancy and capacity overruns are recorded faithfully', async () => {
    // Exit when 0 inside -> becomes -1
    const exitActionId = crypto.randomUUID();
    await applyCountAction(sqlite, db, {
      eventId,
      checkpointId: mainGateCheckpointId,
      clientActionId: exitActionId,
      direction: 'b_to_a', // Exit
    });

    const generalState = await db.select().from(spaceState).where(eq(spaceState.spaceId, generalSpaceId)).get();
    expect(generalState?.occupancy).toBe(-1);
  });

  it('Invariant 7: Supervisor adjustment requires reason, applies delta, and audits', async () => {
    const adjRes = await applySupervisorAdjustment(sqlite, db, {
      eventId,
      spaceId: generalSpaceId,
      observedCount: 42,
      reason: 'Manual headcount verification after rush',
      actorUserId: adminId,
    });

    expect(adjRes.status).toBe('applied');

    const generalState = await db.select().from(spaceState).where(eq(spaceState.spaceId, generalSpaceId)).get();
    expect(generalState?.occupancy).toBe(42);

    // Without reason fails
    const badAdj = await applySupervisorAdjustment(sqlite, db, {
      eventId,
      spaceId: generalSpaceId,
      observedCount: 50,
      reason: '',
      actorUserId: adminId,
    });
    expect(badAdj.status).toBe('rejected');
    expect(badAdj.errorCode).toBe('REASON_REQUIRED');
  });

  it('Invariant 9: State rebuild from raw ledger is 100% mathematically equivalent to space_state', async () => {
    // Perform mixed sequence of entries, exits, transfers, reversals, adjustments
    for (let i = 0; i < 15; i++) {
      await applyCountAction(sqlite, db, {
        eventId,
        checkpointId: mainGateCheckpointId,
        clientActionId: crypto.randomUUID(),
        direction: 'a_to_b',
      });
    }

    const revTargetId = crypto.randomUUID();
    await applyCountAction(sqlite, db, {
      eventId,
      checkpointId: vipCheckpointId,
      clientActionId: revTargetId,
      direction: 'a_to_b',
    });

    await applyReversalAction(sqlite, db, {
      eventId,
      clientActionId: crypto.randomUUID(),
      targetClientActionId: revTargetId,
    });

    await applySupervisorAdjustment(sqlite, db, {
      eventId,
      spaceId: vipSpaceId,
      observedCount: 12,
      reason: 'VIP manual count adjustment',
      actorUserId: adminId,
    });

    const rebuild = await rebuildSpaceStateFromLedger(db, eventId);
    expect(rebuild.isEquivalent).toBe(true);
    expect(rebuild.reconstructedOccupancies[generalSpaceId]).toBe(rebuild.materializedOccupancies[generalSpaceId]);
    expect(rebuild.reconstructedOccupancies[vipSpaceId]).toBe(rebuild.materializedOccupancies[vipSpaceId]);
  });

  it('detects parent hierarchy cycles in spaces', () => {
    const testSpaces = [
      { id: '1', parentId: null },
      { id: '2', parentId: '1' },
      { id: '3', parentId: '2' },
    ];

    expect(detectParentCycle(testSpaces, '1', '3')).toBe(true);
    expect(detectParentCycle(testSpaces, '1', null)).toBe(false);
  });
});
