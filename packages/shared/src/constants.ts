export const APP_NAME = 'PaxFlux';
export const APP_SLUG = 'paxflux';
export const API_PREFIX = '/api/v1';

export const DEFAULT_WARNING_RATIO_1 = 0.80; // 80%
export const DEFAULT_WARNING_RATIO_2 = 0.90; // 90%

export const DEFAULT_PAIRING_TTL_MINUTES = 30;
export const DEFAULT_STAFF_SESSION_HOURS = 12;
export const DEFAULT_DEVICE_SESSION_GRACE_HOURS = 24;
export const DEFAULT_BACKUP_INTERVAL_LIVE_MINUTES = 5;
export const DEFAULT_BACKUP_RETENTION_COUNT = 300;

export const DEFAULT_TIMEZONE = 'Europe/Paris';

export const COOKIE_NAME_STAFF = 'paxflux_staff_session';
export const COOKIE_NAME_DEVICE = 'paxflux_device_session';
export const COOKIE_NAME_STAFF_PROD = '__Host-paxflux_staff_session';
export const COOKIE_NAME_DEVICE_PROD = '__Host-paxflux_device_session';

export const CSRF_HEADER_NAME = 'x-csrf-token';

export const SSE_HEARTBEAT_INTERVAL_MS = 20_000;
export const SSE_COALESCE_WINDOW_MS = 75;

export const MAX_BATCH_ACTIONS = 100;
/**
 * A device that has not been heard from for this long counts as offline in
 * every supervision surface. The single source of truth for that verdict —
 * clients display what the server computed rather than approximating it.
 */
export const DEVICE_OFFLINE_THRESHOLD_MS = 45_000;
/**
 * How often an open counter announces itself. Comfortably under
 * DEVICE_OFFLINE_THRESHOLD_MS so a device stays online across a missed
 * beat, without turning idle handsets into a stream of traffic.
 */
export const DEVICE_HEARTBEAT_INTERVAL_MS = 15_000;
