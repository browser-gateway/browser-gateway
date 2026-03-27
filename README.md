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
- **Load Balancing** - Priority chain, round-robin, least-connections, latency-optimized
- **Cooldown System** - Automatically skip failing providers, recover after TTL
- **Health Checks** - Periodic connectivity probes detect unhealthy providers
- **Web Dashboard** - Built-in UI to manage providers, view sessions, edit config
- **Provider Management** - Add, edit, delete, and test providers from the dashboard
- **Config Editor** - Edit gateway.yml with syntax highlighting and validation
- **Auth** - Token-based auth with secure HttpOnly cookie for the dashboard
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

Open `http://localhost:9500/web` to see the dashboard. Or connect directly:

```typescript
import { chromium } from 'playwright-core';

// For Playwright run-server providers
const browser = await chromium.connect('ws://localhost:9500/v1/connect');

// For Chrome/CDP providers
const browser = await chromium.connectOverCDP('ws://localhost:9500/v1/connect');
```

If your primary provider goes down, traffic automatically routes to the fallback.

---

## Dashboard

Built-in web dashboard at `http://localhost:9500/web`:

- **Overview** - Active sessions, provider health, routing strategy
- **Providers** - Add, edit, delete, and test browser providers. Changes save to gateway.yml automatically
- **Sessions** - Live view of active browser connections with duration and message counts
- **Config** - Edit gateway.yml directly with syntax highlighting and validation
- **Logs** - Coming soon (check terminal output for now)

Dark theme by default with light theme toggle. Secured with HttpOnly cookie auth when `BG_TOKEN` is set.

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

---

## CLI

```bash
browser-gateway serve                    # Start the gateway + dashboard
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
| `/v1/providers` | GET | List configured providers |
| `/v1/providers` | POST | Add a new provider |
| `/v1/providers/:id` | PUT | Update a provider |
| `/v1/providers/:id` | DELETE | Remove a provider |
| `/v1/providers/:id/test` | POST | Test provider connectivity |
| `/v1/config` | GET | Read current config as YAML |
| `/v1/config` | PUT | Save config (with validation) |
| `/v1/config/validate` | POST | Validate YAML without saving |
| `/health` | GET | Simple health check |

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

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT - see [LICENSE](LICENSE) for details.

## Links

- Website: [browsergateway.io](https://browsergateway.io)
- GitHub: [github.com/browser-gateway/browser-gateway](https://github.com/browser-gateway/browser-gateway)
- npm: [npmjs.com/package/browser-gateway](https://www.npmjs.com/package/browser-gateway)
