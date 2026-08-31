import Dexie, { Table } from 'dexie';
import {
  OutboxActionRecord,
  CompactEventState,
  ConfirmedActionRecord,
  DeviceBootstrapResponse,
  EventStatus,
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
  /**
   * Latest lifecycle status seen for this event, and the server timestamp
   * that carried it.
   *
   * Kept apart from `state.eventStatus` because a lifecycle transition does
   * **not** bump `event.version`: a `state` frame minted before the
   * transition carries the same version and would otherwise look equally
   * fresh. Comparing server timestamps is what makes `live → closing`
   * survive a reload, and what stops a late in-flight response from
   * resurrecting `live`.
   */
  lifecycleStatus?: EventStatus;
  lifecycleAtMs?: number;
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
  confirmed_actions!: Table<ConfirmedActionRecord, string>;
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

        if (bootstrapRow?.bootstrap) {
          await tx.table<DeviceConfigRecord>('device_config').put({
            key: 'current',
            bootstrap: bootstrapRow.bootstrap,
            updatedAtMs: bootstrapRow.updatedAtMs,
          });
        }

        // The v1 cache stored a state under its own key with no event id
        // attached, so a device that had been paired to an earlier event
        // could be carrying that event's state — with a *higher* version,
        // since version counters are per-event and mean nothing across
        // them. Taking the highest version and stamping the current
        // event's id on it would show one event's occupancy under another.
        //
        // Provenance is checked instead, and it is provable: space ids are
        // UUIDs, so a state that contains both of this pairing's checkpoint
        // endpoints belongs to this pairing's event. Anything unproven is
        // discarded in favour of the bootstrap's own state, which is known
        // to belong to it.
        if (bootstrapRow?.bootstrap) {
          const bootstrap = bootstrapRow.bootstrap;
          const belongsToThisEvent = (state: CompactEventState): boolean => {
            const ids = new Set(state.spaces.map((space) => space.id));
            return ids.has(bootstrap.checkpoint.spaceAId) && ids.has(bootstrap.checkpoint.spaceBId);
          };

          const candidates: Array<{ state: CompactEventState; updatedAtMs: number }> = [
            { state: bootstrap.state, updatedAtMs: bootstrapRow.updatedAtMs },
          ];
          for (const row of legacyRows) {
            if (row.lastState && belongsToThisEvent(row.lastState)) {
              candidates.push({ state: row.lastState, updatedAtMs: row.updatedAtMs });
            } else if (row.lastState) {
              console.debug(
                `Discarding a legacy cached state whose provenance could not be proven (key: ${row.key})`
              );
            }
          }

          let newest = candidates[0];
          for (const candidate of candidates) {
            if (
              candidate.state.version > newest.state.version ||
              (candidate.state.version === newest.state.version &&
                candidate.state.serverTimeMs > newest.state.serverTimeMs)
            ) {
              newest = candidate;
            }
          }

          await tx.table<EventStateRecord>('event_state').put({
            key: 'current',
            eventId: bootstrap.event.id,
            state: newest.state,
            updatedAtMs: newest.updatedAtMs,
          });
        }
      });

    // v3: the legacy table has been drained, so it can go. Data is moved
    // first and dropped second, never the other way round.
    this.version(3).stores({
      device_cache: null,
    });

    // v4: a small ring of acknowledged counts, so undo survives the
    // acknowledgment that removes the action from the outbox (SPEC §11.2).
    this.version(4).stores({
      confirmed_actions: 'clientActionId, confirmedAtMs, owner.deviceSessionId',
    });
  }
}

export const localDb = new PaxFluxIndexedDB();
