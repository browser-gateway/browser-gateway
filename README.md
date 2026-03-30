# browser-gateway

**Reliable, scalable browser infrastructure for AI agents and automation.**

Route, pool, and failover across any browser provider. Built-in MCP server for AI agents.

---

## What It Does

```
                         ┌─────────────────────┐
                         │   browser-gateway    │
                         │                      │
                         │  routing / failover  │
                         │  load balancing      │
                         │  health monitoring   │
                         │  request queuing     │
                         └──────────┬───────────┘
                                    │
                 ┌──────────────────┼──────────────────┐
                 │                  │                   │
          ┌──────┴──────┐   ┌──────┴──────┐   ┌───────┴──────┐
          │ Provider A  │   │ Provider B  │   │ Provider C   │
          │ Cloud CDP   │   │ Playwright  │   │ Local Chrome │
          │ priority: 1 │   │ Docker :4000│   │ Docker :9222 │
          └─────────────┘   └─────────────┘   └──────────────┘
```

One endpoint. Multiple providers. Automatic failover if one goes down.

Your app connects to `ws://gateway:9500/v1/connect`. The gateway picks the best available provider based on health, capacity, and your routing strategy. Providers can be cloud CDP services, Docker containers, or local Chrome instances.

---

## Core Features

### Routing & Reliability

- **Automatic Failover** - Provider down? Next one picks up instantly. Zero client changes.
- **5 Load Balancing Strategies** - Priority chain, round-robin, least-connections, latency-optimized, weighted
- **Per-Provider Concurrency Limits** - Set `maxConcurrent` per provider, gateway enforces it
- **Request Queue** - All providers busy? Connections wait instead of failing
- **Cooldown System** - Skip failing providers automatically, recover after TTL
- **Health Checks** - Periodic connectivity probes detect unhealthy providers
- **Graceful Shutdown** - Active sessions drain cleanly on SIGTERM/SIGINT
- **Webhooks** - Get notified when providers go down, recover, or queue overflows

### MCP Server for AI Agents

- **8 Browser Tools** - navigate, snapshot, screenshot, viewport, interact, evaluate, close, status
- **Zero Config** - Auto-detects Chrome, launches on first tool use
- **Concurrent Sessions** - Multiple agents get separate browsers, no conflicts
- **Raw CDP** - Lightweight, no Playwright or Puppeteer dependency
- **Works with** Claude Code, Cursor, and any MCP-compatible client

### Management

- **Web Dashboard** - Manage providers, view sessions, edit config from the browser
- **Provider CRUD** - Add, edit, delete, and test providers from the dashboard or API
- **Config Editor** - Edit gateway.yml with syntax highlighting and validation
- **Auth** - Token-based with secure HttpOnly cookie for the dashboard
- **Protocol Agnostic** - Works with Playwright, Puppeteer, any WebSocket protocol

---

## Quick Start

### As a WebSocket Proxy (for applications)

```bash
npm install -g browser-gateway
```

Create `gateway.yml`:

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

```bash
browser-gateway serve
```

Connect from your app:

```typescript
// For CDP providers
const browser = await chromium.connectOverCDP('ws://localhost:9500/v1/connect');

// For Playwright run-server providers
const browser = await chromium.connect('ws://localhost:9500/v1/connect');
```

Dashboard at `http://localhost:9500/web`.

### As an MCP Server (for AI agents)

Add to your Claude Code or Cursor config:

```json
{
  "mcpServers": {
    "browser-gateway": {
      "command": "npx",
      "args": ["browser-gateway", "mcp"]
    }
  }
}
```

No config files needed. The agent can now browse websites, take screenshots, fill forms, and extract data.

See the [MCP documentation](docs/mcp.md) for all options.

---

## Dashboard

Built-in web dashboard at `http://localhost:9500/web`. Served from the same port as the gateway.

| Page | What You Can Do |
|------|----------------|
| **Overview** | Gateway health at a glance: active sessions, provider status, connection endpoint |
| **Providers** | Add, edit, delete, and test browser providers. Changes write to gateway.yml |
| **Sessions** | Live table of every active connection: provider, duration, message count |
| **Config** | Edit gateway.yml in the browser with validation and automatic backups |

If `BG_TOKEN` is set, the dashboard requires authentication via a secure HttpOnly cookie.

See [Dashboard Guide](./docs/dashboard.md) for details.

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
# Proxy server
browser-gateway serve                    # Start the gateway + dashboard
browser-gateway serve --port 8080        # Custom port
browser-gateway serve --config path.yml  # Custom config

# MCP server for AI agents
browser-gateway mcp                      # Auto-detect Chrome, zero config
browser-gateway mcp --headless           # Headless mode (for CI/Docker)
browser-gateway mcp --cdp-endpoint ws:// # Connect to existing browser
browser-gateway mcp --config gateway.yml # Multi-provider with failover

# Utilities
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
| `/v1/providers` | GET/POST | List or add providers |
| `/v1/providers/:id` | PUT/DELETE | Update or remove a provider |
| `/v1/providers/:id/test` | POST | Test provider connectivity |
| `/v1/config` | GET/PUT | Read or save config |
| `/v1/config/validate` | POST | Validate YAML without saving |
| `/mcp` | POST | MCP Streamable HTTP endpoint |
| `/json/version` | GET | CDP discovery (for browser-use, Playwright, Stagehand) |
| `/health` | GET | Health check |

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
2. Gateway selects a provider using your [routing strategy](./docs/load-balancing.md)
3. Gateway opens a raw TCP connection to the provider
4. HTTP upgrade forwarded, provider responds with `101 Switching Protocols`
5. Bidirectional TCP pipe: `client <-> gateway <-> provider`
6. All WebSocket messages forwarded transparently (never parsed or modified)
7. On disconnect: session cleaned up, slot released, metrics updated
8. If all providers full: connection [waits in a queue](./docs/request-queue.md) until a slot opens

---

## Works With

browser-gateway is compatible with existing browser tools. Just pass the gateway URL — it auto-resolves via `/json/version`.

**AI Agent Frameworks:**

```python
# browser-use (Python) — HTTP URL auto-resolves
BrowserSession(cdp_url="http://localhost:9500")
```

```typescript
// Stagehand (TypeScript)
new Stagehand({ env: "LOCAL", localBrowserLaunchOptions: { cdpUrl: "http://localhost:9500" } })
```

**Playwright MCP** (all 70 Playwright tools through gateway routing):

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp@latest", "--cdp-endpoint", "http://localhost:9500"]
    }
  }
}
```

**Puppeteer / Playwright:**

```typescript
// Playwright — HTTP or WebSocket
const browser = await chromium.connectOverCDP("http://localhost:9500");

// Puppeteer — WebSocket
const browser = await puppeteer.connect({ browserWSEndpoint: "ws://localhost:9500/v1/connect" });
```

---

## Documentation

- [MCP Server for AI Agents](./docs/mcp.md) - Setup, tools, options
- [Integrations](./docs/integrations.md) - Playwright, Puppeteer, browser-use, Stagehand, Playwright MCP
- [Getting Started](./docs/getting-started.md)
- [Configuration Reference](./docs/configuration.md)
- [How Failover Works](./docs/failover.md)
- [Load Balancing Strategies](./docs/load-balancing.md)
- [Request Queue](./docs/request-queue.md)
- [Webhooks](./docs/webhooks.md)
- [Web Dashboard](./docs/dashboard.md)
- [Supported Providers](./docs/providers.md)
- [Session Lifecycle](./docs/session-lifecycle.md)
- [CLI Reference](./docs/cli.md)
- [Docker Deployment](./docs/docker.md)

---

## Contributing

Contributions welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT - see [LICENSE](LICENSE).

## Links

- [browsergateway.io](https://browsergateway.io)
- [GitHub](https://github.com/browser-gateway/browser-gateway)
- [npm](https://www.npmjs.com/package/browser-gateway)
