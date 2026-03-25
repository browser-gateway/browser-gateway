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

# Zero-config with env vars
BG_BACKEND_URL=ws://localhost:4000 browser-gateway serve

# With auth
BG_TOKEN=secret browser-gateway serve
```

### check

Test connectivity to all configured backends. Useful for verifying your config.

```bash
browser-gateway check [--config <path>]
```

Output:

```
Backend Connectivity Check

  primary                 OK    340ms
  fallback-playwright     OK    12ms
  backup-chrome           FAIL  connection refused

3 backend(s) checked
```

Exit codes:
- `0` - All backends reachable
- `1` - One or more backends unreachable

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
| `BG_BACKEND_URL` | Single backend URL (no config file needed) | None |
| `BG_PORT` | Server port | 9500 |
| `BG_MAX_CONCURRENT` | Max connections for default backend | 10 |
| `BG_CONFIG_PATH` | Path to config file | `./gateway.yml` |

## Process Signals

The gateway handles shutdown signals gracefully:

- `SIGINT` (Ctrl+C) - Graceful shutdown
- `SIGTERM` - Graceful shutdown (used by Docker, systemd)

On shutdown:
1. Stop accepting new connections
2. Wait for active sessions to close (up to 5 seconds)
3. Force close remaining connections
4. Exit
