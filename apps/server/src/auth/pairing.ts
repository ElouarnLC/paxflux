import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { FastifyRequest, FastifyReply } from 'fastify';
import { AppDb } from '../db/index.js';
import { deviceInvites, deviceSessions, checkpoints } from '../db/schema.js';
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

/** Strips any port, then reports whether a phone could reach this host. */
function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.replace(/:\d+$/, ''));
}

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
  /**
   * Set when the phone will open this URL outside a secure context.
   *
   * Pairing works over plain HTTP; installation and offline do not. Service
   * workers are gated on a secure context, which browsers grant to HTTPS and
   * to loopback — a LAN IP over HTTP gets neither, so the handset can pair
   * and count online while never becoming an installed, offline-capable
   * counter. Judged on the resolved URL rather than on configuration,
   * because the request origin is what the QR carries when PUBLIC_BASE_URL
   * is unset.
   */
  insecureForInstall: boolean;
}

/**
 * Whether a phone opening this origin gets a secure context.
 *
 * `https:` always; `http:` only on loopback, which is the browser's own
 * development exception and never true of a phone on the LAN.
 */
function isSecureContextOrigin(protocol: string, host: string): boolean {
  const scheme = protocol.replace(/:$/, '').toLowerCase();
  if (scheme === 'https') return true;
  return scheme === 'http' && isLoopbackHost(host);
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
    const configured = env.PUBLIC_BASE_URL.replace(/\/+$/, '');
    // A configured PUBLIC_BASE_URL is authoritative, but being configured
    // does not make it reachable: `http://localhost:3000` is a common
    // copy-paste that produces a QR no handset can open. Flag it just the
    // same rather than trusting the setting blindly.
    let unreachableFromPhone = false;
    try {
      unreachableFromPhone = isLoopbackHost(new URL(configured).hostname);
    } catch {
      // EnvSchema already validates PUBLIC_BASE_URL as a URL, so this is
      // unreachable in practice; treat an unparseable value as reachable
      // rather than inventing a warning about it.
      unreachableFromPhone = false;
    }

    let insecureForInstall = false;
    try {
      const parsed = new URL(configured);
      insecureForInstall = !isSecureContextOrigin(parsed.protocol, parsed.host);
    } catch {
      // Unparseable in practice — EnvSchema validates it — and an invented
      // warning is worse than none.
      insecureForInstall = false;
    }

    return { baseUrl: configured, source: 'public_base_url', unreachableFromPhone, insecureForInstall };
  }

  if (!requestOrigin?.host) {
    // Nothing usable at all: better an explicit refusal than a QR encoding
    // a bare "/pair#token" that resolves to nothing once scanned.
    return { error: 'NO_PUBLIC_BASE_URL' };
  }

  return {
    baseUrl: `${requestOrigin.protocol}://${requestOrigin.host}`.replace(/\/+$/, ''),
    source: 'request_origin',
    unreachableFromPhone: isLoopbackHost(requestOrigin.host),
    insecureForInstall: !isSecureContextOrigin(requestOrigin.protocol, requestOrigin.host),
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
  | 'CHECKPOINT_UNUSABLE'
  | 'INTERNAL_ERROR';

export type ExchangeDeviceInviteResult =
  | {
      deviceSession: DeviceSessionModel;
      sessionToken: string;
      expiresAtMs: number;
    }
  | { error: Exclude<ExchangeDeviceInviteError, 'INTERNAL_ERROR'> }
  // The cause and any rollback failure never reach the client — they exist
  // so the route can log what actually went wrong.
  | { error: 'INTERNAL_ERROR'; cause: unknown; rollbackError: unknown };

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

    // The checkpoint is re-verified at consumption, not just at creation:
    // an invitation minted in `draft` may be scanned much later, by which
    // point its door may have been renamed away, deactivated, or (for rows
    // predating the creation-time check) never have belonged to this event
    // at all. Checked *before* the claim, so a refused scan does not burn
    // the token — staff can fix the topology and reuse the same QR.
    const cp = sqlite
      .prepare('SELECT name, event_id, is_active FROM checkpoints WHERE id = ?')
      .get(invite.checkpoint_id) as { name: string; event_id: string; is_active: number } | undefined;
    if (!cp || cp.event_id !== invite.event_id || !cp.is_active) {
      sqlite.exec('ROLLBACK;');
      return { error: 'CHECKPOINT_UNUSABLE' };
    }

    // The atomic claim: only one caller can flip `used_at_ms` from NULL.
    const claim = sqlite
      .prepare('UPDATE device_invites SET used_at_ms = ? WHERE id = ? AND used_at_ms IS NULL')
      .run(now, invite.id);
    if (claim.changes === 0) {
      sqlite.exec('ROLLBACK;');
      return { error: 'INVITE_ALREADY_USED' };
    }

    const existing = sqlite
      .prepare('SELECT COUNT(*) AS total FROM device_sessions WHERE checkpoint_id = ?')
      .get(invite.checkpoint_id) as { total: number } | undefined;

    const deviceIndex = Number(existing?.total || 0) + 1;
    const label = `${cp.name} — appareil ${deviceIndex}`;

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
  } catch (err) {
    // Same contract as Phase 4's topology transaction: keep the real cause
    // for server-side logging, only attempt a rollback when a transaction
    // was actually opened (BEGIN itself may be what failed), and capture a
    // rollback failure separately so it can never mask — nor silently
    // swallow — the error that triggered it.
    let rollbackError: unknown = null;
    if (transactionStarted) {
      try {
        sqlite.exec('ROLLBACK;');
      } catch (errDuringRollback) {
        rollbackError = errDuringRollback;
      }
    }

    return { error: 'INTERNAL_ERROR', cause: err, rollbackError };
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

  // `device_sessions` has no composite FK tying (event_id, checkpoint_id)
  // together, and rows created before Phase 5 could be minted from an
  // invitation pointing at another event's door. Such a session would
  // otherwise authenticate and count through a checkpoint its event does
  // not own. Rejected here, so bootstrap, heartbeat, SSE and batch all
  // refuse it at once.
  //
  // Deliberately *not* a check on event status: a session belonging to a
  // `closing` event must keep authenticating so it can drain its outbox.
  const checkpoint = await db
    .select({ eventId: checkpoints.eventId })
    .from(checkpoints)
    .where(eq(checkpoints.id, session.checkpointId))
    .get();

  if (!checkpoint || checkpoint.eventId !== session.eventId) {
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
