import { CompactEventState } from './offline-protocol.js';
import { EventStatus, SyncQuality } from './models.js';

export type SSEMessageType = 'state' | 'event-status' | 'device-status' | 'notice' | 'ping';

export interface SSEStateEvent {
  type: 'state';
  data: CompactEventState;
}

export interface SSEEventStatusEvent {
  type: 'event-status';
  data: {
    eventId: string;
    status: EventStatus;
    version: number;
    timestampMs: number;
  };
}

export interface SSEDeviceStatusEvent {
  type: 'device-status';
  data: {
    eventId: string;
    deviceSessionId: string;
    checkpointId: string;
    label: string;
    isOnline: boolean;
    lastSeenAtMs: number;
    pendingCount: number;
    syncQuality?: SyncQuality;
  };
}

export interface SSENoticeEvent {
  type: 'notice';
  data: {
    level: 'info' | 'warning' | 'error';
    message: string;
    timestampMs: number;
  };
}

export type SSERealtimeMessage =
  | SSEStateEvent
  | SSEEventStatusEvent
  | SSEDeviceStatusEvent
  | SSENoticeEvent;
