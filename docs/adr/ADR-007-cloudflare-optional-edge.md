# ADR-007: Optional Cloudflare Edge / Reverse Proxy Layer

## Status
Accepted

## Context
Deploying PaxFlux at a festival may utilize Cloudflare Tunnel (cloudflared) or a reverse proxy (Caddy/Nginx) for public DNS routing, DDoS protection, and SSL termination.
However, hardcoding Cloudflare-specific dependencies into the application codebase would prevent purely offline local LAN deployments or self-hosted servers behind other reverse proxies.

## Decision
PaxFlux architecture is **strictly decoupled from Cloudflare and any proprietary edge infrastructure**:
1. **Application Core Independence:** The application core requires only standard HTTP/1.1 and TCP/IP networking.
2. **Reverse Proxy Trust:** Fastify `trustProxy` is configurable via the `TRUST_PROXY` environment variable (disabled by default, enabled when behind an authorized tunnel or reverse proxy).
3. **SSE Buffering Mitigation:** Endpoints include `Cache-Control: no-cache, no-transform` and `X-Accel-Buffering: no`. Deployment documentation provides instructions for configuring Cloudflare rules to disable response body buffering on `/stream` endpoints if needed.
4. **Standalone Operation:** PaxFlux functions fully in an isolated LAN environment (e.g. Wi-Fi router on site without Internet connection) with direct IP/DNS access.

## Consequences
### Positive
- Universal portability: works equally well on localhost, private LANs, Docker hosts, VPS, or behind Cloudflare Tunnels.
- Zero vendor lock-in.

### Negative
- Operators deploying behind Cloudflare must ensure their tunnel or Cloudflare Page Rules do not aggressively buffer long-lived SSE connections.
