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
  defaultStrategy: priority-chain      # Routing strategy (see Load Balancing docs)
  connectionTimeout: 10000             # Max ms to wait for provider connection (default: 10000)
                                       # Tip: increase to 20000-30000 for cloud providers that
                                       # launch browsers on-demand (cold start can take 10-15s)
  healthCheckInterval: 30000           # ms between health checks (default: 30000)

  cooldown:
    defaultMs: 30000                   # How long to skip a failing provider (default: 30000)
    failureThreshold: 0.5              # Cooldown when failure rate exceeds this (default: 0.5 = 50%)
    minRequestVolume: 3                # Min connection attempts before evaluating (default: 3)

  sessions:
    idleTimeoutMs: 300000              # Close idle sessions after this (default: 300000 = 5 min)

providers:
  provider-name:                        # Your name for this provider (any string)
    url: wss://provider.com?token=xxx  # WebSocket URL including any auth params
    limits:
      maxConcurrent: 10                # Max simultaneous connections (optional)
    priority: 1                        # Lower number = tried first (default: 1)

dashboard:
  enabled: true                        # Enable web dashboard (default: true)

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
    url: ws://chrome-host:9222/devtools/browser/UUID

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
