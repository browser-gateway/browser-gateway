# Docker Deployment

Run browser-gateway in Docker for production deployments.

## Quick Start

```bash
docker run -d \
  --name browser-gateway \
  -p 3000:3000 \
  -v ./gateway.yml:/app/gateway.yml:ro \
  -e PROVIDER_TOKEN=your-token \
  ghcr.io/browser-gateway/server:latest
```

## Docker Compose

```yaml
services:
  browser-gateway:
    image: ghcr.io/browser-gateway/server:latest
    ports:
      - "3000:3000"
    volumes:
      - ./gateway.yml:/app/gateway.yml:ro
    environment:
      - PROVIDER_TOKEN=${PROVIDER_TOKEN}
      - BG_TOKEN=${BG_TOKEN}
    restart: unless-stopped
```

## Zero-Config Docker

No config file needed for single-backend setups:

```bash
docker run -d \
  --name browser-gateway \
  -p 3000:3000 \
  -e BG_BACKEND_URL=ws://your-backend:3000 \
  -e BG_TOKEN=my-secret \
  ghcr.io/browser-gateway/server:latest
```

## Configuration in Docker

### Option 1: Mount a config file

```bash
-v ./gateway.yml:/app/gateway.yml:ro
```

Secrets in the config use `${ENV_VAR}` references. Pass the actual values as environment variables:

```bash
-e PROVIDER_TOKEN=xxx -e BACKUP_KEY=yyy
```

### Option 2: Environment variables only

```bash
-e BG_BACKEND_URL=ws://backend:3000
-e BG_PORT=3000
-e BG_TOKEN=my-secret
```

## Networking

The gateway needs to reach your browser backends. Common patterns:

### Backends on the same Docker network

```yaml
services:
  browser-gateway:
    image: ghcr.io/browser-gateway/server:latest
    ports: ["3000:3000"]
    volumes:
      - ./gateway.yml:/app/gateway.yml:ro

  playwright:
    image: mcr.microsoft.com/playwright:v1.50.1-noble
    command: npx -y playwright@1.50.1 run-server --port 3000 --host 0.0.0.0
    shm_size: '1gb'
```

Config:
```yaml
backends:
  playwright:
    url: ws://playwright:3000
```

### Backends on the host machine

Use `host.docker.internal` (Docker Desktop) or `--network host` (Linux):

```yaml
backends:
  local-chrome:
    url: ws://host.docker.internal:9222/devtools/browser/UUID
```

### External backends (cloud)

No special networking needed:

```yaml
backends:
  cloud-provider:
    url: wss://provider.example.com?token=${PROVIDER_TOKEN}
```

## Health Checks

```yaml
services:
  browser-gateway:
    image: ghcr.io/browser-gateway/server:latest
    healthcheck:
      test: ["CMD", "wget", "--spider", "-q", "http://localhost:3000/health"]
      interval: 10s
      timeout: 5s
      retries: 3
```

## Updating

```bash
docker compose pull
docker compose up -d
```

The gateway starts immediately. No migrations needed (all state is in-memory in v1).
