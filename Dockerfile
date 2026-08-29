# ==============================================================================
# PaxFlux Multi-Stage Production Dockerfile (Node.js 24 LTS Alpine)
# ==============================================================================

# --- Stage 1: Build Dependencies & Compile TypeScript / React Assets ---
FROM node:24-alpine AS builder

WORKDIR /app

# Install build prerequisites
RUN apk add --no-cache python3 make g++

# Copy package manifests for workspace caching
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/

# Clean install all dependencies (including dev dependencies)
RUN npm ci

# Copy source tree
COPY packages/shared ./packages/shared
COPY apps/server ./apps/server
COPY apps/web ./apps/web
COPY drizzle ./drizzle
COPY drizzle.config.ts ./
COPY tsconfig.base.json ./

# Build shared library, server, and web PWA bundle
RUN npm run build

# Prune dev dependencies for lean production image
RUN npm prune --production

# --- Stage 2: Production Minimal Runtime Image ---
FROM node:24-alpine AS runner

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    BACKUP_DIR=/backups

WORKDIR /app

# Create dedicated non-root service user and persistent volume directories
RUN addgroup -g 10001 -S paxflux && \
    adduser -u 10001 -S paxflux -G paxflux && \
    mkdir -p /data /backups /app && \
    chown -R paxflux:paxflux /data /backups /app

# Copy production artifacts from builder
COPY --chown=paxflux:paxflux --from=builder /app/package.json ./
COPY --chown=paxflux:paxflux --from=builder /app/node_modules ./node_modules
COPY --chown=paxflux:paxflux --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --chown=paxflux:paxflux --from=builder /app/packages/shared/package.json ./packages/shared/package.json
COPY --chown=paxflux:paxflux --from=builder /app/apps/server/dist ./apps/server/dist
COPY --chown=paxflux:paxflux --from=builder /app/apps/server/package.json ./apps/server/package.json
COPY --chown=paxflux:paxflux --from=builder /app/apps/web/dist ./apps/web/dist
COPY --chown=paxflux:paxflux --from=builder /app/drizzle ./drizzle

# Switch to non-root user
USER paxflux

# Expose standard port
EXPOSE 3000

# Persistent volume mounts
VOLUME ["/data", "/backups"]

# Healthcheck probe
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health/ready || exit 1

# Launch single-process application server
CMD ["node", "apps/server/dist/server.js"]
