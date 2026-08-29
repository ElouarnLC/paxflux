import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, verifyPragmas } from '../../apps/server/src/db/index.js';
import { runMigrations } from '../../apps/server/src/db/migrator.js';
import fs from 'node:fs';
import path from 'node:path';

describe('SQLite Initialization & PRAGMAs', () => {
  const testDbDir = path.resolve(process.cwd(), 'tests/scratch-db');
  const testDbPath = path.join(testDbDir, `test-${Date.now()}.db`);

  beforeEach(() => {
    if (!fs.existsSync(testDbDir)) {
      fs.mkdirSync(testDbDir, { recursive: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(testDbDir)) {
      fs.rmSync(testDbDir, { recursive: true, force: true });
    }
  });

  it('correctly sets WAL, synchronous=FULL, foreign_keys=ON, busy_timeout=5000', () => {
    const { sqlite } = createDatabase(testDbPath);
    const pragmas = verifyPragmas(sqlite);

    expect(pragmas.journalMode.toLowerCase()).toBe('wal');
    expect(pragmas.synchronous).toBe(2); // FULL = 2
    expect(pragmas.foreignKeys).toBe(true);
    expect(pragmas.busyTimeout).toBe(5000);
    sqlite.close();
  });

  it('runs migrations on an empty database successfully', () => {
    const { sqlite } = createDatabase(testDbPath);
    const res = runMigrations(sqlite, testDbPath);
    expect(res.applied).toBeGreaterThan(0);

    // Verify tables exist
    const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    const tableNames = new Set(tables.map((t) => t.name));

    expect(tableNames.has('events')).toBe(true);
    expect(tableNames.has('spaces')).toBe(true);
    expect(tableNames.has('space_state')).toBe(true);
    expect(tableNames.has('checkpoints')).toBe(true);
    expect(tableNames.has('movements')).toBe(true);
    expect(tableNames.has('staff_users')).toBe(true);
    expect(tableNames.has('staff_sessions')).toBe(true);
    expect(tableNames.has('device_sessions')).toBe(true);
    expect(tableNames.has('audit_log')).toBe(true);
    expect(tableNames.has('backup_records')).toBe(true);

    sqlite.close();
  });

  it('is idempotent when running migrations a second time', () => {
    const { sqlite } = createDatabase(testDbPath);
    runMigrations(sqlite, testDbPath);
    const res2 = runMigrations(sqlite, testDbPath);
    expect(res2.applied).toBe(0);
    sqlite.close();
  });
});
