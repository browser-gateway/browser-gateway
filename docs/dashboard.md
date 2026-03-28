# Web Dashboard

browser-gateway includes a built-in web dashboard for monitoring and managing your gateway. No extra tools needed — it's served from the same port as the gateway itself.

```
http://localhost:9500/web
```

## What You Can Do From the Dashboard

- See which providers are healthy and which are down
- Monitor active browser sessions in real-time
- Add, edit, delete, and test providers without touching config files
- Edit your `gateway.yml` with syntax highlighting and validation
- Copy the WebSocket connection URL for your code

Everything updates automatically every 3-5 seconds.

## Pages

The dashboard has 5 pages, accessible from the sidebar.

### Overview

The first thing you see. Shows the current state of your gateway at a glance.

**What's on this page:**

- **Connection Endpoint** — The WebSocket URL your code should connect to (e.g., `ws://localhost:9500/v1/connect`). Includes copy-paste code snippets for both Playwright and Puppeteer. The URL automatically adjusts based on how you're accessing the dashboard — if you're on HTTPS, it shows `wss://`, otherwise `ws://`.

- **Stats Cards** — Three cards showing:
  - Active sessions (how many browser connections are open right now)
  - Providers (how many are healthy out of total, e.g., "2/3")
  - Strategy (which load balancing strategy is active)

- **Provider List** — A card for each provider showing:
  - Health status (green dot = healthy, red pulsing dot = down or in cooldown)
  - Active connections vs. maximum (e.g., "3/10")
  - Average connection latency
  - Total connections routed (lifetime)
  - Cooldown status (if the provider is temporarily skipped due to failures)

**If you have no providers yet**, the overview shows a friendly "Get Started" card explaining what providers are and linking to the Providers page.

### Providers

Where you manage your browser providers. This is the most interactive page.

**Adding a provider:**

Click "Add Provider" to open a dialog. Fill in:

| Field | Required | What It Means |
|-------|----------|--------------|
| Provider Name | Yes | A short name you'll recognize (e.g., `my-playwright`, `cloud-primary`). Lowercase with hyphens. |
| WebSocket URL | Yes | The `ws://` or `wss://` URL of your browser provider, including any API keys in the URL. |
| Max Connections | No | How many simultaneous browser sessions this provider can handle. Leave empty for no limit. |
| Priority | No | Lower number = tried first. Use 1 for primary, 2 for fallback, 3 for last resort. Default: 1. |

You can **test the connection** right from the dialog before saving — click the test button next to the URL field. It'll tell you if the provider is reachable and how fast.

**If you've never added a provider**, the page shows examples of common provider types:
- **Playwright Server** — A self-hosted Playwright instance (`ws://host:3000`)
- **Cloud Browser Service** — Any cloud provider with a WebSocket URL and API key
- **Chrome Remote Debugging** — A Chrome instance with `--remote-debugging-port`

**For each existing provider**, you can:
- **Test** — Check if the provider is reachable right now (shows latency or error)
- **Edit** — Change the URL, limits, or priority
- **Delete** — Remove it from the gateway

Changes are saved to your `gateway.yml` automatically.

### Sessions

A live table of every active browser connection going through the gateway.

| Column | What It Shows |
|--------|--------------|
| Session | Short ID for the connection |
| Provider | Which provider this session is routed to |
| Connected | When the connection was opened |
| Duration | How long the session has been active |
| Messages | Total WebSocket messages exchanged |

This page is read-only — you're observing active connections, not managing them. It refreshes every 3 seconds.

When no sessions are active, it shows "No active sessions."

### Config

A full YAML editor for your `gateway.yml` file.

**What you can do:**
- Edit the YAML directly in the browser (syntax highlighting, monospace font)
- Click **Validate** to check if your YAML is valid without saving
- Click **Save** to write changes back to disk (a backup is created automatically before each save)
- Click **Discard** to throw away unsaved changes

The editor shows the file path where the config is stored. Validation feedback appears below the editor — green for valid, red with specific error messages for invalid YAML.

**Tip**: Provider changes made here require a gateway restart to take effect. For live provider changes, use the Providers page instead.

### Logs

Coming in a future update. For now, check the terminal where you ran `browser-gateway serve` — the gateway outputs structured JSON logs there.

## Authentication

If you've set `BG_TOKEN` (via environment variable or `.env` file), the dashboard requires authentication.

**How it works:**

1. Open the dashboard — you see a login form
2. Enter your gateway token (the value of `BG_TOKEN`)
3. The dashboard sets a secure HttpOnly cookie in your browser
4. You stay logged in until you log out or the cookie expires

The cookie is tied to your `BG_TOKEN` value, so it survives gateway restarts. If you change `BG_TOKEN`, everyone gets logged out.

**If `BG_TOKEN` is not set**, there's no login form — the dashboard is open to anyone who can reach it. Only do this on private networks or localhost.

## Accessing the Dashboard

### Local development

```
http://localhost:9500/web
```

### Docker

Map port 9500 and open in your browser:

```bash
docker run -d -p 9500:9500 ghcr.io/browser-gateway/server:latest
# Open http://localhost:9500/web
```

### Remote server

If running on a remote server, access via the server's IP or domain:

```
http://your-server:9500/web
```

**Important**: If the dashboard is exposed to the internet, always set `BG_TOKEN` to require authentication. Without it, anyone can view your providers, sessions, and config.

For HTTPS, put the gateway behind a reverse proxy (nginx, Caddy, Traefik) that handles TLS. The dashboard automatically detects HTTPS and shows `wss://` in the connection URL.

## Disabling the Dashboard

If you don't need the web UI (e.g., API-only usage):

```yaml
dashboard:
  enabled: false
```

The gateway still works normally — you just won't have the `/web` route.

## Tips

- **The overview page is your health check.** Glance at it to see if all providers are green and how many sessions are active.
- **Test before you save.** When adding a provider, always use the test button to verify connectivity before saving. Saves you from debugging typos in URLs.
- **Use the config page for advanced settings.** Things like cooldown thresholds, queue size, and webhook URLs are easier to set in YAML than through individual forms.
- **Sessions page helps debug "where did my connection go?"** If a client connects and you're not sure which provider it landed on, check the sessions table.
