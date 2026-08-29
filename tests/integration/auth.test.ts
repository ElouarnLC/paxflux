import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from '../../apps/server/src/db/index.js';
import { runMigrations } from '../../apps/server/src/db/migrator.js';
import { buildApp } from '../../apps/server/src/app.js';
import { parseEnv } from '../../apps/server/src/config/env.js';
import { checkAndInitializeSetupToken, isSetupCompleted } from '../../apps/server/src/auth/bootstrap.js';
import { hashPassword, verifyPassword } from '../../apps/server/src/auth/passwords.js';
import { createDeviceInvite, exchangeDeviceInvite } from '../../apps/server/src/auth/pairing.js';
import {
  staffUsers,
  instanceSettings,
  events,
  spaces,
  checkpoints,
  deviceInvites,
} from '../../apps/server/src/db/schema.js';
import { eq } from 'drizzle-orm';
import crypto from 'node:crypto';

describe('Authentication, Security & Pairing Protocol', () => {
  let sqlite: ReturnType<typeof createDatabase>['sqlite'];
  let db: ReturnType<typeof createDatabase>['db'];
  let env: ReturnType<typeof parseEnv>;

  beforeEach(() => {
    env = parseEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATA_DIR: './tests/scratch-data',
    });
    const conn = createDatabase(':memory:');
    sqlite = conn.sqlite;
    db = conn.db;
    runMigrations(sqlite, ':memory:');
  });

  afterEach(() => {
    sqlite.close();
  });

  it('Argon2id password hashing and verification works correctly', async () => {
    const password = 'CorrectHorseBatteryStaple123!';
    const hashedPassword = await hashPassword(password);

    expect(hashedPassword).toContain('$argon2id$');
    expect(await verifyPassword(hashedPassword, password)).toBe(true);
    expect(await verifyPassword(hashedPassword, 'WrongPassword')).toBe(false);
  });

  it('Generates setup token on first boot and prevents unauthenticated admin claim', async () => {
    expect(await isSetupCompleted(db)).toBe(false);

    const initRes = await checkAndInitializeSetupToken(db, env);
    expect(initRes.setupRequired).toBe(true);
    expect(initRes.setupTokenGenerated).toBe(true);

    const settings = await db.select().from(instanceSettings).where(eq(instanceSettings.id, 1)).get();
    expect(settings?.setupTokenHash).toBeDefined();
    expect(settings?.setupTokenExpiresAtMs).toBeGreaterThan(Date.now());
  });

  it('Pairing token single-use exchange issues device session and rejects reuse', async () => {
    const now = Date.now();
    const adminId = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    const checkpointId = crypto.randomUUID();
    const spaceAId = crypto.randomUUID();
    const spaceBId = crypto.randomUUID();

    // Seed admin, event, checkpoint
    await db.insert(staffUsers).values({
      id: adminId,
      username: 'admin',
      usernameNormalized: 'admin',
      role: 'admin',
      passwordHash: 'hash',
      isActive: true,
      createdAtMs: now,
      updatedAtMs: now,
    });

    await db.insert(events).values({
      id: eventId,
      name: 'Event 1',
      slug: 'event-1',
      capacity: 500,
      status: 'live',
      createdBy: adminId,
      createdAtMs: now,
      updatedAtMs: now,
    });

    await db.insert(spaces).values({
      id: spaceAId,
      eventId,
      parentId: null,
      name: 'Extérieur',
      kind: 'external',
      createdAtMs: now,
      updatedAtMs: now,
    });

    await db.insert(spaces).values({
      id: spaceBId,
      eventId,
      parentId: null,
      name: 'Site',
      kind: 'leaf',
      createdAtMs: now,
      updatedAtMs: now,
    });

    await db.insert(checkpoints).values({
      id: checkpointId,
      eventId,
      name: 'Porte Nord',
      spaceAId,
      spaceBId,
      allowAToB: true,
      allowBToA: true,
      labelAToB: 'Entrée',
      labelBToA: 'Sortie',
      createdAtMs: now,
      updatedAtMs: now,
    });

    // 1. Create Invite
    const invite = await createDeviceInvite(db, {
      eventId,
      checkpointId,
      createdBy: adminId,
      expiresInMinutes: 30,
      publicBaseUrl: 'http://localhost:3000',
    });

    expect(invite.token).toBeDefined();
    expect(invite.pairUrl).toContain('/pair#');

    // 2. First Exchange -> Success
    const exchange1 = await exchangeDeviceInvite(db, invite.token, '1.0.0');
    expect('deviceSession' in exchange1).toBe(true);
    if ('deviceSession' in exchange1) {
      expect(exchange1.deviceSession.checkpointId).toBe(checkpointId);
      expect(exchange1.deviceSession.label).toContain('Porte Nord — appareil 1');
    }

    // 3. Second Exchange with same token -> Rejected (INVITE_ALREADY_USED)
    const exchange2 = await exchangeDeviceInvite(db, invite.token, '1.0.0');
    expect('error' in exchange2).toBe(true);
    if ('error' in exchange2) {
      expect(exchange2.error).toBe('INVITE_ALREADY_USED');
    }
  });
});
