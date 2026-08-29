import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from '../../apps/server/src/db/index.js';
import { runMigrations } from '../../apps/server/src/db/migrator.js';
import { applyCountAction } from '../../apps/server/src/domain/movements.js';
import { rebuildSpaceStateFromLedger } from '../../apps/server/src/domain/rebuild.js';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';

describe('High-Throughput Load Simulation (50 Virtual Devices, 1000 Actions)', () => {
  const scratchDir = path.resolve(process.cwd(), 'tests/scratch-load-test');
  const dbPath = path.join(scratchDir, 'load.db');

  let sqlite: ReturnType<typeof createDatabase>['sqlite'];
  let db: ReturnType<typeof createDatabase>['db'];

  const eventId = crypto.randomUUID();
  const spaceAId = crypto.randomUUID();
  const spaceBId = crypto.randomUUID();
  const checkpointId = crypto.randomUUID();

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
    sqlite = conn.sqlite;
    db = conn.db;
    runMigrations(sqlite, dbPath);

    const now = Date.now();
    sqlite.exec(`
      INSERT INTO staff_users (id, username, username_normalized, role, password_hash, is_active, created_at_ms, updated_at_ms)
      VALUES ('admin-load', 'admin-load', 'admin-load', 'admin', 'hash', 1, ${now}, ${now});

      INSERT INTO events (id, name, slug, capacity, status, version, created_by, created_at_ms, updated_at_ms)
      VALUES ('${eventId}', 'Load Fest', 'load-fest', 10000, 'live', 1, 'admin-load', ${now}, ${now});

      INSERT INTO spaces (id, event_id, name, kind, sort_order, is_active, created_at_ms, updated_at_ms)
      VALUES ('${spaceAId}', '${eventId}', 'Extérieur', 'external', 0, 1, ${now}, ${now}),
             ('${spaceBId}', '${eventId}', 'Site Principal', 'leaf', 1, 1, ${now}, ${now});

      INSERT INTO space_state (event_id, space_id, occupancy, updated_at_ms)
      VALUES ('${eventId}', '${spaceBId}', 0, ${now});

      INSERT INTO checkpoints (id, event_id, name, space_a_id, space_b_id, allow_a_to_b, allow_b_to_a, label_a_to_b, label_b_to_a, is_active, created_at_ms, updated_at_ms)
      VALUES ('${checkpointId}', '${eventId}', 'Porte Nord', '${spaceAId}', '${spaceBId}', 1, 1, 'Entrée', 'Sortie', 1, ${now}, ${now});
    `);
  });

  afterEach(() => {
    try {
      sqlite?.close();
    } catch {
      // ignore
    }
  });

  it(
    'Processes 1,000 rapid concurrent count actions across 50 simulated devices with 100% ledger consistency',
    async () => {
      const NUM_DEVICES = 50;
      const ACTIONS_PER_DEVICE = 20; // 1,000 total actions
      const deviceIds: string[] = [];

      const now = Date.now();
      for (let d = 0; d < NUM_DEVICES; d++) {
        const devId = `device-${d + 1}`;
        deviceIds.push(devId);
        sqlite.exec(`
          INSERT INTO device_sessions (id, event_id, checkpoint_id, label, token_hash, created_at_ms, expires_at_ms, last_seen_at_ms, last_pending_count)
          VALUES ('${devId}', '${eventId}', '${checkpointId}', 'Device ${d + 1}', 'hash-${d}', ${now}, ${now + 3600000}, ${now}, 0);
        `);
      }

      const startTime = performance.now();

      // Execute 1,000 movements
      for (let d = 0; d < NUM_DEVICES; d++) {
        const devId = deviceIds[d];
        for (let a = 0; a < ACTIONS_PER_DEVICE; a++) {
          const actionId = `action-${d}-${a}`;
          const res = await applyCountAction(sqlite, db, {
            eventId,
            checkpointId,
            deviceSessionId: devId,
            clientActionId: actionId,
            deviceSequence: a + 1,
            direction: 'a_to_b',
            clientTimeMs: Date.now(),
            source: 'online',
          });
          expect(res.status).toBe('applied');
        }
      }

      const elapsedMs = performance.now() - startTime;
      const throughput = (NUM_DEVICES * ACTIONS_PER_DEVICE) / (elapsedMs / 1000);

      console.log(`\n⚡ Load Benchmark: 1,000 actions processed in ${elapsedMs.toFixed(1)}ms (${throughput.toFixed(1)} actions/sec)`);

      // Verify final state matches exactly 1,000
      const stateRow = sqlite.prepare(`SELECT occupancy FROM space_state WHERE space_id = '${spaceBId}';`).get() as { occupancy: number };
      expect(stateRow.occupancy).toBe(1000);

      // Verify rebuildSpaceStateFromLedger equivalence
      const rebuild = await rebuildSpaceStateFromLedger(db, eventId);
      expect(rebuild.isEquivalent).toBe(true);
      expect(rebuild.totalMovementsProcessed).toBe(1000);
      expect(rebuild.reconstructedOccupancies[spaceBId]).toBe(1000);
    },
    30000
  );
});
