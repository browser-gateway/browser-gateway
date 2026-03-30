# browser-gateway

**Reliable, scalable browser infrastructure for AI agents.**

Route, pool, and failover across any browser provider. Built-in MCP server for Claude Code, Cursor, and any MCP-compatible AI agent.

---

## MCP Server for AI Agents

Give your AI agent browser access in one line:

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

The agent can now navigate websites, take screenshots, fill forms, and extract data. No Playwright or Puppeteer installation needed.

- **Zero config** - auto-detects Chrome on your system
- **Concurrent sessions** - multiple agents, no "browser already in use" errors
- **8 browser tools** - navigate, snapshot, screenshot, interact, evaluate, and more
- **Lightweight** - raw CDP, no heavy browser automation dependencies
- **Works with** Claude Code, Cursor, and any MCP client

See the [MCP documentation](docs/mcp.md) for all options.

---

## WebSocket Proxy for Applications

`browser-gateway` is also a proxy router for remote browser connections. You bring your own browser providers. We handle routing, failover, load balancing, health monitoring, and usage tracking.

```
Your cloud providers (Browserless, Steel) ---\
Your Playwright servers ---------------------+--->  browser-gateway  <--- Your app / AI agent
Your Chrome instances -----------------------+
Any CDP-compatible endpoint ----------------/
```

### The Problem

- **Vendor lock-in** - Coupled to one browser provider
- **No failover** - Provider goes down, your app breaks
- **Concurrency blindness** - No visibility into active sessions across providers
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

- **MCP Server** - Built-in MCP server for AI agents (Claude Code, Cursor). 8 browser tools, zero-config, concurrent sessions.
- **Connection Routing** - Route WebSocket/CDP connections to the right provider
- **Automatic Failover** - Provider down? Next one instantly, zero client changes
- **Per-Provider Limits** - Set `maxConcurrent` per provider, gateway enforces it
- **5 Load Balancing Strategies** - Priority chain, round-robin, least-connections, latency-optimized, weighted
- **Cooldown System** - Automatically skip failing providers, recover after TTL
- **Request Queue** - All providers busy? Connections wait in a queue instead of failing
- **Graceful Shutdown** - Active sessions drain cleanly on SIGTERM/SIGINT (configurable timeout)
- **Webhooks** - Get notified (Slack, Discord, custom) when providers go down, recover, or queue overflows
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

Built-in web dashboard at `http://localhost:9500/web`. No extra setup — it's served from the same port as the gateway.

| Page | What You Can Do |
|------|----------------|
| **Overview** | See gateway health at a glance — active sessions, provider status, connection URL with copy-paste snippets |
| **Providers** | Add, edit, delete, and test browser providers. Test connectivity before saving. Changes write to gateway.yml automatically |
| **Sessions** | Live table of every active browser connection — which provider it's on, how long it's been open, message count |
| **Config** | Edit gateway.yml directly in the browser with syntax highlighting, validation, and automatic backups |
| **Logs** | Coming soon (check terminal output for now) |

Dark theme by default with light theme toggle. If `BG_TOKEN` is set, the dashboard shows a login form and uses a secure HttpOnly cookie — no token in the URL.

See [Dashboard Guide](./docs/dashboard.md) for a detailed walkthrough of every page.

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
browser-gateway mcp                      # Start MCP server for AI agents
browser-gateway mcp --headless           # MCP server in headless mode
browser-gateway mcp --config path.yml    # MCP with multi-provider config
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
2. Gateway selects a provider using your [routing strategy](./docs/load-balancing.md) (checks health, capacity, cooldowns)
3. Gateway opens a raw TCP connection to the provider
4. HTTP upgrade request is forwarded to the provider
5. Provider responds with `101 Switching Protocols`
6. Bidirectional TCP pipe established: `client <-> gateway <-> provider`
7. All WebSocket messages forwarded transparently
8. On disconnect: session cleaned up, concurrency slot released, metrics updated
9. If all providers were full at step 2, the connection [waits in a queue](./docs/request-queue.md) until a slot opens

The gateway never parses or modifies WebSocket messages. It's a transparent pipe with smart routing.

---

## Documentation

- [MCP Server for AI Agents](./docs/mcp.md) - Setup, tools, options, using with Playwright MCP
- [Getting Started](./docs/getting-started.md)
- [Configuration Reference](./docs/configuration.md)
- [How Failover Works](./docs/failover.md)
- [Load Balancing Strategies](./docs/load-balancing.md) - Priority chain, round-robin, least-connections, latency-optimized, weighted
- [Request Queue](./docs/request-queue.md) - What happens when all providers are busy
- [Webhooks](./docs/webhooks.md) - Get notified when providers go down or recover
- [Web Dashboard](./docs/dashboard.md) - Every page explained with what you can do
- [Supported Providers](./docs/providers.md)
- [Session Lifecycle](./docs/session-lifecycle.md)
- [CLI Reference](./docs/cli.md) - Commands and graceful shutdown
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
