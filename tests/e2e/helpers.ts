import fs from 'node:fs';
import path from 'node:path';
import { APIRequestContext, request as pwRequest } from '@playwright/test';
import { E2E_BASE_URL, E2E_DATA_DIR } from '../../playwright.config.js';

export const ADMIN_USERNAME = 'e2e-admin';
export const ADMIN_PASSWORD = 'E2eTestPass!2026';
export const CSRF_HEADER_NAME = 'x-csrf-token';

export interface AdminSession {
  api: APIRequestContext;
  csrfToken: string;
}

async function waitForSetupToken(timeoutMs = 30_000): Promise<string> {
  const tokenFile = path.resolve(process.cwd(), E2E_DATA_DIR, 'setup-token.txt');
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(tokenFile)) {
      const content = fs.readFileSync(tokenFile, 'utf-8');
      const match = content.match(/PAXFLUX SETUP TOKEN:\s*\n([a-f0-9]+)/i);
      if (match) return match[1];
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${tokenFile}`);
}

let sessionPromise: Promise<AdminSession> | null = null;

/**
 * Creates (or reuses) the single admin account for the whole E2E run.
 * Idempotent across spec files: only the first caller performs /setup.
 */
export function getAdminSession(): Promise<AdminSession> {
  if (!sessionPromise) {
    sessionPromise = bootstrapAdminSession();
  }
  return sessionPromise;
}

async function bootstrapAdminSession(): Promise<AdminSession> {
  const api = await pwRequest.newContext({ baseURL: E2E_BASE_URL });

  const metaRes = await api.get('/api/v1/meta');
  const meta = await metaRes.json();

  if (!meta.isInitialized) {
    const setupToken = await waitForSetupToken();
    const setupRes = await api.post('/api/v1/setup', {
      data: {
        setupToken,
        username: ADMIN_USERNAME,
        password: ADMIN_PASSWORD,
        instanceName: 'PaxFlux E2E',
      },
    });
    if (!setupRes.ok()) {
      throw new Error(`/api/v1/setup failed: ${setupRes.status()} ${await setupRes.text()}`);
    }
    const body = await setupRes.json();
    return { api, csrfToken: body.csrfToken };
  }

  const loginRes = await api.post('/api/v1/auth/login', {
    data: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
  });
  if (!loginRes.ok()) {
    throw new Error(`/api/v1/auth/login failed: ${loginRes.status()} ${await loginRes.text()}`);
  }
  const body = await loginRes.json();
  return { api, csrfToken: body.csrfToken };
}

export async function adminApi<T = any>(
  session: AdminSession,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  data?: unknown
): Promise<T> {
  const res = await session.api.fetch(url, {
    method,
    data,
    headers: method === 'GET' ? {} : { [CSRF_HEADER_NAME]: session.csrfToken },
  });
  if (!res.ok()) {
    throw new Error(`${method} ${url} -> ${res.status()}: ${await res.text()}`);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export interface DraftEventTopology {
  eventId: string;
  externalSpaceId: string;
  siteSpaceId: string;
  mainCheckpointId: string;
}

/**
 * Creates a draft event with the default seed topology (Extérieur <-> Site)
 * and returns the ids needed to drive the rest of a scenario directly via
 * the API, bypassing the (currently broken) multi-checkpoint wizard UI.
 */
export async function createDraftEventWithMainCheckpoint(
  session: AdminSession,
  opts: { name: string; capacity: number }
): Promise<DraftEventTopology> {
  const event = await adminApi(session, 'POST', '/api/v1/events', {
    name: opts.name,
    capacity: opts.capacity,
    warningRatio1: 0.8,
    warningRatio2: 0.9,
    timezone: 'Europe/Paris',
  });

  const spaces = await adminApi<any[]>(session, 'GET', `/api/v1/events/${event.id}/spaces`);
  const externalSpace = spaces.find((s) => s.kind === 'external');
  const siteSpace = spaces.find((s) => s.kind === 'leaf');

  const checkpoint = await adminApi(session, 'POST', `/api/v1/events/${event.id}/checkpoints`, {
    name: 'Porte Principale',
    spaceAId: externalSpace.id,
    spaceBId: siteSpace.id,
    allowAToB: true,
    allowBToA: true,
    labelAToB: 'ENTRÉE +1',
    labelBToA: 'SORTIE −1',
  });

  return {
    eventId: event.id,
    externalSpaceId: externalSpace.id,
    siteSpaceId: siteSpace.id,
    mainCheckpointId: checkpoint.id,
  };
}

/**
 * Adds a second internal leaf space (e.g. "VIP") connected to the main
 * "Site" space by its own checkpoint, i.e. a transfer that never touches
 * the external boundary. Used to reproduce the offline projection bug.
 */
export async function addInternalTransferCheckpoint(
  session: AdminSession,
  topo: DraftEventTopology,
  opts: { zoneName: string; capacity: number }
): Promise<{ zoneSpaceId: string; internalCheckpointId: string }> {
  const zoneSpace = await adminApi(session, 'POST', `/api/v1/events/${topo.eventId}/spaces`, {
    name: opts.zoneName,
    kind: 'leaf',
    capacity: opts.capacity,
  });

  const internalCheckpoint = await adminApi(session, 'POST', `/api/v1/events/${topo.eventId}/checkpoints`, {
    name: `Accès ${opts.zoneName}`,
    spaceAId: topo.siteSpaceId,
    spaceBId: zoneSpace.id,
    allowAToB: true,
    allowBToA: true,
    labelAToB: `→ ${opts.zoneName}`,
    labelBToA: '← SORTIE',
  });

  return { zoneSpaceId: zoneSpace.id, internalCheckpointId: internalCheckpoint.id };
}

export async function startEvent(session: AdminSession, eventId: string) {
  return adminApi(session, 'POST', `/api/v1/events/${eventId}/start`);
}

export async function beginClosingEvent(session: AdminSession, eventId: string) {
  return adminApi(session, 'POST', `/api/v1/events/${eventId}/begin-closing`);
}

export async function createDeviceInviteToken(
  session: AdminSession,
  eventId: string,
  checkpointId: string
): Promise<string> {
  const invite = await adminApi<{ token: string }>(
    session,
    'POST',
    `/api/v1/events/${eventId}/device-invites`,
    { checkpointId, expiresInMinutes: 30 }
  );
  return invite.token;
}

export async function getEventDevices(session: AdminSession, eventId: string): Promise<any[]> {
  return adminApi(session, 'GET', `/api/v1/events/${eventId}/devices`);
}

export async function revokeDeviceSession(session: AdminSession, deviceSessionId: string): Promise<void> {
  await adminApi(session, 'POST', `/api/v1/device-sessions/${deviceSessionId}/revoke`);
}

export async function createDeviceInvite(
  session: AdminSession,
  eventId: string,
  checkpointId: string
): Promise<{ id: string; token: string; pairUrl: string; pairUrlSource: string; unreachableFromPhone: boolean }> {
  return adminApi(session, 'POST', `/api/v1/events/${eventId}/device-invites`, {
    checkpointId,
    expiresInMinutes: 30,
  });
}

export async function getEventState(session: AdminSession, eventId: string): Promise<any> {
  return adminApi(session, 'GET', `/api/v1/events/${eventId}/state`);
}

export async function getEventSpaces(session: AdminSession, eventId: string): Promise<any[]> {
  return adminApi(session, 'GET', `/api/v1/events/${eventId}/spaces`);
}

export async function getEventCheckpoints(session: AdminSession, eventId: string): Promise<any[]> {
  return adminApi(session, 'GET', `/api/v1/events/${eventId}/checkpoints`);
}

export async function getEventPreflight(session: AdminSession, eventId: string): Promise<any> {
  return adminApi(session, 'GET', `/api/v1/events/${eventId}/preflight`);
}

/**
 * Drives a leaf space to an exact occupancy through the supervisor
 * adjustment endpoint. Used by the offline specs to move the authoritative
 * state away from the value a device cached at bootstrap time, without
 * needing a second paired device.
 */
export async function adjustSpaceOccupancy(
  session: AdminSession,
  eventId: string,
  spaceId: string,
  observedCount: number,
  reason = 'Recalage E2E'
): Promise<void> {
  await adminApi(session, 'POST', `/api/v1/events/${eventId}/adjustments`, {
    spaceId,
    observedCount,
    reason,
  });
}

export async function closeEvent(session: AdminSession, eventId: string) {
  return adminApi(session, 'POST', `/api/v1/events/${eventId}/close`);
}

/** `/close` without throwing, so a spec can assert on the refusal itself. */
export async function tryCloseEvent(
  session: AdminSession,
  eventId: string
): Promise<{ status: number; body: unknown }> {
  const res = await session.api.fetch(`/api/v1/events/${eventId}/close`, {
    method: 'POST',
    headers: { [CSRF_HEADER_NAME]: session.csrfToken },
  });
  const text = await res.text();
  return { status: res.status(), body: text ? JSON.parse(text) : undefined };
}

export async function forceCloseEvent(session: AdminSession, eventId: string, reason = 'Fermeture forcée E2E') {
  return adminApi(session, 'POST', `/api/v1/events/${eventId}/force-close`, { reason });
}

export async function reopenEvent(session: AdminSession, eventId: string, reason = 'Réouverture E2E') {
  return adminApi(session, 'POST', `/api/v1/events/${eventId}/reopen`, { reason });
}
