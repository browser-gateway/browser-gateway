# Integrations

browser-gateway works with any tool that connects to browsers via WebSocket or CDP. This guide covers the most popular ones.

All examples assume the gateway is running on `http://localhost:9500` with at least one provider configured.

## Playwright

```typescript
import { chromium } from "playwright-core";

// HTTP URL — auto-resolves via /json/version
const browser = await chromium.connectOverCDP("http://localhost:9500");

// Or direct WebSocket
const browser = await chromium.connectOverCDP("ws://localhost:9500/v1/connect");

const page = await browser.newPage();
await page.goto("https://example.com");
console.log(await page.title());
await browser.close();
```

With authentication:

```typescript
const browser = await chromium.connectOverCDP("http://localhost:9500?token=my-secret");
```

## Puppeteer

```typescript
import puppeteer from "puppeteer-core";

const browser = await puppeteer.connect({
  browserWSEndpoint: "ws://localhost:9500/v1/connect",
});

const page = await browser.newPage();
await page.goto("https://example.com");
console.log(await page.title());
await browser.close();
```

With authentication:

```typescript
const browser = await puppeteer.connect({
  browserWSEndpoint: "ws://localhost:9500/v1/connect?token=my-secret",
});
```

## Playwright MCP

Use all 70 Playwright MCP tools with gateway routing and failover. Add to your Claude Code or Cursor config:

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

This requires running `browser-gateway serve` separately with providers configured.

With authentication:

```json
{
  "args": ["@playwright/mcp@latest", "--cdp-endpoint", "http://localhost:9500?token=my-secret"]
}
```

## browser-use (Python)

```python
from browser_use.browser.session import BrowserSession

# HTTP URL — auto-resolves via /json/version
session = BrowserSession(cdp_url="http://localhost:9500")
await session.connect()
```

With authentication:

```python
session = BrowserSession(cdp_url="http://localhost:9500?token=my-secret")
```

## Stagehand (TypeScript)

```typescript
import { Stagehand } from "@browserbase/stagehand";

const stagehand = new Stagehand({
  env: "LOCAL",
  localBrowserLaunchOptions: {
    cdpUrl: "http://localhost:9500",
  },
});
await stagehand.init();
```

## Chrome DevTools MCP

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": ["chrome-devtools-mcp@latest", "--ws-endpoint", "ws://localhost:9500/v1/connect"]
    }
  }
}
```

## Any WebSocket Client

The gateway is a standard WebSocket proxy. Any tool that connects to a WebSocket URL works:

```
ws://localhost:9500/v1/connect
```

With authentication:

```
ws://localhost:9500/v1/connect?token=my-secret
```

## How Auto-Discovery Works

Tools that accept HTTP URLs (Playwright, browser-use, Stagehand) fetch `http://localhost:9500/json/version` and read the `webSocketDebuggerUrl` field:

```json
{
  "Browser": "browser-gateway/0.1.6",
  "Protocol-Version": "1.3",
  "webSocketDebuggerUrl": "ws://localhost:9500/v1/connect"
}
```

This is the same endpoint Chrome exposes. If you pass `?token=` in the HTTP URL, it's forwarded into the WebSocket URL automatically.
