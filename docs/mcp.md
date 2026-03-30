# MCP Server

browser-gateway includes a built-in MCP (Model Context Protocol) server that gives AI agents direct browser access. No Playwright or Puppeteer installation needed.

## Quick Start

Add to your Claude Code or Cursor MCP configuration:

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

That's it. The agent can now navigate websites, take screenshots, fill forms, and extract data.

## How It Works

When an agent calls a browser tool for the first time, browser-gateway:

1. Detects Chrome on your system (macOS, Linux, Windows)
2. Launches it automatically
3. Connects via Chrome DevTools Protocol (CDP)
4. Returns results to the agent

No configuration files. No provider setup. No extra dependencies.

## Tools

browser-gateway provides 8 browser tools:

| Tool | What It Does |
|------|-------------|
| `browser_navigate` | Go to a URL. Auto-creates a browser session on first call. |
| `browser_snapshot` | Get the page structure as an accessibility tree with numbered refs like `[1]`, `[2]`. Use these refs with `browser_interact`. |
| `browser_screenshot` | Capture the page as a PNG image. Saves to a temp file. |
| `browser_set_viewport` | Set the browser viewport size (desktop, tablet, mobile). |
| `browser_interact` | Click, type, select, press keys, or scroll. Accepts `[n]` refs from snapshots or CSS selectors. |
| `browser_evaluate` | Run JavaScript in the page. Scripts with `await` are auto-wrapped. |
| `browser_close` | Close the browser session and free resources. |
| `browser_status` | Check gateway health: provider status, active sessions, queue. |

## Options

```bash
browser-gateway mcp                                     # Auto-detect Chrome (default)
browser-gateway mcp --headless                           # Run Chrome in headless mode
browser-gateway mcp --cdp-endpoint ws://localhost:9222   # Connect to existing Chrome/provider
browser-gateway mcp --config gateway.yml                 # Use multi-provider config
```

### Headless vs Headed

By default, browser-gateway shows the browser window on desktop (macOS/Windows) and runs headless on Linux without a display (Docker, CI). This matches what Playwright MCP does.

To force headless mode:

```json
{
  "mcpServers": {
    "browser-gateway": {
      "command": "npx",
      "args": ["browser-gateway", "mcp", "--headless"]
    }
  }
}
```

## Multiple Agents

Each Claude Code or Cursor session gets its own browser. No conflicts, no "browser already in use" errors.

```
Session 1 → browser-gateway mcp → Chrome A
Session 2 → browser-gateway mcp → Chrome B
Session 3 → browser-gateway mcp → Chrome C
```

Each process auto-detects an available port. No configuration needed.

## Using with Remote Providers

For production workloads, point the MCP at a gateway with remote providers:

```yaml
# gateway.yml
providers:
  browserless:
    url: wss://production-sfo.browserless.io?token=${BL_TOKEN}
    limits:
      maxConcurrent: 10
    priority: 1
  steel:
    url: wss://connect.steel.dev?apiKey=${STEEL_KEY}
    limits:
      maxConcurrent: 5
    priority: 2
```

```json
{
  "mcpServers": {
    "browser-gateway": {
      "command": "npx",
      "args": ["browser-gateway", "mcp", "--config", "gateway.yml"]
    }
  }
}
```

The gateway routes to the best available provider with automatic failover.

## Using with Playwright MCP

browser-gateway works alongside Playwright MCP. Point Playwright MCP at the gateway to get routing and failover with all 70 Playwright tools:

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": [
        "@playwright/mcp@latest",
        "--cdp-endpoint", "ws://localhost:9500/v1/connect"
      ]
    }
  }
}
```

This requires running `browser-gateway serve` separately:

```bash
browser-gateway serve --config gateway.yml
```

## How It Compares

| Feature | browser-gateway MCP | Playwright MCP |
|---------|-------------------|---------------|
| Tools | 8 (lightweight) | 70 (comprehensive) |
| Dependencies | None (raw CDP) | Playwright |
| Concurrent sessions | Yes (separate Chrome per session) | No (single browser) |
| Multi-provider | Yes (with config) | No |
| Failover | Yes (with config) | No |
| Zero config | Yes | Yes |
| Headless default | Headed (same as Playwright) | Headed |

Use browser-gateway MCP when you want lightweight, concurrent browser access. Use Playwright MCP when you need the full 70-tool automation surface. Use both together for the best of both worlds.
