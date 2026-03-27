# Getting Started

Get browser-gateway running in under 5 minutes.

## Prerequisites

- Node.js 20 or later
- At least one remote browser provider (Playwright server, cloud browser provider, Chrome CDP, etc.)

## Install

```bash
npm install -g browser-gateway
```

## Configure

Create a `gateway.yml` file in your working directory:

```yaml
version: 1

providers:
  primary:
    url: wss://provider.example.com?token=${PROVIDER_TOKEN}
    limits:
      maxConcurrent: 5
    priority: 1

  fallback:
    url: ws://your-playwright-server:4000
    limits:
      maxConcurrent: 10
    priority: 2
```

Start:

```bash
browser-gateway serve
```

## Connect Through the Gateway

### Playwright

```typescript
import { chromium } from 'playwright-core';

// For Playwright run-server providers
const browser = await chromium.connect('ws://localhost:9500/v1/connect');

// For Chrome CDP providers
const browser = await chromium.connectOverCDP('ws://localhost:9500/v1/connect');
```

### Puppeteer

```javascript
const puppeteer = require('puppeteer-core');

const browser = await puppeteer.connect({
  browserWSEndpoint: 'ws://localhost:9500/v1/connect'
});
```

### Any WebSocket Client

The gateway proxies raw WebSocket bytes. Any client that connects via WebSocket works.

## Verify It's Working

```bash
# Check health
curl http://localhost:9500/health

# Check provider status
curl http://localhost:9500/v1/status

# Check active sessions
curl http://localhost:9500/v1/sessions

# Test provider connectivity
browser-gateway check
```

## Web Dashboard

The gateway includes a built-in web dashboard at `/web`:

```
http://localhost:9500/web
```

It shows provider health, active sessions, and metrics in real-time.

## Add Authentication

Set the `BG_TOKEN` environment variable to require a token for all connections:

```bash
BG_TOKEN=my-secret-token browser-gateway serve
```

You can also put it in a `.env` file (auto-loaded on startup):

```bash
# .env
BG_TOKEN=my-secret-token
```

When auth is enabled:
- The web dashboard shows a login form - enter the token once and it sets a secure session cookie
- WebSocket clients pass the token as a query param: `?token=my-secret-token`
- API clients use `Authorization: Bearer my-secret-token` header
- `/health` is always public (no auth required)

## Next Steps

- [Configuration Reference](./configuration.md) - Every config option explained
- [How Failover Works](./failover.md) - Understanding automatic failover
- [Load Balancing](./load-balancing.md) - Routing strategies
- [Docker Deployment](./docker.md) - Running in containers
