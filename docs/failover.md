# How Failover Works

browser-gateway automatically routes connections to healthy backends. When a backend fails, the next one is tried instantly. Your client never knows a failover happened.

## The Failover Chain

When a client connects to `/v1/connect`, the gateway:

1. Gets the list of configured backends, sorted by priority
2. Filters out backends that are in cooldown (recently failed too much)
3. Filters out backends at their `maxConcurrent` limit
4. Tries to connect to the first available backend
5. If it fails, tries the next one
6. If all fail, returns 503

```
Client connects
  |
  v
Backend A (priority 1) --> Connection refused
  |                            |
  |                     Record failure, try next
  v
Backend B (priority 2) --> Timeout after 10s
  |                            |
  |                     Record failure, try next
  v
Backend C (priority 3) --> Connected!
  |
  v
Session established. Client has no idea A and B were tried.
```

## What Triggers Failover

The gateway fails over to the next backend when:

- **Connection refused** - Backend is down or unreachable
- **Connection timeout** - Backend didn't respond within `connectionTimeout` (default: 10s)
- **WebSocket error** - Backend accepted TCP but rejected the WebSocket upgrade
- **Backend at capacity** - Backend's `maxConcurrent` limit is reached (skipped, not even attempted)
- **Backend in cooldown** - Backend failed too recently (skipped automatically)

## What Does NOT Trigger Failover

Once a session is established (client and backend are connected and exchanging messages), the gateway does not intervene. If the backend drops the session mid-use, the client receives the disconnect. The gateway does not try to reconnect to another backend mid-session.

This is by design. Browser sessions have state (cookies, page history, DOM). You can't transparently move a session to a different backend.

## Cooldown System

When a backend fails repeatedly, the gateway puts it in "cooldown" - temporarily removing it from the pool so it stops receiving connection attempts.

### How Cooldown Works

1. The gateway tracks successes and failures per backend over a 60-second window
2. When the failure rate exceeds the threshold (default: 50%), the backend enters cooldown
3. During cooldown, the backend is skipped entirely - no connection attempts
4. After the cooldown period expires (default: 30 seconds), the backend re-enters the pool
5. If it fails again, a new cooldown starts

### Cooldown Configuration

```yaml
gateway:
  cooldown:
    defaultMs: 30000          # Cooldown duration in ms (default: 30s)
    failureThreshold: 0.5     # Trigger at >50% failure rate (default: 0.5)
    minRequestVolume: 3       # Need at least 3 attempts before evaluating (default: 3)
```

### Why This Approach

Traditional circuit breakers need health probes to test if a backend has recovered. Our TTL-based cooldown doesn't - it just waits for the timer to expire and tries again. This means:

- Zero extra load on a struggling backend (no health probe requests)
- Simple to reason about (either in cooldown or not)
- Automatically adapts (if the backend recovers quickly, the next connection works)

### Single Backend Protection

If you only have one backend configured, the cooldown threshold is much higher (100% failure rate with 5+ attempts). This prevents the gateway from disabling your only backend over a few transient errors.

## Checking Failover Status

```bash
curl http://localhost:3000/v1/status
```

```json
{
  "backends": [
    {
      "id": "primary",
      "healthy": true,
      "active": 3,
      "maxConcurrent": 5,
      "cooldownUntil": null
    },
    {
      "id": "fallback",
      "healthy": false,
      "active": 0,
      "maxConcurrent": 10,
      "cooldownUntil": "2026-03-25T17:22:06.481Z"
    }
  ]
}
```

A backend with `healthy: false` and a `cooldownUntil` timestamp is in cooldown. It will automatically recover when the timestamp passes.
