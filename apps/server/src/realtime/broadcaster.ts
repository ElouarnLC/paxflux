import { FastifyReply } from 'fastify';
import { CompactEventState, SSERealtimeMessage } from '@paxflux/shared';
import { SSE_COALESCE_WINDOW_MS, SSE_HEARTBEAT_INTERVAL_MS } from '@paxflux/shared';

interface SSEClient {
  id: string;
  eventId: string;
  isStaff: boolean;
  deviceSessionId?: string;
  reply: FastifyReply;
}

class RealtimeBroadcaster {
  private clients: Map<string, SSEClient> = new Map();
  private pendingStateBroadcasts: Map<string, { state: CompactEventState; timer: NodeJS.Timeout | null }> = new Map();
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.startHeartbeat();
  }

  public registerClient(client: SSEClient) {
    this.clients.set(client.id, client);

    client.reply.raw.on('close', () => {
      this.removeClient(client.id);
    });
  }

  public removeClient(clientId: string) {
    this.clients.delete(clientId);
  }

  public getConnectedClientCount(eventId?: string): number {
    if (!eventId) return this.clients.size;
    let count = 0;
    for (const c of this.clients.values()) {
      if (c.eventId === eventId) count++;
    }
    return count;
  }

  /**
   * Broadcast state changes with coalescing window (50-100ms) to avoid flooding under tap bursts
   */
  public broadcastState(eventId: string, state: CompactEventState) {
    const existing = this.pendingStateBroadcasts.get(eventId);
    if (existing?.timer) {
      clearTimeout(existing.timer);
    }

    const timer = setTimeout(() => {
      this.flushStateBroadcast(eventId, state);
    }, SSE_COALESCE_WINDOW_MS);

    this.pendingStateBroadcasts.set(eventId, { state, timer });
  }

  private flushStateBroadcast(eventId: string, state: CompactEventState) {
    this.pendingStateBroadcasts.delete(eventId);
    const payload = `event: state\ndata: ${JSON.stringify(state)}\n\n`;

    for (const client of this.clients.values()) {
      if (client.eventId === eventId && !client.reply.raw.destroyed) {
        try {
          client.reply.raw.write(payload);
        } catch {
          this.removeClient(client.id);
        }
      }
    }
  }

  public broadcastMessage(eventId: string, message: SSERealtimeMessage) {
    const payload = `event: ${message.type}\ndata: ${JSON.stringify(message.data)}\n\n`;

    for (const client of this.clients.values()) {
      if (client.eventId === eventId && !client.reply.raw.destroyed) {
        try {
          client.reply.raw.write(payload);
        } catch {
          this.removeClient(client.id);
        }
      }
    }
  }

  public sendToClient(clientId: string, eventName: string, data: unknown) {
    const client = this.clients.get(clientId);
    if (client && !client.reply.raw.destroyed) {
      try {
        client.reply.raw.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
        this.removeClient(clientId);
      }
    }
  }

  private startHeartbeat() {
    this.heartbeatTimer = setInterval(() => {
      const ping = ':ping\n\n';
      for (const [id, client] of this.clients.entries()) {
        if (client.reply.raw.destroyed) {
          this.removeClient(id);
        } else {
          try {
            client.reply.raw.write(ping);
          } catch {
            this.removeClient(id);
          }
        }
      }
    }, SSE_HEARTBEAT_INTERVAL_MS);
  }

  public closeAllForEvent(eventId: string) {
    for (const [id, client] of this.clients.entries()) {
      if (client.eventId === eventId) {
        try {
          client.reply.raw.end();
        } catch {
          // ignore
        }
        this.removeClient(id);
      }
    }
  }

  public destroy() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    for (const client of this.clients.values()) {
      try {
        client.reply.raw.end();
      } catch {
        // ignore
      }
    }
    this.clients.clear();
  }
}

export const broadcaster = new RealtimeBroadcaster();
