import crypto from 'node:crypto';
import { FastifyRequest, FastifyReply } from 'fastify';
import { AppDb } from '../db/index.js';
import {
  deviceInvites,
  deviceSessions,
  checkpoints,
  events,
  spaces,
  spaceState,
} from '../db/schema.js';
import { eq, and, count } from 'drizzle-orm';
import {
  COOKIE_NAME_DEVICE,
  COOKIE_NAME_DEVICE_PROD,
  DeviceSessionModel,
  createProblemDetails,
} from '@paxflux/shared';
import { hashToken } from './csrf.js';
import { Env } from '../config/env.js';

export function getDeviceCookieName(env: Env): string {
  return env.NODE_ENV === 'production' && env.PUBLIC_BASE_URL?.startsWith('https')
    ? COOKIE_NAME_DEVICE_PROD
    : COOKIE_NAME_DEVICE;
}

export async function createDeviceInvite(
  db: AppDb,
  params: {
    eventId: string;
    checkpointId: string;
    createdBy: string;
    expiresInMinutes?: number;
    publicBaseUrl?: string;
  }
) {
  const inviteId = crypto.randomUUID();
  const rawToken = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashToken(rawToken);

  const now = Date.now();
  const ttlMinutes = params.expiresInMinutes || 30;
  const expiresAtMs = now + ttlMinutes * 60 * 1000;

  await db.insert(deviceInvites).values({
    id: inviteId,
    eventId: params.eventId,
    checkpointId: params.checkpointId,
    tokenHash,
    expiresAtMs,
    createdBy: params.createdBy,
    createdAtMs: now,
    usedAtMs: null,
    revokedAtMs: null,
  });

  const baseUrl = params.publicBaseUrl || '';
  const pairUrl = `${baseUrl}/pair#${rawToken}`;

  return {
    id: inviteId,
    checkpointId: params.checkpointId,
    token: rawToken,
    pairUrl,
    expiresAtMs,
  };
}

export async function exchangeDeviceInvite(
  db: AppDb,
  token: string,
  appVersion?: string,
  graceHours: number = 24
): Promise<
  | {
      deviceSession: DeviceSessionModel;
      sessionToken: string;
      expiresAtMs: number;
    }
  | { error: 'INVITE_NOT_FOUND' | 'INVITE_EXPIRED' | 'INVITE_ALREADY_USED' | 'INVITE_REVOKED' }
> {
  const tokenHash = hashToken(token);
  const now = Date.now();

  const invite = await db
    .select()
    .from(deviceInvites)
    .where(eq(deviceInvites.tokenHash, tokenHash))
    .get();

  if (!invite) {
    return { error: 'INVITE_NOT_FOUND' };
  }
  if (invite.revokedAtMs !== null) {
    return { error: 'INVITE_REVOKED' };
  }
  if (invite.usedAtMs !== null) {
    return { error: 'INVITE_ALREADY_USED' };
  }
  if (invite.expiresAtMs <= now) {
    return { error: 'INVITE_EXPIRED' };
  }

  // Load checkpoint for auto-labeling
  const cp = await db.select().from(checkpoints).where(eq(checkpoints.id, invite.checkpointId)).get();
  const existingCount = await db
    .select({ total: count() })
    .from(deviceSessions)
    .where(eq(deviceSessions.checkpointId, invite.checkpointId))
    .get();

  const deviceIndex = (existingCount?.total || 0) + 1;
  const label = `${cp?.name || 'Checkpoint'} — appareil ${deviceIndex}`;

  const sessionId = crypto.randomUUID();
  const sessionToken = crypto.randomBytes(32).toString('base64url');
  const sessionTokenHash = hashToken(sessionToken);

  const expiresAtMs = now + (graceHours + 48) * 3600 * 1000;

  // Mark invite as used
  await db
    .update(deviceInvites)
    .set({ usedAtMs: now })
    .where(eq(deviceInvites.id, invite.id));

  // Insert device session
  await db.insert(deviceSessions).values({
    id: sessionId,
    eventId: invite.eventId,
    checkpointId: invite.checkpointId,
    label,
    tokenHash: sessionTokenHash,
    createdAtMs: now,
    expiresAtMs,
    revokedAtMs: null,
    lastSeenAtMs: now,
    lastPendingCount: 0,
    lastClientSequence: null,
    appVersion: appVersion || null,
  });

  const sessionModel: DeviceSessionModel = {
    id: sessionId,
    eventId: invite.eventId,
    checkpointId: invite.checkpointId,
    label,
    createdAtMs: now,
    expiresAtMs,
    revokedAtMs: null,
    lastSeenAtMs: now,
    lastPendingCount: 0,
    lastClientSequence: null,
    appVersion: appVersion || null,
  };

  return {
    deviceSession: sessionModel,
    sessionToken,
    expiresAtMs,
  };
}

export function setDeviceSessionCookie(
  reply: FastifyReply,
  sessionToken: string,
  expiresAtMs: number,
  env: Env
) {
  const cookieName = getDeviceCookieName(env);
  const isSecure = env.NODE_ENV === 'production' && env.PUBLIC_BASE_URL?.startsWith('https');

  reply.setCookie(cookieName, sessionToken, {
    path: '/',
    httpOnly: true,
    secure: isSecure,
    sameSite: 'strict',
    expires: new Date(expiresAtMs),
  });
}

export async function authenticateDeviceRequest(
  req: FastifyRequest,
  db: AppDb,
  env: Env
): Promise<DeviceSessionModel | null> {
  const cookieName = getDeviceCookieName(env);
  const rawToken = req.cookies[cookieName] || req.cookies[COOKIE_NAME_DEVICE] || req.cookies[COOKIE_NAME_DEVICE_PROD];

  if (!rawToken) {
    return null;
  }

  const tokenHash = hashToken(rawToken);
  const now = Date.now();

  const session = await db
    .select()
    .from(deviceSessions)
    .where(eq(deviceSessions.tokenHash, tokenHash))
    .get();

  if (!session) {
    return null;
  }

  if (session.revokedAtMs !== null || session.expiresAtMs <= now) {
    return null;
  }

  return {
    id: session.id,
    eventId: session.eventId,
    checkpointId: session.checkpointId,
    label: session.label,
    createdAtMs: session.createdAtMs,
    expiresAtMs: session.expiresAtMs,
    revokedAtMs: session.revokedAtMs,
    lastSeenAtMs: session.lastSeenAtMs,
    lastPendingCount: session.lastPendingCount,
    lastClientSequence: session.lastClientSequence,
    appVersion: session.appVersion,
  };
}

export async function requireDeviceAuth(
  req: FastifyRequest,
  reply: FastifyReply,
  db: AppDb,
  env: Env
): Promise<DeviceSessionModel | void> {
  const deviceSession = await authenticateDeviceRequest(req, db, env);

  if (!deviceSession) {
    reply.status(401).send(
      createProblemDetails(401, 'UNAUTHORIZED', 'Appareil non appairé', 'Session appareil invalide ou révoquée.')
    );
    return;
  }

  (req as any).deviceSession = deviceSession;
  return deviceSession;
}
