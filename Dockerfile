# syntax=docker/dockerfile:1.7

# Stage 1: Build server
FROM node:22-slim@sha256:813a7480f28fdadac1f7f5c824bcdad435b5bc1322a5968bbbdef8d058f9dff4 AS builder
WORKDIR /app
ENV HUSKY=0
COPY package.json package-lock.json ./
RUN npm ci
COPY src/ src/
COPY tsconfig.json ./
RUN npm run build

# Stage 2: Build dashboard
FROM node:22-slim@sha256:813a7480f28fdadac1f7f5c824bcdad435b5bc1322a5968bbbdef8d058f9dff4 AS web-builder
WORKDIR /app/web
ENV HUSKY=0
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
# next.config.ts reads ../package.json at build time to bake the version
# into the dashboard sidebar, so the gateway's package.json must be present.
COPY package.json /app/package.json
RUN npm run build

# Stage 3: Production
FROM node:22-slim@sha256:813a7480f28fdadac1f7f5c824bcdad435b5bc1322a5968bbbdef8d058f9dff4
WORKDIR /app
ENV HUSKY=0

# tini as PID 1 — forwards SIGTERM cleanly so graceful shutdown works
# under Docker / Compose / Kubernetes.
RUN apt-get update && \
    apt-get install -y --no-install-recommends tini ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Non-root user
RUN addgroup --system --gid 1001 bguser && \
    adduser --system --uid 1001 bguser

# Production deps only. --ignore-scripts skips husky (dev-only).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# Build outputs
COPY --from=builder /app/dist ./dist
COPY --from=web-builder /app/web/dist ./web/dist

# Docs + example config (mounted config file overrides this)
COPY gateway.example.yml ./
COPY LICENSE README.md ./

# Default data directory. Override with -e BG_DATA_DIR=/somewhere/else.
# We create /data with the right ownership; the orchestrator decides
# whether to bind-mount a host dir, attach a named volume, or leave it
# ephemeral. No VOLUME directive — persistence is the operator's choice,
# matches n8n / Uptime Kuma convention.
ENV BG_DATA_DIR=/data
RUN mkdir -p /data && chown bguser:bguser /data

USER bguser

EXPOSE 9500

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:9500/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "node", "dist/server/index.js"]
CMD ["serve"]
