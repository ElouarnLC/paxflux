import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from '../../apps/server/src/db/index.js';
import { runMigrations } from '../../apps/server/src/db/migrator.js';
import { applyCountAction } from '../../apps/server/src/domain/movements.js';
import { rebuildSpaceStateFromLedger } from '../../apps/server/src/domain/rebuild.js';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';

describe('Chaos & Crash Recovery Invariants', () => {
  const scratchDir = path.resolve(process.cwd(), 'tests/scratch-chaos-test');
  const dbPath = path.join(scratchDir, 'chaos.db');

  const eventId = crypto.randomUUID();
  const spaceAId = crypto.randomUUID();
  const spaceBId = crypto.randomUUID();
  const checkpointId = crypto.randomUUID();
  const deviceSessionId = crypto.randomUUID();

  let activeConn: ReturnType<typeof createDatabase> | null = null;

  beforeEach(() => {
    if (fs.existsSync(dbPath)) {
      try {
        fs.unlinkSync(dbPath);
      } catch {
        // ignore
      }
    }
    if (!fs.existsSync(scratchDir)) {
      fs.mkdirSync(scratchDir, { recursive: true });
    }
    const conn = createDatabase(dbPath);
    runMigrations(conn.sqlite, dbPath);

    const now = Date.now();
    const adminId = `admin-chaos-${Date.now()}`;
    conn.sqlite.exec(`
      INSERT INTO staff_users (id, username, username_normalized, role, password_hash, is_active, created_at_ms, updated_at_ms)
      VALUES ('${adminId}', '${adminId}', '${adminId}', 'admin', 'hash', 1, ${now}, ${now});

      INSERT INTO events (id, name, slug, capacity, status, version, created_by, created_at_ms, updated_at_ms)
      VALUES ('${eventId}', 'Chaos Fest', 'chaos-fest', 5000, 'live', 1, '${adminId}', ${now}, ${now});

      INSERT INTO spaces (id, event_id, name, kind, sort_order, is_active, created_at_ms, updated_at_ms)
      VALUES ('${spaceAId}', '${eventId}', 'Extérieur', 'external', 0, 1, ${now}, ${now}),
             ('${spaceBId}', '${eventId}', 'Site', 'leaf', 1, 1, ${now}, ${now});

      INSERT INTO space_state (event_id, space_id, occupancy, updated_at_ms)
      VALUES ('${eventId}', '${spaceBId}', 0, ${now});

      INSERT INTO checkpoints (id, event_id, name, space_a_id, space_b_id, allow_a_to_b, allow_b_to_a, label_a_to_b, label_b_to_a, is_active, created_at_ms, updated_at_ms)
      VALUES ('${checkpointId}', '${eventId}', 'Porte Chaos', '${spaceAId}', '${spaceBId}', 1, 1, 'Entrée', 'Sortie', 1, ${now}, ${now});

      INSERT INTO device_sessions (id, event_id, checkpoint_id, label, token_hash, created_at_ms, expires_at_ms, last_seen_at_ms, last_pending_count)
      VALUES ('${deviceSessionId}', '${eventId}', '${checkpointId}', 'Device 1', 'hash-1', ${now}, ${now + 3600000}, ${now}, 0);
    `);

    conn.sqlite.close();
  });

  afterEach(() => {
    try {
      activeConn?.sqlite.close();
    } catch {
      // ignore
    }
  });

  it('Recovers cleanly from simulated abrupt connection death and maintains ledger invariants', async () => {
    // 1. Open Connection and record 50 counts
    activeConn = createDatabase(dbPath);
    for (let i = 1; i <= 50; i++) {
      await applyCountAction(activeConn.sqlite, activeConn.db, {
        eventId,
        checkpointId,
        deviceSessionId,
        clientActionId: `chaos-action-${i}`,
        deviceSequence: i,
        direction: 'a_to_b',
        clientTimeMs: Date.now(),
        source: 'online',
      });
    }

    // 2. Abruptly kill the connection without checkpointing
    activeConn.sqlite.close();
    activeConn = null;

    // 3. Re-open connection (Simulating process restart after crash)
    const restartedConn = createDatabase(dbPath);
    activeConn = restartedConn;

    // Verify DB integrity
    const checkRow = restartedConn.sqlite.prepare('PRAGMA quick_check;').get() as { quick_check: string };
    expect(checkRow.quick_check).toBe('ok');

    // Verify all 50 movements persisted
    const countRow = restartedConn.sqlite.prepare(`SELECT count(*) as total FROM movements WHERE event_id = '${eventId}';`).get() as { total: number };
    expect(countRow.total).toBe(50);

    // Verify state rebuild produces exact match
    const rebuild = await rebuildSpaceStateFromLedger(restartedConn.db, eventId);
    expect(rebuild.isEquivalent).toBe(true);
    expect(rebuild.reconstructedOccupancies[spaceBId]).toBe(50);

    restartedConn.sqlite.close();
    activeConn = null;
  });
});
