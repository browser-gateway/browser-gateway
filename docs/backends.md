# Supported Backends

browser-gateway works with any WebSocket endpoint. If your browser provider exposes a WebSocket URL, it works with the gateway.

## How Backends Work

Each backend is just a WebSocket URL. The gateway doesn't care what's behind it - it forwards bytes transparently. You configure the URL (with any auth params baked in), set connection limits, and assign a priority.

```yaml
backends:
  my-backend:
    url: <websocket-url-with-auth>
    limits:
      maxConcurrent: <number>
    priority: <number>
```

## Backend Types

### Remote browser services (cloud)

Cloud providers typically give you a WebSocket URL with an API key:

```yaml
backends:
  cloud-provider:
    url: wss://provider.example.com?token=${API_TOKEN}
    limits:
      maxConcurrent: 5
    priority: 1
```

### Self-hosted Playwright

Run your own Playwright server:

```bash
npx playwright run-server --port 4000 --host 0.0.0.0
```

Or via Docker:
```bash
docker run -d -p 4000:3000 --shm-size=1gb \
  mcr.microsoft.com/playwright:v1.50.1-noble \
  /bin/sh -c "npx -y playwright@1.50.1 run-server --port 3000 --host 0.0.0.0"
```

Config:
```yaml
backends:
  my-playwright:
    url: ws://playwright-host:4000
    limits:
      maxConcurrent: 10
    priority: 1
```

**Important**: Playwright client and server versions must match exactly.

### Raw Chrome (--remote-debugging-port)

Chrome/Chromium with remote debugging enabled:

```bash
google-chrome --remote-debugging-port=9222 --headless --no-sandbox
```

Get the WebSocket URL:
```bash
curl http://localhost:9222/json/version
# Look for "webSocketDebuggerUrl"
```

Config:
```yaml
backends:
  my-chrome:
    url: ws://chrome-host:9222/devtools/browser/UUID
    limits:
      maxConcurrent: 1
    priority: 1
```

## Connection Modes

The gateway is protocol-agnostic - it forwards raw bytes without parsing. However, your client needs to use the correct connection method for the backend type:

| Backend Type | Client Method |
|-------------|--------------|
| Playwright run-server | `chromium.connect(wsEndpoint)` |
| Chrome CDP endpoints | `chromium.connectOverCDP(wsEndpoint)` |
| Puppeteer (any) | `puppeteer.connect({ browserWSEndpoint })` |

## Multiple Backends

Mix any number of backends with different priorities:

```yaml
backends:
  primary:
    url: wss://provider-a.example.com?key=${KEY_A}
    limits:
      maxConcurrent: 5
    priority: 1

  overflow:
    url: ws://my-playwright-server:4000
    limits:
      maxConcurrent: 20
    priority: 2

  emergency:
    url: wss://provider-b.example.com?key=${KEY_B}
    limits:
      maxConcurrent: 50
    priority: 3
```

The gateway tries them in priority order. If the primary is full or down, traffic routes to the next available backend automatically.

## Tips

- **Auth goes in the URL** - Most providers use query params for auth (`?token=xxx`, `?apiKey=xxx`). Put these directly in the URL. Use `${ENV_VAR}` references for secrets.
- **Set realistic limits** - Check your provider's actual concurrency limits and set `maxConcurrent` accordingly. The gateway enforces these locally to avoid hitting provider rate limits.
- **Chrome CDP needs the full path** - Chrome's CDP URL includes a UUID that changes on restart. You'll need to update the config or fetch it dynamically.
