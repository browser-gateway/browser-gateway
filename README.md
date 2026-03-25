# browser-gateway

**The Unified Interface for Headless Browsers.**

Route connections across any browser backend with automatic failover, load balancing, and zero lock-in.

---

## What is this?

`browser-gateway` is an open-source proxy router for remote browser connections. You bring your own browser backends. We handle routing, failover, load balancing, health monitoring, and usage tracking.

```
Your cloud browser providers ---\
Your Playwright servers ---------+--->  browser-gateway  <--- Your app / AI agent
Your Chrome instances -----------+
Any CDP-compatible endpoint ----/
```

### The Problem

- **Vendor lock-in** - Coupled to one browser provider
- **No failover** - Provider goes down, your app breaks
- **Concurrency blindness** - No visibility into active sessions across backends
- **Wasted free tiers** - Can't pool multiple providers into one endpoint
- **Scaling cliff** - Outgrow one provider, re-architect everything

### The Solution

One endpoint. Configure your backends. We route intelligently.

```typescript
// Before: coupled to one provider
const browser = await chromium.connect('wss://provider.example.com?token=xxx');

// After: routed through browser-gateway with automatic failover
const browser = await chromium.connect('ws://localhost:3000/v1/connect');
```

---

## Features

- **Connection Routing** - Route WebSocket/CDP connections to the right backend
- **Automatic Failover** - Backend down? Next one instantly, zero client changes
- **Per-Backend Limits** - Set `maxConcurrent` per backend, gateway enforces it
- **Load Balancing** - Priority chain, round-robin, or least-connections
- **Cooldown System** - Automatically skip failing backends, recover after TTL
- **Health Monitoring** - Real-time backend status via API
- **Dashboard** - Built-in web UI for live visibility (enabled by default)
- **CLI** - `serve`, `check`, `status` commands
- **Protocol Agnostic** - Works with Playwright, Puppeteer, any WebSocket protocol

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

backends:
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

// For Playwright run-server backends
const browser = await chromium.connect('ws://localhost:3000/v1/connect');

// For Chrome/CDP backends
const browser = await chromium.connectOverCDP('ws://localhost:3000/v1/connect');

const page = await browser.newPage();
await page.goto('https://example.com');
console.log(await page.title());
await browser.close();
```

That's it. If your primary backend goes down, traffic automatically routes to the fallback.

---

## Zero-Config Start

No config file needed. Set one environment variable:

```bash
BG_BACKEND_URL=ws://localhost:4000 browser-gateway serve
```

---

## Authentication

Set `BG_TOKEN` to require a token for all connections:

```bash
BG_TOKEN=my-secret-token browser-gateway serve
```

Clients include the token:

```typescript
const browser = await chromium.connect('ws://localhost:3000/v1/connect?token=my-secret-token');
```

---

## CLI

```bash
browser-gateway serve                    # Start the gateway
browser-gateway serve --port 8080        # Custom port
browser-gateway serve --config path.yml  # Custom config
browser-gateway check                    # Test backend connectivity
browser-gateway version                  # Print version
browser-gateway help                     # Show help
```

---

## API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/connect` | WebSocket | Connect to a browser (the core feature) |
| `/v1/status` | GET | Gateway health + backend status |
| `/v1/sessions` | GET | Active sessions |
| `/health` | GET | Simple health check |

### GET /v1/status

```json
{
  "status": "ok",
  "activeSessions": 7,
  "strategy": "priority-chain",
  "backends": [
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
  -p 3000:3000 \
  -v ./gateway.yml:/app/gateway.yml:ro \
  -e PROVIDER_TOKEN=xxx \
  ghcr.io/browser-gateway/server:latest
```

---

## How It Works

1. Client connects to `ws://gateway:3000/v1/connect`
2. Gateway selects a backend (priority, health, capacity)
3. Gateway opens a raw TCP connection to the backend
4. HTTP upgrade request is forwarded to the backend
5. Backend responds with `101 Switching Protocols`
6. Bidirectional TCP pipe established: `client <-> gateway <-> backend`
7. All WebSocket messages forwarded transparently
8. On disconnect: session cleaned up, metrics updated

The gateway never parses or modifies WebSocket messages. It's a transparent pipe with smart routing.

---

## Documentation

- [Getting Started](./docs/getting-started.md)
- [Configuration Reference](./docs/configuration.md)
- [How Failover Works](./docs/failover.md)
- [Load Balancing Strategies](./docs/load-balancing.md)
- [Supported Backends](./docs/backends.md)
- [Session Lifecycle](./docs/session-lifecycle.md)
- [CLI Reference](./docs/cli.md)
- [Docker Deployment](./docs/docker.md)

---

## Roadmap

- [x] WebSocket proxy with failover
- [x] Per-backend concurrency limits
- [x] TTL-based cooldown system
- [x] Load balancing strategies
- [x] CLI (serve, check)
- [x] Status API
- [ ] Web dashboard
- [ ] Quota tracking (monthly usage limits)
- [ ] Webhook notifications
- [ ] Pre-connect hooks (for providers needing session creation)
- [ ] REST convenience endpoints (screenshot, content, PDF)
- [ ] Multi-instance support (Redis)
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
