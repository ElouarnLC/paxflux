import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AppDb } from '../db/index.js';
import { backupRecords, events } from '../db/schema.js';
import { eq, desc, asc } from 'drizzle-orm';
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

export function restoreDatabaseFromFile(
  backupFilePath: string,
  targetDbPath: string
): { success: boolean; message: string } {
  if (!fs.existsSync(backupFilePath)) {
    throw new Error(`Backup file not found: ${backupFilePath}`);
  }

  // Verify backup before copying
  const tempDb = new DatabaseSync(backupFilePath);
  const checkRow = tempDb.prepare('PRAGMA quick_check;').get() as { quick_check?: string } | undefined;
  if (checkRow?.quick_check !== 'ok') {
    tempDb.close();
    throw new Error('PRAGMA quick_check failed on backup file.');
  }
  tempDb.close();

  // Copy file over target
  fs.copyFileSync(backupFilePath, targetDbPath);

  // Invalidate all restored staff and device sessions per Invariant 17
  const restoredDb = new DatabaseSync(targetDbPath);
  const now = Date.now();
  restoredDb.exec(`UPDATE staff_sessions SET revoked_at_ms = ${now} WHERE revoked_at_ms IS NULL;`);
  restoredDb.exec(`UPDATE device_sessions SET revoked_at_ms = ${now} WHERE revoked_at_ms IS NULL;`);
  restoredDb.close();

  return { success: true, message: 'Database successfully restored and active sessions invalidated.' };
}
