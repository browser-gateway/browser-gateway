# Session Replays

Capture a frame-accurate visual record of every routed session so you can scrub through what happened later from the dashboard.

## When To Use Them

- **AI agent debugging.** Your agent failed mid-workflow. Open the replay, watch the actual rendered pixels at the moment it broke.
- **Customer support.** A user reports "the bot didn't see the popup." Pull the session replay, confirm.
- **Audit.** Regulated industries need proof of what a headless browser actually rendered for a given session.
- **Provider comparison.** Replay the same job on Provider A vs Provider B. See where they diverge visually.

## How It Works

The gateway opens a separate CDP connection to the same provider that's handling the session, attaches to every browser Target the session creates (main page + tabs + iframes), and runs `Page.startScreencast`. Chrome emits a frame each time the rendered viewport actually changes. The gateway writes each frame as a PNG file plus one line to a `manifest.jsonl` per target, then acknowledges the frame so Chrome continues streaming.

The customer's automation code is never modified. Nothing runs inside the page being scraped. The capture is invisible to the website under test.

## Quickstart

Replays are off by default. Enable them in `gateway.yml`:

```yaml
replay:
  enabled: true
```

Restart the gateway. From the next session onward, recordings appear in the **Replays** tab of the dashboard.

That's the whole configuration. The defaults pick PNG frames, 7-day retention, and a 500 MB per-session cap.

## Configuration Reference

```yaml
replay:
  enabled: false                   # opt-in
  retentionDays: 7                 # delete completed replays older than this. 0 = keep forever
  maxBytesPerSession: 524288000    # 500 MB cap per session
  filesystem:
    path: ./replays                # resolved under $BG_DATA_DIR
  capture:
    format: png                    # png (lossless, fast) or jpeg (smaller, slower CPU)
    quality: 80                    # 1-100, only used when format=jpeg
    everyNthFrame: 1               # 1 = every visual change; bump to skip frames
```

| Field | Default | What it controls |
|---|---|---|
| `enabled` | `false` | Master switch. Off skips all capture work. |
| `retentionDays` | `7` | Daily cleanup deletes completed replays older than this. `0` keeps replays forever. |
| `maxBytesPerSession` | `500 MB` | Safety cap. Capture stops for a session that exceeds this. |
| `filesystem.path` | `./replays` | Where replays are stored under `$BG_DATA_DIR`. |
| `capture.format` | `jpeg` | `jpeg` is ~5x smaller than PNG on disk and indistinguishable for replay playback. Switch to `png` for lossless capture. |
| `capture.quality` | `70` | JPEG quality (1-100). Ignored for PNG. |
| `capture.everyNthFrame` | `1` | Frame sampling. `1` captures every visual change. |

## Storage Layout

```
$BG_DATA_DIR/replays/
  <session-id>/
    meta.json                   summary written at capture start
    complete.json               written on clean finish (endedAt, frameCount, sizeBytes)
    targets/
      <target-id>/
        manifest.jsonl          one frame record per line
        000001.png              6-digit zero-padded frame files
        000002.png
        ...
```

The 6-digit padding keeps frames in lexicographic order up to 999,999 frames per target.

## Provider Support

Replay works with any provider that supports CDP `Page.startScreencast`. The gateway probes capabilities on provider registration. Providers without screencast support skip capture silently and the session runs normally without recording.

| Capability | Replay status |
|---|---|
| `pageScreencast: "supported"` | Full capture |
| `pageScreencast: "unsupported"` | Session runs, no replay recorded, info log emitted |
| `pageScreencast: "unknown"` | Treated as unsupported |

Check provider capabilities in the dashboard under **Providers** or via `GET /v1/providers/:id`.

## REST API

| Endpoint | Method | Purpose |
|---|---|---|
| `/v1/replays` | GET | List replays (newest first). Accepts `?since=<iso>&limit=<n>`. |
| `/v1/replays/:id` | GET | Single replay metadata with per-target summaries. |
| `/v1/replays/:id` | DELETE | Permanent delete. |
| `/v1/replays/:id/targets/:targetId/manifest` | GET | Stream `manifest.jsonl` for one target. |
| `/v1/replays/:id/targets/:targetId/frames/:N.png` | GET | Single frame binary. Long-cached. |
| `/v1/replays/:id/targets/:targetId/export.mp4` | GET | H.264-encoded MP4 of the target. Requires `ffmpeg` on the gateway host. Returns 503 with install instructions when missing. |

Auth uses the standard `BG_TOKEN`.

## Retention

A daily sweep walks the replay store and deletes any session whose `endedAt` is older than `retentionDays`. Incomplete sessions (no `complete.json` written, e.g. the gateway crashed mid-capture) get a 24-hour grace period before they're eligible for deletion.

Set `retentionDays: 0` to keep replays forever. You're responsible for disk space at that point.

## Safety Caps

- **Per-session byte cap** (`maxBytesPerSession`, default 500 MB) protects against a runaway tab consuming the volume. When a session hits the cap, capture stops for that session, a warning is logged, and the existing frames are flushed.
- **Bounded write queue** (200 frames in-flight) prevents Chrome from emitting frames faster than disk can absorb. Frames over the queue limit are dropped and counted in `droppedFrames` written to `complete.json`.
- **Capture is fully isolated.** It runs on a separate CDP socket and never interferes with the customer's automation pipe.

## Dashboard

The **Replays** tab lists captured sessions with provider, profile, duration, frame count, size, and status. Click any row to open the player.

The player is an image-swap loop driven by manifest timestamps. Play, pause, scrub, jump to start or end. Each target captured during the session appears as a pill above the player so you can switch between tabs.

## Cross-references

- **Profiles + replay.** When `?profile=<id>` is used on a session, the replay's metadata includes the `profileId`. The Profile detail page surfaces the most recent replays that used that profile.
- **Provider pinning + replay.** REST endpoints with a `provider` field still record. The replay's `providerId` reflects the pinned provider.
- **Live view + replay.** Both use CDP screencast but serve different purposes. Live view streams real-time to the dashboard. Replay persists to disk for later playback.

## What gets recorded

| Connection type | Recorded? |
|---|---|
| `WS /v1/connect` (Puppeteer, Playwright, MCP clients) | Yes |
| `WS /v1/live` (Playground page) | Yes |
| `POST /v1/screenshot` / `/v1/content` / `/v1/scrape` | No |

REST endpoints are single-shot operations that complete in seconds. Capturing them would dominate the request budget. The cost is also high for what you'd see — a couple of frames of a page load. Use the Playground if you need to inspect a one-off page interactively.

## MP4 export

The dashboard player exposes an **Export as MP4** button. The endpoint runs `ffmpeg` to encode the captured frames into an H.264 MP4 with variable per-frame durations honoring the original timestamps.

The gateway looks for ffmpeg in this order:

1. `ffmpeg` on the system `PATH` (preferred — uses your OS install, smaller footprint)
2. `$BG_DATA_DIR/.npm/node_modules/ffmpeg-static/ffmpeg` (auto-installed fallback)

The Docker image ships with `ffmpeg` pre-installed, so no setup is needed for containerized deploys.

For npm installs, you have two options:

### Option 1 — system install (recommended)

```bash
# macOS
brew install ffmpeg

# Debian / Ubuntu
apt install ffmpeg

# Fedora / RHEL
dnf install ffmpeg
```

### Option 2 — automatic install from the dashboard

Click **Install ffmpeg automatically** in the export dialog. The gateway runs `npm install ffmpeg-static` into `$BG_DATA_DIR/.npm/`, which adds ~80 MB to the data directory and survives restarts. Requires `npm` on the host.

The dashboard surfaces both options. The system install is faster (no download), uses a newer ffmpeg, and can be shared across multiple gateway instances on the same host. The auto-install is one click.

### REST endpoints

| Endpoint | Purpose |
|---|---|
| `GET /v1/replays/ffmpeg/status` | Returns `{ available, source, installing, localInstalled }`. |
| `POST /v1/replays/ffmpeg/install` | Triggers the `ffmpeg-static` install. Idempotent — concurrent calls share the same in-flight install. |

When `ffmpeg` is missing entirely, the export endpoint returns `503` with platform-specific install hints + a `canAutoInstall: true` flag in the JSON body.

## Limitations

- Capture skips providers without `pageScreencast` support. Sessions still run, just without a recording.
- No PII redaction yet. If you record sessions handling sensitive data, configure short retention and restrict dashboard access.
- Replays are stored on local disk. Operators running multi-instance deployments need to point all instances at a shared mount.

## Troubleshooting

**No replays appear after enabling.** Confirm the provider supports `pageScreencast`. Check the dashboard's Providers page or `/v1/providers/:id/capabilities`.

**Frames are recorded but the player shows nothing.** Check that the gateway can serve `/v1/replays/:id/targets/:t/frames/000001.png` with a 200. If the dashboard sits behind a reverse proxy that strips long URLs or paths with dots, the frame endpoint may not reach the gateway.

**Disk fills up.** Lower `retentionDays`, set `maxBytesPerSession` to a smaller value, or bump `capture.everyNthFrame` to `2`/`3` to sample fewer frames.

**Dropped frames count is high.** Disk write throughput is the bottleneck. Move `$BG_DATA_DIR` to faster storage, or switch `capture.format` to `jpeg` to cut bytes per frame.
