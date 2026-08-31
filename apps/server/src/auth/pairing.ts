import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { FastifyRequest, FastifyReply } from 'fastify';
import { AppDb } from '../db/index.js';
import { deviceInvites, deviceSessions } from '../db/schema.js';
import { eq } from 'drizzle-orm';
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

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0']);

export interface PairingBaseUrl {
  baseUrl: string;
  source: 'public_base_url' | 'request_origin';
  /**
   * Set when the resolved base is one a phone scanning the QR cannot reach
   * (a loopback address). The QR is still produced — refusing outright
   * would break nothing but help nobody — but the caller is told, so the
   * admin sees why the code won't work from a handset instead of
   * discovering it at the door.
   */
  unreachableFromPhone: boolean;
}

/**
 * The server, not the browser, is the authority on the pairing URL: an
 * admin may well be on `localhost:3000` through an SSH tunnel while the
 * phones need the LAN or public address. `PUBLIC_BASE_URL` therefore wins
 * unambiguously whenever it is set; otherwise the request's own origin is
 * used, which is correct for the common local case where staff open
 * PaxFlux on the LAN address the phones can also reach.
 */
export function resolvePairingBaseUrl(
  env: Env,
  requestOrigin: { protocol: string; host: string } | null
): PairingBaseUrl | { error: 'NO_PUBLIC_BASE_URL' } {
  if (env.PUBLIC_BASE_URL) {
    return {
      baseUrl: env.PUBLIC_BASE_URL.replace(/\/+$/, ''),
      source: 'public_base_url',
      unreachableFromPhone: false,
    };
  }

  if (!requestOrigin?.host) {
    // Nothing usable at all: better an explicit refusal than a QR encoding
    // a bare "/pair#token" that resolves to nothing once scanned.
    return { error: 'NO_PUBLIC_BASE_URL' };
  }

  const hostname = requestOrigin.host.replace(/:\d+$/, '');
  return {
    baseUrl: `${requestOrigin.protocol}://${requestOrigin.host}`.replace(/\/+$/, ''),
    source: 'request_origin',
    unreachableFromPhone: LOOPBACK_HOSTS.has(hostname),
  };
}

export async function createDeviceInvite(
  db: AppDb,
  params: {
    eventId: string;
    checkpointId: string;
    createdBy: string;
    expiresInMinutes?: number;
    baseUrl: string;
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

  // The secret stays in the fragment: never in the path or query, so it is
  // not sent to the server, proxies, logs or the Referer header.
  const pairUrl = `${params.baseUrl}/pair#${rawToken}`;

  return {
    id: inviteId,
    checkpointId: params.checkpointId,
    token: rawToken,
    pairUrl,
    expiresAtMs,
  };
}

export type ExchangeDeviceInviteError =
  | 'INVITE_NOT_FOUND'
  | 'INVITE_EXPIRED'
  | 'INVITE_ALREADY_USED'
  | 'INVITE_REVOKED'
  | 'EVENT_NOT_PAIRABLE'
  | 'INTERNAL_ERROR';

export type ExchangeDeviceInviteResult =
  | {
      deviceSession: DeviceSessionModel;
      sessionToken: string;
      expiresAtMs: number;
    }
  | { error: ExchangeDeviceInviteError };

interface InviteRow {
  id: string;
  event_id: string;
  checkpoint_id: string;
  expires_at_ms: number;
  used_at_ms: number | null;
  revoked_at_ms: number | null;
}

/**
 * Consumes a pairing invitation and creates the device session in one
 * synchronous SQLite transaction on the shared connection.
 *
 * Two properties matter here, and both come from keeping this whole
 * section synchronous (no `await` while the transaction is open — the same
 * rule Phase 4 established for topology creation):
 *
 *  - the token is claimed with a conditional
 *    `UPDATE ... WHERE used_at_ms IS NULL`, so SQLite itself — not a
 *    check-then-act window in JavaScript — decides which of two concurrent
 *    pairings wins. The loser sees `changes === 0` and is refused;
 *  - if anything after that claim fails, the whole thing rolls back, so a
 *    token is never burnt without the session it was burnt for.
 */
function exchangeDeviceInviteSync(
  sqlite: DatabaseSync,
  tokenHash: string,
  appVersion: string | undefined,
  graceHours: number
): ExchangeDeviceInviteResult {
  let transactionStarted = false;

  try {
    sqlite.exec('BEGIN IMMEDIATE;');
    transactionStarted = true;

    const now = Date.now();
    const invite = sqlite
      .prepare(
        `SELECT id, event_id, checkpoint_id, expires_at_ms, used_at_ms, revoked_at_ms
         FROM device_invites WHERE token_hash = ?`
      )
      .get(tokenHash) as InviteRow | undefined;

    if (!invite) {
      sqlite.exec('ROLLBACK;');
      return { error: 'INVITE_NOT_FOUND' };
    }
    if (invite.revoked_at_ms !== null) {
      sqlite.exec('ROLLBACK;');
      return { error: 'INVITE_REVOKED' };
    }
    if (invite.used_at_ms !== null) {
      sqlite.exec('ROLLBACK;');
      return { error: 'INVITE_ALREADY_USED' };
    }
    if (invite.expires_at_ms <= now) {
      sqlite.exec('ROLLBACK;');
      return { error: 'INVITE_EXPIRED' };
    }

    // SPEC §5.1: devices are prepared and paired while `draft`, and may
    // still be added while `live`. `closing` is a drain state, and
    // `closed`/`archived` accept no new device at all — pairing one there
    // would silently undermine the closing sync gate.
    const eventRow = sqlite.prepare('SELECT status FROM events WHERE id = ?').get(invite.event_id) as
      | { status: string }
      | undefined;
    if (!eventRow || (eventRow.status !== 'draft' && eventRow.status !== 'live')) {
      sqlite.exec('ROLLBACK;');
      return { error: 'EVENT_NOT_PAIRABLE' };
    }

    // The atomic claim: only one caller can flip `used_at_ms` from NULL.
    const claim = sqlite
      .prepare('UPDATE device_invites SET used_at_ms = ? WHERE id = ? AND used_at_ms IS NULL')
      .run(now, invite.id);
    if (claim.changes === 0) {
      sqlite.exec('ROLLBACK;');
      return { error: 'INVITE_ALREADY_USED' };
    }

    const cp = sqlite.prepare('SELECT name FROM checkpoints WHERE id = ?').get(invite.checkpoint_id) as
      | { name: string }
      | undefined;
    const existing = sqlite
      .prepare('SELECT COUNT(*) AS total FROM device_sessions WHERE checkpoint_id = ?')
      .get(invite.checkpoint_id) as { total: number } | undefined;

    const deviceIndex = Number(existing?.total || 0) + 1;
    const label = `${cp?.name || 'Checkpoint'} — appareil ${deviceIndex}`;

    const sessionId = crypto.randomUUID();
    const sessionToken = crypto.randomBytes(32).toString('base64url');
    const sessionTokenHash = hashToken(sessionToken);
    const expiresAtMs = now + (graceHours + 48) * 3600 * 1000;

    sqlite
      .prepare(
        `INSERT INTO device_sessions (
          id, event_id, checkpoint_id, label, token_hash,
          created_at_ms, expires_at_ms, revoked_at_ms,
          last_seen_at_ms, last_pending_count, last_client_sequence, app_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 0, NULL, ?)`
      )
      .run(
        sessionId,
        invite.event_id,
        invite.checkpoint_id,
        label,
        sessionTokenHash,
        now,
        expiresAtMs,
        now,
        appVersion || null
      );

    sqlite.exec('COMMIT;');
    transactionStarted = false;

    const sessionModel: DeviceSessionModel = {
      id: sessionId,
      eventId: invite.event_id,
      checkpointId: invite.checkpoint_id,
      label,
      createdAtMs: now,
      expiresAtMs,
      revokedAtMs: null,
      lastSeenAtMs: now,
      lastPendingCount: 0,
      lastClientSequence: null,
      appVersion: appVersion || null,
    };

    return { deviceSession: sessionModel, sessionToken, expiresAtMs };
  } catch {
    if (transactionStarted) {
      try {
        sqlite.exec('ROLLBACK;');
      } catch {
        // A failed rollback must not mask the original failure; the caller
        // only ever learns a generic internal error either way.
      }
    }
    return { error: 'INTERNAL_ERROR' };
  }
}

export function exchangeDeviceInvite(
  sqlite: DatabaseSync,
  token: string,
  appVersion?: string,
  graceHours: number = 24
): ExchangeDeviceInviteResult {
  return exchangeDeviceInviteSync(sqlite, hashToken(token), appVersion, graceHours);
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
