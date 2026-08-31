import { sqliteTable, text, integer, real, uniqueIndex, index, primaryKey } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// 17.1 instance_settings
export const instanceSettings = sqliteTable('instance_settings', {
  id: integer('id').primaryKey({ autoIncrement: false }).default(1),
  instanceName: text('instance_name').notNull().default('PaxFlux'),
  setupTokenHash: text('setup_token_hash'),
  setupTokenExpiresAtMs: integer('setup_token_expires_at_ms'),
  initializedAtMs: integer('initialized_at_ms'),
  createdAtMs: integer('created_at_ms').notNull(),
  updatedAtMs: integer('updated_at_ms').notNull(),
});

// 17.2 staff_users
export const staffUsers = sqliteTable('staff_users', {
  id: text('id').primaryKey(),
  username: text('username').notNull(),
  usernameNormalized: text('username_normalized').notNull().unique(),
  displayName: text('display_name'),
  role: text('role', { enum: ['admin', 'supervisor'] }).notNull().default('supervisor'),
  passwordHash: text('password_hash').notNull(),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  createdAtMs: integer('created_at_ms').notNull(),
  updatedAtMs: integer('updated_at_ms').notNull(),
  lastLoginAtMs: integer('last_login_at_ms'),
});

// 17.3 staff_sessions
export const staffSessions = sqliteTable('staff_sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => staffUsers.id),
  tokenHash: text('token_hash').notNull().unique(),
  csrfHash: text('csrf_hash').notNull(),
  createdAtMs: integer('created_at_ms').notNull(),
  lastSeenAtMs: integer('last_seen_at_ms').notNull(),
  expiresAtMs: integer('expires_at_ms').notNull(),
  revokedAtMs: integer('revoked_at_ms'),
});

// 17.4 events
export const events = sqliteTable('events', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  timezone: text('timezone').notNull().default('Europe/Paris'),
  capacity: integer('capacity').notNull().default(0),
  status: text('status', { enum: ['draft', 'live', 'closing', 'closed', 'archived'] }).notNull().default('draft'),
  warningRatio1: real('warning_ratio_1').notNull().default(0.80),
  warningRatio2: real('warning_ratio_2').notNull().default(0.90),
  startsAtMs: integer('starts_at_ms'),
  endsAtMs: integer('ends_at_ms'),
  liveStartedAtMs: integer('live_started_at_ms'),
  closingStartedAtMs: integer('closing_started_at_ms'),
  closedAtMs: integer('closed_at_ms'),
  archivedAtMs: integer('archived_at_ms'),
  version: integer('version').notNull().default(1),
  topologyLockedAtMs: integer('topology_locked_at_ms'),
  createdBy: text('created_by').notNull().references(() => staffUsers.id),
  createdAtMs: integer('created_at_ms').notNull(),
  updatedAtMs: integer('updated_at_ms').notNull(),
});

// 17.5 spaces
export const spaces = sqliteTable('spaces', {
  id: text('id').primaryKey(),
  eventId: text('event_id').notNull().references(() => events.id),
  parentId: text('parent_id'),
  name: text('name').notNull(),
  kind: text('kind', { enum: ['leaf', 'aggregate', 'external'] }).notNull(),
  capacity: integer('capacity'),
  sortOrder: integer('sort_order').notNull().default(0),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  createdAtMs: integer('created_at_ms').notNull(),
  updatedAtMs: integer('updated_at_ms').notNull(),
}, (table) => [
  index('idx_spaces_event_parent').on(table.eventId, table.parentId),
]);

// 17.6 space_state
export const spaceState = sqliteTable('space_state', {
  eventId: text('event_id').notNull().references(() => events.id),
  spaceId: text('space_id').notNull().references(() => spaces.id),
  occupancy: integer('occupancy').notNull().default(0),
  updatedAtMs: integer('updated_at_ms').notNull(),
}, (table) => [
  primaryKey({ columns: [table.eventId, table.spaceId] }),
]);

// 17.7 checkpoints
export const checkpoints = sqliteTable('checkpoints', {
  id: text('id').primaryKey(),
  eventId: text('event_id').notNull().references(() => events.id),
  name: text('name').notNull(),
  spaceAId: text('space_a_id').notNull().references(() => spaces.id),
  spaceBId: text('space_b_id').notNull().references(() => spaces.id),
  allowAToB: integer('allow_a_to_b', { mode: 'boolean' }).notNull().default(true),
  allowBToA: integer('allow_b_to_a', { mode: 'boolean' }).notNull().default(true),
  labelAToB: text('label_a_to_b').notNull().default('ENTRÉE +1'),
  labelBToA: text('label_b_to_a').notNull().default('SORTIE −1'),
  sortOrder: integer('sort_order').notNull().default(0),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  createdAtMs: integer('created_at_ms').notNull(),
  updatedAtMs: integer('updated_at_ms').notNull(),
}, (table) => [
  index('idx_checkpoints_event').on(table.eventId),
]);

// 17.8 device_invites
export const deviceInvites = sqliteTable('device_invites', {
  id: text('id').primaryKey(),
  eventId: text('event_id').notNull().references(() => events.id),
  checkpointId: text('checkpoint_id').notNull().references(() => checkpoints.id),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAtMs: integer('expires_at_ms').notNull(),
  createdBy: text('created_by').notNull().references(() => staffUsers.id),
  createdAtMs: integer('created_at_ms').notNull(),
  usedAtMs: integer('used_at_ms'),
  revokedAtMs: integer('revoked_at_ms'),
});

// 17.9 device_sessions
export const deviceSessions = sqliteTable('device_sessions', {
  id: text('id').primaryKey(),
  eventId: text('event_id').notNull().references(() => events.id),
  checkpointId: text('checkpoint_id').notNull().references(() => checkpoints.id),
  label: text('label').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  createdAtMs: integer('created_at_ms').notNull(),
  expiresAtMs: integer('expires_at_ms').notNull(),
  revokedAtMs: integer('revoked_at_ms'),
  lastSeenAtMs: integer('last_seen_at_ms'),
  lastPendingCount: integer('last_pending_count').notNull().default(0),
  lastClientSequence: integer('last_client_sequence'),
  appVersion: text('app_version'),
  /**
   * The closing epoch (`events.closing_started_at_ms`) this session has
   * explicitly acknowledged with nothing unresolved left.
   *
   * A timestamp comparison would not do: a report prepared before the
   * transition can arrive after it, and `last_seen_at_ms >=
   * closing_started_at_ms` would then read it as confirming an epoch the
   * device knew nothing about. Storing the epoch the device actually named
   * makes the acknowledgment unambiguous.
   */
  drainedForClosingAtMs: integer('drained_for_closing_at_ms'),
}, (table) => [
  index('idx_device_sessions_event_last_seen').on(table.eventId, table.lastSeenAtMs),
]);

// 17.10 movements
export const movements = sqliteTable('movements', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  eventId: text('event_id').notNull().references(() => events.id),
  checkpointId: text('checkpoint_id').references(() => checkpoints.id),
  deviceSessionId: text('device_session_id').references(() => deviceSessions.id),
  actorUserId: text('actor_user_id').references(() => staffUsers.id),
  kind: text('kind', { enum: ['count', 'reversal', 'adjustment'] }).notNull(),
  clientActionId: text('client_action_id').unique(),
  deviceSequence: integer('device_sequence'),
  fromSpaceId: text('from_space_id').references(() => spaces.id),
  toSpaceId: text('to_space_id').references(() => spaces.id),
  quantity: integer('quantity').notNull().default(1),
  reversesMovementId: integer('reverses_movement_id').unique(),
  reason: text('reason'),
  clientTimeMs: integer('client_time_ms'),
  serverTimeMs: integer('server_time_ms').notNull(),
  eventVersion: integer('event_version').notNull(),
  source: text('source', { enum: ['online', 'offline_batch', 'staff'] }).notNull().default('online'),
}, (table) => [
  index('idx_movements_event_time').on(table.eventId, table.serverTimeMs),
  index('idx_movements_event_checkpoint_time').on(table.eventId, table.checkpointId, table.serverTimeMs),
  index('idx_movements_device_time').on(table.deviceSessionId, table.serverTimeMs),
]);

// 17.11 audit_log
export const auditLog = sqliteTable('audit_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  eventId: text('event_id').references(() => events.id),
  actorUserId: text('actor_user_id').references(() => staffUsers.id),
  action: text('action').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
  metadata: text('metadata', { mode: 'json' }),
  createdAtMs: integer('created_at_ms').notNull(),
}, (table) => [
  index('idx_audit_event_time').on(table.eventId, table.createdAtMs),
]);

// 17.12 backup_records
export const backupRecords = sqliteTable('backup_records', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  filename: text('filename').notNull(),
  reason: text('reason').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  sha256: text('sha256').notNull(),
  quickCheckOk: integer('quick_check_ok', { mode: 'boolean' }).notNull(),
  createdAtMs: integer('created_at_ms').notNull(),
});
