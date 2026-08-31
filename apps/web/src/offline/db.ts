import Dexie, { Table } from 'dexie';
import {
  OutboxActionRecord,
  CompactEventState,
  DeviceBootstrapResponse,
  OUTBOX_LOCAL_ERROR_CODES,
} from '@paxflux/shared';

/**
 * The single row describing what this device is paired to. Stable across a
 * pairing: event, checkpoint, session, labels and directions.
 */
export interface DeviceConfigRecord {
  key: 'current';
  bootstrap: DeviceBootstrapResponse;
  updatedAtMs: number;
}

/**
 * The single row holding the most recent authoritative state, whatever
 * carried it in (bootstrap, a batch response, or an SSE frame).
 *
 * Scoped by `eventId` so a snapshot can never be read back under a pairing
 * that belongs to a different event — `version` counters are per-event and
 * would otherwise be compared across events.
 */
export interface EventStateRecord {
  key: 'current';
  eventId: string;
  state: CompactEventState;
  updatedAtMs: number;
}

export interface MetaRecord {
  key: string;
  value: number | string;
}

/** The v1 shape, kept only so the migration can read what it must move. */
interface LegacyDeviceCacheRecord {
  key: string;
  bootstrap?: DeviceBootstrapResponse;
  lastState?: CompactEventState;
  updatedAtMs: number;
}

export class PaxFluxIndexedDB extends Dexie {
  outbox_actions!: Table<OutboxActionRecord, string>;
  device_config!: Table<DeviceConfigRecord, string>;
  event_state!: Table<EventStateRecord, string>;
  meta!: Table<MetaRecord, string>;

  constructor() {
    super('PaxFluxDB');

    // v1: a single `device_cache` table holding both the bootstrap config
    // and — under a *separate* key written by a different code path — the
    // last state seen over SSE. Two competing sources for one value.
    this.version(1).stores({
      outbox_actions: 'clientActionId, sequence, type, sendState, createdAtMs',
      device_cache: 'key',
      meta: 'key',
    });

    // v2: split the snapshot into a stable config and an authoritative
    // state, and give queued actions an owner. `device_cache` is still
    // declared here so the upgrade can read the rows it needs to move; v3
    // removes it once they have been copied.
    this.version(2)
      .stores({
        outbox_actions: 'clientActionId, sequence, type, sendState, createdAtMs, owner.deviceSessionId',
        device_cache: 'key',
        device_config: 'key',
        event_state: 'key',
        meta: 'key',
      })
      .upgrade(async (tx) => {
        // Queued actions written before this version carry no identity. The
        // device that happens to be paired now may or may not be the one
        // that made them, and there is no way to tell — so they are parked
        // for reconciliation, never adopted. Guessing here would attribute
        // real counts to the wrong door.
        await tx
          .table<OutboxActionRecord>('outbox_actions')
          .toCollection()
          .modify((row) => {
            if (!row.owner) {
              row.sendState = 'quarantined';
              row.lastErrorCode = OUTBOX_LOCAL_ERROR_CODES.OWNER_UNKNOWN;
              return;
            }
            // A row left mid-flight by an older build is an uncertain ACK,
            // not a lost action: idempotence makes a re-send safe.
            if (row.sendState === 'sending') {
              row.sendState = 'pending';
              row.lastErrorCode = OUTBOX_LOCAL_ERROR_CODES.UNCERTAIN_ACK;
            }
          });

        const legacyRows = await tx.table<LegacyDeviceCacheRecord>('device_cache').toArray();
        const bootstrapRow = legacyRows.find((row) => row.key === 'bootstrap_config');
        const eventId = bootstrapRow?.bootstrap?.event.id ?? null;

        if (bootstrapRow?.bootstrap) {
          await tx.table<DeviceConfigRecord>('device_config').put({
            key: 'current',
            bootstrap: bootstrapRow.bootstrap,
            updatedAtMs: bootstrapRow.updatedAtMs,
          });
        }

        // Pick the newest of the two competing sources by the authoritative
        // `version` counter, not by the local write time.
        if (eventId) {
          const candidates = legacyRows
            .map((row) => ({ state: row.lastState, updatedAtMs: row.updatedAtMs }))
            .filter((c): c is { state: CompactEventState; updatedAtMs: number } => Boolean(c.state));
          candidates.push(
            ...(bootstrapRow?.bootstrap
              ? [{ state: bootstrapRow.bootstrap.state, updatedAtMs: bootstrapRow.updatedAtMs }]
              : [])
          );

          let newest: { state: CompactEventState; updatedAtMs: number } | null = null;
          for (const candidate of candidates) {
            if (
              !newest ||
              candidate.state.version > newest.state.version ||
              (candidate.state.version === newest.state.version && candidate.updatedAtMs > newest.updatedAtMs)
            ) {
              newest = candidate;
            }
          }

          if (newest) {
            await tx.table<EventStateRecord>('event_state').put({
              key: 'current',
              eventId,
              state: newest.state,
              updatedAtMs: newest.updatedAtMs,
            });
          }
        }
      });

    // v3: the legacy table has been drained, so it can go. Data is moved
    // first and dropped second, never the other way round.
    this.version(3).stores({
      device_cache: null,
    });
  }
}

export const localDb = new PaxFluxIndexedDB();
