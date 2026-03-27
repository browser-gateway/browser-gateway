# Load Balancing Strategies

browser-gateway supports multiple strategies for choosing which provider handles each connection.

## Available Strategies

### priority-chain (default)

Providers are tried in order of their configured `priority` (lowest number first). The first available provider handles the connection.

```yaml
gateway:
  defaultStrategy: priority-chain

providers:
  primary:
    url: ws://primary:3000
    priority: 1        # Always tried first

  secondary:
    url: ws://secondary:3000
    priority: 2        # Only when primary is full or in cooldown

  emergency:
    url: ws://emergency:3000
    priority: 3        # Last resort
```

**Best for**: Maximizing free tier usage, having a clear primary/fallback hierarchy.

### round-robin

Connections are distributed evenly across all available providers, rotating through them.

```yaml
gateway:
  defaultStrategy: round-robin

providers:
  server-1:
    url: ws://server-1:3000
    priority: 1

  server-2:
    url: ws://server-2:3000
    priority: 1

  server-3:
    url: ws://server-3:3000
    priority: 1
```

**Best for**: Spreading load evenly when all providers have similar capacity.

### least-connections

Each connection goes to the provider with the fewest active connections at that moment.

```yaml
gateway:
  defaultStrategy: least-connections
```

**Best for**: Providers with different capacities where you want to keep them balanced by actual load.

## How Strategy Interacts with Failover

The strategy only determines the **order** providers are tried. Failover still applies:

1. Strategy picks the order: [A, B, C]
2. A is tried first - if it's in cooldown or at capacity, skip to B
3. B is tried - if it fails to connect, skip to C
4. C succeeds - connection established

The strategy never overrides health checks or concurrency limits. An unhealthy provider is always skipped regardless of strategy.

## Providers with Same Priority

When multiple providers have the same priority:

- **priority-chain**: Tries them in config file order
- **round-robin**: Rotates through them
- **least-connections**: Picks the least busy one

## Examples

### Free Tier Maximizer

Use free tiers first, paid as overflow:

```yaml
gateway:
  defaultStrategy: priority-chain

providers:
  free-tier:
    url: wss://provider.example.com?token=${FREE_TOKEN}
    limits:
      maxConcurrent: 3
    priority: 1

  self-hosted:
    url: ws://my-server:3000
    limits:
      maxConcurrent: 10
    priority: 2

  paid-tier:
    url: wss://provider.example.com?token=${PAID_TOKEN}
    limits:
      maxConcurrent: 50
    priority: 3
```

### Load Spreader

Distribute evenly across identical servers:

```yaml
gateway:
  defaultStrategy: least-connections

providers:
  server-a:
    url: ws://10.0.1.1:3000
    limits:
      maxConcurrent: 20
    priority: 1

  server-b:
    url: ws://10.0.1.2:3000
    limits:
      maxConcurrent: 20
    priority: 1

  server-c:
    url: ws://10.0.1.3:3000
    limits:
      maxConcurrent: 20
    priority: 1
```
