import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AppDb } from '../db/index.js';
import { backupRecords } from '../db/schema.js';
import { eq, desc } from 'drizzle-orm';
import { Env } from '../config/env.js';

export interface BackupResult {
  filename: string;
  filepath: string;
  sizeBytes: number;
  sha256: string;
  quickCheckOk: boolean;
  createdAtMs: number;
}

export async function createDatabaseBackup(
  sqlite: DatabaseSync,
  db: AppDb,
  env: Env,
  reason: string = 'manual'
): Promise<BackupResult> {
  const backupDir = path.resolve(env.BACKUP_DIR);
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  const now = Date.now();
  const safeReason = reason.replace(/[^a-zA-Z0-9_-]/g, '_');
  const filename = `paxflux-backup-${now}-${safeReason}.db`;
  const filepath = path.join(backupDir, filename);

  // Use SQLite VACUUM INTO for atomic WAL-coherent snapshot
  sqlite.exec(`VACUUM INTO '${filepath.replace(/'/g, "''")}';`);

  // Calculate SHA-256
  const fileBuffer = fs.readFileSync(filepath);
  const sha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex');
  const sizeBytes = fileBuffer.length;

  // Validate integrity of the copy with PRAGMA quick_check
  let quickCheckOk = false;
  try {
    const backupDb = new DatabaseSync(filepath);
    const checkRow = backupDb.prepare('PRAGMA quick_check;').get() as { quick_check?: string } | undefined;
    quickCheckOk = checkRow?.quick_check === 'ok';
    backupDb.close();
  } catch (err) {
    console.error('Backup quick_check failed:', err);
    quickCheckOk = false;
  }

  // Record in backup_records
  await db.insert(backupRecords).values({
    filename,
    reason,
    sizeBytes,
    sha256,
    quickCheckOk,
    createdAtMs: now,
  });

  // Prune older backups
  try {
    await pruneOldBackups(db, env);
  } catch (err) {
    console.warn('Backup pruning warning:', err);
  }

  return {
    filename,
    filepath,
    sizeBytes,
    sha256,
    quickCheckOk,
    createdAtMs: now,
  };
}

async function pruneOldBackups(db: AppDb, env: Env) {
  const allBackups = await db
    .select()
    .from(backupRecords)
    .orderBy(desc(backupRecords.id))
    .all();

  const retentionCount = env.BACKUP_RETENTION_COUNT || 300;
  if (allBackups.length > retentionCount) {
    const toDelete = allBackups.slice(retentionCount);
    const backupDir = path.resolve(env.BACKUP_DIR);

    for (const b of toDelete) {
      const p = path.join(backupDir, b.filename);
      if (fs.existsSync(p)) {
        fs.unlinkSync(p);
      }
      await db.delete(backupRecords).where(eq(backupRecords.id, b.id));
    }
  }
}

export interface RestoreResult {
  backupFilePath: string;
  targetDbPath: string;
  sizeBytes: number;
  sha256: string;
  revokedStaffSessions: number;
  revokedDeviceSessions: number;
  removedSidecars: string[];
}

/** Every way a restore can refuse, so a caller can report the cause exactly. */
export class RestoreError extends Error {
  constructor(
    message: string,
    readonly step: string
  ) {
    super(message);
    this.name = 'RestoreError';
  }
}

function quickCheck(dbPath: string, step: string): void {
  // Opening is lazy: SQLite accepts the path and only rejects the file when a
  // statement runs, so a text file an operator picked by mistake fails here
  // and not above. Both paths have to produce a RestoreError naming the step,
  // otherwise the command reports a bare driver message with no context.
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath);
    const row = db.prepare('PRAGMA quick_check;').get() as { quick_check?: string } | undefined;
    if (row?.quick_check !== 'ok') {
      throw new RestoreError(
        `PRAGMA quick_check on ${dbPath} returned '${row?.quick_check ?? 'no result'}' instead of 'ok'`,
        step
      );
    }
  } catch (err) {
    if (err instanceof RestoreError) throw err;
    throw new RestoreError(
      `${dbPath} is not a usable SQLite database: ${(err as Error).message}`,
      step
    );
  } finally {
    db?.close();
  }
}

/**
 * Restores a snapshot over the live database, offline.
 *
 * This is the single primitive behind `npm run db:restore`, which is the only
 * documented way to restore PaxFlux. It is deliberately not reachable over
 * HTTP: a restore replaces the whole instance and must happen with the service
 * stopped, so it is an operator action taken from a one-shot container, not a
 * request.
 *
 * Everything the runbook used to ask an operator to remember by hand is
 * enforced here instead, because the previous file-copy procedure failed in
 * three separate ways in the field:
 *
 *  * the backup is validated *before* anything is replaced, so a corrupt
 *    snapshot cannot destroy a working instance;
 *  * the work happens on a temporary file beside the target and is promoted by
 *    a single rename, so the live database is never left half-restored — if
 *    any step fails, the instance still holds exactly what it held before;
 *  * the sessions carried inside the snapshot are revoked before it becomes
 *    live, so a token issued after the snapshot cannot keep writing to the
 *    restored database (specification invariant 17);
 *  * the stale `-wal` and `-shm` sidecars of the replaced database are removed,
 *    since they describe a file that no longer exists;
 *  * the file is written by this process, so it belongs to the runtime user
 *    (uid/gid 10001 in the image) rather than to whoever ran the copy.
 *
 * Any problem throws: there is no partial success to report.
 */
export function restoreDatabaseFromFile(
  backupFilePath: string,
  targetDbPath: string
): RestoreResult {
  const backup = path.resolve(backupFilePath);
  const target = path.resolve(targetDbPath);

  if (backup === target) {
    throw new RestoreError('The backup and the target database are the same file.', 'arguments');
  }
  if (!fs.existsSync(backup)) {
    throw new RestoreError(`Backup file not found: ${backup}`, 'read-backup');
  }
  if (!fs.statSync(backup).isFile()) {
    throw new RestoreError(`Backup path is not a file: ${backup}`, 'read-backup');
  }

  const targetDir = path.dirname(target);
  if (!fs.existsSync(targetDir)) {
    throw new RestoreError(`Target directory does not exist: ${targetDir}`, 'read-target');
  }

  // 1. The backup must be a sound database before anything is touched.
  quickCheck(backup, 'verify-backup');

  const fileBuffer = fs.readFileSync(backup);
  const sha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex');

  // 2. Stage beside the target, on the same filesystem, so the promotion below
  //    is a rename and not a copy that could be interrupted half-written.
  const staging = path.join(targetDir, `.restore-${process.pid}-${Date.now()}.db`);
  let revokedStaffSessions = 0;
  let revokedDeviceSessions = 0;

  try {
    fs.copyFileSync(backup, staging);
    // Readable and writable by the owner, readable by the group, nothing for
    // anyone else. The owner is this process, i.e. the runtime user.
    fs.chmodSync(staging, 0o640);

    // 3. Revoke every session the snapshot carried, while it is still staging.
    const staged = new DatabaseSync(staging);
    try {
      const now = Date.now();
      const countActive = (table: string): number => {
        const row = staged
          .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE revoked_at_ms IS NULL;`)
          .get() as { n?: number } | undefined;
        return row?.n ?? 0;
      };
      revokedStaffSessions = countActive('staff_sessions');
      revokedDeviceSessions = countActive('device_sessions');

      staged.exec('BEGIN IMMEDIATE;');
      try {
        staged.prepare('UPDATE staff_sessions SET revoked_at_ms = ? WHERE revoked_at_ms IS NULL;').run(now);
        staged.prepare('UPDATE device_sessions SET revoked_at_ms = ? WHERE revoked_at_ms IS NULL;').run(now);
        staged.exec('COMMIT;');
      } catch (err) {
        staged.exec('ROLLBACK;');
        throw err;
      }

      if (countActive('staff_sessions') !== 0 || countActive('device_sessions') !== 0) {
        throw new RestoreError(
          'Sessions from the snapshot are still active after revocation.',
          'revoke-sessions'
        );
      }

      // Fold the WAL back into the file itself: what gets renamed into place
      // must be complete on its own, with no sidecar to carry.
      staged.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } finally {
      staged.close();
    }

    // 4. The database that is about to go live must itself be sound.
    quickCheck(staging, 'verify-restored');
  } catch (err) {
    fs.rmSync(staging, { force: true });
    fs.rmSync(`${staging}-wal`, { force: true });
    fs.rmSync(`${staging}-shm`, { force: true });
    if (err instanceof RestoreError) throw err;
    throw new RestoreError((err as Error).message, 'stage-restore');
  }

  // 5. Drop the sidecars of the database being replaced: they describe a file
  //    that is about to stop existing.
  const removedSidecars: string[] = [];
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = `${target}${suffix}`;
    if (fs.existsSync(sidecar)) {
      fs.rmSync(sidecar, { force: true });
      removedSidecars.push(path.basename(sidecar));
    }
  }
  for (const suffix of ['-wal', '-shm']) {
    fs.rmSync(`${staging}${suffix}`, { force: true });
  }

  // 6. Promote. Up to here the live database was untouched.
  fs.renameSync(staging, target);

  // 7. And confirm what is now in place, rather than assuming the rename was
  //    enough.
  quickCheck(target, 'verify-final');

  return {
    backupFilePath: backup,
    targetDbPath: target,
    sizeBytes: fileBuffer.length,
    sha256,
    revokedStaffSessions,
    revokedDeviceSessions,
    removedSidecars,
  };
}
