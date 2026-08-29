import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/sqlite-proxy';
import * as schema from './schema.js';
import path from 'node:path';
import fs from 'node:fs';

export type AppDb = ReturnType<typeof drizzle<typeof schema>>;

export interface DatabaseConnection {
  sqlite: DatabaseSync;
  db: AppDb;
}

export function createDatabase(dbPath: string = './data/app.db'): DatabaseConnection {
  if (dbPath !== ':memory:') {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const sqlite = new DatabaseSync(dbPath);

  // Apply PRAGMAs per SPEC §16.2
  if (dbPath !== ':memory:') {
    sqlite.exec('PRAGMA journal_mode = WAL;');
  }
  sqlite.exec('PRAGMA synchronous = FULL;');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  sqlite.exec('PRAGMA busy_timeout = 5000;');

  const db = drizzle(
    async (sqlQuery, params, method) => {
      try {
        const stmt = sqlite.prepare(sqlQuery);
        stmt.setReturnArrays(true);
        if (method === 'get') {
          const row = stmt.get(...(params as any[]));
          return { rows: row as any };
        }
        if (method === 'all' || method === 'values') {
          const rows = stmt.all(...(params as any[]));
          return { rows: rows as any };
        }
        stmt.run(...(params as any[]));
        return { rows: [] };
      } catch (err: any) {
        console.error('Database query error:', { sql: sqlQuery, params, error: err.message });
        throw err;
      }
    },
    { schema }
  );

  return { sqlite, db };
}

export function verifyPragmas(sqlite: DatabaseSync): {
  journalMode: string;
  synchronous: number;
  foreignKeys: boolean;
  busyTimeout: number;
} {
  const journalModeRow = sqlite.prepare('PRAGMA journal_mode;').get() as { journal_mode?: string } | undefined;
  const syncRow = sqlite.prepare('PRAGMA synchronous;').get() as { synchronous?: number } | undefined;
  const fkRow = sqlite.prepare('PRAGMA foreign_keys;').get() as { foreign_keys?: number } | undefined;
  const busyRow = sqlite.prepare('PRAGMA busy_timeout;').get() as { timeout?: number } | undefined;

  return {
    journalMode: journalModeRow?.journal_mode || 'unknown',
    synchronous: syncRow?.synchronous ?? -1,
    foreignKeys: fkRow?.foreign_keys === 1,
    busyTimeout: busyRow?.timeout ?? -1,
  };
}
