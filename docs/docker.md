# Docker Deployment

Run browser-gateway in Docker for production deployments.

## Quick Start

```bash
docker run -d \
  --name browser-gateway \
  -p 9500:9500 \
  -v ./gateway.yml:/app/gateway.yml:ro \
  -e PROVIDER_TOKEN=your-token \
  -e BG_TOKEN=your-gateway-secret \
  ghcr.io/browser-gateway/server:latest
```

Open `http://localhost:9500/web` to access the dashboard.

## Docker Compose

```yaml
services:
  browser-gateway:
    image: ghcr.io/browser-gateway/server:latest
    ports:
      - "9500:9500"
    volumes:
      - ./gateway.yml:/app/gateway.yml:ro
    environment:
      - PROVIDER_TOKEN=${PROVIDER_TOKEN}
      - BG_TOKEN=${BG_TOKEN}
    restart: unless-stopped
```

See `examples/docker-compose.yml` in the repo for a ready-to-use template.

## No Config File

The gateway starts without a config file. You can add providers through the dashboard UI at `/web/providers`.

```bash
docker run -d \
  --name browser-gateway \
  -p 9500:9500 \
  ghcr.io/browser-gateway/server:latest
```

## Configuration

### Mount a config file

```bash
-v ./gateway.yml:/app/gateway.yml:ro
```

Secrets in the config use `${ENV_VAR}` references. Pass the actual values as environment variables:

```bash
-e PROVIDER_TOKEN=xxx -e BACKUP_KEY=yyy
```

### Environment variables

| Variable | Description |
|----------|-------------|
| `BG_TOKEN` | Auth token for gateway access |
| `BG_PORT` | Server port (default: 9500) |
| `BG_CONFIG_PATH` | Path to config file (default: ./gateway.yml) |

## Networking

The gateway needs to reach your browser providers.

### Providers on the same Docker network

```yaml
services:
  browser-gateway:
    image: ghcr.io/browser-gateway/server:latest
    ports: ["9500:9500"]
    volumes:
      - ./gateway.yml:/app/gateway.yml:ro

  playwright:
    image: mcr.microsoft.com/playwright:v1.50.1-noble
    command: npx -y playwright@1.50.1 run-server --port 3000 --host 0.0.0.0
    shm_size: '1gb'
```

Config:
```yaml
providers:
  playwright:
    url: ws://playwright:3000
```

### Providers on the host machine

Use `host.docker.internal` (Docker Desktop) or `--network host` (Linux):

```yaml
providers:
  local-chrome:
    url: ws://host.docker.internal:9222/devtools/browser/UUID
```

### External providers (cloud)

No special networking needed:

```yaml
providers:
  cloud-provider:
    url: wss://provider.example.com?token=${PROVIDER_TOKEN}
```

## Health Check

The Docker image has a built-in health check that polls `/health` every 30 seconds.

```bash
docker inspect browser-gateway --format='{{.State.Health.Status}}'
```

## Updating

```bash
docker compose pull
docker compose up -d
```

The gateway starts immediately. No migrations needed (all state is in-memory).

## Image Details

| Property | Value |
|----------|-------|
| Registry | `ghcr.io/browser-gateway/server` |
| Base image | `node:22-slim` |
| Size | ~370MB |
| User | Non-root (`bguser`) |
| Port | 9500 |
| Health check | Built-in (30s interval) |
