# Stage 1: Build server
FROM node:22-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY src/ src/
COPY tsconfig.json ./
RUN npm run build

# Stage 2: Build dashboard
FROM node:22-slim AS web-builder
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# Stage 3: Production
FROM node:22-slim
WORKDIR /app

# Security: non-root user
RUN addgroup --system --gid 1001 bguser && \
    adduser --system --uid 1001 bguser

# Production dependencies only
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Server build output
COPY --from=builder /app/dist ./dist

# Dashboard build output
COPY --from=web-builder /app/web/dist ./web/dist

# Config and docs
COPY gateway.example.yml ./
COPY LICENSE README.md ./

# Data directory for config persistence
RUN mkdir -p /data && chown bguser:bguser /data
VOLUME /data

# Switch to non-root
USER bguser

# Default port
EXPOSE 9500

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:9500/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

ENTRYPOINT ["node", "dist/server/index.js"]
CMD ["serve"]
