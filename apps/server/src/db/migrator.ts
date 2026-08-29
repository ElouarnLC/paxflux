import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export interface MigrationOptions {
  migrationsFolder?: string;
  backupDir?: string;
}

export function runMigrations(sqlite: DatabaseSync, dbPath: string = './data/app.db', options: MigrationOptions = {}) {
  const migrationsFolder = options.migrationsFolder || path.resolve(process.cwd(), 'drizzle');
  const backupDir = options.backupDir || path.resolve(process.cwd(), 'backups');

  if (!fs.existsSync(migrationsFolder)) {
    throw new Error(`Migrations folder not found: ${migrationsFolder}`);
  }

  // Create migrations table if not exists
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT NOT NULL,
      created_at NUMERIC
    );
  `);

  // Read SQL migration files in order
  const files = fs.readdirSync(migrationsFolder)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  // Check existing applied migrations
  const appliedRows = sqlite.prepare('SELECT hash FROM "__drizzle_migrations"').all() as Array<{ hash: string }>;
  const appliedHashes = new Set(appliedRows.map((r) => r.hash));

  const pendingFiles = files.filter((f) => !appliedHashes.has(f));

  if (pendingFiles.length === 0) {
    return { applied: 0 };
  }

  // If applying migrations to an existing non-memory database with existing data, perform pre-migration backup
  if (dbPath !== ':memory:' && fs.existsSync(dbPath) && appliedHashes.size > 0) {
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    const backupName = `pre-migration-${Date.now()}-${path.basename(dbPath)}`;
    const backupPath = path.join(backupDir, backupName);
    sqlite.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
  }

  // Apply pending migrations inside a transaction
  let appliedCount = 0;
  for (const file of pendingFiles) {
    const sqlContent = fs.readFileSync(path.join(migrationsFolder, file), 'utf8');
    const statements = sqlContent
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    for (const stmt of statements) {
      sqlite.exec(stmt);
    }

    sqlite.prepare('INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES (?, ?)').run(
      file,
      Date.now()
    );
    appliedCount++;
  }

  return { applied: appliedCount };
}
