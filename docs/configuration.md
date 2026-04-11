# Configuration Reference

browser-gateway is configured via a `gateway.yml` file, environment variables, or both.

## Config File Location

The gateway looks for configuration in this order:

1. `--config <path>` CLI flag
2. `BG_CONFIG_PATH` environment variable
3. `./gateway.yml` in the current directory
4. `./gateway.yaml` in the current directory

If no file is found, the gateway falls back to environment variables.

## Full Config Reference

```yaml
version: 1

gateway:
  port: 9500                          # Server port (default: 9500)
  defaultStrategy: priority-chain      # How the gateway chooses which provider to use
                                       # Options: priority-chain, round-robin, least-connections,
                                       #          latency-optimized, weighted
  connectionTimeout: 10000             # Max ms to wait when connecting to a provider (default: 10000)
                                       # Tip: increase to 20000-30000 for cloud providers that
                                       # launch browsers on-demand (cold start can take 10-15s)
  healthCheckInterval: 30000           # How often to check if providers are alive (default: 30000)
  shutdownDrainMs: 30000               # When stopping the gateway, how long to wait for active
                                       # sessions to finish before force-closing (default: 30000)

  cooldown:
    defaultMs: 30000                   # How long to skip a failing provider (default: 30000)
    failureThreshold: 0.5              # Cooldown when failure rate exceeds this (default: 0.5 = 50%)
    minRequestVolume: 3                # Min connection attempts before evaluating (default: 3)

  sessions:
    idleTimeoutMs: 300000              # Close sessions with no activity after this (default: 300000 = 5 min)
    reconnectTimeoutMs: 300000         # How long a disconnected session stays available for reconnection (default: 300000 = 5 min)

  queue:
    maxSize: 50                        # Max requests waiting when all providers are busy (default: 50)
    timeoutMs: 30000                   # How long a request waits in queue before giving up (default: 30000)

providers:
  provider-name:                        # Your name for this provider (any string)
    url: wss://provider.com?token=xxx  # WebSocket URL including any auth params
    limits:
      maxConcurrent: 10                # Max simultaneous connections (optional, no limit if omitted)
    priority: 1                        # Lower number = tried first (default: 1)
    weight: 1                          # For weighted strategy: higher = more traffic (default: 1)

# Optional: get notified when things happen
webhooks:
  - url: https://hooks.slack.com/services/xxx    # Where to send notifications
    events: [provider.cooldown, provider.down]    # Which events (omit for all events)

dashboard:
  enabled: true                        # Enable web dashboard at /web (default: true)

logging:
  level: info                          # debug | info | warn | error (default: info)
```

## Providers

### URL

The URL is the WebSocket endpoint of your browser provider. It includes everything the provider needs for authentication - tokens, API keys, session IDs.

```yaml
providers:
  # Cloud provider with token auth
  cloud-provider:
    url: wss://provider.example.com?token=${PROVIDER_TOKEN}

  # Self-hosted Playwright server
  my-playwright:
    url: ws://playwright-host:3000

  # Raw Chrome with remote debugging
  my-chrome:
    url: http://chrome-host:9222              # Auto-discovers WebSocket endpoint

  # Any WebSocket endpoint
  my-custom:
    url: ws://custom-service:8080/browser
```

### Limits

```yaml
limits:
  maxConcurrent: 10    # Max simultaneous connections to this provider
```

When a provider reaches `maxConcurrent`, the gateway skips it and tries the next one. If not set, there is no connection limit.

### Priority

```yaml
priority: 1    # Lower = higher priority. Tried first in priority-chain strategy.
```

Providers with the same priority are tried in config order.

### Weight

```yaml
weight: 3    # For weighted strategy only. Higher = more traffic. Default: 1.
```

Weights only matter when using the `weighted` strategy. A provider with `weight: 3` gets 3x more traffic than one with `weight: 1`. See [Load Balancing](./load-balancing.md#weighted) for detailed examples.

## Deep Dives

Each major feature has its own guide with real-world examples:

- **[Load Balancing](./load-balancing.md)** - All 5 strategies explained with when to use each
- **[Failover](./failover.md)** - How automatic failover works, cooldown system
- **[Request Queue](./request-queue.md)** - What happens when all providers are busy
- **[Webhooks](./webhooks.md)** - Get notifications when providers go down or recover
- **[Session Lifecycle](./session-lifecycle.md)** - What happens during connect and disconnect
- **[Graceful Shutdown](./cli.md#graceful-shutdown)** - How the gateway shuts down cleanly

## Environment Variable Interpolation

Use `${ENV_VAR}` syntax in any string value. The gateway resolves these at startup.

```yaml
providers:
  production:
    url: wss://service.com?token=${API_TOKEN}
```

Supports defaults with `${VAR:-default}`:

```yaml
gateway:
  port: ${BG_PORT:-9500}
```

Secrets should ALWAYS use env vars. Never put actual tokens in the config file.

## Environment Variables (No Config File)

These environment variables can be set alongside or instead of a config file:

| Variable | Description | Default |
|----------|-------------|---------|
| `BG_PORT` | Server port | 9500 |
| `BG_TOKEN` | Auth token (if set, all connections require it) | None (no auth) |
| `BG_CONFIG_PATH` | Path to config file | `./gateway.yml` |

### .env File

The gateway automatically loads a `.env` file from the current directory. Put secrets here instead of passing them inline:

```bash
# .env
BG_TOKEN=my-secret-token
```

The `.env` file is loaded on startup. Environment variables set externally (e.g., via Docker `-e` flags) take precedence over `.env` values.

## Multiple Providers Example

```yaml
version: 1

providers:
  # Cloud provider - use first
  cloud-primary:
    url: wss://provider.example.com?token=${PRIMARY_TOKEN}
    limits:
      maxConcurrent: 3
    priority: 1

  # Self-hosted servers - overflow
  playwright-1:
    url: ws://playwright-server-1:3000
    limits:
      maxConcurrent: 10
    priority: 2

  playwright-2:
    url: ws://playwright-server-2:3000
    limits:
      maxConcurrent: 10
    priority: 2

  # Second cloud provider - last resort
  cloud-backup:
    url: wss://backup-provider.example.com?key=${BACKUP_KEY}
    limits:
      maxConcurrent: 20
    priority: 3
```

This setup: use the primary cloud provider first (3 concurrent), overflow to self-hosted Playwright servers (20 concurrent across 2 servers), fall back to the backup provider if everything else is full.

## Session Pool

The session pool manages browser connections for the REST API endpoints (`/v1/screenshot`, `/v1/content`, `/v1/scrape`). Instead of opening a new browser connection for every request, the pool keeps a small number of long-lived connections and creates lightweight pages (tabs) within them.

```yaml
pool:
  minSessions: 0          # Minimum browser sessions to keep alive
  maxSessions: 5           # Maximum browser connections from pool
  maxPagesPerSession: 10   # Pages per browser before creating another
  retireAfterPages: 100    # Recycle browser after this many total pages
  retireAfterMs: 3600000   # Recycle after 1 hour max
  idleTimeoutMs: 300000    # Close idle browsers after 5 minutes
```

| Setting | Default | What it does |
|---------|---------|-------------|
| minSessions | 0 | How many browser sessions to keep alive even when idle. 0 means scale to zero — no browser running until the first REST request. Set to 1 to eliminate cold start latency. |
| maxSessions | 5 | Hard cap on total browser connections. 5 sessions with 10 pages each = 50 concurrent REST operations. |
| maxPagesPerSession | 10 | When a browser session has this many active pages, the next request creates a new session. Higher values use less connections but put more load on each browser. |
| retireAfterPages | 100 | After serving this many total pages, the session is marked for retirement. It finishes active pages, then closes. This prevents Chrome memory leaks from accumulating over time. |
| retireAfterMs | 3600000 | Maximum lifetime of a browser session (1 hour). Even if the page count hasn't been reached, long-running sessions are recycled. |
| idleTimeoutMs | 300000 | Close idle sessions (no active pages) after this many milliseconds. Only applies to sessions above minSessions — the pool never closes below the minimum. |

**When to adjust these settings:**

- **High throughput, beefy providers:** Increase `maxPagesPerSession` to 20 and `maxSessions` to 10
- **Memory-constrained providers:** Lower `maxPagesPerSession` to 5, lower `retireAfterPages` to 50
- **Zero idle cost:** Keep `minSessions: 0` (default) — browsers only run when requests are active
- **Zero cold start:** Set `minSessions: 1` — one browser stays warm at all times
