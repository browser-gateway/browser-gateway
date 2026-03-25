# Session Lifecycle

Understanding what happens when connections open and close through the gateway.

## What the Gateway Manages

The gateway manages the **transport layer** - the WebSocket pipe between your client and the backend. When a client connects, the gateway:

1. Selects a backend
2. Opens a TCP connection to the backend
3. Forwards the WebSocket upgrade handshake
4. Pipes all traffic bidirectionally
5. Tracks the session (connected time, message count, backend assignment)

When either side disconnects, the gateway:

1. Closes the other side of the pipe
2. Releases the concurrency slot for that backend
3. Updates metrics (duration, latency)
4. Removes the session from tracking

## What the Gateway Does NOT Manage

The gateway does not manage **backend-specific session lifecycle**. Some backends have their own concept of "sessions" that exist independently of the WebSocket connection.

For example:
- Some cloud providers keep a browser session alive after you disconnect, expecting you to explicitly release it
- Some providers auto-timeout idle sessions after a period (e.g., 15 minutes)
- Self-hosted Playwright servers close the browser when the WebSocket closes (no cleanup needed)
- Raw Chrome instances stay alive after the WebSocket disconnects

The gateway has no knowledge of these backend-specific behaviors. It's a transparent transport layer.

## Best Practices

### Self-hosted backends (Playwright, Chrome)

No special cleanup needed. The browser process is managed by the backend.

```typescript
const browser = await chromium.connect('ws://gateway:9500/v1/connect');
await page.goto('https://example.com');
await browser.close();  // WebSocket closes, gateway cleans up. Done.
```

### Cloud providers with managed sessions

If your cloud provider has session management (create/release lifecycle), handle it in your application code:

```typescript
// Your application manages the provider session
const session = await provider.sessions.create();

// Connect through the gateway
const browser = await chromium.connectOverCDP('ws://gateway:9500/v1/connect');
await page.goto('https://example.com');
await browser.close();

// Your application releases the provider session
await provider.sessions.release(session.id);
```

The gateway handles the WebSocket transport. Your application handles the provider session lifecycle.

### Why It Works This Way

The gateway is protocol-agnostic. It forwards raw bytes without understanding what they mean. This is what makes it work with any backend and any protocol. The trade-off is that backend-specific lifecycle management stays in the application layer, where it belongs.

This is the same model used by reverse proxies like nginx and HAProxy - they manage TCP/HTTP connections, not application sessions.

## Connection States in the Gateway

You can check active sessions at any time:

```bash
curl http://localhost:9500/v1/sessions
```

```json
{
  "count": 2,
  "sessions": [
    {
      "id": "abc123",
      "backendId": "primary",
      "connectedAt": "2026-03-25T17:00:00.000Z",
      "lastActivity": "2026-03-25T17:05:30.000Z",
      "durationMs": 330000,
      "messageCount": 847
    }
  ]
}
```

### Idle Timeout

The gateway has a configurable idle timeout. If no WebSocket messages pass through a session for the configured period, the gateway closes both sides:

```yaml
gateway:
  sessions:
    idleTimeoutMs: 300000   # 5 minutes (default)
```

This protects against leaked connections where a client disconnects without a proper close handshake (e.g., network drop, crashed process). The backend's concurrency slot is freed when the idle timeout fires.
