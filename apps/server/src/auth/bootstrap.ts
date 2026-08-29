import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AppDb } from '../db/index.js';
import { staffUsers, instanceSettings } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { hashToken } from './csrf.js';
import { Env } from '../config/env.js';

export async function checkAndInitializeSetupToken(db: AppDb, env: Env): Promise<{ setupRequired: boolean; setupTokenGenerated?: boolean }> {
  // Check if any admin exists
  const existingAdmin = await db
    .select({ id: staffUsers.id })
    .from(staffUsers)
    .where(eq(staffUsers.role, 'admin'))
    .get();

  if (existingAdmin) {
    return { setupRequired: false };
  }

  const now = Date.now();
  const settings = await db.select().from(instanceSettings).where(eq(instanceSettings.id, 1)).get();

  // If already have a valid unexpired token, don't regenerate
  if (settings && settings.setupTokenHash && settings.setupTokenExpiresAtMs && settings.setupTokenExpiresAtMs > now) {
    return { setupRequired: true, setupTokenGenerated: false };
  }

  // Generate new high-entropy setup token (32 random bytes)
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(rawToken);
  const expiresAtMs = now + 24 * 3600 * 1000; // 24 hours

  if (settings) {
    await db
      .update(instanceSettings)
      .set({
        setupTokenHash: tokenHash,
        setupTokenExpiresAtMs: expiresAtMs,
        updatedAtMs: now,
      })
      .where(eq(instanceSettings.id, 1));
  } else {
    await db.insert(instanceSettings).values({
      id: 1,
      instanceName: 'PaxFlux',
      setupTokenHash: tokenHash,
      setupTokenExpiresAtMs: expiresAtMs,
      initializedAtMs: null,
      createdAtMs: now,
      updatedAtMs: now,
    });
  }

  // Write token to /data/setup-token.txt with 0600 permissions
  try {
    const dataDir = path.resolve(env.DATA_DIR);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    const tokenFile = path.join(dataDir, 'setup-token.txt');
    fs.writeFileSync(tokenFile, `PAXFLUX SETUP TOKEN:\n${rawToken}\n\nExpires in 24 hours.\nUse this token at /setup to create the first administrator.\n`, {
      mode: 0o600,
    });
  } catch (err) {
    console.warn('Could not write setup-token.txt to disk:', err);
  }

  // Print notice to logs
  console.log('\n===============================================================');
  console.log('                 PAXFLUX FIRST-RUN SETUP TOKEN                 ');
  console.log('===============================================================');
  console.log(` Setup Token: ${rawToken}`);
  console.log(' Visit http://<host>:3000/setup to create the first admin user.');
  console.log(' This token will expire in 24 hours and is shown only once.');
  console.log('===============================================================\n');

  return { setupRequired: true, setupTokenGenerated: true };
}

export async function isSetupCompleted(db: AppDb): Promise<boolean> {
  const admin = await db
    .select({ id: staffUsers.id })
    .from(staffUsers)
    .where(eq(staffUsers.role, 'admin'))
    .get();

  return !!admin;
}
