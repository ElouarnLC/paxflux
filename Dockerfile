# ==============================================================================
# PaxFlux Multi-Stage Production Dockerfile (Node.js 24 LTS Alpine)
# ==============================================================================

# --- Stage 1: Build TypeScript & Vite Assets ---
FROM node:24-alpine AS builder

WORKDIR /app

# Copy package manifests for workspace installation
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/

# Clean install all dependencies (including devDependencies needed for build)
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

# --- Stage 2: Production Dependencies Only ---
FROM node:24-alpine AS prod-deps

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/

# Install only runtime production dependencies without dev tools
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

# --- Stage 3: Production Minimal Runtime Image ---
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

# Copy production node_modules from prod-deps stage
COPY --chown=paxflux:paxflux --from=prod-deps /app/package.json ./
COPY --chown=paxflux:paxflux --from=prod-deps /app/node_modules ./node_modules
COPY --chown=paxflux:paxflux --from=prod-deps /app/packages/shared/package.json ./packages/shared/package.json
COPY --chown=paxflux:paxflux --from=prod-deps /app/apps/server/package.json ./apps/server/package.json

# Copy compiled artifacts from builder stage
COPY --chown=paxflux:paxflux --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --chown=paxflux:paxflux --from=builder /app/apps/server/dist ./apps/server/dist
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
