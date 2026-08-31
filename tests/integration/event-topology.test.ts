import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildApp } from '../../apps/server/src/app.js';
import { createDatabase } from '../../apps/server/src/db/index.js';
import { parseEnv } from '../../apps/server/src/config/env.js';
import { instanceSettings, events, spaces, spaceState, checkpoints } from '../../apps/server/src/db/schema.js';
import { eq } from 'drizzle-orm';
import crypto from 'node:crypto';

// Phase 4 — atomic event-draft creation (event + full topology in a single
// SQLite transaction). Reference scenario from the remediation plan:
// "Festival Test", capacity 100, Extérieur/Site/VIP, three physical
// checkpoints Extérieur<->Site and one internal checkpoint Site<->VIP.
describe('POST /api/v1/events/drafts — atomic event + topology creation', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let sqlite: ReturnType<typeof createDatabase>['sqlite'];
  let db: ReturnType<typeof createDatabase>['db'];
  let env: ReturnType<typeof parseEnv>;
  let csrfToken: string;
  let sessionCookie: { name: string; value: string };

  beforeEach(async () => {
    env = parseEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATA_DIR: './tests/scratch-topology-data',
      BACKUP_DIR: './tests/scratch-topology-backups',
    });
    const dbConn = createDatabase(':memory:');
    sqlite = dbConn.sqlite;
    db = dbConn.db;
    app = await buildApp({ env, dbConnection: dbConn });

    const rawSetupToken = 'test-valid-setup-token-1234567890abcdef';
    const setupTokenHash = crypto.createHash('sha256').update(rawSetupToken).digest('hex');
    await db
      .update(instanceSettings)
      .set({ setupTokenHash, setupTokenExpiresAtMs: Date.now() + 3_600_000 })
      .where(eq(instanceSettings.id, 1));

    const setupRes = await app.inject({
      method: 'POST',
      url: '/api/v1/setup',
      payload: { setupToken: rawSetupToken, username: 'topology_admin', password: 'AdminPassword123!' },
    });
    csrfToken = setupRes.json().csrfToken;
    sessionCookie = setupRes.cookies[0];
  });

  afterEach(async () => {
    await app.close();
    sqlite.close();
  });

  function authHeaders(extra: Record<string, string> = {}) {
    return {
      cookie: `${sessionCookie.name}=${sessionCookie.value}`,
      'x-csrf-token': csrfToken,
      ...extra,
    };
  }

  function referenceScenarioPayload(name = 'Festival Test') {
    return {
      event: { name, capacity: 100, timezone: 'Europe/Paris' },
      spaces: [
        { clientId: 'ext', name: 'Extérieur', kind: 'external' as const },
        { clientId: 'site', name: 'Site', kind: 'leaf' as const, capacity: 100 },
        { clientId: 'vip', name: 'VIP', kind: 'leaf' as const, capacity: 30 },
      ],
      checkpoints: [
        {
          name: 'Porte A',
          spaceAClientId: 'ext',
          spaceBClientId: 'site',
          allowAToB: true,
          allowBToA: true,
          labelAToB: 'ENTRÉE +1',
          labelBToA: 'SORTIE −1',
        },
        {
          name: 'Porte B',
          spaceAClientId: 'ext',
          spaceBClientId: 'site',
          allowAToB: true,
          allowBToA: true,
          labelAToB: 'ENTRÉE +1',
          labelBToA: 'SORTIE −1',
        },
        {
          name: 'Porte C',
          spaceAClientId: 'ext',
          spaceBClientId: 'site',
          allowAToB: true,
          allowBToA: true,
          labelAToB: 'ENTRÉE +1',
          labelBToA: 'SORTIE −1',
        },
        {
          name: 'Accès VIP',
          spaceAClientId: 'site',
          spaceBClientId: 'vip',
          allowAToB: true,
          allowBToA: true,
          labelAToB: '→ VIP',
          labelBToA: '← SORTIE',
        },
      ],
    };
  }

  it('creates the exact reference topology (3 portes Extérieur<->Site + 1 Site<->VIP) in one transaction, with no auto-generated extras', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/events/drafts',
      headers: authHeaders(),
      payload: referenceScenarioPayload(),
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.event.status).toBe('draft');
    expect(body.event.capacity).toBe(100);
    expect(body.spaces).toHaveLength(3);
    expect(body.checkpoints).toHaveLength(4);

    // Re-fetch from the DB independently of the response body, to prove
    // exactly this topology landed — no extra auto-generated links.
    const eventId = body.event.id;
    const spacesRes = await app.inject({ method: 'GET', url: `/api/v1/events/${eventId}/spaces`, headers: authHeaders() });
    const checkpointsRes = await app.inject({
      method: 'GET',
      url: `/api/v1/events/${eventId}/checkpoints`,
      headers: authHeaders(),
    });
    const spacesList = spacesRes.json();
    const checkpointsList = checkpointsRes.json();

    expect(spacesList).toHaveLength(3);
    expect(spacesList.map((s: any) => s.name).sort()).toEqual(['Extérieur', 'Site', 'VIP'].sort());

    expect(checkpointsList).toHaveLength(4);
    const site = spacesList.find((s: any) => s.name === 'Site');
    const ext = spacesList.find((s: any) => s.name === 'Extérieur');
    const vip = spacesList.find((s: any) => s.name === 'VIP');

    const extSiteCheckpoints = checkpointsList.filter(
      (c: any) =>
        (c.spaceAId === ext.id && c.spaceBId === site.id) || (c.spaceAId === site.id && c.spaceBId === ext.id)
    );
    expect(extSiteCheckpoints).toHaveLength(3);

    const siteVipCheckpoints = checkpointsList.filter(
      (c: any) =>
        (c.spaceAId === site.id && c.spaceBId === vip.id) || (c.spaceAId === vip.id && c.spaceBId === site.id)
    );
    expect(siteVipCheckpoints).toHaveLength(1);

    // VIP must not be directly reachable from Extérieur — no auto-generated
    // Extérieur<->VIP link, unlike the old wizard's "multi" mode.
    const extVipCheckpoints = checkpointsList.filter(
      (c: any) =>
        (c.spaceAId === ext.id && c.spaceBId === vip.id) || (c.spaceAId === vip.id && c.spaceBId === ext.id)
    );
    expect(extVipCheckpoints).toHaveLength(0);
  });

  it('preflight accepts the freshly created reference topology as ready to go live', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/events/drafts',
      headers: authHeaders(),
      payload: referenceScenarioPayload(),
    });
    const eventId = createRes.json().event.id;

    const preflightRes = await app.inject({
      method: 'GET',
      url: `/api/v1/events/${eventId}/preflight`,
      headers: authHeaders(),
    });

    expect(preflightRes.statusCode).toBe(200);
    expect(preflightRes.json().ready).toBe(true);
  });

  it('rejects a structurally invalid payload (dangling checkpoint reference) without creating anything', async () => {
    const payload = referenceScenarioPayload('Repro Invalid Dangling Ref');
    payload.checkpoints.push({
      name: 'Porte Fantôme',
      spaceAClientId: 'ext',
      spaceBClientId: 'does-not-exist',
      allowAToB: true,
      allowBToA: true,
      labelAToB: 'X',
      labelBToA: 'Y',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/events/drafts',
      headers: authHeaders(),
      payload,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_TOPOLOGY');

    const orphanEvent = await db.select().from(events).where(eq(events.name, 'Repro Invalid Dangling Ref')).get();
    expect(orphanEvent).toBeUndefined();
  });

  it('rejects a payload with no external space, without creating anything', async () => {
    const payload = {
      event: { name: 'Repro No External', capacity: 50, timezone: 'Europe/Paris' },
      spaces: [{ clientId: 'a', name: 'Salle A', kind: 'leaf' as const, capacity: 50 }],
      checkpoints: [],
    };

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/events/drafts',
      headers: authHeaders(),
      payload,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_TOPOLOGY');

    const orphanEvent = await db.select().from(events).where(eq(events.name, 'Repro No External')).get();
    expect(orphanEvent).toBeUndefined();
  });

  it('rolls back the entire transaction — event, spaces, and already-inserted checkpoints — when a later checkpoint is invalid (real SQLite ROLLBACK, not compensating deletes)', async () => {
    const payload = referenceScenarioPayload('Repro Mid Transaction Failure');
    // Porte A and Porte B (indices 0-1) are valid and would be inserted
    // first; this third one is invalid (same space on both ends) and must
    // cause the whole transaction — including the two already-inserted
    // checkpoints, the spaces, and the event itself — to roll back.
    payload.checkpoints = [
      payload.checkpoints[0],
      payload.checkpoints[1],
      {
        name: 'Porte Invalide',
        spaceAClientId: 'site',
        spaceBClientId: 'site',
        allowAToB: true,
        allowBToA: true,
        labelAToB: 'X',
        labelBToA: 'Y',
      },
    ];

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/events/drafts',
      headers: authHeaders(),
      payload,
    });

    expect(res.statusCode).toBe(400);

    const orphanEvent = await db.select().from(events).where(eq(events.name, 'Repro Mid Transaction Failure')).get();
    expect(orphanEvent).toBeUndefined();

    // No fragment of this attempt anywhere: no space named "Site"/"VIP"/
    // "Extérieur" left over with no owning event, and no checkpoint at all
    // referencing a nonexistent event.
    const allSpaces = await db.select().from(spaces).all();
    const allSpaceStates = await db.select().from(spaceState).all();
    const allCheckpoints = await db.select().from(checkpoints).all();
    expect(allSpaces).toHaveLength(0);
    expect(allSpaceStates).toHaveLength(0);
    expect(allCheckpoints).toHaveLength(0);
  });

  it('rejects the request for a non-admin (supervisor) session (403)', async () => {
    // Supervisors cannot create events per existing POST /api/v1/events rules.
    const supervisorUserId = crypto.randomUUID();
    const now = Date.now();
    const { staffUsers } = await import('../../apps/server/src/db/schema.js');
    await db.insert(staffUsers).values({
      id: supervisorUserId,
      username: 'supervisor_topo',
      usernameNormalized: 'supervisor_topo',
      role: 'supervisor',
      passwordHash: 'unused-in-this-test',
      isActive: true,
      createdAtMs: now,
      updatedAtMs: now,
    });
    const { createStaffSession } = await import('../../apps/server/src/auth/staff-sessions.js');
    const session = await createStaffSession(db, supervisorUserId, 12);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/events/drafts',
      headers: { cookie: `paxflux_staff_session=${session.sessionToken}`, 'x-csrf-token': session.csrfToken },
      payload: referenceScenarioPayload('Repro Supervisor Forbidden'),
    });

    expect(res.statusCode).toBe(403);
  });
});

describe('Draft topology editing (PATCH/DELETE) is locked once the event leaves draft', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let sqlite: ReturnType<typeof createDatabase>['sqlite'];
  let db: ReturnType<typeof createDatabase>['db'];
  let env: ReturnType<typeof parseEnv>;
  let csrfToken: string;
  let sessionCookie: { name: string; value: string };

  beforeEach(async () => {
    env = parseEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATA_DIR: './tests/scratch-topology-lock-data',
      BACKUP_DIR: './tests/scratch-topology-lock-backups',
    });
    const dbConn = createDatabase(':memory:');
    sqlite = dbConn.sqlite;
    db = dbConn.db;
    app = await buildApp({ env, dbConnection: dbConn });

    const rawSetupToken = 'test-valid-setup-token-1234567890abcdef';
    const setupTokenHash = crypto.createHash('sha256').update(rawSetupToken).digest('hex');
    await db
      .update(instanceSettings)
      .set({ setupTokenHash, setupTokenExpiresAtMs: Date.now() + 3_600_000 })
      .where(eq(instanceSettings.id, 1));

    const setupRes = await app.inject({
      method: 'POST',
      url: '/api/v1/setup',
      payload: { setupToken: rawSetupToken, username: 'topology_lock_admin', password: 'AdminPassword123!' },
    });
    csrfToken = setupRes.json().csrfToken;
    sessionCookie = setupRes.cookies[0];
  });

  afterEach(async () => {
    await app.close();
    sqlite.close();
  });

  function authHeaders(extra: Record<string, string> = {}) {
    return {
      cookie: `${sessionCookie.name}=${sessionCookie.value}`,
      'x-csrf-token': csrfToken,
      ...extra,
    };
  }

  async function createDraft() {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/events/drafts',
      headers: authHeaders(),
      payload: {
        event: { name: 'Repro Topology Lock', capacity: 50, timezone: 'Europe/Paris' },
        spaces: [
          { clientId: 'ext', name: 'Extérieur', kind: 'external' as const },
          { clientId: 'site', name: 'Site', kind: 'leaf' as const, capacity: 50 },
        ],
        checkpoints: [
          {
            name: 'Porte',
            spaceAClientId: 'ext',
            spaceBClientId: 'site',
            allowAToB: true,
            allowBToA: true,
            labelAToB: 'ENTRÉE +1',
            labelBToA: 'SORTIE −1',
          },
        ],
      },
    });
    return res.json();
  }

  it('allows editing a checkpoint label while draft', async () => {
    const { event, checkpoints: cps } = await createDraft();

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/events/${event.id}/checkpoints/${cps[0].id}`,
      headers: authHeaders(),
      payload: { labelAToB: 'Nouvelle Entrée' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().labelAToB).toBe('Nouvelle Entrée');
  });

  it('allows deleting a space while draft', async () => {
    const { event, spaces: sps, checkpoints: cps } = await createDraft();
    const vip = sps.find((s: any) => s.kind === 'leaf');

    // A leaf referenced by an existing checkpoint cannot be deleted without
    // first removing the checkpoint — delete the checkpoint, then the space.
    await app.inject({
      method: 'DELETE',
      url: `/api/v1/events/${event.id}/checkpoints/${cps[0].id}`,
      headers: authHeaders(),
    });

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/events/${event.id}/spaces/${vip.id}`,
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
  });

  it('refuses to delete a space still referenced by a checkpoint (SPACE_IN_USE)', async () => {
    const { event, spaces: sps } = await createDraft();
    const site = sps.find((s: any) => s.name === 'Site');

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/events/${event.id}/spaces/${site.id}`,
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('SPACE_IN_USE');
  });

  it('rejects PATCH/DELETE on spaces and checkpoints once the event is live (409 TOPOLOGY_LOCKED)', async () => {
    const { event, spaces: sps, checkpoints: cps } = await createDraft();

    const startRes = await app.inject({ method: 'POST', url: `/api/v1/events/${event.id}/start`, headers: authHeaders() });
    expect(startRes.statusCode).toBe(200);

    const patchCheckpointRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/events/${event.id}/checkpoints/${cps[0].id}`,
      headers: authHeaders(),
      payload: { labelAToB: 'Devrait Échouer' },
    });
    expect(patchCheckpointRes.statusCode).toBe(409);
    expect(patchCheckpointRes.json().code).toBe('TOPOLOGY_LOCKED');

    const deleteSpaceRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/events/${event.id}/spaces/${sps[0].id}`,
      headers: authHeaders(),
    });
    expect(deleteSpaceRes.statusCode).toBe(409);
    expect(deleteSpaceRes.json().code).toBe('TOPOLOGY_LOCKED');

    const deleteCheckpointRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/events/${event.id}/checkpoints/${cps[0].id}`,
      headers: authHeaders(),
    });
    expect(deleteCheckpointRes.statusCode).toBe(409);
    expect(deleteCheckpointRes.json().code).toBe('TOPOLOGY_LOCKED');
  });

  it('deactivating the external space makes preflight refuse the topology, and /start is rejected (SPEC: boundary counting requires it)', async () => {
    const { event, spaces: sps } = await createDraft();
    const ext = sps.find((s: any) => s.kind === 'external');

    const preflightBefore = await app.inject({
      method: 'GET',
      url: `/api/v1/events/${event.id}/preflight`,
      headers: authHeaders(),
    });
    expect(preflightBefore.json().ready).toBe(true);

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/events/${event.id}/spaces/${ext.id}`,
      headers: authHeaders(),
      payload: { isActive: false },
    });
    expect(patchRes.statusCode).toBe(200);

    const preflightAfter = await app.inject({
      method: 'GET',
      url: `/api/v1/events/${event.id}/preflight`,
      headers: authHeaders(),
    });
    expect(preflightAfter.json().ready).toBe(false);

    const startRes = await app.inject({ method: 'POST', url: `/api/v1/events/${event.id}/start`, headers: authHeaders() });
    expect(startRes.statusCode).toBe(400);
  });

  it('preflight and /start refuse when an active checkpoint has an inactive endpoint, even with another leaf still active', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/events/drafts',
      headers: authHeaders(),
      payload: {
        event: { name: 'Repro Inactive Checkpoint Endpoint', capacity: 100, timezone: 'Europe/Paris' },
        spaces: [
          { clientId: 'ext', name: 'Extérieur', kind: 'external' as const },
          { clientId: 'site', name: 'Site', kind: 'leaf' as const, capacity: 100 },
          { clientId: 'vip', name: 'VIP', kind: 'leaf' as const, capacity: 30 },
        ],
        checkpoints: [
          {
            name: 'Porte',
            spaceAClientId: 'ext',
            spaceBClientId: 'site',
            allowAToB: true,
            allowBToA: true,
            labelAToB: 'ENTRÉE +1',
            labelBToA: 'SORTIE −1',
          },
          {
            name: 'Accès VIP',
            spaceAClientId: 'site',
            spaceBClientId: 'vip',
            allowAToB: true,
            allowBToA: true,
            labelAToB: '→ VIP',
            labelBToA: '← SORTIE',
          },
        ],
      },
    });
    const { event, spaces: sps } = createRes.json();
    const vip = sps.find((s: any) => s.name === 'VIP');

    const preflightBefore = await app.inject({
      method: 'GET',
      url: `/api/v1/events/${event.id}/preflight`,
      headers: authHeaders(),
    });
    expect(preflightBefore.json().ready).toBe(true);

    // Site stays active, so NO_INTERNAL_LEAF_SPACES alone can't explain a
    // refusal here — only the "Accès VIP" checkpoint (still active) now
    // pointing at a deactivated endpoint can.
    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/events/${event.id}/spaces/${vip.id}`,
      headers: authHeaders(),
      payload: { isActive: false },
    });
    expect(patchRes.statusCode).toBe(200);

    const preflightAfter = await app.inject({
      method: 'GET',
      url: `/api/v1/events/${event.id}/preflight`,
      headers: authHeaders(),
    });
    expect(preflightAfter.json().ready).toBe(false);

    const startRes = await app.inject({ method: 'POST', url: `/api/v1/events/${event.id}/start`, headers: authHeaders() });
    expect(startRes.statusCode).toBe(400);
  });
});

describe('Space parentId invariants: dangling, cross-event, and cycle rejection', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let sqlite: ReturnType<typeof createDatabase>['sqlite'];
  let db: ReturnType<typeof createDatabase>['db'];
  let env: ReturnType<typeof parseEnv>;
  let csrfToken: string;
  let sessionCookie: { name: string; value: string };

  beforeEach(async () => {
    env = parseEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATA_DIR: './tests/scratch-topology-parent-data',
      BACKUP_DIR: './tests/scratch-topology-parent-backups',
    });
    const dbConn = createDatabase(':memory:');
    sqlite = dbConn.sqlite;
    db = dbConn.db;
    app = await buildApp({ env, dbConnection: dbConn });

    const rawSetupToken = 'test-valid-setup-token-1234567890abcdef';
    const setupTokenHash = crypto.createHash('sha256').update(rawSetupToken).digest('hex');
    await db
      .update(instanceSettings)
      .set({ setupTokenHash, setupTokenExpiresAtMs: Date.now() + 3_600_000 })
      .where(eq(instanceSettings.id, 1));

    const setupRes = await app.inject({
      method: 'POST',
      url: '/api/v1/setup',
      payload: { setupToken: rawSetupToken, username: 'topology_parent_admin', password: 'AdminPassword123!' },
    });
    csrfToken = setupRes.json().csrfToken;
    sessionCookie = setupRes.cookies[0];
  });

  afterEach(async () => {
    await app.close();
    sqlite.close();
  });

  function authHeaders(extra: Record<string, string> = {}) {
    return {
      cookie: `${sessionCookie.name}=${sessionCookie.value}`,
      'x-csrf-token': csrfToken,
      ...extra,
    };
  }

  async function createEventWithAggregates(name = 'Repro Parent Invariants') {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/events/drafts',
      headers: authHeaders(),
      payload: {
        event: { name, capacity: 50, timezone: 'Europe/Paris' },
        spaces: [
          { clientId: 'ext', name: 'Extérieur', kind: 'external' as const },
          { clientId: 'zoneA', name: 'Zone A', kind: 'aggregate' as const },
          { clientId: 'zoneB', name: 'Zone B', kind: 'aggregate' as const },
          { clientId: 'site', name: 'Site', kind: 'leaf' as const, parentClientId: 'zoneA', capacity: 50 },
        ],
        checkpoints: [
          {
            name: 'Porte',
            spaceAClientId: 'ext',
            spaceBClientId: 'site',
            allowAToB: true,
            allowBToA: true,
            labelAToB: 'ENTRÉE +1',
            labelBToA: 'SORTIE −1',
          },
        ],
      },
    });
    return res.json();
  }

  it('POST /spaces rejects an unknown parentId UUID, with no mutation', async () => {
    const { event } = await createEventWithAggregates();
    const before = await db.select().from(spaces).where(eq(spaces.eventId, event.id)).all();

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/events/${event.id}/spaces`,
      headers: authHeaders(),
      payload: { name: 'Salle Fantôme', kind: 'leaf', parentId: crypto.randomUUID(), capacity: 10 },
    });

    expect(res.statusCode).toBe(400);
    const after = await db.select().from(spaces).where(eq(spaces.eventId, event.id)).all();
    expect(after).toHaveLength(before.length);
  });

  it('POST /spaces rejects a parentId belonging to another event, with no mutation', async () => {
    const { event: eventA } = await createEventWithAggregates('Repro Parent Invariants A');
    const otherRes = await app.inject({
      method: 'POST',
      url: '/api/v1/events/drafts',
      headers: authHeaders(),
      payload: {
        event: { name: 'Repro Other Event', capacity: 20, timezone: 'Europe/Paris' },
        spaces: [
          { clientId: 'ext', name: 'Extérieur', kind: 'external' as const },
          { clientId: 'zone', name: 'Zone Autre Événement', kind: 'aggregate' as const },
        ],
        checkpoints: [],
      },
    });
    const foreignZone = otherRes.json().spaces.find((s: any) => s.kind === 'aggregate');

    const before = await db.select().from(spaces).where(eq(spaces.eventId, eventA.id)).all();

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/events/${eventA.id}/spaces`,
      headers: authHeaders(),
      payload: { name: 'Salle Croisée', kind: 'leaf', parentId: foreignZone.id, capacity: 10 },
    });

    expect(res.statusCode).toBe(400);
    const after = await db.select().from(spaces).where(eq(spaces.eventId, eventA.id)).all();
    expect(after).toHaveLength(before.length);
  });

  it('POST /spaces accepts a valid parentId from the same event', async () => {
    const { event, spaces: sps } = await createEventWithAggregates();
    const zoneB = sps.find((s: any) => s.name === 'Zone B');

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/events/${event.id}/spaces`,
      headers: authHeaders(),
      payload: { name: 'Salle B1', kind: 'leaf', parentId: zoneB.id, capacity: 10 },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().parentId).toBe(zoneB.id);
  });

  it('PATCH /spaces/:id rejects an unknown parentId UUID, with no mutation', async () => {
    const { event, spaces: sps } = await createEventWithAggregates();
    const zoneB = sps.find((s: any) => s.name === 'Zone B');

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/events/${event.id}/spaces/${zoneB.id}`,
      headers: authHeaders(),
      payload: { parentId: crypto.randomUUID() },
    });

    expect(res.statusCode).toBe(400);
    const row = await db.select().from(spaces).where(eq(spaces.id, zoneB.id)).get();
    expect(row?.parentId).toBeNull();
  });

  it('PATCH /spaces/:id rejects a parentId belonging to another event, with no mutation', async () => {
    const { event: eventA, spaces: spsA } = await createEventWithAggregates('Repro Parent Invariants Patch A');
    const zoneB = spsA.find((s: any) => s.name === 'Zone B');

    const otherRes = await app.inject({
      method: 'POST',
      url: '/api/v1/events/drafts',
      headers: authHeaders(),
      payload: {
        event: { name: 'Repro Other Event 2', capacity: 20, timezone: 'Europe/Paris' },
        spaces: [
          { clientId: 'ext', name: 'Extérieur', kind: 'external' as const },
          { clientId: 'zone', name: 'Zone Autre Événement 2', kind: 'aggregate' as const },
        ],
        checkpoints: [],
      },
    });
    const foreignZone = otherRes.json().spaces.find((s: any) => s.kind === 'aggregate');

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/events/${eventA.id}/spaces/${zoneB.id}`,
      headers: authHeaders(),
      payload: { parentId: foreignZone.id },
    });

    expect(res.statusCode).toBe(400);
    const row = await db.select().from(spaces).where(eq(spaces.id, zoneB.id)).get();
    expect(row?.parentId).toBeNull();
  });

  it('PATCH /spaces/:id accepts a valid parentId from the same event', async () => {
    const { event, spaces: sps } = await createEventWithAggregates();
    const zoneA = sps.find((s: any) => s.name === 'Zone A');
    const zoneB = sps.find((s: any) => s.name === 'Zone B');

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/events/${event.id}/spaces/${zoneB.id}`,
      headers: authHeaders(),
      payload: { parentId: zoneA.id },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().parentId).toBe(zoneA.id);
  });

  it('PATCH /spaces/:id still rejects a cycle (Zone A -> Zone B -> Zone A)', async () => {
    const { event, spaces: sps } = await createEventWithAggregates();
    const zoneA = sps.find((s: any) => s.name === 'Zone A');
    const zoneB = sps.find((s: any) => s.name === 'Zone B');

    const firstPatch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/events/${event.id}/spaces/${zoneB.id}`,
      headers: authHeaders(),
      payload: { parentId: zoneA.id },
    });
    expect(firstPatch.statusCode).toBe(200);

    const cyclePatch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/events/${event.id}/spaces/${zoneA.id}`,
      headers: authHeaders(),
      payload: { parentId: zoneB.id },
    });

    expect(cyclePatch.statusCode).toBe(400);
    const row = await db.select().from(spaces).where(eq(spaces.id, zoneA.id)).get();
    expect(row?.parentId).toBeNull();
  });
});
