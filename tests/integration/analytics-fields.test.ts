import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from '../../apps/server/src/db/index.js';
import { runMigrations } from '../../apps/server/src/db/migrator.js';
import { computeEventAnalytics } from '../../apps/server/src/domain/analytics.js';
import {
  staffUsers,
  events,
  spaces,
  checkpoints,
  spaceState,
  movements,
} from '../../apps/server/src/db/schema.js';
import crypto from 'node:crypto';

/**
 * The analytics fields RC2-B surfaces on the supervisor's screen.
 *
 * `flowRecent5Min` and `spaceStats` already existed in `AnalyticsResponse`
 * and were never rendered, so nothing pinned their shape. Two things matter
 * now that an operator reads them: the recent window must be able to express
 * a falling gauge (a negative net, not an absolute value), and a client must
 * be able to tell an operational zone from the `external` sentinel without
 * guessing from the space's name.
 */

describe('Analytics — the fields the supervisor screen reads', () => {
  let sqlite: ReturnType<typeof createDatabase>['sqlite'];
  let db: ReturnType<typeof createDatabase>['db'];

  const adminId = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  const checkpointId = crypto.randomUUID();
  const externalSpaceId = crypto.randomUUID();
  const siteSpaceId = crypto.randomUUID();
  const vipSpaceId = crypto.randomUUID();

  const now = Date.now();
  let nextMovementId = 1;

  /** A boundary crossing at a chosen age, as the ledger records it. */
  async function seedMovement(opts: {
    direction: 'entry' | 'exit';
    ageMs: number;
    spaceId?: string;
  }): Promise<void> {
    const leaf = opts.spaceId ?? siteSpaceId;
    await db.insert(movements).values({
      id: nextMovementId++,
      eventId,
      checkpointId,
      kind: 'count',
      clientActionId: crypto.randomUUID(),
      fromSpaceId: opts.direction === 'entry' ? externalSpaceId : leaf,
      toSpaceId: opts.direction === 'entry' ? leaf : externalSpaceId,
      quantity: 1,
      serverTimeMs: now - opts.ageMs,
      eventVersion: nextMovementId,
      source: 'online',
    });
  }

  beforeEach(async () => {
    const dbConn = createDatabase(':memory:');
    sqlite = dbConn.sqlite;
    db = dbConn.db;
    await runMigrations(sqlite);
    nextMovementId = 1;

    await db.insert(staffUsers).values({
      id: adminId,
      username: 'admin',
      usernameNormalized: 'admin',
      role: 'admin',
      passwordHash: 'hash',
      isActive: true,
      createdAtMs: now,
      updatedAtMs: now,
    });

    await db.insert(events).values({
      id: eventId,
      name: 'Festival Live',
      slug: 'festival-analytics',
      capacity: 500,
      status: 'live',
      version: 1,
      createdBy: adminId,
      createdAtMs: now,
      updatedAtMs: now,
    });

    await db.insert(spaces).values([
      {
        id: externalSpaceId,
        eventId,
        name: 'Extérieur',
        kind: 'external',
        sortOrder: 0,
        createdAtMs: now,
        updatedAtMs: now,
      },
      {
        id: siteSpaceId,
        eventId,
        name: 'Site',
        kind: 'leaf',
        capacity: 500,
        sortOrder: 1,
        createdAtMs: now,
        updatedAtMs: now,
      },
      {
        id: vipSpaceId,
        eventId,
        name: 'Carré VIP',
        kind: 'leaf',
        capacity: null,
        sortOrder: 2,
        createdAtMs: now,
        updatedAtMs: now,
      },
    ]);

    await db.insert(spaceState).values([
      { eventId, spaceId: siteSpaceId, occupancy: 0, updatedAtMs: now },
      { eventId, spaceId: vipSpaceId, occupancy: 0, updatedAtMs: now },
    ]);

    await db.insert(checkpoints).values({
      id: checkpointId,
      eventId,
      name: 'Porte Sud',
      spaceAId: externalSpaceId,
      spaceBId: siteSpaceId,
      allowAToB: true,
      allowBToA: true,
      labelAToB: 'Entrée',
      labelBToA: 'Sortie',
      sortOrder: 0,
      createdAtMs: now,
      updatedAtMs: now,
    });
  });

  afterEach(() => {
    sqlite.close();
  });

  describe('flowRecent5Min', () => {
    it('counts only movements inside the five-minute window', async () => {
      await seedMovement({ direction: 'entry', ageMs: 60_000 });
      await seedMovement({ direction: 'entry', ageMs: 120_000 });
      // Outside the window: cumulative totals must still see it, the recent
      // flow must not.
      await seedMovement({ direction: 'entry', ageMs: 20 * 60_000 });

      const analytics = await computeEventAnalytics(db, eventId);

      expect(analytics?.flowRecent5Min.entries).toBe(2);
      expect(analytics?.totalEntries).toBe(3);
    });

    it('reports a negative net when more people are leaving than arriving', async () => {
      // A gauge that is falling is the case an absolute value would hide.
      await seedMovement({ direction: 'entry', ageMs: 240_000 });
      await seedMovement({ direction: 'exit', ageMs: 60_000 });
      await seedMovement({ direction: 'exit', ageMs: 30_000 });
      await seedMovement({ direction: 'exit', ageMs: 10_000 });

      const analytics = await computeEventAnalytics(db, eventId);

      expect(analytics?.flowRecent5Min.entries).toBe(1);
      expect(analytics?.flowRecent5Min.exits).toBe(3);
      expect(analytics?.flowRecent5Min.netDelta).toBe(-2);
    });

    it('reports a zero net when arrivals and departures balance', async () => {
      await seedMovement({ direction: 'entry', ageMs: 90_000 });
      await seedMovement({ direction: 'exit', ageMs: 30_000 });

      const analytics = await computeEventAnalytics(db, eventId);

      expect(analytics?.flowRecent5Min.netDelta).toBe(0);
    });

    it('reports a quiet window as zero rather than omitting it', async () => {
      await seedMovement({ direction: 'entry', ageMs: 30 * 60_000 });

      const analytics = await computeEventAnalytics(db, eventId);

      expect(analytics?.flowRecent5Min).toEqual({ entries: 0, exits: 0, netDelta: 0 });
      expect(analytics?.netDelta).toBe(1);
    });
  });

  describe('spaceStats', () => {
    it('labels every row with its kind, so external is identifiable', async () => {
      const analytics = await computeEventAnalytics(db, eventId);
      const byId = new Map(analytics?.spaceStats.map((s) => [s.spaceId, s]));

      // Without this the only way to recognise the sentinel from a client
      // is its operator-chosen name.
      expect(byId.get(externalSpaceId)?.kind).toBe('external');
      expect(byId.get(siteSpaceId)?.kind).toBe('leaf');
      expect(byId.get(vipSpaceId)?.kind).toBe('leaf');
    });

    it('keeps a null capacity null rather than reporting it as zero', async () => {
      const analytics = await computeEventAnalytics(db, eventId);
      const vip = analytics?.spaceStats.find((s) => s.spaceId === vipSpaceId);

      expect(vip?.capacity).toBeNull();
    });

    it('reports the external sentinel at zero, which is why it is not a zone', async () => {
      // The sentinel's occupancy is structurally 0 and never counted into
      // `eventOccupancy` — the screen must not present it as an empty zone.
      await seedMovement({ direction: 'entry', ageMs: 10_000 });

      const analytics = await computeEventAnalytics(db, eventId);
      const external = analytics?.spaceStats.find((s) => s.spaceId === externalSpaceId);

      expect(external?.occupancy).toBe(0);
      expect(analytics?.spaceStats.filter((s) => s.kind !== 'external')).toHaveLength(2);
    });
  });
});
