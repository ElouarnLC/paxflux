import fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Env } from './config/env.js';
import { REDACT_PATHS } from './logging/redactor.js';
import { API_PREFIX } from '@paxflux/shared';
import { createDatabase, DatabaseConnection } from './db/index.js';
import { runMigrations } from './db/migrator.js';
import { checkAndInitializeSetupToken } from './auth/bootstrap.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerEventRoutes } from './routes/events.js';
import { registerTopologyRoutes } from './routes/topology.js';
import { registerDeviceRoutes } from './routes/devices.js';
import { registerCountingRoutes } from './routes/counting.js';
import { registerSSERoutes } from './routes/sse.js';
import { registerExportRoutes } from './routes/export.js';
import { registerSystemRoutes } from './routes/system.js';
import { createDatabaseBackup } from './backups/backup-service.js';
import { events } from './db/schema.js';
import { eq, or } from 'drizzle-orm';

export interface AppOptions {
  env: Env;
  dbConnection?: DatabaseConnection;
}

/**
 * Locates the committed SQL migrations.
 *
 * They live at the repository root (`drizzle/`), which the image copies next
 * to the compiled server so the container sees `/app/drizzle`. Resolving them
 * from `process.cwd()` alone only works when the process happens to be started
 * from that root: `npm run dev -w @paxflux/server` runs with `apps/server` as
 * its cwd and died at boot with "Migrations folder not found". Walking up from
 * this module finds the same directory from every entry point — `npm start`,
 * `tsx watch`, the container — and the cwd remains the last resort so an
 * unusual layout still behaves as before.
 */
function resolveMigrationsFolder(): string {
  const cwdCandidate = path.resolve(process.cwd(), 'drizzle');
  const candidates: string[] = [];

  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth += 1) {
    candidates.push(path.join(dir, 'drizzle'));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  candidates.push(cwdCandidate);

  return candidates.find((candidate) => fs.existsSync(candidate)) ?? cwdCandidate;
}

export async function buildApp(options: AppOptions) {
  const { env } = options;

  const app = fastify({
    logger: {
      level: env.LOG_LEVEL,
      redact: REDACT_PATHS,
    },
    trustProxy: env.TRUST_PROXY,
    bodyLimit: 1048576, // 1 MB
  });

  // Initialize or use injected database
  const dbConn = options.dbConnection || createDatabase(path.resolve(env.DATA_DIR, 'app.db'));
  const { sqlite, db } = dbConn;

  // Run migrations
  const dbPath = path.resolve(env.DATA_DIR, 'app.db');
  runMigrations(sqlite, dbPath, {
    backupDir: path.resolve(env.BACKUP_DIR),
    migrationsFolder: resolveMigrationsFolder(),
  });

  // Check and initialize setup token if no admin exists
  await checkAndInitializeSetupToken(db, env);

  // Security Headers
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: env.PUBLIC_BASE_URL?.startsWith('https') ? [] : null,
      },
    },
    referrerPolicy: { policy: 'no-referrer' },
    xContentTypeOptions: true,
  });

  // Cookies
  await app.register(fastifyCookie);

  // Rate Limiting
  await app.register(fastifyRateLimit, {
    max: 1000,
    timeWindow: '1 minute',
    allowList: ['127.0.0.1', '::1'],
  });

  // Register All Routes
  await registerAuthRoutes(app, db, env);
  await registerEventRoutes(app, sqlite, db, env);
  await registerTopologyRoutes(app, sqlite, db, env);
  await registerDeviceRoutes(app, sqlite, db, env);
  await registerCountingRoutes(app, sqlite, db, env);
  await registerSSERoutes(app, db, env);
  await registerExportRoutes(app, db, env);
  await registerSystemRoutes(app, sqlite, db, env);

  // Automated Periodic Backup Timer during live / closing
  const backupIntervalMs = (env.BACKUP_INTERVAL_LIVE_MINUTES || 5) * 60 * 1000;
  const backupTimer = setInterval(async () => {
    try {
      const activeLiveEvent = await db
        .select({ id: events.id })
        .from(events)
        .where(or(eq(events.status, 'live'), eq(events.status, 'closing')))
        .limit(1)
        .get();

      if (activeLiveEvent) {
        await createDatabaseBackup(sqlite, db, env, 'periodic_live');
      }
    } catch (err) {
      app.log.error({ err }, 'Periodic backup error');
    }
  }, backupIntervalMs);

  app.addHook('onClose', (_instance, done) => {
    clearInterval(backupTimer);
    done();
  });

  // Static Frontend Serving (if apps/web/dist exists)
  const webDistPath = path.resolve(process.cwd(), 'apps/web/dist');
  if (fs.existsSync(webDistPath)) {
    await app.register(fastifyStatic, {
      root: webDistPath,
      prefix: '/',
      wildcard: false,
    });

    app.setNotFoundHandler((req, reply) => {
      if (req.raw.url && req.raw.url.startsWith(API_PREFIX)) {
        return reply.status(404).send({
          type: 'https://paxflux.org/problems/not-found',
          title: 'Not Found',
          status: 404,
          code: 'NOT_FOUND',
          detail: `Route ${req.method} ${req.url} not found`,
        });
      }
      return reply.sendFile('index.html');
    });
  }

  return app;
}
