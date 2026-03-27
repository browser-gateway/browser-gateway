# How Failover Works

browser-gateway automatically routes connections to healthy providers. When a provider fails, the next one is tried instantly. Your client never knows a failover happened.

## The Failover Chain

When a client connects to `/v1/connect`, the gateway:

1. Gets the list of configured providers, sorted by priority
2. Filters out providers that are in cooldown (recently failed too much)
3. Filters out providers at their `maxConcurrent` limit
4. Tries to connect to the first available provider
5. If it fails, tries the next one
6. If all fail, returns 503

```
Client connects
  |
  v
Provider A (priority 1) --> Connection refused
  |                            |
  |                     Record failure, try next
  v
Provider B (priority 2) --> Timeout after 10s
  |                            |
  |                     Record failure, try next
  v
Provider C (priority 3) --> Connected!
  |
  v
Session established. Client has no idea A and B were tried.
```

## What Triggers Failover

The gateway fails over to the next provider when:

- **Connection refused** - Provider is down or unreachable
- **Connection timeout** - Provider didn't respond within `connectionTimeout` (default: 10s)
- **WebSocket error** - Provider accepted TCP but rejected the WebSocket upgrade
- **Provider at capacity** - Provider's `maxConcurrent` limit is reached (skipped, not even attempted)
- **Provider in cooldown** - Provider failed too recently (skipped automatically)

## What Does NOT Trigger Failover

Once a session is established (client and provider are connected and exchanging messages), the gateway does not intervene. If the provider drops the session mid-use, the client receives the disconnect. The gateway does not try to reconnect to another provider mid-session.

This is by design. Browser sessions have state (cookies, page history, DOM). You can't transparently move a session to a different provider.

## Cooldown System

When a provider fails repeatedly, the gateway puts it in "cooldown" - temporarily removing it from the pool so it stops receiving connection attempts.

### How Cooldown Works

1. The gateway tracks successes and failures per provider over a 60-second window
2. When the failure rate exceeds the threshold (default: 50%), the provider enters cooldown
3. During cooldown, the provider is skipped entirely - no connection attempts
4. After the cooldown period expires (default: 30 seconds), the provider re-enters the pool
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

Traditional circuit breakers need health probes to test if a provider has recovered. Our TTL-based cooldown doesn't - it just waits for the timer to expire and tries again. This means:

- Zero extra load on a struggling provider (no health probe requests)
- Simple to reason about (either in cooldown or not)
- Automatically adapts (if the provider recovers quickly, the next connection works)

### Single Provider Protection

If you only have one provider configured, the cooldown threshold is much higher (100% failure rate with 5+ attempts). This prevents the gateway from disabling your only provider over a few transient errors.

## Checking Failover Status

```bash
curl http://localhost:9500/v1/status
```

```json
{
  "providers": [
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

A provider with `healthy: false` and a `cooldownUntil` timestamp is in cooldown. It will automatically recover when the timestamp passes.
