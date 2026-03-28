# CLI Reference

browser-gateway provides a command-line interface for running and managing the gateway.

## Commands

### serve

Start the gateway server.

```bash
browser-gateway serve [options]
```

| Option | Description | Default |
|--------|-------------|---------|
| `--config <path>` | Path to gateway.yml | `./gateway.yml` |
| `--port <number>` | Override server port | 9500 |
| `--no-ui` | Disable the web dashboard | Dashboard enabled |

Examples:

```bash
# Start with default config
browser-gateway serve

# Custom config and port
browser-gateway serve --config /etc/browser-gateway/gateway.yml --port 8080

# With auth
BG_TOKEN=secret browser-gateway serve
```

### check

Test connectivity to all configured providers. Useful for verifying your config.

```bash
browser-gateway check [--config <path>]
```

Output:

```
Provider Connectivity Check

  primary                 OK    340ms
  fallback-playwright     OK    12ms
  backup-chrome           FAIL  connection refused

3 provider(s) checked
```

Exit codes:
- `0` - All providers reachable
- `1` - One or more providers unreachable

### version

Print the installed version.

```bash
browser-gateway version
```

### help

Show usage information.

```bash
browser-gateway help
```

## Running Without Global Install

```bash
# Using npx
npx browser-gateway serve

# Using project dependency
npx browser-gateway serve --config ./gateway.yml
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `BG_TOKEN` | Auth token for all connections | None (no auth) |
| `BG_PORT` | Server port | 9500 |
| `BG_CONFIG_PATH` | Path to config file | `./gateway.yml` |

## Graceful Shutdown

The gateway handles shutdown signals gracefully so active browser sessions aren't interrupted mid-task:

- `SIGINT` (Ctrl+C) — Graceful shutdown
- `SIGTERM` — Graceful shutdown (used by Docker, systemd, Kubernetes)

What happens when the gateway receives a shutdown signal:

1. **Stop accepting new connections** — new requests get `503 Service Unavailable`
2. **Drain active sessions** — wait for existing browser sessions to finish naturally
3. **Timeout** — after `shutdownDrainMs` (default: 30 seconds), force-close any remaining sessions
4. **Exit** — process exits cleanly

### Why this matters

Browser sessions have state. If you're halfway through filling a form or scraping a page, an abrupt disconnect means lost work. Graceful shutdown gives active sessions time to finish.

### Configuration

```yaml
gateway:
  shutdownDrainMs: 30000    # Wait up to 30s for sessions to finish (default)
```

Increase this if your browser sessions are long-running (e.g., complex scraping workflows). Decrease it if you need faster restarts.

### Docker and Kubernetes

Docker sends `SIGTERM` on `docker stop`, then waits 10 seconds before `SIGKILL`. If your `shutdownDrainMs` is longer than Docker's stop timeout, increase Docker's timeout:

```bash
docker stop --time 60 browser-gateway
```

Or in Docker Compose:

```yaml
services:
  browser-gateway:
    stop_grace_period: 60s
```

For Kubernetes, set `terminationGracePeriodSeconds` to match your drain timeout.

### Webhook notification

If [webhooks](./webhooks.md) are configured, the gateway sends a `shutdown.start` event when it begins shutting down.
