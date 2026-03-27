# browser-gateway

**The Unified Interface for Headless Browsers.**

Route connections across any browser provider with automatic failover, load balancing, and zero lock-in.

---

## What is this?

`browser-gateway` is an open-source proxy router for remote browser connections. You bring your own browser providers. We handle routing, failover, load balancing, health monitoring, and usage tracking.

```
Your cloud browser providers ---\
Your Playwright servers ---------+--->  browser-gateway  <--- Your app / AI agent
Your Chrome instances -----------+
Any CDP-compatible endpoint ----/
```

### The Problem

- **Vendor lock-in** - Coupled to one browser provider
- **No failover** - Provider goes down, your app breaks
- **Concurrency blindness** - No visibility into active sessions across providers
- **Wasted free tiers** - Can't pool multiple providers into one endpoint
- **Scaling cliff** - Outgrow one provider, re-architect everything

### The Solution

One endpoint. Configure your providers. We route intelligently.

```typescript
// Before: coupled to one provider
const browser = await chromium.connect('wss://provider.example.com?token=xxx');

// After: routed through browser-gateway with automatic failover
const browser = await chromium.connect('ws://localhost:9500/v1/connect');
```

---

## Features

- **Connection Routing** - Route WebSocket/CDP connections to the right provider
- **Automatic Failover** - Provider down? Next one instantly, zero client changes
- **Per-Provider Limits** - Set `maxConcurrent` per provider, gateway enforces it
- **Load Balancing** - Priority chain, round-robin, or least-connections
- **Cooldown System** - Automatically skip failing providers, recover after TTL
- **Status API** - Real-time provider health, active sessions, and metrics
- **Auth** - Optional token-based auth for all endpoints
- **CLI** - `serve`, `check`, `version`, `help`
- **Protocol Agnostic** - Works with Playwright, Puppeteer, any WebSocket protocol
- **ws:// and wss://** - Supports both plain and TLS providers

---

## Quick Start

### Install

```bash
npm install -g browser-gateway
```

### Configure

Create a `gateway.yml`:

```yaml
version: 1

providers:
  primary:
    url: wss://provider.example.com?token=${PROVIDER_TOKEN}
    limits:
      maxConcurrent: 5
    priority: 1

  fallback:
    url: ws://my-playwright-server:4000
    limits:
      maxConcurrent: 10
    priority: 2
```

### Run

```bash
browser-gateway serve
```

### Connect

```typescript
import { chromium } from 'playwright-core';

// For Playwright run-server providers
const browser = await chromium.connect('ws://localhost:9500/v1/connect');

// For Chrome/CDP providers
const browser = await chromium.connectOverCDP('ws://localhost:9500/v1/connect');

const page = await browser.newPage();
await page.goto('https://example.com');
console.log(await page.title());
await browser.close();
```

That's it. If your primary provider goes down, traffic automatically routes to the fallback.

---

---

## Authentication

Set `BG_TOKEN` to require a token (or put it in a `.env` file):

```bash
BG_TOKEN=my-secret-token browser-gateway serve
```

- **WebSocket clients** pass the token as `?token=` query param
- **API clients** use `Authorization: Bearer <token>` header
- **Dashboard** shows a login form, sets a secure HttpOnly cookie
- **Health endpoint** (`/health`) is always public

```typescript
const browser = await chromium.connect('ws://localhost:9500/v1/connect?token=my-secret-token');
```

---

## Dashboard

Built-in web dashboard at `/web`:

```
http://localhost:9500/web
```

Shows real-time provider health, active sessions, connection metrics, and cooldown status. Dark theme by default with light theme toggle.

---

## CLI

```bash
browser-gateway serve                    # Start the gateway
browser-gateway serve --port 8080        # Custom port
browser-gateway serve --config path.yml  # Custom config
browser-gateway check                    # Test provider connectivity
browser-gateway version                  # Print version
browser-gateway help                     # Show help
```

---

## API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/connect` | WebSocket | Connect to a browser (the core feature) |
| `/v1/status` | GET | Gateway health + provider status |
| `/v1/sessions` | GET | Active sessions |
| `/health` | GET | Simple health check |

### GET /v1/status

```json
{
  "status": "ok",
  "activeSessions": 7,
  "strategy": "priority-chain",
  "providers": [
    {
      "id": "primary",
      "healthy": true,
      "active": 4,
      "maxConcurrent": 5,
      "cooldownUntil": null,
      "avgLatencyMs": 340,
      "totalConnections": 1247,
      "priority": 1
    },
    {
      "id": "fallback",
      "healthy": true,
      "active": 3,
      "maxConcurrent": 10,
      "cooldownUntil": null,
      "avgLatencyMs": 12,
      "totalConnections": 893,
      "priority": 2
    }
  ]
}
```

---

## Docker

```bash
docker run -d \
  -p 9500:9500 \
  -v ./gateway.yml:/app/gateway.yml:ro \
  -e PROVIDER_TOKEN=xxx \
  ghcr.io/browser-gateway/server:latest
```

---

## How It Works

1. Client connects to `ws://gateway:9500/v1/connect`
2. Gateway selects a provider (priority, health, capacity)
3. Gateway opens a raw TCP connection to the provider
4. HTTP upgrade request is forwarded to the provider
5. Provider responds with `101 Switching Protocols`
6. Bidirectional TCP pipe established: `client <-> gateway <-> provider`
7. All WebSocket messages forwarded transparently
8. On disconnect: session cleaned up, metrics updated

The gateway never parses or modifies WebSocket messages. It's a transparent pipe with smart routing.

---

## Documentation

- [Getting Started](./docs/getting-started.md)
- [Configuration Reference](./docs/configuration.md)
- [How Failover Works](./docs/failover.md)
- [Load Balancing Strategies](./docs/load-balancing.md)
- [Supported Providers](./docs/providers.md)
- [Session Lifecycle](./docs/session-lifecycle.md)
- [CLI Reference](./docs/cli.md)
- [Docker Deployment](./docs/docker.md)

---

## Roadmap

### Shipped (v0.1.x)
- [x] WebSocket proxy with automatic failover
- [x] Per-provider concurrency limits
- [x] TTL-based cooldown system
- [x] Load balancing (priority-chain, round-robin, least-connections, latency-optimized)
- [x] ws:// and wss:// (TLS) provider support
- [x] Token-based auth (WebSocket + HTTP API + dashboard cookie)
- [x] Web dashboard with login, real-time status, sessions
- [x] Health check probes (periodic provider connectivity)
- [x] Status and sessions API
- [x] Idle session timeout
- [x] .env auto-loading
- [x] CLI (serve, check, version)
- [x] Zero-config mode (starts with no providers, shows setup guide)

### Next
- [ ] `browser-gateway init` (interactive config generator)
- [ ] Docker image on GHCR

### Planned
- [ ] Quota tracking (monthly usage limits per provider)
- [ ] Webhook notifications (provider down, quota warnings)
- [ ] Pre-connect hooks (for providers needing session creation)
- [ ] Config hot-reload (apply changes without restart)
- [ ] REST convenience endpoints (screenshot, content, PDF)
- [ ] Multi-instance support (Redis shared state)
- [ ] OpenTelemetry integration

---

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT - see [LICENSE](LICENSE) for details.

## Links

- Website: [browsergateway.io](https://browsergateway.io)
- GitHub: [github.com/browser-gateway/browser-gateway](https://github.com/browser-gateway/browser-gateway)
- npm: [npmjs.com/package/browser-gateway](https://www.npmjs.com/package/browser-gateway)
