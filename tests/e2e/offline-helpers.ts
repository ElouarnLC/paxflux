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
/** A row of the v1 `device_cache` table, as an older build wrote it. */
export interface LegacyCacheRow {
  key: string;
  bootstrap?: unknown;
  lastState?: unknown;
  updatedAtMs: number;
}

export async function seedLegacyV1Database(
  page: Page,
  rows: Array<Omit<StoredOutboxRow, 'owner'>>,
  cacheRows: LegacyCacheRow[] = []
): Promise<void> {
  await page.evaluate(
    async ({ dbName, rows, cacheRows }) => {
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
        const tx = db.transaction(['outbox_actions', 'device_cache', 'meta'], 'readwrite');
        const store = tx.objectStore('outbox_actions');
        for (const row of rows) store.put(row);
        const cache = tx.objectStore('device_cache');
        for (const row of cacheRows) cache.put(row);
        tx.objectStore('meta').put({ key: 'next_sequence', value: rows.length });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    },
    { dbName: DB_NAME, rows, cacheRows }
  );
}

/**
 * Waits for the service worker to be registered and controlling the page.
 *
 * `vite-plugin-pwa` injects its registration script into the built
 * `index.html` (default `injectRegister: 'auto'`), and the E2E server serves
 * that build — so the shell genuinely is available offline, but only once
 * the worker has activated and taken control.
 */
export async function waitForServiceWorkerControl(page: Page, timeoutMs = 20_000): Promise<boolean> {
  return page.evaluate(async (timeout) => {
    if (!('serviceWorker' in navigator)) return false;
    const deadline = Date.now() + timeout;
    try {
      await navigator.serviceWorker.ready;
    } catch {
      return false;
    }
    while (Date.now() < deadline) {
      if (navigator.serviceWorker.controller) return true;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return navigator.serviceWorker.controller !== null;
  }, timeoutMs);
}

/**
 * Overwrites the stored authoritative state with a version the server has
 * moved *behind*.
 *
 * This is the client half of a database restore, and the only half a browser
 * test can stage: the server really is rolled back by `npm run db:restore`,
 * but a Playwright spec cannot stop the web server mid-run to do it. What
 * matters for the defect is the resulting asymmetry — an IndexedDB row whose
 * `version` is ahead of the server's — so the row is written directly, in the
 * stored shape, exactly as a pre-restore device would still be carrying it.
 */
export async function seedAheadOfServerEventState(
  page: Page,
  record: { eventId: string; version: number; eventOccupancy: number; serverTimeMs: number }
): Promise<void> {
  await page.evaluate(
    async ({ dbName, seed }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(dbName);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const existing = await new Promise<any>((resolve, reject) => {
        const req = db.transaction('event_state', 'readonly').objectStore('event_state').get('current');
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror = () => reject(req.error);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('event_state', 'readwrite');
        tx.objectStore('event_state').put({
          key: 'current',
          eventId: seed.eventId,
          updatedAtMs: Date.now(),
          state: {
            ...(existing?.state ?? {}),
            version: seed.version,
            eventStatus: existing?.state?.eventStatus ?? 'live',
            eventOccupancy: seed.eventOccupancy,
            eventCapacity: existing?.state?.eventCapacity ?? 500,
            spaces: existing?.state?.spaces ?? [],
            serverTimeMs: seed.serverTimeMs,
            closingStartedAtMs: existing?.state?.closingStartedAtMs ?? null,
          },
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    },
    { dbName: DB_NAME, seed: record }
  );
}

/** The stored snapshot record, for asserting on migration outcomes. */
export async function readEventStateRecord(page: Page): Promise<Record<string, unknown> | null> {
  return page.evaluate(async (dbName) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(dbName);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (!db.objectStoreNames.contains('event_state')) {
      db.close();
      return null;
    }
    const record = await new Promise<unknown>((resolve, reject) => {
      const req = db.transaction('event_state', 'readonly').objectStore('event_state').get('current');
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return record as Record<string, unknown> | null;
  }, DB_NAME);
}

/**
 * The occupancy figure the counter displays, as a number.
 *
 * The counter writes a negative with U+2212 — the same minus as the
 * `SORTIE −1` button beside it — so it is normalised here before parsing.
 * Reading `−1` as `1` would make a no-clamp assertion pass on a clamped
 * display, which is the one failure this helper must not produce.
 */
export async function displayedOccupancy(page: Page): Promise<number> {
  const text = (await page.getByTestId('global-occupancy').innerText()).replace(/\u2212/g, '-');
  return Number(text.replace(/[^\d-]/g, ''));
}

export function uuid(): string {
  return crypto.randomUUID();
}

/** The device session id this page is currently paired as, per the server. */
export async function readDeviceSessionId(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const res = await fetch('/api/v1/device/bootstrap', { credentials: 'include' });
    if (!res.ok) throw new Error(`bootstrap failed: ${res.status}`);
    const bootstrap = await res.json();
    return bootstrap.deviceSession.id as string;
  });
}

/** The stored pairing configuration, for asserting on a pairing handoff. */
export async function readDeviceConfigRecord(page: Page): Promise<Record<string, unknown> | null> {
  return page.evaluate(async (dbName) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(dbName);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (!db.objectStoreNames.contains('device_config')) {
      db.close();
      return null;
    }
    const record = await new Promise<unknown>((resolve, reject) => {
      const req = db.transaction('device_config', 'readonly').objectStore('device_config').get('current');
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return record as Record<string, unknown> | null;
  }, DB_NAME);
}
