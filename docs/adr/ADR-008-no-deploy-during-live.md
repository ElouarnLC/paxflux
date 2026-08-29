# ADR-008: Operational Policy: No Live Deployments & Controlled Service Worker Updates

## Status
Accepted

## Context
During a live festival with active counting, restarting the backend container or aggressively forcing service worker updates can cause client disruptions, failed in-flight requests, cache thrashing, and volunteer confusion.

## Decision
1. **Operational Freeze:** No software deployments or schema migrations may take place while any event is in `live` or `closing` state.
2. **PWA Service Worker Policy:**
   - The service worker caches static hashed assets (cache-first) and HTML (network-first with cache fallback).
   - The service worker never intercepts or caches write API requests (`/api/v1/device/actions/batch`, `/api/v1/auth/*`, etc.).
   - When a new version is detected, the PWA displays a non-blocking *"Mise à jour disponible"* banner. It **never** calls `skipWaiting()` or auto-reloads active client tabs automatically during active operations.
3. **Closing Drain State:** Before closing an event, it transitions from `live` to `closing`. This disables new taps on connected counters while keeping synchronization endpoints open so offline devices returning within range can safely drain their outboxes before the event is permanently closed.

## Consequences
### Positive
- Maximum field stability and volunteer trust during the event.
- Zero risk of in-flight count data loss caused by unexpected browser reloads or container restarts.

### Negative
- Emergency hotfixes require either a brief scheduled pause or executing a documented manual supervisor adjustment.
