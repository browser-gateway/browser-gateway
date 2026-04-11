# REST API

The gateway provides simple HTTP endpoints for common browser operations. Instead of managing WebSocket connections, you send a POST request and get back the result.

Each request gets a fresh, isolated browser page. The gateway handles everything: routing to the best available provider, load balancing, retries on failure, and connection pooling.

## Endpoints

### POST /v1/screenshot

Capture a screenshot of any URL.

**Request:**
```json
{
  "url": "https://example.com",
  "fullPage": false,
  "format": "png",
  "quality": 80,
  "viewport": { "width": 1280, "height": 720 },
  "selector": "#main",
  "scrollPage": false,
  "omitBackground": false,
  "waitUntil": "load",
  "waitForSelector": ".content-loaded",
  "waitForTimeout": 2000,
  "timeout": 30000,
  "retries": 2
}
```

Only `url` is required. Everything else has sensible defaults.

**Response:** Binary image (PNG or JPEG) with headers:
- `Content-Type: image/png` or `image/jpeg`
- `X-Response-Code: 200` — HTTP status of the target page
- `X-Response-URL: https://example.com/` — final URL after redirects
- `X-Timing-Total-Ms: 1250` — total request time
- `X-Timing-Navigation-Ms: 800` — time spent navigating

**Options:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| url | string | required | URL to screenshot |
| fullPage | boolean | false | Capture the entire scrollable page |
| format | "png" \| "jpeg" | "png" | Image format |
| quality | number (0-100) | 80 for jpeg | JPEG quality (ignored for PNG) |
| viewport | {width, height} | 1280x720 | Browser viewport size |
| selector | string | — | Screenshot only this CSS selector element |
| scrollPage | boolean | false | Scroll the page first to trigger lazy-loaded images |
| omitBackground | boolean | false | Transparent background (PNG only) |
| clip | {x, y, width, height} | — | Capture a specific region |
| waitUntil | string | "load" | When to consider navigation done |
| waitForSelector | string | — | Wait for this element before capturing |
| waitForTimeout | number | — | Additional delay in ms |
| timeout | number | 30000 | Max time for the entire operation (ms) |
| retries | number | 2 | Retry on transient failures (0 to disable) |

### POST /v1/content

Extract page content in multiple formats.

**Request:**
```json
{
  "url": "https://example.com",
  "formats": ["markdown", "text", "html", "readability"],
  "waitUntil": "domcontentloaded",
  "timeout": 30000
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "url": "https://example.com/",
    "statusCode": 200,
    "content": {
      "markdown": "# Example Domain\n\nThis domain is for use in...",
      "text": "Example Domain\nThis domain is for use in...",
      "html": "<html>...</html>",
      "readability": "<div>...</div>"
    },
    "metadata": {
      "title": "Example Domain",
      "description": "",
      "author": "",
      "published": "",
      "language": "en",
      "image": "",
      "favicon": "",
      "wordCount": 17,
      "site": ""
    },
    "links": [
      { "url": "https://iana.org/domains/example", "text": "Learn more" }
    ]
  },
  "timings": {
    "total": 1250,
    "navigation": 800,
    "action": 350
  }
}
```

**Formats:**

| Format | What you get |
|--------|-------------|
| markdown | Clean markdown of the main page content (ads, nav, footer stripped) |
| text | Plain text of the page body |
| html | Full rendered HTML after JavaScript execution |
| readability | Cleaned HTML of the main article content |

### POST /v1/scrape

Extract specific data from a page using CSS selectors, full-page formats, or both.

**Request (selectors):**
```json
{
  "url": "https://example.com",
  "selectors": [
    { "name": "title", "selector": "h1" },
    { "name": "price", "selector": ".price", "attribute": "data-value" }
  ]
}
```

**Request (formats):**
```json
{
  "url": "https://example.com",
  "formats": ["markdown"]
}
```

**Request (both):**
```json
{
  "url": "https://example.com",
  "selectors": [{ "name": "title", "selector": "h1" }],
  "formats": ["markdown"],
  "screenshot": true
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "url": "https://example.com/",
    "statusCode": 200,
    "selectors": [
      {
        "name": "title",
        "selector": "h1",
        "results": [
          { "text": "Example Domain", "html": "Example Domain" }
        ]
      }
    ],
    "content": {
      "markdown": "# Example Domain\n\nThis domain is for use in..."
    },
    "screenshot": "/9j/4AAQSkZJRg..." 
  }
}
```

The `screenshot` field is a base64-encoded JPEG when `"screenshot": true` is set.

## Authentication

REST API endpoints require the same authentication as all `/v1/*` endpoints. Pass your token via:

- Query parameter: `?token=your-token`
- Header: `Authorization: Bearer your-token`
- Cookie: `bg_session` (set by dashboard login)

## Session Pool

The gateway maintains a pool of browser sessions to serve REST requests efficiently. Instead of opening a new browser connection for every request, pages are created within existing browser sessions.

**How it works:**
- Each request gets an isolated browser context + page (separate cookies, storage)
- Multiple requests share the same browser connection (one connection serves many pages)
- Sessions are created on demand and closed when idle
- Sessions are recycled after serving a configurable number of pages (prevents memory leaks)

**Configuration:**
```yaml
pool:
  minSessions: 0          # 0 = scale to zero when idle (no browser running)
  maxSessions: 5           # max browser connections from pool
  maxPagesPerSession: 10   # pages per browser before creating another
  retireAfterPages: 100    # recycle browser after this many total pages
  retireAfterMs: 3600000   # recycle after 1 hour max
  idleTimeoutMs: 300000    # close idle browsers after 5 minutes
```

**Scaling behavior:**
- Pool starts empty (`minSessions: 0`) — no browser running until first request
- When a browser is full, a new one is created automatically
- When load drops, idle browsers are closed
- Set `minSessions: 1` if you want zero cold start (keeps one browser warm)

## Retries

Requests are automatically retried on transient failures:

- **Retried:** Timeouts, browser crashes, provider capacity errors, connection resets
- **Not retried:** DNS errors, invalid URLs, SSL errors, auth failures

Each retry gets a fresh browser page (never reuses a failed page). Default is 2 retries (3 total attempts). Set `"retries": 0` to disable.

## Error Responses

| Status | Meaning |
|--------|---------|
| 400 | Invalid request (missing URL, bad format, etc.) |
| 401 | Missing or invalid authentication |
| 408 | Navigation timeout (page took too long to load) |
| 500 | Unexpected error |
| 503 | No providers available |

All error responses follow the same shape:
```json
{
  "success": false,
  "error": "Description of what went wrong"
}
```

## Performance

REST requests go through the gateway's WebSocket proxy internally. The gateway routing layer adds approximately 20ms of overhead. The dominant factor in request latency is the browser provider speed and the complexity of the target page.

**Tips for best performance:**
- Use `waitUntil: "domcontentloaded"` for content/scrape (faster than `"load"`)
- Use `waitUntil: "load"` for screenshots (ensures images are loaded)
- Use weighted or priority-chain strategy when mixing fast and slow providers
- Increase `maxPagesPerSession` if your providers have enough memory
