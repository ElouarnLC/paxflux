import { Page } from '@playwright/test';

/**
 * Direct IndexedDB access for the offline specs.
 *
 * These helpers deliberately talk to raw IndexedDB rather than importing the
 * app's Dexie wrapper: a Phase 6 test must be able to seed the *stored* shape
 * a real device would carry (including a legacy schema written by an older
 * build), not the shape the current code happens to produce. Reading through
 * the same abstraction under test would hide exactly the migration and
 * ownership defects these specs exist to catch.
 */

export const DB_NAME = 'PaxFluxDB';

/** Shape of a row in `outbox_actions`, as stored. */
export interface StoredOutboxRow {
  clientActionId: string;
  sequence: number;
  type: 'count' | 'reversal';
  direction?: 'a_to_b' | 'b_to_a';
  targetClientActionId?: string;
  clientCreatedAtMs: number;
  attempts: number;
  sendState: string;
  lastErrorCode?: string;
  createdAtMs: number;
  owner?: {
    deviceSessionId: string;
    eventId: string;
    checkpointId: string;
  };
}

/** Reads every row currently in `outbox_actions`, whatever schema version. */
export async function readOutbox(page: Page): Promise<StoredOutboxRow[]> {
  return page.evaluate(async (dbName) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(dbName);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (!db.objectStoreNames.contains('outbox_actions')) {
      db.close();
      return [];
    }
    const rows = await new Promise<unknown[]>((resolve, reject) => {
      const req = db.transaction('outbox_actions', 'readonly').objectStore('outbox_actions').getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return rows;
  }, DB_NAME) as Promise<StoredOutboxRow[]>;
}

/** Writes rows straight into `outbox_actions` on the current schema. */
export async function seedOutboxRows(page: Page, rows: StoredOutboxRow[]): Promise<void> {
  await page.evaluate(
    async ({ dbName, rows }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(dbName);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('outbox_actions', 'readwrite');
        const store = tx.objectStore('outbox_actions');
        for (const row of rows) store.put(row);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    },
    { dbName: DB_NAME, rows }
  );
}

/**
 * Recreates the schema an older build left behind: version 1 stores, a
 * `device_cache` keyed by string, and outbox rows carrying no owner at all.
 *
 * Must run before the app first opens the database in this browser context,
 * so that Dexie sees an existing v1 database and runs its upgrade path.
 */
export async function seedLegacyV1Database(
  page: Page,
  rows: Array<Omit<StoredOutboxRow, 'owner'>>
): Promise<void> {
  await page.evaluate(
    async ({ dbName, rows }) => {
      // Dexie multiplies its declared version by ten for the underlying
      // IndexedDB version, so its schema v1 is IDB version 10. Seeding at
      // exactly that number reproduces a device that ran the v1 build, and
      // lets Dexie run the v2 and v3 upgrades on top of it.
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(dbName, 10);
        req.onupgradeneeded = () => {
          const upgraded = req.result;
          // Mirrors the v1 schema exactly — same stores, same indexes —
          // so Dexie introspects it as its own and applies the declared
          // upgrades rather than treating it as a foreign database.
          if (!upgraded.objectStoreNames.contains('outbox_actions')) {
            const store = upgraded.createObjectStore('outbox_actions', { keyPath: 'clientActionId' });
            store.createIndex('sequence', 'sequence', { unique: false });
            store.createIndex('type', 'type', { unique: false });
            store.createIndex('sendState', 'sendState', { unique: false });
            store.createIndex('createdAtMs', 'createdAtMs', { unique: false });
          }
          if (!upgraded.objectStoreNames.contains('device_cache')) {
            upgraded.createObjectStore('device_cache', { keyPath: 'key' });
          }
          if (!upgraded.objectStoreNames.contains('meta')) {
            upgraded.createObjectStore('meta', { keyPath: 'key' });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });

      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(['outbox_actions', 'meta'], 'readwrite');
        const store = tx.objectStore('outbox_actions');
        for (const row of rows) store.put(row);
        tx.objectStore('meta').put({ key: 'next_sequence', value: rows.length });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    },
    { dbName: DB_NAME, rows }
  );
}

/** The occupancy figure the counter displays, as a number. */
export async function displayedOccupancy(page: Page): Promise<number> {
  const text = await page.locator('span.text-5xl.font-black').innerText();
  return Number(text.replace(/[^\d-]/g, ''));
}

export function uuid(): string {
  return crypto.randomUUID();
}
