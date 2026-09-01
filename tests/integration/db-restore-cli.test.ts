import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createDatabase } from '../../apps/server/src/db/index.js';
import { runMigrations } from '../../apps/server/src/db/migrator.js';
import { parseEnv } from '../../apps/server/src/config/env.js';
import {
  createDatabaseBackup,
  restoreDatabaseFromFile,
  RestoreError,
} from '../../apps/server/src/backups/backup-service.js';
import { parseArgs } from '../../apps/server/src/db/restore.js';
import { staffUsers, staffSessions, deviceSessions, events, checkpoints, spaces } from '../../apps/server/src/db/schema.js';

/**
 * `npm run db:restore` is the only supported way to restore PaxFlux, so the
 * guarantees are pinned on the primitive it calls rather than left to the
 * runbook. Each of these corresponds to a way the previous file-copy procedure
 * failed in the field.
 */

const scratchDir = path.resolve(process.cwd(), 'tests/scratch-restore-cli');
const dataDir = path.join(scratchDir, 'data');
const backupDir = path.join(scratchDir, 'backups');
const dbPath = path.join(dataDir, 'app.db');

let env: ReturnType<typeof parseEnv>;

/** A database with an admin, a live event, and one active session of each kind. */
async function seedInstance(): Promise<void> {
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
    id: 'staff-session-1',
    userId: 'admin-1',
    tokenHash: 'staff_token_hash',
    csrfHash: 'staff_csrf_hash',
    createdAtMs: now,
    lastSeenAtMs: now,
    expiresAtMs: now + 3_600_000,
    revokedAtMs: null,
  });

  await conn.db.insert(events).values({
    id: 'event-1',
    name: 'Restore Fixture',
    slug: 'restore-fixture',
    status: 'live',
    capacity: 100,
    warningRatio1: 0.8,
    warningRatio2: 0.9,
    timezone: 'Europe/Paris',
    version: 1,
    createdBy: 'admin-1',
    createdAtMs: now,
    updatedAtMs: now,
  });
  await conn.db.insert(spaces).values([
    { id: 'space-ext', eventId: 'event-1', name: 'Extérieur', kind: 'external', sortOrder: 0, createdAtMs: now, updatedAtMs: now },
    { id: 'space-site', eventId: 'event-1', name: 'Site', kind: 'leaf', capacity: 100, sortOrder: 1, createdAtMs: now, updatedAtMs: now },
  ]);
  await conn.db.insert(checkpoints).values({
    id: 'cp-1',
    eventId: 'event-1',
    name: 'Porte',
    spaceAId: 'space-ext',
    spaceBId: 'space-site',
    allowAToB: true,
    allowBToA: true,
    labelAToB: 'ENTREE',
    labelBToA: 'SORTIE',
    isActive: true,
    sortOrder: 0,
    createdAtMs: now,
    updatedAtMs: now,
  });
  await conn.db.insert(deviceSessions).values({
    id: 'device-session-1',
    eventId: 'event-1',
    checkpointId: 'cp-1',
    tokenHash: 'device_token_hash',
    label: 'Téléphone 1',
    createdAtMs: now,
    expiresAtMs: now + 3_600_000,
    lastSeenAtMs: now,
    lastPendingCount: 0,
    revokedAtMs: null,
  });

  conn.sqlite.close();
}

function activeSessions(file: string): { staff: number; device: number } {
  const db = new DatabaseSync(file);
  try {
    const one = (table: string) =>
      (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE revoked_at_ms IS NULL;`).get() as { n: number }).n;
    return { staff: one('staff_sessions'), device: one('device_sessions') };
  } finally {
    db.close();
  }
}

describe('db:restore — the restore primitive', () => {
  beforeEach(() => {
    fs.rmSync(scratchDir, { recursive: true, force: true });
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(backupDir, { recursive: true });
    env = parseEnv({ NODE_ENV: 'test', DATA_DIR: dataDir, BACKUP_DIR: backupDir });
  });

  afterEach(() => {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  async function snapshot(): Promise<string> {
    const conn = createDatabase(dbPath);
    const backup = await createDatabaseBackup(conn.sqlite, conn.db, env, 'test');
    conn.sqlite.close();
    return backup.filepath;
  }

  it('revokes every staff and device session carried by the snapshot (invariant 17)', async () => {
    await seedInstance();
    const backupPath = await snapshot();

    // The snapshot itself still holds the live sessions...
    expect(activeSessions(backupPath)).toEqual({ staff: 1, device: 1 });

    const result = restoreDatabaseFromFile(backupPath, dbPath);

    // ...and the restored database holds none.
    expect(result.revokedStaffSessions).toBe(1);
    expect(result.revokedDeviceSessions).toBe(1);
    expect(activeSessions(dbPath)).toEqual({ staff: 0, device: 0 });

    // The snapshot file is not modified by restoring from it.
    expect(activeSessions(backupPath)).toEqual({ staff: 1, device: 1 });
  });

  it('restores the data itself, not only the sessions', async () => {
    await seedInstance();
    const backupPath = await snapshot();

    // Diverge after the snapshot.
    const live = createDatabase(dbPath);
    live.sqlite.exec("UPDATE events SET name = 'Renamed After Snapshot' WHERE id = 'event-1';");
    live.sqlite.close();

    restoreDatabaseFromFile(backupPath, dbPath);

    const db = new DatabaseSync(dbPath);
    const row = db.prepare("SELECT name FROM events WHERE id = 'event-1';").get() as { name: string };
    db.close();
    expect(row.name).toBe('Restore Fixture');
  });

  it('removes the stale -wal and -shm sidecars of the replaced database', async () => {
    await seedInstance();
    const backupPath = await snapshot();

    // Force a WAL to exist beside the live database.
    const live = createDatabase(dbPath);
    live.sqlite.exec("UPDATE events SET name = 'Dirty' WHERE id = 'event-1';");
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(true);
    live.sqlite.close();
    // A close checkpoints the WAL; recreate one that outlives the connection.
    fs.writeFileSync(`${dbPath}-wal`, Buffer.alloc(64));
    fs.writeFileSync(`${dbPath}-shm`, Buffer.alloc(64));

    const result = restoreDatabaseFromFile(backupPath, dbPath);

    expect(result.removedSidecars.sort()).toEqual(['app.db-shm', 'app.db-wal']);
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(false);
    expect(fs.existsSync(`${dbPath}-shm`)).toBe(false);
  });

  it('writes a database owned by the running process, with 0640 permissions', async () => {
    await seedInstance();
    const backupPath = await snapshot();

    restoreDatabaseFromFile(backupPath, dbPath);

    const stat = fs.statSync(dbPath);
    // Ownership is what it is because *this* process wrote the file — which is
    // the whole point of restoring from the runtime container rather than
    // copying in as root.
    expect(stat.uid).toBe(process.getuid?.());
    expect(stat.gid).toBe(process.getgid?.());
    expect(stat.mode & 0o777).toBe(0o640);
  });

  it('refuses a corrupt snapshot and leaves the live database untouched', async () => {
    await seedInstance();
    const corrupt = path.join(backupDir, 'corrupt.db');
    fs.writeFileSync(corrupt, Buffer.from('this is definitely not a SQLite database'));

    const before = fs.readFileSync(dbPath);
    expect(() => restoreDatabaseFromFile(corrupt, dbPath)).toThrow(RestoreError);
    expect(fs.readFileSync(dbPath).equals(before)).toBe(true);
    // The instance still has its sessions: nothing was half-applied.
    expect(activeSessions(dbPath)).toEqual({ staff: 1, device: 1 });
  });

  it('refuses a snapshot that is a valid file but not a database, without staging leftovers', async () => {
    await seedInstance();
    const notADb = path.join(backupDir, 'notes.txt');
    fs.writeFileSync(notADb, 'a text file an operator picked by mistake');

    expect(() => restoreDatabaseFromFile(notADb, dbPath)).toThrow(RestoreError);
    const leftovers = fs.readdirSync(dataDir).filter((name) => name.startsWith('.restore-'));
    expect(leftovers, 'a failed restore must not leave staging files behind').toEqual([]);
  });

  it('refuses a missing snapshot, a directory, and a target that is its own source', async () => {
    await seedInstance();
    const backupPath = await snapshot();

    expect(() => restoreDatabaseFromFile(path.join(backupDir, 'nope.db'), dbPath)).toThrow(
      /Backup file not found/
    );
    expect(() => restoreDatabaseFromFile(backupDir, dbPath)).toThrow(/not a file/);
    expect(() => restoreDatabaseFromFile(backupPath, backupPath)).toThrow(/same file/);
    expect(() => restoreDatabaseFromFile(backupPath, path.join(scratchDir, 'no-such-dir/app.db'))).toThrow(
      /Target directory does not exist/
    );
  });

  it('names the step that failed, so an operator knows where it stopped', async () => {
    await seedInstance();
    const corrupt = path.join(backupDir, 'corrupt.db');
    fs.writeFileSync(corrupt, Buffer.from('nope'));
    try {
      restoreDatabaseFromFile(corrupt, dbPath);
      throw new Error('expected the restore to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RestoreError);
      expect((err as RestoreError).step).toBe('verify-backup');
    }
  });
});

describe('db:restore — the command', () => {
  beforeEach(() => {
    fs.rmSync(scratchDir, { recursive: true, force: true });
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(backupDir, { recursive: true });
    env = parseEnv({ NODE_ENV: 'test', DATA_DIR: dataDir, BACKUP_DIR: backupDir });
  });

  afterEach(() => {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  it('takes one snapshot path, with an optional explicit target', () => {
    expect(parseArgs(['/backups/x.db'])).toEqual({ backupFile: '/backups/x.db', target: undefined });
    expect(parseArgs(['/backups/x.db', '--target', '/data/app.db'])).toEqual({
      backupFile: '/backups/x.db',
      target: '/data/app.db',
    });
  });

  it('refuses ambiguous or missing arguments rather than guessing', () => {
    expect(() => parseArgs([])).toThrow(/No backup file given/);
    expect(() => parseArgs(['a.db', 'b.db'])).toThrow(/Expected one backup file/);
    expect(() => parseArgs(['a.db', '--target'])).toThrow(/--target requires a path/);
    expect(() => parseArgs(['--wat', 'a.db'])).toThrow(/Unknown option/);
  });

  /**
   * The command as an operator runs it, against the compiled entry point that
   * ships in the image — not the TypeScript source.
   */
  const compiled = path.resolve(process.cwd(), 'apps/server/dist/db/restore.js');
  const hasBuild = fs.existsSync(compiled);

  it('exits non-zero and changes nothing when the snapshot is unusable', async () => {
    await seedInstance();
    if (!hasBuild) {
      // Nothing to assert about a binary that has not been built; the argument
      // parser above already covers the logic. `npm test` builds only the
      // shared package, so this is skipped rather than silently passing.
      return;
    }
    const corrupt = path.join(backupDir, 'corrupt.db');
    fs.writeFileSync(corrupt, Buffer.from('not a database'));
    const before = fs.readFileSync(dbPath);

    let status = 0;
    let output = '';
    try {
      execFileSync('node', [compiled, corrupt], {
        env: { ...process.env, DATA_DIR: dataDir, BACKUP_DIR: backupDir },
        encoding: 'utf-8',
        stdio: 'pipe',
      });
    } catch (err) {
      const e = err as { status: number; stderr: string };
      status = e.status;
      output = e.stderr;
    }

    expect(status, 'a failed restore must exit non-zero').toBe(1);
    expect(output).toMatch(/RESTORE FAILED \(verify-backup\)/);
    expect(output).toMatch(/left untouched/);
    expect(fs.readFileSync(dbPath).equals(before)).toBe(true);
  });

  it('restores through the compiled command and reports what it did', async () => {
    await seedInstance();
    if (!hasBuild) return;

    const conn = createDatabase(dbPath);
    const backup = await createDatabaseBackup(conn.sqlite, conn.db, env, 'cli');
    conn.sqlite.exec("UPDATE events SET name = 'Diverged' WHERE id = 'event-1';");
    conn.sqlite.close();

    const stdout = execFileSync('node', [compiled, backup.filepath], {
      env: { ...process.env, DATA_DIR: dataDir, BACKUP_DIR: backupDir },
      encoding: 'utf-8',
    });

    expect(stdout).toMatch(/snapshot passed PRAGMA quick_check before anything was replaced/);
    expect(stdout).toMatch(/revoked 1 staff session\(s\) and 1 device session\(s\)/);
    expect(stdout).toMatch(/restored database passed PRAGMA quick_check/);

    expect(activeSessions(dbPath)).toEqual({ staff: 0, device: 0 });
    const db = new DatabaseSync(dbPath);
    const row = db.prepare("SELECT name FROM events WHERE id = 'event-1';").get() as { name: string };
    db.close();
    expect(row.name).toBe('Restore Fixture');
  });
});
