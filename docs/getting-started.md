# Getting Started

Get browser-gateway running in under 5 minutes.

## Prerequisites

- Node.js 20 or later
- At least one remote browser backend (Playwright server, cloud browser provider, Chrome CDP, etc.)

## Install

```bash
npm install -g browser-gateway
```

## Option 1: Zero Config (Single Backend)

If you have one backend, you don't need a config file:

```bash
BG_BACKEND_URL=ws://your-backend:3000 browser-gateway serve
```

That's it. Your gateway is running at `ws://localhost:3000/v1/connect`.

## Option 2: Config File (Multiple Backends)

Create `gateway.yml` in your working directory:

```yaml
version: 1

backends:
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

// For Playwright run-server backends
const browser = await chromium.connect('ws://localhost:3000/v1/connect');

// For Chrome CDP backends
const browser = await chromium.connectOverCDP('ws://localhost:3000/v1/connect');
```

### Puppeteer

```javascript
const puppeteer = require('puppeteer-core');

const browser = await puppeteer.connect({
  browserWSEndpoint: 'ws://localhost:3000/v1/connect'
});
```

### Any WebSocket Client

The gateway proxies raw WebSocket bytes. Any client that connects via WebSocket works.

## Verify It's Working

```bash
# Check health
curl http://localhost:3000/health

# Check backend status
curl http://localhost:3000/v1/status

# Check active sessions
curl http://localhost:3000/v1/sessions

# Test backend connectivity
browser-gateway check
```

## Add Authentication

Set the `BG_TOKEN` environment variable to require a token for all connections:

```bash
BG_TOKEN=my-secret-token browser-gateway serve
```

Clients include the token:

```typescript
const browser = await chromium.connect('ws://localhost:3000/v1/connect?token=my-secret-token');
```

## Next Steps

- [Configuration Reference](./configuration.md) - Every config option explained
- [How Failover Works](./failover.md) - Understanding automatic failover
- [Load Balancing](./load-balancing.md) - Routing strategies
- [Docker Deployment](./docker.md) - Running in containers
