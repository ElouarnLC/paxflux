import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/sqlite-proxy';
import crypto from 'node:crypto';
import * as schema from '../../apps/server/src/db/schema.js';
import { createDatabase } from '../../apps/server/src/db/index.js';
import { runMigrations } from '../../apps/server/src/db/migrator.js';
import { getCompactEventState } from '../../apps/server/src/domain/events.js';
import { events, spaces, spaceState, staffUsers } from '../../apps/server/src/db/schema.js';
import { buildApp } from '../../apps/server/src/app.js';
import { parseEnv } from '../../apps/server/src/config/env.js';
import { broadcaster } from '../../apps/server/src/realtime/broadcaster.js';
import { SSERealtimeMessage } from '@paxflux/shared';

/**
 * Where the dashboard's lifecycle ordering signal actually comes from.
 *
 * RC2-B ordered the lifecycle by a wall-clock epoch taken from
 * `CompactEventState.serverTimeMs` on the SSE side, on the claim that a frame
 * can never carry a later timestamp than the status inside it. These tests
 * examine that claim at the producer, because it is a claim about how the
 * server builds a frame — not something a client-side test can establish.
 */

describe('CompactEventState.serverTimeMs is not the timestamp of the status it carries', () => {
  let sqlite: DatabaseSync;

  const adminId = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  const externalSpaceId = crypto.randomUUID();
  const siteSpaceId = crypto.randomUUID();

  beforeEach(async () => {
    const conn = createDatabase(':memory:');
    sqlite = conn.sqlite;
    await runMigrations(sqlite);

    const now = 1_000_000;
    await conn.db.insert(staffUsers).values({
      id: adminId,
      username: 'admin',
      usernameNormalized: 'admin',
      role: 'admin',
      passwordHash: 'hash',
      isActive: true,
      createdAtMs: now,
      updatedAtMs: now,
    });
    await conn.db.insert(events).values({
      id: eventId,
      name: 'Festival',
      slug: 'festival-provenance',
      capacity: 500,
      status: 'live',
      version: 20,
      createdBy: adminId,
      createdAtMs: now,
      updatedAtMs: now,
    });
    await conn.db.insert(spaces).values([
      { id: externalSpaceId, eventId, name: 'Extérieur', kind: 'external', sortOrder: 0, createdAtMs: now, updatedAtMs: now },
      { id: siteSpaceId, eventId, name: 'Site', kind: 'leaf', capacity: 500, sortOrder: 1, createdAtMs: now, updatedAtMs: now },
    ]);
    await conn.db.insert(spaceState).values({ eventId, spaceId: siteSpaceId, occupancy: 14, updatedAtMs: now });
  });

  afterEach(() => {
    sqlite.close();
  });

  /**
   * The production driver, with a hook that runs after a chosen query.
   *
   * This is how the interleaving is made observable: `getCompactEventState`
   * reads the event row, then issues two further queries, and only then calls
   * `Date.now()`. Anything that commits in that gap is invisible to the
   * status already in hand but is *before* the timestamp that will be
   * stamped on it.
   */
  function instrumentedDb(afterFirstEventRead: () => void) {
    let eventReadSeen = false;
    return drizzle(
      async (sqlQuery, params, method) => {
        const stmt = sqlite.prepare(sqlQuery);
        stmt.setReturnArrays(true);
        let rows: unknown;
        if (method === 'get') rows = stmt.get(...(params as never[]));
        else if (method === 'all' || method === 'values') rows = stmt.all(...(params as never[]));
        else {
          stmt.run(...(params as never[]));
          rows = [];
        }
        if (!eventReadSeen && /from "events"/.test(sqlQuery)) {
          eventReadSeen = true;
          afterFirstEventRead();
        }
        return { rows: rows as never };
      },
      { schema }
    );
  }

  it('can stamp a frame with a timestamp later than a transition its status predates', async () => {
    // The event transitions to `closing` after its row has been read for
    // this frame, but before the frame is stamped.
    let transitionAtMs = 0;
    const db = instrumentedDb(() => {
      transitionAtMs = Date.now();
      sqlite
        .prepare(`UPDATE events SET status = 'closing', closing_started_at_ms = ?, updated_at_ms = ? WHERE id = ?`)
        .run(transitionAtMs, transitionAtMs, eventId);
    });

    const frame = await getCompactEventState(db, eventId);

    expect(frame).not.toBeNull();
    // The frame carries the *old* status...
    expect(frame?.eventStatus).toBe('live');
    // ...stamped with a time at or after the transition that superseded it.
    expect(frame?.serverTimeMs).toBeGreaterThanOrEqual(transitionAtMs);
    // Which is exactly the inversion the client must not be exposed to: a
    // later epoch carrying an older status.
    const rowAfter = sqlite.prepare('SELECT status, updated_at_ms FROM events WHERE id = ?').get(eventId) as {
      status: string;
      updated_at_ms: number;
    };
    expect(rowAfter.status).toBe('closing');
    expect(frame?.serverTimeMs).toBeGreaterThanOrEqual(rowAfter.updated_at_ms);
  });

  it('does not bump version on a lifecycle transition, so version cannot order it either', async () => {
    const before = sqlite.prepare('SELECT version FROM events WHERE id = ?').get(eventId) as { version: number };
    sqlite
      .prepare(`UPDATE events SET status = 'closing', updated_at_ms = ? WHERE id = ?`)
      .run(Date.now(), eventId);
    const after = sqlite.prepare('SELECT version FROM events WHERE id = ?').get(eventId) as { version: number };

    expect(after.version).toBe(before.version);
  });
});

/**
 * The provenance of the signal the dashboard now uses.
 *
 * Every lifecycle transition writes `updatedAtMs` and broadcasts
 * `timestampMs` from the same `now`, in the same handler. This test asserts
 * that at the producer, for every transition an event can make — including
 * the one that runs the status ordering backwards.
 */
describe('event-status carries the same instant the event row records', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let sqlite: DatabaseSync;
  let cookie: string;
  let eventId: string;
  let siteSpaceId: string;
  let messages: SSERealtimeMessage[];

  beforeEach(async () => {
    const env = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'silent', DATA_DIR: './tests/scratch-lifecycle-data' });
    const conn = createDatabase(':memory:');
    sqlite = conn.sqlite;
    await runMigrations(sqlite);
    app = await buildApp({ env, dbConnection: conn });

    const now = Date.now();
    const adminId = crypto.randomUUID();
    const { hashPassword } = await import('../../apps/server/src/auth/passwords.js');
    await conn.db.insert(staffUsers).values({
      id: adminId,
      username: 'admin',
      usernameNormalized: 'admin',
      role: 'admin',
      passwordHash: await hashPassword('MotDePasse!2026'),
      isActive: true,
      createdAtMs: now,
      updatedAtMs: now,
    });

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'admin', password: 'MotDePasse!2026' },
    });
    const setCookie = login.headers['set-cookie'];
    const cookieList = Array.isArray(setCookie) ? setCookie : [setCookie as string];
    cookie = cookieList.map((c) => c.split(';')[0]).join('; ');
    const csrf = login.json().csrfToken as string;

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/events',
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { name: 'Provenance', capacity: 100, warningRatio1: 0.8, warningRatio2: 0.9, timezone: 'Europe/Paris' },
    });
    eventId = created.json().id as string;

    const spacesList = await app.inject({ method: 'GET', url: `/api/v1/events/${eventId}/spaces`, headers: { cookie } });
    const rows = spacesList.json() as Array<{ id: string; kind: string }>;
    const external = rows.find((r) => r.kind === 'external')!;
    siteSpaceId = rows.find((r) => r.kind === 'leaf')!.id;
    await app.inject({
      method: 'POST',
      url: `/api/v1/events/${eventId}/checkpoints`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: {
        name: 'Porte',
        spaceAId: external.id,
        spaceBId: siteSpaceId,
        allowAToB: true,
        allowBToA: true,
        labelAToB: 'E',
        labelBToA: 'S',
      },
    });

    messages = [];
    vi.spyOn(broadcaster, 'broadcastMessage').mockImplementation((_id, message) => {
      messages.push(message);
    });
    (globalThis as { __csrf?: string }).__csrf = csrf;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  async function transition(path: string, payload?: Record<string, unknown>): Promise<void> {
    const csrf = (globalThis as { __csrf?: string }).__csrf as string;
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/events/${eventId}/${path}`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: payload ?? {},
    });
    expect(res.statusCode, `${path} -> ${res.body}`).toBe(200);
  }

  function lastStatusMessage(): { status: string; timestampMs: number; version: number } {
    const statusMessages = messages.filter((m) => m.type === 'event-status');
    const last = statusMessages[statusMessages.length - 1];
    expect(last, 'a transition must broadcast event-status').toBeDefined();
    return (last as { data: { status: string; timestampMs: number; version: number } }).data;
  }

  function eventRow(): { status: string; updated_at_ms: number; version: number } {
    return sqlite.prepare('SELECT status, updated_at_ms, version FROM events WHERE id = ?').get(eventId) as {
      status: string;
      updated_at_ms: number;
      version: number;
    };
  }

  /** The message and the row must agree on both the status and the instant. */
  function expectMessageMatchesRow(): void {
    const message = lastStatusMessage();
    const row = eventRow();
    expect(message.status).toBe(row.status);
    expect(message.timestampMs, 'the broadcast instant is the row’s own updatedAtMs').toBe(row.updated_at_ms);
  }

  it('start: live', async () => {
    await transition('start');
    expectMessageMatchesRow();
  });

  it('begin-closing, and the state frame broadcast beside it does not define the lifecycle', async () => {
    await transition('start');
    const liveVersion = eventRow().version;
    await transition('begin-closing');
    expectMessageMatchesRow();
    // The transition that most matters carries no version change at all,
    // which is why version cannot order the lifecycle.
    expect(eventRow().version).toBe(liveVersion);
  });

  it('force-close: closed', async () => {
    await transition('start');
    await transition('begin-closing');
    await transition('force-close', { reason: 'Fermeture forcée de test' });
    expectMessageMatchesRow();
  });

  it('reopen: closed → live, where the status ordering runs backwards', async () => {
    await transition('start');
    await transition('begin-closing');
    await transition('force-close', { reason: 'Fermeture forcée de test' });
    const closedAt = eventRow().updated_at_ms;

    await transition('reopen', { reason: 'Réouverture de test' });
    expectMessageMatchesRow();

    const reopened = eventRow();
    expect(reopened.status).toBe('live');
    // The epoch moves forward even though the status moved "backwards",
    // which is the whole reason the ordering is an instant and not a rank.
    expect(reopened.updated_at_ms).toBeGreaterThanOrEqual(closedAt);
  });
});
