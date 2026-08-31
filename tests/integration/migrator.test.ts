import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createDatabase } from '../../apps/server/src/db/index.js';
import { runMigrations } from '../../apps/server/src/db/migrator.js';

/**
 * The migrator's own guarantees, exercised against a real SQLite file.
 *
 * A half-applied migration is the one failure mode `runMigrations` cannot
 * recover from on the next run: the ledger says the file was never applied,
 * so it replays statements that already landed. These tests are about the
 * boundary that makes that impossible.
 */

const REPO_MIGRATIONS = path.resolve(process.cwd(), 'drizzle');

describe('runMigrations', () => {
  const scratchDir = path.resolve(process.cwd(), 'tests/scratch-migrator');
  let dbPath: string;
  let migrationsDir: string;
  let backupDir: string;

  beforeEach(() => {
    fs.mkdirSync(scratchDir, { recursive: true });
    dbPath = path.join(scratchDir, `migrator-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
    migrationsDir = path.join(scratchDir, 'migrations');
    backupDir = path.join(scratchDir, 'backups');
    fs.mkdirSync(migrationsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  function appliedHashes(sqlite: ReturnType<typeof createDatabase>['sqlite']): string[] {
    const rows = sqlite.prepare('SELECT hash FROM "__drizzle_migrations" ORDER BY id').all() as Array<{
      hash: string;
    }>;
    return rows.map((r) => r.hash);
  }

  function tableColumns(
    sqlite: ReturnType<typeof createDatabase>['sqlite'],
    table: string
  ): string[] {
    const rows = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return rows.map((r) => r.name);
  }

  it('rolls a failing migration back whole, and does not record it', () => {
    // Start from a database with 0000 already applied, as a deployed
    // instance would be.
    fs.copyFileSync(path.join(REPO_MIGRATIONS, '0000_petite_beyonder.sql'), path.join(migrationsDir, '0000_petite_beyonder.sql'));

    const { sqlite } = createDatabase(dbPath);
    expect(runMigrations(sqlite, dbPath, { migrationsFolder: migrationsDir, backupDir }).applied).toBe(1);

    // A migration whose first statement is a perfectly good mutation and
    // whose second is not. Half of it landing is exactly the state the
    // ledger cannot describe.
    fs.writeFileSync(
      path.join(migrationsDir, '0001_half_valid.sql'),
      [
        'ALTER TABLE `device_sessions` ADD `first_mutation_should_not_survive` integer;',
        '--> statement-breakpoint',
        'ALTER TABLE `device_sessions` ADD COLUMN;',
      ].join('\n')
    );

    expect(() =>
      runMigrations(sqlite, dbPath, { migrationsFolder: migrationsDir, backupDir })
    ).toThrow(/0001_half_valid\.sql failed and was rolled back/);

    // Neither half of the migration survives…
    expect(tableColumns(sqlite, 'device_sessions')).not.toContain('first_mutation_should_not_survive');
    // …and it is not recorded, so a later run is free to apply a fixed
    // version of it from a clean starting point.
    expect(appliedHashes(sqlite)).toEqual(['0000_petite_beyonder.sql']);

    sqlite.close();
  });

  it('keeps the original failure as the cause rather than replacing it', () => {
    fs.writeFileSync(path.join(migrationsDir, '0000_broken.sql'), 'CREATE TABLE;');

    const { sqlite } = createDatabase(dbPath);

    let caught: unknown;
    try {
      runMigrations(sqlite, dbPath, { migrationsFolder: migrationsDir, backupDir });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    // The SQLite error is what explains why the database looks as it does;
    // wrapping must not throw it away.
    expect((caught as Error).cause).toBeDefined();
    sqlite.close();
  });

  it('applies the real 0000 -> 0001 upgrade without disturbing existing rows', () => {
    fs.cpSync(REPO_MIGRATIONS, migrationsDir, { recursive: true });
    fs.rmSync(path.join(migrationsDir, '0001_superb_white_queen.sql'));

    const { sqlite } = createDatabase(dbPath);
    expect(runMigrations(sqlite, dbPath, { migrationsFolder: migrationsDir, backupDir }).applied).toBe(1);
    expect(tableColumns(sqlite, 'device_sessions')).not.toContain('drained_for_closing_at_ms');

    // Data an operator would already have when the upgrade lands.
    const now = Date.now();
    sqlite
      .prepare(
        `INSERT INTO staff_users (id, username, username_normalized, password_hash, role, is_active, created_at_ms, updated_at_ms)
         VALUES ('user-1', 'admin', 'admin', 'hash', 'admin', 1, ?, ?)`
      )
      .run(now, now);
    sqlite
      .prepare(
        `INSERT INTO events (id, name, slug, timezone, capacity, status, warning_ratio_1, warning_ratio_2, version, created_by, created_at_ms, updated_at_ms)
         VALUES ('event-1', 'Festival', 'festival', 'Europe/Paris', 100, 'live', 0.8, 0.9, 1, 'user-1', ?, ?)`
      )
      .run(now, now);
    sqlite
      .prepare(
        `INSERT INTO spaces (id, event_id, name, kind, sort_order, is_active, created_at_ms, updated_at_ms)
         VALUES ('space-1', 'event-1', 'Site', 'leaf', 0, 1, ?, ?)`
      )
      .run(now, now);
    sqlite
      .prepare(
        `INSERT INTO spaces (id, event_id, name, kind, sort_order, is_active, created_at_ms, updated_at_ms)
         VALUES ('space-0', 'event-1', 'Extérieur', 'external', 0, 1, ?, ?)`
      )
      .run(now, now);
    sqlite
      .prepare(
        `INSERT INTO checkpoints (id, event_id, name, space_a_id, space_b_id, allow_a_to_b, allow_b_to_a, label_a_to_b, label_b_to_a, sort_order, is_active, created_at_ms, updated_at_ms)
         VALUES ('cp-1', 'event-1', 'Porte', 'space-0', 'space-1', 1, 1, 'ENTREE', 'SORTIE', 0, 1, ?, ?)`
      )
      .run(now, now);
    sqlite
      .prepare(
        `INSERT INTO device_sessions (id, event_id, checkpoint_id, label, token_hash, created_at_ms, expires_at_ms, last_pending_count)
         VALUES ('device-1', 'event-1', 'cp-1', 'Porte 1', 'token-hash', ?, ?, 4)`
      )
      .run(now, now + 3_600_000);

    // Now the upgrade lands.
    fs.cpSync(REPO_MIGRATIONS, migrationsDir, { recursive: true });
    const upgrade = runMigrations(sqlite, dbPath, { migrationsFolder: migrationsDir, backupDir });
    expect(upgrade.applied).toBe(1);

    expect(tableColumns(sqlite, 'device_sessions')).toContain('drained_for_closing_at_ms');

    // The existing row is intact, and the new column defaults to "has not
    // acknowledged anything" rather than to a value that would satisfy a
    // close gate on its own.
    const device = sqlite.prepare('SELECT * FROM device_sessions WHERE id = ?').get('device-1') as {
      label: string;
      last_pending_count: number;
      drained_for_closing_at_ms: number | null;
    };
    expect(device.label).toBe('Porte 1');
    expect(device.last_pending_count).toBe(4);
    expect(device.drained_for_closing_at_ms).toBeNull();

    // And the migrator is idempotent: nothing left to do.
    expect(runMigrations(sqlite, dbPath, { migrationsFolder: migrationsDir, backupDir }).applied).toBe(0);
    expect(appliedHashes(sqlite)).toEqual([
      '0000_petite_beyonder.sql',
      '0001_superb_white_queen.sql',
    ]);

    sqlite.close();
  });
});
