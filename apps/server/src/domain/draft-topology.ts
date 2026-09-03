import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  CheckpointModel,
  CreateCheckpointRequest,
  CreateSpaceRequest,
  ErrorCode,
  SpaceModel,
  UpdateCheckpointRequest,
  UpdateSpaceRequest,
} from '@paxflux/shared';
import { validateSpaceRules } from './spaces.js';
import { validateCheckpointRules } from './checkpoints.js';

/**
 * Every draft-only topology mutation, as one indivisible decision.
 *
 * Each function here opens `BEGIN IMMEDIATE`, re-reads everything it depends
 * on, decides, writes, and commits — with no `await` anywhere in between.
 * That is what makes them atomic in this process: `node:sqlite`'s
 * `DatabaseSync` is synchronous, so no other request can interleave inside
 * one of these blocks, and `BEGIN IMMEDIATE` gives the same guarantee at the
 * database level against anything outside it.
 *
 * Two windows closed by that rule, both of which existed when these routes
 * read with awaited drizzle calls and wrote afterwards:
 *
 *  - **draft → live.** A mutation read `status = 'draft'`, then awaited more
 *    work, then wrote. `POST /start` could flip the status in between, so
 *    the write landed on a live event past its own topology lock. The status
 *    is now re-read inside the transaction that writes.
 *  - **pairing → structural edit.** An endpoint move checked for active
 *    device sessions, then awaited, then wrote; a QR scan could create a
 *    session in that gap and be bootstrapped against endpoints the server
 *    was about to change. Pairing runs its own synchronous `BEGIN IMMEDIATE`
 *    (`auth/pairing.ts`), so putting the session check in the same kind of
 *    block makes the two mutually exclusive.
 *
 * The lock in `domain/event-lock.ts` is still needed on top of this, because
 * `/start` cannot be one synchronous block: it awaits a `VACUUM INTO`
 * backup between validating the topology and making it live.
 */

export interface DraftRefusal {
  ok: false;
  status: number;
  code: ErrorCode;
  title: string;
  detail: string;
}

export type DraftResult<T> = { ok: true; row: T } | DraftRefusal;
type Decision<T> = { ok: true; row: T } | DraftRefusal;

/**
 * The checkpoint fields a paired counter has already cached.
 *
 * `/device/bootstrap` hands the whole checkpoint to the phone and the phone
 * stores it (`offline/snapshot.ts`); `CounterView` then draws its buttons
 * from `allow*`/`label*` and projects each tap across `spaceAId`/`spaceBId`
 * before the server ever sees it. Changing any of these under a live pairing
 * changes what the device's taps mean without the device knowing — so for
 * RC2-C they require revoke and re-pair rather than a silent migration.
 *
 * `name` and `sortOrder` are deliberately *not* here. The name is a heading;
 * a stale one is confusing, but it never misattributes a count. Only fields
 * that change the meaning of a tap are protected.
 */
const DEVICE_VISIBLE_CHECKPOINT_FIELDS = [
  'spaceAId',
  'spaceBId',
  'allowAToB',
  'allowBToA',
  'labelAToB',
  'labelBToA',
  'isActive',
] as const;

// ---------------------------------------------------------------------------
// Rows, as SQLite hands them back
// ---------------------------------------------------------------------------

interface SpaceRow {
  id: string;
  event_id: string;
  parent_id: string | null;
  name: string;
  kind: SpaceModel['kind'];
  capacity: number | null;
  sort_order: number;
  is_active: number;
  created_at_ms: number;
  updated_at_ms: number;
}

interface CheckpointRow {
  id: string;
  event_id: string;
  name: string;
  space_a_id: string;
  space_b_id: string;
  allow_a_to_b: number;
  allow_b_to_a: number;
  label_a_to_b: string;
  label_b_to_a: string;
  sort_order: number;
  is_active: number;
  created_at_ms: number;
  updated_at_ms: number;
}

function toSpaceModel(row: SpaceRow): SpaceModel {
  return {
    id: row.id,
    eventId: row.event_id,
    parentId: row.parent_id,
    name: row.name,
    kind: row.kind,
    capacity: row.capacity,
    sortOrder: row.sort_order,
    isActive: row.is_active !== 0,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

function toCheckpointModel(row: CheckpointRow): CheckpointModel {
  return {
    id: row.id,
    eventId: row.event_id,
    name: row.name,
    spaceAId: row.space_a_id,
    spaceBId: row.space_b_id,
    allowAToB: row.allow_a_to_b !== 0,
    allowBToA: row.allow_b_to_a !== 0,
    labelAToB: row.label_a_to_b,
    labelBToA: row.label_b_to_a,
    sortOrder: row.sort_order,
    isActive: row.is_active !== 0,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

const eventNotFound: DraftRefusal = {
  ok: false,
  status: 404,
  code: 'EVENT_NOT_FOUND',
  title: 'Événement introuvable',
  detail: 'Événement introuvable.',
};

const topologyLocked: DraftRefusal = {
  ok: false,
  status: 409,
  code: 'TOPOLOGY_LOCKED',
  title: 'Topologie verrouillée',
  detail: 'La topologie ne peut être modifiée qu’en mode brouillon.',
};

function invalid(detail: string, code: ErrorCode = 'VALIDATION_ERROR'): DraftRefusal {
  return { ok: false, status: 400, code, title: 'Règle topologique enfreinte', detail };
}

function checkpointInUse(count: number, action: string): DraftRefusal {
  return {
    ok: false,
    status: 409,
    code: 'CHECKPOINT_IN_USE',
    title: 'Porte utilisée par un appareil',
    detail:
      `${count} appareil${count > 1 ? 's sont appairés' : ' est appairé'} à cette porte. ` +
      `Révoquez-${count > 1 ? 'les' : 'le'} depuis la gestion des appareils avant de ${action}, ` +
      'puis appairez à nouveau : un appareil déjà appairé garde en mémoire la configuration de cette porte.',
  };
}

// ---------------------------------------------------------------------------
// Synchronous primitives — none of these may await
// ---------------------------------------------------------------------------

/**
 * Runs one decision inside `BEGIN IMMEDIATE`.
 *
 * A refusal rolls back rather than commits, so a decision that wrote before
 * discovering a problem leaves nothing behind. A thrown error rolls back too
 * and is re-raised: a failed `ROLLBACK` must never mask it.
 */
function decideInTransaction<T>(sqlite: DatabaseSync, body: () => Decision<T>): Decision<T> {
  sqlite.exec('BEGIN IMMEDIATE;');
  let outcome: Decision<T>;
  try {
    outcome = body();
  } catch (err) {
    try {
      sqlite.exec('ROLLBACK;');
    } catch {
      /* keep the original failure */
    }
    throw err;
  }
  sqlite.exec(outcome.ok ? 'COMMIT;' : 'ROLLBACK;');
  return outcome;
}

/** The draft precondition, read inside the transaction that writes. */
function draftGuard(sqlite: DatabaseSync, eventId: string): DraftRefusal | null {
  const row = sqlite.prepare('SELECT status FROM events WHERE id = ?').get(eventId) as
    | { status: string }
    | undefined;
  if (!row) return eventNotFound;
  if (row.status !== 'draft') return topologyLocked;
  return null;
}

function activeSessionCount(sqlite: DatabaseSync, checkpointId: string): number {
  const row = sqlite
    .prepare('SELECT COUNT(*) AS total FROM device_sessions WHERE checkpoint_id = ? AND revoked_at_ms IS NULL')
    .get(checkpointId) as { total: number } | undefined;
  return Number(row?.total ?? 0);
}

function readSpaceRows(sqlite: DatabaseSync, eventId: string, activeOnly: boolean): SpaceRow[] {
  const sql = activeOnly
    ? 'SELECT * FROM spaces WHERE event_id = ? AND is_active = 1'
    : 'SELECT * FROM spaces WHERE event_id = ?';
  return sqlite.prepare(sql).all(eventId) as unknown as SpaceRow[];
}

function readSpace(sqlite: DatabaseSync, eventId: string, spaceId: string): SpaceRow | undefined {
  return sqlite.prepare('SELECT * FROM spaces WHERE id = ? AND event_id = ?').get(spaceId, eventId) as
    | SpaceRow
    | undefined;
}

function readCheckpoint(sqlite: DatabaseSync, eventId: string, checkpointId: string): CheckpointRow | undefined {
  return sqlite
    .prepare('SELECT * FROM checkpoints WHERE id = ? AND event_id = ?')
    .get(checkpointId, eventId) as CheckpointRow | undefined;
}

// ---------------------------------------------------------------------------
// Spaces
// ---------------------------------------------------------------------------

export function createSpaceSync(
  sqlite: DatabaseSync,
  eventId: string,
  input: CreateSpaceRequest
): DraftResult<SpaceModel> {
  return decideInTransaction(sqlite, () => {
    const locked = draftGuard(sqlite, eventId);
    if (locked) return locked;

    const existing = readSpaceRows(sqlite, eventId, false).map((r) => ({
      id: r.id,
      parentId: r.parent_id,
      kind: r.kind as string,
    }));

    const ruleError = validateSpaceRules(
      { kind: input.kind, parentId: input.parentId, capacity: input.capacity },
      existing
    );
    if (ruleError) return invalid(ruleError.message, (ruleError.code as ErrorCode) || 'VALIDATION_ERROR');

    const spaceId = crypto.randomUUID();
    const now = Date.now();

    sqlite
      .prepare(
        `INSERT INTO spaces (id, event_id, parent_id, name, kind, capacity, sort_order, is_active, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
      )
      .run(
        spaceId,
        eventId,
        input.parentId || null,
        input.name.trim(),
        input.kind,
        input.capacity ?? null,
        input.sortOrder ?? 0,
        now,
        now
      );

    if (input.kind === 'leaf') {
      sqlite
        .prepare('INSERT INTO space_state (event_id, space_id, occupancy, updated_at_ms) VALUES (?, ?, 0, ?)')
        .run(eventId, spaceId, now);
    }

    return { ok: true, row: toSpaceModel(readSpace(sqlite, eventId, spaceId)!) };
  });
}

export function patchSpaceSync(
  sqlite: DatabaseSync,
  eventId: string,
  spaceId: string,
  patch: UpdateSpaceRequest
): DraftResult<SpaceModel> {
  return decideInTransaction(sqlite, () => {
    const locked = draftGuard(sqlite, eventId);
    if (locked) return locked;

    const existing = readSpace(sqlite, eventId, spaceId);
    if (!existing) {
      return { ok: false, status: 404, code: 'SPACE_NOT_FOUND', title: 'Espace introuvable', detail: 'Espace introuvable.' };
    }

    // Active spaces only, exactly as this route validated before: a
    // deactivated space is not a candidate parent.
    const others = readSpaceRows(sqlite, eventId, true).map((r) => ({
      id: r.id,
      parentId: r.parent_id,
      kind: r.kind as string,
    }));

    const parentId = patch.parentId !== undefined ? patch.parentId : existing.parent_id;
    const capacity = patch.capacity !== undefined ? patch.capacity : existing.capacity;
    const ruleError = validateSpaceRules({ kind: existing.kind, parentId, capacity }, others, spaceId);
    if (ruleError) return invalid(ruleError.message);

    sqlite
      .prepare(
        `UPDATE spaces SET
           name = COALESCE(?, name),
           parent_id = CASE WHEN ? THEN ? ELSE parent_id END,
           capacity = CASE WHEN ? THEN ? ELSE capacity END,
           sort_order = COALESCE(?, sort_order),
           is_active = COALESCE(?, is_active),
           updated_at_ms = ?
         WHERE id = ?`
      )
      .run(
        patch.name !== undefined ? patch.name.trim() : null,
        patch.parentId !== undefined ? 1 : 0,
        patch.parentId ?? null,
        patch.capacity !== undefined ? 1 : 0,
        patch.capacity ?? null,
        patch.sortOrder ?? null,
        patch.isActive === undefined ? null : patch.isActive ? 1 : 0,
        Date.now(),
        spaceId
      );

    return { ok: true, row: toSpaceModel(readSpace(sqlite, eventId, spaceId)!) };
  });
}

export function deleteSpaceSync(sqlite: DatabaseSync, eventId: string, spaceId: string): DraftResult<{ success: true }> {
  return decideInTransaction(sqlite, () => {
    const locked = draftGuard(sqlite, eventId);
    if (locked) return locked;

    const existing = readSpace(sqlite, eventId, spaceId);
    if (!existing) {
      return { ok: false, status: 404, code: 'SPACE_NOT_FOUND', title: 'Espace introuvable', detail: 'Espace introuvable.' };
    }

    const referenced = sqlite
      .prepare(
        `SELECT 1 FROM checkpoints WHERE event_id = ? AND (space_a_id = ? OR space_b_id = ?)
         UNION ALL
         SELECT 1 FROM spaces WHERE event_id = ? AND parent_id = ?
         LIMIT 1`
      )
      .get(eventId, spaceId, spaceId, eventId, spaceId);

    if (referenced) {
      return {
        ok: false,
        status: 409,
        code: 'SPACE_IN_USE',
        title: 'Espace utilisé',
        detail: 'Cet espace est référencé par un checkpoint ou un espace enfant ; supprimez-les d’abord.',
      };
    }

    sqlite.prepare('DELETE FROM space_state WHERE event_id = ? AND space_id = ?').run(eventId, spaceId);
    sqlite.prepare('DELETE FROM spaces WHERE id = ?').run(spaceId);

    return { ok: true, row: { success: true } };
  });
}

// ---------------------------------------------------------------------------
// Checkpoints
// ---------------------------------------------------------------------------

export function createCheckpointSync(
  sqlite: DatabaseSync,
  eventId: string,
  input: CreateCheckpointRequest
): DraftResult<CheckpointModel> {
  return decideInTransaction(sqlite, () => {
    const locked = draftGuard(sqlite, eventId);
    if (locked) return locked;

    const spacesMap = new Map(readSpaceRows(sqlite, eventId, false).map((r) => [r.id, { kind: r.kind }]));
    const cpError = validateCheckpointRules(
      {
        spaceAId: input.spaceAId,
        spaceBId: input.spaceBId,
        allowAToB: input.allowAToB,
        allowBToA: input.allowBToA,
      },
      spacesMap
    );
    if (cpError) return invalid(cpError.message, (cpError.code as ErrorCode) || 'VALIDATION_ERROR');

    const cpId = crypto.randomUUID();
    const now = Date.now();

    sqlite
      .prepare(
        `INSERT INTO checkpoints (
           id, event_id, name, space_a_id, space_b_id,
           allow_a_to_b, allow_b_to_a, label_a_to_b, label_b_to_a,
           sort_order, is_active, created_at_ms, updated_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
      )
      .run(
        cpId,
        eventId,
        input.name.trim(),
        input.spaceAId,
        input.spaceBId,
        input.allowAToB === false ? 0 : 1,
        input.allowBToA === false ? 0 : 1,
        input.labelAToB.trim(),
        input.labelBToA.trim(),
        input.sortOrder ?? 0,
        now,
        now
      );

    return { ok: true, row: toCheckpointModel(readCheckpoint(sqlite, eventId, cpId)!) };
  });
}

export function patchCheckpointSync(
  sqlite: DatabaseSync,
  eventId: string,
  checkpointId: string,
  patch: UpdateCheckpointRequest
): DraftResult<CheckpointModel> {
  return decideInTransaction(sqlite, () => {
    const locked = draftGuard(sqlite, eventId);
    if (locked) return locked;

    const existing = readCheckpoint(sqlite, eventId, checkpointId);
    if (!existing) {
      return {
        ok: false,
        status: 404,
        code: 'CHECKPOINT_NOT_FOUND',
        title: 'Checkpoint introuvable',
        detail: 'Checkpoint introuvable.',
      };
    }

    const stored = toCheckpointModel(existing);
    const proposed = {
      spaceAId: patch.spaceAId ?? stored.spaceAId,
      spaceBId: patch.spaceBId ?? stored.spaceBId,
      allowAToB: patch.allowAToB ?? stored.allowAToB,
      allowBToA: patch.allowBToA ?? stored.allowBToA,
      labelAToB: patch.labelAToB !== undefined ? patch.labelAToB.trim() : stored.labelAToB,
      labelBToA: patch.labelBToA !== undefined ? patch.labelBToA.trim() : stored.labelBToA,
      isActive: patch.isActive ?? stored.isActive,
    };

    // Compared field by field against what is stored, so a request that
    // merely repeats the current configuration is a no-op and passes: a
    // refusal is earned by an actual change, never by the shape of the body.
    const changed = DEVICE_VISIBLE_CHECKPOINT_FIELDS.filter((field) => proposed[field] !== stored[field]);
    if (changed.length > 0) {
      const paired = activeSessionCount(sqlite, checkpointId);
      if (paired > 0) return checkpointInUse(paired, 'modifier sa configuration');
    }

    const spacesMap = new Map(readSpaceRows(sqlite, eventId, false).map((r) => [r.id, { kind: r.kind }]));
    // Validated against the *proposed* endpoints with exactly the rules
    // creation uses — an endpoint belonging to another event is simply not
    // in this map, so it fails as unknown rather than being trusted.
    const cpError = validateCheckpointRules(proposed, spacesMap);
    if (cpError) return invalid(cpError.message);

    sqlite
      .prepare(
        `UPDATE checkpoints SET
           name = COALESCE(?, name),
           space_a_id = ?, space_b_id = ?,
           allow_a_to_b = ?, allow_b_to_a = ?,
           label_a_to_b = ?, label_b_to_a = ?,
           sort_order = COALESCE(?, sort_order),
           is_active = ?,
           updated_at_ms = ?
         WHERE id = ?`
      )
      .run(
        patch.name !== undefined ? patch.name.trim() : null,
        proposed.spaceAId,
        proposed.spaceBId,
        proposed.allowAToB ? 1 : 0,
        proposed.allowBToA ? 1 : 0,
        proposed.labelAToB,
        proposed.labelBToA,
        patch.sortOrder ?? null,
        proposed.isActive ? 1 : 0,
        Date.now(),
        checkpointId
      );

    return { ok: true, row: toCheckpointModel(readCheckpoint(sqlite, eventId, checkpointId)!) };
  });
}

export function deleteCheckpointSync(
  sqlite: DatabaseSync,
  eventId: string,
  checkpointId: string
): DraftResult<{ success: true }> {
  return decideInTransaction(sqlite, () => {
    const locked = draftGuard(sqlite, eventId);
    if (locked) return locked;

    const existing = readCheckpoint(sqlite, eventId, checkpointId);
    if (!existing) {
      return {
        ok: false,
        status: 404,
        code: 'CHECKPOINT_NOT_FOUND',
        title: 'Checkpoint introuvable',
        detail: 'Checkpoint introuvable.',
      };
    }

    const paired = activeSessionCount(sqlite, checkpointId);
    if (paired > 0) return checkpointInUse(paired, 'supprimer cette porte');

    // A movement recorded here would make this door part of the ledger, and
    // the ledger is append-only. Counting requires `live`, so a draft should
    // never have one — asserted rather than assumed, because the cost of
    // being wrong is a deleted row the ledger still references.
    const recorded = sqlite.prepare('SELECT 1 FROM movements WHERE checkpoint_id = ? LIMIT 1').get(checkpointId);
    if (recorded) {
      return {
        ok: false,
        status: 409,
        code: 'CHECKPOINT_IN_USE',
        title: 'Porte déjà utilisée',
        detail: 'Des mouvements ont déjà été enregistrés sur cette porte ; elle ne peut plus être supprimée.',
      };
    }

    // Only rows proven safe are removable. `revoked_at_ms IS NOT NULL` is
    // the whole defence: a blanket delete by checkpoint would destroy an
    // active pairing on the strength of a count taken earlier, and a count
    // is exactly the thing that must not be trusted twice. Anything left
    // behind is an active session, which the foreign key then refuses to
    // orphan — the delete below fails and the whole decision rolls back.
    sqlite
      .prepare('DELETE FROM device_sessions WHERE checkpoint_id = ? AND revoked_at_ms IS NOT NULL')
      .run(checkpointId);
    sqlite.prepare('DELETE FROM device_invites WHERE checkpoint_id = ?').run(checkpointId);
    sqlite.prepare('DELETE FROM checkpoints WHERE id = ?').run(checkpointId);

    return { ok: true, row: { success: true } };
  });
}

/**
 * Makes a validated draft live, if it is still the draft that was validated.
 *
 * The conditional `WHERE status = 'draft'` is the last word: even with the
 * event lock held, the transition refuses to overwrite a status something
 * else already moved. `changes === 0` means the caller lost the race and
 * must not report a start.
 */
export function markEventLiveSync(sqlite: DatabaseSync, eventId: string, nowMs: number): boolean {
  const result = sqlite
    .prepare(
      `UPDATE events SET status = 'live', live_started_at_ms = ?, topology_locked_at_ms = ?, updated_at_ms = ?
       WHERE id = ? AND status = 'draft'`
    )
    .run(nowMs, nowMs, nowMs, eventId);
  return Number(result.changes) === 1;
}

/**
 * The event's own editable fields, written only if it is still a draft.
 *
 * The precondition is read inside the transaction that writes, so it holds
 * at the instant of the write rather than at some earlier moment the caller
 * hoped was close enough. That is the difference the draft editor needs: it
 * may have been open for minutes while somebody else started the event.
 *
 * `null` for a field means "leave it alone"; the two nullable columns are
 * addressed by an explicit present-flag so that clearing them stays possible.
 */
export interface DraftEventPatch {
  name?: string;
  capacity?: number;
  timezone?: string;
  warningRatio1?: number;
  warningRatio2?: number;
  startsAtMs?: number | null;
  endsAtMs?: number | null;
}

export function patchDraftEventSync(
  sqlite: DatabaseSync,
  eventId: string,
  patch: DraftEventPatch
): DraftResult<{ updatedAtMs: number }> {
  return decideInTransaction(sqlite, () => {
    const row = sqlite.prepare('SELECT status FROM events WHERE id = ?').get(eventId) as
      | { status: string }
      | undefined;
    if (!row) return eventNotFound;
    if (row.status !== 'draft') {
      return {
        ok: false,
        status: 409,
        code: 'EVENT_NO_LONGER_DRAFT',
        title: 'Événement déjà démarré',
        detail:
          'Cet événement n’est plus un brouillon : sa préparation a été verrouillée pendant que cet écran était ouvert. Aucune modification n’a été enregistrée.',
      };
    }

    const now = Date.now();
    sqlite
      .prepare(
        `UPDATE events SET
           name = COALESCE(?, name),
           capacity = COALESCE(?, capacity),
           timezone = COALESCE(?, timezone),
           warning_ratio_1 = COALESCE(?, warning_ratio_1),
           warning_ratio_2 = COALESCE(?, warning_ratio_2),
           starts_at_ms = CASE WHEN ? THEN ? ELSE starts_at_ms END,
           ends_at_ms = CASE WHEN ? THEN ? ELSE ends_at_ms END,
           updated_at_ms = ?
         WHERE id = ? AND status = 'draft'`
      )
      .run(
        patch.name ?? null,
        patch.capacity ?? null,
        patch.timezone ?? null,
        patch.warningRatio1 ?? null,
        patch.warningRatio2 ?? null,
        patch.startsAtMs !== undefined ? 1 : 0,
        patch.startsAtMs ?? null,
        patch.endsAtMs !== undefined ? 1 : 0,
        patch.endsAtMs ?? null,
        now,
        eventId
      );

    return { ok: true, row: { updatedAtMs: now } };
  });
}
