import { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { AppDb } from '../db/index.js';
import { Env } from '../config/env.js';
import { staffUsers, instanceSettings, staffSessions } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import {
  SetupRequestSchema,
  LoginRequestSchema,
  createProblemDetails,
  MetaResponse,
  AuthSessionResponse,
} from '@paxflux/shared';
import { hashPassword, verifyPassword } from '../auth/passwords.js';
import { hashToken, deriveCsrfToken } from '../auth/csrf.js';
import {
  createStaffSession,
  setStaffSessionCookie,
  clearStaffSessionCookie,
  authenticateStaffRequest,
} from '../auth/staff-sessions.js';
import { isSetupCompleted } from '../auth/bootstrap.js';

export async function registerAuthRoutes(app: FastifyInstance, db: AppDb, env: Env) {
  // GET /api/v1/meta
  app.get('/api/v1/meta', async (_req, reply) => {
    const isInit = await isSetupCompleted(db);
    const settings = await db.select().from(instanceSettings).where(eq(instanceSettings.id, 1)).get();

    const response: MetaResponse = {
      isInitialized: isInit,
      instanceName: settings?.instanceName || 'PaxFlux',
      version: '1.0.0',
      apiVersion: '1.0.0',
      serverTimeMs: Date.now(),
    };

    return reply.status(200).send(response);
  });

  // POST /api/v1/setup
  app.post('/api/v1/setup', async (req, reply) => {
    const isInit = await isSetupCompleted(db);
    if (isInit) {
      return reply
        .status(409)
        .send(
          createProblemDetails(
            409,
            'SETUP_ALREADY_COMPLETED',
            'Installation déjà effectuée',
            'L’administrateur principal a déjà été configuré sur cette instance.'
          )
        );
    }

    const parseResult = SetupRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply
        .status(400)
        .send(
          createProblemDetails(
            400,
            'VALIDATION_ERROR',
            'Paramètres invalides',
            'Les données du formulaire sont invalides.',
            undefined,
            parseResult.error.errors.map((e: any) => ({
              name: e.path.join('.'),
              reason: e.message,
            }))
          )
        );
    }

    const { setupToken, username, password, instanceName } = parseResult.data;
    const submittedTokenHash = hashToken(setupToken);
    const now = Date.now();

    const settings = await db.select().from(instanceSettings).where(eq(instanceSettings.id, 1)).get();
    if (
      !settings ||
      !settings.setupTokenHash ||
      !settings.setupTokenExpiresAtMs ||
      settings.setupTokenExpiresAtMs <= now
    ) {
      return reply
        .status(401)
        .send(
          createProblemDetails(
            401,
            'SETUP_TOKEN_EXPIRED',
            'Token expiré',
            'Le setup token a expiré. Redémarrez le serveur pour en générer un nouveau.'
          )
        );
    }

    // Verify token hash timing-safely
    let isMatch = false;
    try {
      isMatch = crypto.timingSafeEqual(
        Buffer.from(submittedTokenHash, 'hex'),
        Buffer.from(settings.setupTokenHash, 'hex')
      );
    } catch {
      isMatch = false;
    }

    if (!isMatch) {
      return reply
        .status(401)
        .send(
          createProblemDetails(
            401,
            'INVALID_SETUP_TOKEN',
            'Token invalide',
            'Le setup token fourni est incorrect.'
          )
        );
    }

    // Hash admin password using Argon2id
    const passwordHash = await hashPassword(password);
    const userId = crypto.randomUUID();
    const usernameNormalized = username.toLowerCase().trim();

    // Create admin user
    await db.insert(staffUsers).values({
      id: userId,
      username: username.trim(),
      usernameNormalized,
      displayName: 'Administrateur',
      role: 'admin',
      passwordHash,
      isActive: true,
      createdAtMs: now,
      updatedAtMs: now,
      lastLoginAtMs: now,
    });

    // Update settings: clear setup token and mark initialized
    await db
      .update(instanceSettings)
      .set({
        instanceName: instanceName?.trim() || 'PaxFlux',
        setupTokenHash: null,
        setupTokenExpiresAtMs: null,
        initializedAtMs: now,
        updatedAtMs: now,
      })
      .where(eq(instanceSettings.id, 1));

    // Create admin session
    const { sessionToken, csrfToken, expiresAtMs } = await createStaffSession(
      db,
      userId,
      env.STAFF_SESSION_HOURS
    );

    setStaffSessionCookie(reply, sessionToken, expiresAtMs, env);

    const userRecord = await db.select().from(staffUsers).where(eq(staffUsers.id, userId)).get();

    return reply.status(201).send({
      user: userRecord,
      csrfToken,
    });
  });

  // POST /api/v1/auth/login
  app.post('/api/v1/auth/login', async (req, reply) => {
    const parseResult = LoginRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply
        .status(400)
        .send(
          createProblemDetails(
            400,
            'VALIDATION_ERROR',
            'Paramètres invalides',
            'Nom d’utilisateur ou mot de passe invalide.'
          )
        );
    }

    const { username, password } = parseResult.data;
    const usernameNormalized = username.toLowerCase().trim();

    const user = await db
      .select()
      .from(staffUsers)
      .where(eq(staffUsers.usernameNormalized, usernameNormalized))
      .get();

    if (!user || !user.isActive) {
      return reply
        .status(401)
        .send(
          createProblemDetails(
            401,
            'INVALID_CREDENTIALS',
            'Identifiants incorrects',
            'Nom d’utilisateur ou mot de passe incorrect.'
          )
        );
    }

    const isValid = await verifyPassword(user.passwordHash, password);
    if (!isValid) {
      return reply
        .status(401)
        .send(
          createProblemDetails(
            401,
            'INVALID_CREDENTIALS',
            'Identifiants incorrects',
            'Nom d’utilisateur ou mot de passe incorrect.'
          )
        );
    }

    const now = Date.now();
    await db.update(staffUsers).set({ lastLoginAtMs: now }).where(eq(staffUsers.id, user.id));

    const { sessionToken, csrfToken, expiresAtMs } = await createStaffSession(
      db,
      user.id,
      env.STAFF_SESSION_HOURS
    );

    setStaffSessionCookie(reply, sessionToken, expiresAtMs, env);

    const sessionResponse: AuthSessionResponse = {
      user: {
        id: user.id,
        username: user.username,
        usernameNormalized: user.usernameNormalized,
        displayName: user.displayName,
        role: user.role as any,
        isActive: user.isActive,
        createdAtMs: user.createdAtMs,
        updatedAtMs: user.updatedAtMs,
        lastLoginAtMs: now,
      },
      csrfToken,
    };

    return reply.status(200).send(sessionResponse);
  });

  // POST /api/v1/auth/logout
  app.post('/api/v1/auth/logout', async (req, reply) => {
    const sessionData = await authenticateStaffRequest(req, reply, db, env);
    if (sessionData) {
      await db
        .update(staffSessions)
        .set({ revokedAtMs: Date.now() })
        .where(eq(staffSessions.id, sessionData.sessionId));
    }
    clearStaffSessionCookie(reply, env);
    return reply.status(200).send({ success: true });
  });

  // GET /api/v1/auth/session
  app.get('/api/v1/auth/session', async (req, reply) => {
    const sessionData = await authenticateStaffRequest(req, reply, db, env);
    if (!sessionData) {
      return reply
        .status(401)
        .send(
          createProblemDetails(401, 'UNAUTHORIZED', 'Non authentifié', 'Session inexistante ou expirée.')
        );
    }

    // Re-derive (never rotate) the session's CSRF token: this endpoint is
    // what lets an admin page hydrate CSRF after a direct reload, and it
    // may be called concurrently (multiple tabs sharing the same session,
    // React StrictMode's double-invoke in dev). Deriving deterministically
    // from the session's own secret means every caller gets the exact same
    // token the server already stored at login — no write, no race.
    const csrfToken = deriveCsrfToken(sessionData.tokenHash);

    const response: AuthSessionResponse = {
      user: sessionData.user,
      csrfToken,
    };

    return reply.status(200).send(response);
  });
}
