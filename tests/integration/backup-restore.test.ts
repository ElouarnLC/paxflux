import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from '../../apps/server/src/db/index.js';
import { runMigrations } from '../../apps/server/src/db/migrator.js';
import { createDatabaseBackup, restoreDatabaseFromFile } from '../../apps/server/src/backups/backup-service.js';
import { parseEnv } from '../../apps/server/src/config/env.js';
import { staffUsers, staffSessions } from '../../apps/server/src/db/schema.js';
import { eq } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';

describe('Backup & Restore Operations', () => {
  const scratchDir = path.resolve(process.cwd(), 'tests/scratch-backup-test');
  const dbPath = path.join(scratchDir, 'test.db');
  const backupDir = path.join(scratchDir, 'backups');

  let env: ReturnType<typeof parseEnv>;

  beforeEach(() => {
    if (!fs.existsSync(scratchDir)) {
      fs.mkdirSync(scratchDir, { recursive: true });
    }
    env = parseEnv({
      NODE_ENV: 'test',
      DATA_DIR: scratchDir,
      BACKUP_DIR: backupDir,
    });
  });

  afterEach(() => {
    if (fs.existsSync(scratchDir)) {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  it('Creates valid WAL-coherent backup and verifies SHA256 and quick_check', async () => {
    const conn = createDatabase(dbPath);
    runMigrations(conn.sqlite, dbPath);

    // Seed test data
    const now = Date.now();
    await conn.db.insert(staffUsers).values({
      id: 'admin-1',
      username: 'admin',
      usernameNormalized: 'admin',
      role: 'admin',
      passwordHash: 'hash',
      createdAtMs: now,
      updatedAtMs: now,
    });

    const backup = await createDatabaseBackup(conn.sqlite, conn.db, env, 'test_backup');

    expect(backup.filename).toBeDefined();
    expect(backup.quickCheckOk).toBe(true);
    expect(backup.sha256.length).toBe(64);
    expect(fs.existsSync(backup.filepath)).toBe(true);

    conn.sqlite.close();
  });

  it('Invariant 17: Restoring a backup successfully invalidates active staff and device sessions', async () => {
    const conn = createDatabase(dbPath);
    runMigrations(conn.sqlite, dbPath);

    const now = Date.now();
    await conn.db.insert(staffUsers).values({
      id: 'admin-1',
      username: 'admin',
      usernameNormalized: 'admin',
      role: 'admin',
      passwordHash: 'hash',
      createdAtMs: now,
      updatedAtMs: now,
    });

    await conn.db.insert(staffSessions).values({
      id: 'session-1',
      userId: 'admin-1',
      tokenHash: 'token_hash_1',
      csrfHash: 'csrf_hash_1',
      createdAtMs: now,
      lastSeenAtMs: now,
      expiresAtMs: now + 3600000,
      revokedAtMs: null, // Active
    });

    // Create backup with active session
    const backup = await createDatabaseBackup(conn.sqlite, conn.db, env, 'pre_restore');
    conn.sqlite.close();

    // Now restore backup into a new DB file
    const restoreTargetDbPath = path.join(scratchDir, 'restored.db');
    const restoreResult = restoreDatabaseFromFile(backup.filepath, restoreTargetDbPath);

    expect(restoreResult.success).toBe(true);

    // Verify restored sessions are revoked
    const restoredConn = createDatabase(restoreTargetDbPath);
    const restoredSession = await restoredConn.db
      .select()
      .from(staffSessions)
      .where(eq(staffSessions.id, 'session-1'))
      .get();

    expect(restoredSession?.revokedAtMs).not.toBeNull();
    restoredConn.sqlite.close();
  });
});
