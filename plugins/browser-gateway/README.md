# browser-gateway for coding agents

Gives your coding agent a real browser for the pages its built-in web fetch cannot read: sites that block simple fetchers (403, 429, captcha), pages that need JavaScript, pages behind a login, and screenshots of websites.

Two tools do most of the work:

| Tool | What it does |
|---|---|
| `fetch_page` | Loads a url in a real browser and returns clean markdown. One call; the browser opens and closes on its own. |
| `screenshot_page` | Loads a url and returns a screenshot. One call. |

For multi-step work (logging in, filling forms) the agent opens a `browser_session` and uses the other `browser_*` tools.

## Claude Code

```
/plugin marketplace add browser-gateway/browser-gateway
/plugin install browser-gateway@browser-gateway
```

You are asked for your router key, from the Routers page of the BrowserGateway dashboard. Sessions run on your router's providers.

To run a browser on your own machine instead:

```
/plugin install browser-gateway-local@browser-gateway
```

Both plugins add a hook: when WebFetch gets a 403, 402 or 429, an empty page, or a bot check, Claude is told to retry the same url with `fetch_page`. The hook only adds a suggestion. It never fetches anything itself and costs nothing when the fetch worked.

## Codex

Put your router key in an environment variable named `BROWSER_GATEWAY_ROUTER_KEY`, then add the server to `~/.codex/config.toml`:

```toml
[mcp_servers.browser-gateway]
url = "https://cdp.browsergateway.io/mcp"
bearer_token_env_var = "BROWSER_GATEWAY_ROUTER_KEY"
```

Add to your `AGENTS.md`:

```
Web pages: try curl or the built-in fetch first. If it fails or returns 403, 402, 429, a captcha, a login wall or an almost empty page, use the browser-gateway fetch_page tool on the same url. For screenshots of websites use browser-gateway screenshot_page.
```

## Cursor

Add the server to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "browser-gateway": {
      "url": "https://cdp.browsergateway.io/mcp",
      "headers": { "Authorization": "Bearer <router key>" }
    }
  }
}
```

Save the same `AGENTS.md` text as a rule in `.cursor/rules/browser-gateway.mdc` with the description "Use when a web page cannot be fetched or a website screenshot is needed".

## Gemini CLI

Add the server to `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "browser-gateway": {
      "httpUrl": "https://cdp.browsergateway.io/mcp",
      "headers": { "Authorization": "Bearer <router key>" }
    }
  }
}
```

Put the `AGENTS.md` text in `GEMINI.md`.

## claude.ai and ChatGPT

Add the connector link from your BrowserGateway dashboard (it starts with `https://cdp.browsergateway.io/mcp/u/`) as a custom connector. In claude.ai, set the connector's tool access to "Always available" so Claude sees the tools without searching for them. In ChatGPT, mention the app in your message when you want it used.

## Self-hosted gateway

Point any of the above at your own gateway's `/mcp` endpoint, or run `npx browser-gateway mcp` as a local stdio server.
