<p align="center">
  <img src="https://raw.githubusercontent.com/browser-gateway/browser-gateway/main/docs/assets/logo.png" alt="browser-gateway" width="120" />
</p>

<h1 align="center">browser-gateway</h1>

<p align="center">
  <strong>The control plane for browser fleets.</strong>
  <br />
  One endpoint that routes across every browser provider you use: automatic failover, persistent profiles, session replay, REST API, MCP server, dashboard.
  <br />
  <em>OpenRouter for browsers.</em> Works unchanged with Puppeteer, Playwright, Stagehand, browser-use, and any MCP client.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/browser-gateway"><img src="https://img.shields.io/npm/v/browser-gateway?style=flat-square&logo=npm&logoColor=white" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/browser-gateway"><img src="https://img.shields.io/npm/dm/browser-gateway?style=flat-square&label=downloads" alt="npm downloads" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/npm/l/browser-gateway?style=flat-square" alt="MIT license" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/node/v/browser-gateway?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node.js" /></a>
  <a href="https://github.com/browser-gateway/browser-gateway"><img src="https://img.shields.io/github/stars/browser-gateway/browser-gateway?style=flat-square&logo=github&logoColor=white" alt="GitHub stars" /></a>
</p>

<p align="center">
  <a href="https://railway.com/new/template/browser-gateway?utm_medium=integration&amp;utm_source=button&amp;utm_campaign=browser-gateway"><img src="https://railway.com/button.svg" alt="Deploy on Railway" height="32" /></a>
  &nbsp;
  <a href="https://render.com/deploy?repo=https://github.com/browser-gateway/browser-gateway"><img src="https://render.com/images/deploy-to-render-button.svg" alt="Deploy to Render" height="32" /></a>
  &nbsp;
  <a href="https://cloud.digitalocean.com/apps/new?repo=https://github.com/browser-gateway/browser-gateway/tree/main"><img src="https://www.deploytodo.com/do-btn-blue.svg" alt="Deploy to DigitalOcean" height="32" /></a>
  &nbsp;
  <a href="https://app.koyeb.com/deploy?type=docker&amp;name=browser-gateway&amp;image=ghcr.io/browser-gateway/server:latest&amp;ports=9500;http;/&amp;env%5BBG_DATA_DIR%5D=/data"><img src="https://www.koyeb.com/static/images/deploy/button.svg" alt="Deploy to Koyeb" height="32" /></a>
</p>

<p align="center">
  <a href="https://browsergateway.com">Website</a>
  &nbsp;·&nbsp;
  <a href="https://docs.browsergateway.com/quickstart">Quick start</a>
  &nbsp;·&nbsp;
  <a href="https://docs.browsergateway.com/mcp">MCP</a>
  &nbsp;·&nbsp;
  <a href="https://docs.browsergateway.com/profiles">Profiles</a>
  &nbsp;·&nbsp;
  <a href="https://docs.browsergateway.com/replays">Replays</a>
  &nbsp;·&nbsp;
  <a href="https://docs.browsergateway.com/rest-api">REST API</a>
  &nbsp;·&nbsp;
  <a href="https://docs.browsergateway.com/dashboard">Dashboard</a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/browser-gateway/browser-gateway/main/docs/assets/routing.gif" alt="browser-gateway routes traffic across multiple browser providers, filling them by priority and failing over when one is saturated" width="720" />
</p>

---

## Overview

One endpoint. Multiple providers. Automatic failover when one is saturated or goes down.

Your app connects to `ws://gateway:9500/v1/connect`. The gateway picks the best available provider based on health, capacity, and your routing strategy. Providers can be cloud CDP services, Docker containers, or local Chrome instances.

---

## Dashboard

A web dashboard ships with every install. Open `http://localhost:9500/web` after starting the gateway.

**Overview.** Active sessions, queue depth, provider health, connection endpoint, and a copy-paste quickstart for Puppeteer, Playwright, Stagehand, browser-use, and raw CDP.

<p align="center">
  <img src="https://raw.githubusercontent.com/browser-gateway/browser-gateway/main/docs/assets/overview.png" alt="Dashboard overview page showing active sessions, queue depth, provider health, masked connection endpoint, and a tabbed quickstart with Puppeteer code" width="860" />
</p>

**REST API.** Run screenshot, content extraction, and structured scraping endpoints from a form-driven UI, with profile selection and parameter reference inline.

<p align="center">
  <img src="https://raw.githubusercontent.com/browser-gateway/browser-gateway/main/docs/assets/api.png" alt="REST API page in the dashboard with three tabs (screenshot, content, scrape) and a form to capture a screenshot of a target URL with format and profile options" width="860" />
</p>

**Playground.** Drive any provider live from the browser. Pick a provider and profile, type into the canvas as if it were a local browser, and watch the remote session in real time.

<p align="center">
  <img src="https://raw.githubusercontent.com/browser-gateway/browser-gateway/main/docs/assets/playground.jpg" alt="Live playground page streaming a remote Chrome session showing yahoo.com loaded inside the dashboard canvas" width="860" />
</p>

---

## Features

### Routing & reliability

- **Automatic failover** - the next provider takes over the instant one fails, no client changes
- **Five load-balancing strategies** - priority chain, round-robin, least-connections, latency-optimized, weighted
- **Per-provider concurrency limits** - the gateway enforces `maxConcurrent` on every backend
- **Request queue** - connections wait when every provider is saturated instead of failing immediately
- **Cooldown** - failing providers are skipped and recover automatically after a TTL
- **Health checks** - periodic connectivity probes mark providers unhealthy before clients hit them
- **Graceful shutdown** - active sessions drain cleanly on SIGTERM and SIGINT
- **Session reconnect** - dropped clients resume against the same provider with cookies and page state intact
- **Webhooks** - fire on provider down, recover, and queue-overflow events

### REST API

- **Screenshot** - `POST /v1/screenshot` returns any URL as PNG or JPEG, full-page or scoped to a selector
- **Content extraction** - `POST /v1/content` returns markdown, plain text, HTML, or a cleaned article
- **Scrape** - `POST /v1/scrape` extracts structured data via CSS selectors or full-page formats
- **Pooled sessions** - browser connections are reused across requests, like a database pool
- **Automatic retry** - failed requests retry against a fresh page

### Profiles — persistent browser state

- **Survive across sessions** - cookies, `localStorage`, `sessionStorage`, and `IndexedDB` are captured on disconnect and replayed on the next connect with the same id
- **One-line opt-in** - add `?profile=acme` to the WebSocket URL, the rest is automatic
- **Encrypted at rest** - AES-256-GCM with envelope encryption, anti-swap binding, and a scrypt-derived KEK
- **Provider-agnostic** - state is captured at the CDP level, so it replays against any provider
- **Per-profile locking** - concurrent connects to the same id return HTTP 409 to prevent corruption
- **Export and import** - encrypted `.bgp` blobs are portable between gateway installs
- **One-click enable** - the dashboard wizard generates a strong key in your browser and writes it to config

See the [Profiles docs](https://docs.browsergateway.com/profiles) for the full guide, security model, REST endpoints, and limitations.

### Session replay — see what the agent saw

- **Frame-accurate visual record** of every routed session, captured via CDP `Page.startScreencast`
- **Zero injection** - no script runs inside the customer page, capture is fully out-of-band
- **Provider-agnostic** - works with any backend that supports page screencast
- **Dashboard player** - scrub through the recorded frames, switch between captured browser targets
- **Retention controls** - configurable horizon, per-session byte cap, daily cleanup

See the [Replays docs](https://docs.browsergateway.com/replays) for the storage layout, REST endpoints, and tuning knobs.

### MCP server for AI agents

- **Eight browser tools** - navigate, snapshot, screenshot, viewport, interact, evaluate, close, status
- **Zero config** - auto-detects Chrome and launches it on first tool use
- **Concurrent sessions** - every agent gets its own browser, no shared state
- **Raw CDP** - no Playwright or Puppeteer dependency
- **Compatible** - Claude Code, Cursor, and any MCP-compatible client

### Management

- **Dashboard** - manage providers, watch sessions, and edit config from the browser
- **Provider CRUD** - add, edit, delete, and test providers from the dashboard or API
- **Config editor** - edit `gateway.yml` in-browser with syntax highlighting and validation
- **Auth** - token-based, with a secure HttpOnly cookie for the dashboard
- **Protocol-agnostic** - works with Playwright, Puppeteer, and any WebSocket protocol

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

Or use the REST API — no WebSocket management needed:

```bash
# Screenshot
curl -X POST http://localhost:9500/v1/screenshot \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com"}' --output screenshot.png

# Extract content as markdown
curl -X POST http://localhost:9500/v1/content \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com", "formats": ["markdown"]}'
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

No config files needed. The agent gets navigate, snapshot, screenshot, click, type, and evaluate tools through the gateway's routing layer.

See the [MCP docs](https://docs.browsergateway.com/mcp) for all options.

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
| `/v1/screenshot` | POST | Take a screenshot of any URL ([docs](https://docs.browsergateway.com/rest-api)) |
| `/v1/content` | POST | Extract page content as markdown, text, or HTML ([docs](https://docs.browsergateway.com/rest-api)) |
| `/v1/scrape` | POST | Extract data via CSS selectors or full-page formats ([docs](https://docs.browsergateway.com/rest-api)) |
| `/v1/status` | GET | Gateway health + provider status + pool status |
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

Recommended: Docker Compose. The bundled `docker-compose.yml` mounts a named volume for state and a read-only `gateway.yml` from the host.

```bash
# Drop your gateway.yml next to docker-compose.yml, then:
docker compose up -d
```

Plain `docker run`:

```bash
docker run -d \
  -p 9500:9500 \
  -v bg_data:/data \
  -v ./gateway.yml:/app/gateway.yml:ro \
  -e PROVIDER_TOKEN=xxx \
  ghcr.io/browser-gateway/server:latest
```

### Persistence

Everything the gateway writes to disk lives under a single directory, `BG_DATA_DIR` (defaults to `/data` inside the image). Mount that as a named volume or a bind mount and all state survives container restarts and image upgrades. Today it contains:

- `profiles/` — encrypted profile blobs (when profiles are enabled)

Future versions may add more subdirectories under the same root (cooldown state, session snapshots, captures). Mounting `BG_DATA_DIR` as one volume keeps every subsystem persistent without follow-up config changes.

### Upgrades

State lives in the volume, code lives in the image. Pull the new image, recreate the container — no data lost:

```bash
docker compose pull
docker compose up -d
```

The container reads the same `BG_DATA_DIR` and the same `gateway.yml`. Profile blobs are versioned and the gateway reads older formats transparently.

### Image tags

| Tag | Updated on |
|---|---|
| `:0.3.0` (and every subsequent version) | published manually after a release |
| `:latest` | always points at the newest version |

Images are multi-arch (`linux/amd64`, `linux/arm64`), signed with [Sigstore](https://www.sigstore.dev/) build provenance, and ship an SBOM. Verify with the [GitHub CLI](https://cli.github.com/):

```bash
gh attestation verify oci://ghcr.io/browser-gateway/server:0.3.0 \
  --repo browser-gateway/browser-gateway
```

---

## How It Works

1. Client connects to `ws://gateway:9500/v1/connect`
2. Gateway selects a provider using your [routing strategy](https://docs.browsergateway.com/operating/load-balancing)
3. Gateway opens a raw TCP connection to the provider
4. HTTP upgrade forwarded, provider responds with `101 Switching Protocols`
5. Bidirectional TCP pipe: `client <-> gateway <-> provider`
6. All WebSocket messages forwarded transparently (never parsed or modified)
7. On disconnect: session cleaned up, slot released, metrics updated
8. If all providers full: connection [waits in a queue](https://docs.browsergateway.com/operating/queue) until a slot opens

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

Full docs live at **[docs.browsergateway.com](https://docs.browsergateway.com)**.

- [Getting Started](https://docs.browsergateway.com/quickstart)
- [Configuration Reference](https://docs.browsergateway.com/configuration)
- [Supported Providers](https://docs.browsergateway.com/providers)
- [Profiles — Persistent Browser State](https://docs.browsergateway.com/profiles)
- [Session Replays](https://docs.browsergateway.com/replays)
- [Session Lifecycle](https://docs.browsergateway.com/sessions)
- [REST API](https://docs.browsergateway.com/rest-api)
- [MCP Server for AI Agents](https://docs.browsergateway.com/mcp)
- [CLI Reference](https://docs.browsergateway.com/cli)
- [Web Dashboard](https://docs.browsergateway.com/dashboard)
- [How Failover Works](https://docs.browsergateway.com/operating/failover)
- [Load Balancing Strategies](https://docs.browsergateway.com/operating/load-balancing)
- [Request Queue](https://docs.browsergateway.com/operating/queue)
- [Webhooks](https://docs.browsergateway.com/operating/webhooks)
- [Docker Deployment](https://docs.browsergateway.com/operating/docker)
- [Integrations](https://docs.browsergateway.com/operating/integrations) — Playwright, Puppeteer, browser-use, Stagehand, Playwright MCP

---

## Contributing

Contributions welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT - see [LICENSE](LICENSE).

## Links

- [browsergateway.com](https://browsergateway.com)
- [GitHub](https://github.com/browser-gateway/browser-gateway)
- [npm](https://www.npmjs.com/package/browser-gateway)

---

<sub>Maintained by <a href="https://monostellar.com">Monostellar Labs</a>.</sub>
