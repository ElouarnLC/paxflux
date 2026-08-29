import Dexie, { Table } from 'dexie';
import { OutboxActionRecord, CompactEventState, DeviceBootstrapResponse } from '@paxflux/shared';

export interface DeviceCacheRecord {
  key: string;
  bootstrap?: DeviceBootstrapResponse;
  lastState?: CompactEventState;
  updatedAtMs: number;
}

export interface MetaRecord {
  key: string;
  value: number | string;
}

export class PaxFluxIndexedDB extends Dexie {
  outbox_actions!: Table<OutboxActionRecord, string>;
  device_cache!: Table<DeviceCacheRecord, string>;
  meta!: Table<MetaRecord, string>;

  constructor() {
    super('PaxFluxDB');
    this.version(1).stores({
      outbox_actions: 'clientActionId, sequence, type, sendState, createdAtMs',
      device_cache: 'key',
      meta: 'key',
    });
  }
}

export const localDb = new PaxFluxIndexedDB();
