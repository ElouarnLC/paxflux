import crypto from 'node:crypto';
import { FastifyRequest, FastifyReply } from 'fastify';
import { AppDb } from '../db/index.js';
import { staffSessions, staffUsers } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import {
  StaffUser,
  StaffRole,
  COOKIE_NAME_STAFF,
  COOKIE_NAME_STAFF_PROD,
  CSRF_HEADER_NAME,
  createProblemDetails,
} from '@paxflux/shared';
import { generateCsrfToken, hashToken, verifyCsrfToken, validateOriginAndFetchMetadata } from './csrf.js';
import { Env } from '../config/env.js';

export interface StaffSessionData {
  sessionId: string;
  user: StaffUser;
  csrfToken?: string;
}

export function getStaffCookieName(env: Env): string {
  return env.NODE_ENV === 'production' && env.PUBLIC_BASE_URL?.startsWith('https')
    ? COOKIE_NAME_STAFF_PROD
    : COOKIE_NAME_STAFF;
}

export async function createStaffSession(
  db: AppDb,
  userId: string,
  sessionHours: number = 12
): Promise<{ sessionId: string; sessionToken: string; csrfToken: string; expiresAtMs: number }> {
  const sessionId = crypto.randomUUID();
  const sessionToken = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashToken(sessionToken);

  const { token: csrfToken, hash: csrfHash } = generateCsrfToken();

  const now = Date.now();
  const expiresAtMs = now + sessionHours * 3600 * 1000;

  await db.insert(staffSessions).values({
    id: sessionId,
    userId,
    tokenHash,
    csrfHash,
    createdAtMs: now,
    lastSeenAtMs: now,
    expiresAtMs,
    revokedAtMs: null,
  });

  return { sessionId, sessionToken, csrfToken, expiresAtMs };
}

export async function authenticateStaffRequest(
  req: FastifyRequest,
  reply: FastifyReply,
  db: AppDb,
  env: Env
): Promise<StaffSessionData | null> {
  const cookieName = getStaffCookieName(env);
  // Also check dev fallback cookie name
  const rawToken = req.cookies[cookieName] || req.cookies[COOKIE_NAME_STAFF] || req.cookies[COOKIE_NAME_STAFF_PROD];

  if (!rawToken) {
    return null;
  }

  const tokenHash = hashToken(rawToken);
  const now = Date.now();

  const sessionRow = await db
    .select({
      session: staffSessions,
      user: staffUsers,
    })
    .from(staffSessions)
    .innerJoin(staffUsers, eq(staffSessions.userId, staffUsers.id))
    .where(eq(staffSessions.tokenHash, tokenHash))
    .get();

  if (!sessionRow) {
    return null;
  }

  const { session, user } = sessionRow;

  if (session.revokedAtMs !== null || session.expiresAtMs <= now || !user.isActive) {
    return null;
  }

  // Update last seen periodically (throttled to 60s)
  if (now - session.lastSeenAtMs > 60_000) {
    await db
      .update(staffSessions)
      .set({ lastSeenAtMs: now })
      .where(eq(staffSessions.id, session.id));
  }

  return {
    sessionId: session.id,
    user: {
      id: user.id,
      username: user.username,
      usernameNormalized: user.usernameNormalized,
      displayName: user.displayName,
      role: user.role as StaffRole,
      isActive: user.isActive,
      createdAtMs: user.createdAtMs,
      updatedAtMs: user.updatedAtMs,
      lastLoginAtMs: user.lastLoginAtMs,
    },
  };
}

export function setStaffSessionCookie(
  reply: FastifyReply,
  sessionToken: string,
  expiresAtMs: number,
  env: Env
) {
  const cookieName = getStaffCookieName(env);
  const isSecure = env.NODE_ENV === 'production' && env.PUBLIC_BASE_URL?.startsWith('https');

  reply.setCookie(cookieName, sessionToken, {
    path: '/',
    httpOnly: true,
    secure: isSecure,
    sameSite: 'strict',
    expires: new Date(expiresAtMs),
  });
}

export function clearStaffSessionCookie(reply: FastifyReply, env: Env) {
  const cookieName = getStaffCookieName(env);
  reply.clearCookie(cookieName, { path: '/' });
  reply.clearCookie(COOKIE_NAME_STAFF, { path: '/' });
  reply.clearCookie(COOKIE_NAME_STAFF_PROD, { path: '/' });
}

export async function requireStaffAuth(
  req: FastifyRequest,
  reply: FastifyReply,
  db: AppDb,
  env: Env,
  requiredRole?: StaffRole
): Promise<StaffSessionData | void> {
  const sessionData = await authenticateStaffRequest(req, reply, db, env);

  if (!sessionData) {
    reply.status(401).send(
      createProblemDetails(401, 'UNAUTHORIZED', 'Non authentifié', 'Une session valide est requise.')
    );
    return;
  }

  if (requiredRole && requiredRole === 'admin' && sessionData.user.role !== 'admin') {
    reply.status(403).send(
      createProblemDetails(403, 'FORBIDDEN', 'Accès interdit', 'Droits administrateur requis.')
    );
    return;
  }

  // Validate CSRF and Origin for state-changing HTTP methods
  const mutatingMethods = ['POST', 'PUT', 'PATCH', 'DELETE'];
  if (mutatingMethods.includes(req.method.toUpperCase())) {
    if (!validateOriginAndFetchMetadata(req)) {
      reply.status(403).send(
        createProblemDetails(403, 'INVALID_CSRF', 'Origine non autorisée', 'Requête inter-origine refusée.')
      );
      return;
    }

    const csrfHeader = req.headers[CSRF_HEADER_NAME] as string | undefined;
    const sessionRecord = await db
      .select({ csrfHash: staffSessions.csrfHash })
      .from(staffSessions)
      .where(eq(staffSessions.id, sessionData.sessionId))
      .get();

    if (!csrfHeader || !sessionRecord || !verifyCsrfToken(csrfHeader, sessionRecord.csrfHash)) {
      reply.status(403).send(
        createProblemDetails(403, 'INVALID_CSRF', 'Token CSRF invalide', 'Le token CSRF est manquant ou invalide.')
      );
      return;
    }
  }

  (req as any).staffSession = sessionData;
  return sessionData;
}
