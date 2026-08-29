# ADR-006: Stateful Server Sessions in HttpOnly Cookies

## Status
Accepted

## Context
Storing JWTs or API bearer tokens in browser `localStorage` exposes credentials to Cross-Site Scripting (XSS) extraction and prevents instantaneous server-side session revocation.
Field counters require rapid pairing via QR codes without volunteer account credentials.

## Decision
PaxFlux implements **stateful, opaque session management using HttpOnly cookies**:
1. **Opaque Tokens:** Sessions are identified by 32-byte cryptographically random tokens (base64url).
2. **Server-Side Hash Storage:** Only `SHA-256(raw_token)` is persisted in SQLite (`staff_sessions` and `device_sessions`).
3. **Cookie Attributes:**
   - Production HTTPS: `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`, no `Domain`, prefix `__Host-`.
   - Localhost development: `HttpOnly`, `SameSite=Strict`, `Path=/`.
4. **Instant Revocation:** Revoking a device or logging out a staff member immediately sets `revoked_at_ms` in the database, instantly rejecting subsequent requests and closing associated SSE streams.
5. **CSRF Protection:** Synchronizer tokens are issued per session, stored hashed in `staff_sessions.csrf_hash`, and required via `X-CSRF-Token` header on state-changing staff endpoints, accompanied by Origin and Fetch-Metadata validation.
6. **QR Pairing Flow:** QR codes contain an invitation URL with a one-time secret in the **URL fragment** (`/pair#<secret>`). The client reads the fragment via JavaScript, strips it from browser history immediately via `history.replaceState()`, and exchanges it over POST for an HttpOnly device session cookie.

## Consequences
### Positive
- Immune to token theft via `localStorage` reading.
- Immediate revocation enforcement without waiting for JWT TTL expiration.
- QR secrets never leak into server access logs or HTTP Referer headers.

### Negative
- Requires server state lookup for each authenticated request (sub-millisecond in local SQLite).
