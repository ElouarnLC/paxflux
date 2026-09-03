export type ErrorCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'INVALID_CREDENTIALS'
  | 'SESSION_EXPIRED'
  | 'SESSION_REVOKED'
  | 'INVALID_CSRF'
  | 'SETUP_ALREADY_COMPLETED'
  | 'INVALID_SETUP_TOKEN'
  | 'SETUP_TOKEN_EXPIRED'
  | 'EVENT_NOT_FOUND'
  | 'EVENT_NOT_LIVE'
  | 'EVENT_CLOSED'
  | 'EVENT_ARCHIVED'
  | 'EVENT_ALREADY_LIVE'
  | 'EVENT_NOT_PAIRABLE'
  | 'INVALID_LIFECYCLE_TRANSITION'
  | 'TOPOLOGY_LOCKED'
  /** The timezone may only change while the event is a draft. */
  | 'TIMEZONE_LOCKED'
  /**
   * A write that required the event to still be a draft, applied when it was
   * not. Distinct from `TOPOLOGY_LOCKED`: nothing structural was attempted,
   * the caller simply held a view of the event that time has passed by.
   */
  | 'EVENT_NO_LONGER_DRAFT'
  | 'INVALID_TOPOLOGY'
  | 'SPACE_NOT_FOUND'
  | 'SPACE_IN_USE'
  | 'CHECKPOINT_NOT_FOUND'
  /**
   * A structural change to a checkpoint an active device is paired to.
   *
   * The paired counter caches this checkpoint's endpoints and projects its
   * taps across them, so changing them — or removing the checkpoint — under
   * a live pairing would silently change what those taps mean. The device is
   * revoked and re-paired first; it is never migrated.
   */
  | 'CHECKPOINT_IN_USE'
  | 'DEVICE_NOT_FOUND'
  | 'DEVICE_SESSION_MISMATCH'
  | 'INVITE_NOT_FOUND'
  | 'INVITE_EXPIRED'
  | 'INVITE_ALREADY_USED'
  | 'INVITE_REVOKED'
  | 'INVALID_INVITE_TOKEN'
  | 'ORIGINAL_MOVEMENT_NOT_FOUND'
  | 'ALREADY_REVERSED'
  | 'INVALID_REVERSAL_TARGET'
  | 'VALIDATION_ERROR'
  | 'RATE_LIMIT_EXCEEDED'
  | 'PAYLOAD_TOO_LARGE'
  | 'INTERNAL_ERROR'
  | 'BACKUP_FAILED'
  | 'RESTORE_FAILED'
  | 'DATABASE_INTEGRITY_CHECK_FAILED'
  | 'DEVICES_NOT_SYNCED';

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  code: ErrorCode;
  detail: string;
  requestId?: string;
  invalidParams?: Array<{
    name: string;
    reason: string;
  }>;
}

export function createProblemDetails(
  status: number,
  code: ErrorCode,
  title: string,
  detail: string,
  requestId?: string,
  invalidParams?: Array<{ name: string; reason: string }>
): ProblemDetails {
  return {
    type: `https://paxflux.org/problems/${code.toLowerCase().replace(/_/g, '-')}`,
    title,
    status,
    code,
    detail,
    requestId,
    invalidParams,
  };
}
