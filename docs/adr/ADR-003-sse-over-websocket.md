# ADR-003: Server-Sent Events (SSE) for Real-Time Distribution

## Status
Accepted

## Context
Clients (field counters and supervisor dashboards) need immediate real-time notifications of state changes (occupancy updates, event status transitions, device presence).
There are two primary real-time paradigms: WebSocket (bidirectional) and Server-Sent Events (SSE, unidirectional server-to-client).

## Decision
PaxFlux will use **Server-Sent Events (SSE)** for all real-time server-to-client notifications:
1. **Unidirectional Push:** Real-time updates flow exclusively from server to clients over standard HTTP `text/event-stream`.
2. **Mutations via HTTP POST/PATCH:** All counting actions, adjustments, and administrative state changes are sent via standard transactional HTTP endpoints.
3. **Reconnection & Snapshots:** Clients automatically reconnect via the browser's built-in `EventSource` semantics. Upon (re)connection, the server transmits a full authoritative compact state snapshot.
4. **Headers:** Endpoints respond with `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`, `Connection: keep-alive`, and `X-Accel-Buffering: no`.

## Consequences
### Positive
- Works seamlessly across all HTTP reverse proxies, CDNs, and Cloudflare Tunnels without custom WebSocket upgrade configurations.
- Leverages standard HTTP authentication (HttpOnly cookies), CSRF protections, and rate limiting.
- Clear separation of concerns: transactional mutations are auditable HTTP requests with exact HTTP status codes and error bodies; SSE is merely an invalidation/notification bus.
- Inherent connection recovery and simple client implementation.

### Negative
- SSE does not support client-to-server messaging on the same channel; this is an architectural benefit for PaxFlux, as all mutations belong in auditable HTTP transactions.
