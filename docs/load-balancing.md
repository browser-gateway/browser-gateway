# Load Balancing Strategies

browser-gateway supports 5 strategies for choosing which provider handles each connection. Pick the one that matches how you want traffic distributed.

## Quick Comparison

| Strategy | Best For | How It Works |
|----------|----------|--------------|
| `priority-chain` | Primary/fallback setups | Always use Provider A first, overflow to B, then C |
| `round-robin` | Equal distribution | Take turns: A, B, C, A, B, C... |
| `least-connections` | Balanced load | Send to whichever provider is least busy right now |
| `latency-optimized` | Fastest response | Send to the provider that connects fastest |
| `weighted` | Proportional distribution | Provider A gets 3x more traffic than Provider B |

## priority-chain (default)

**What it does**: Always tries providers in a fixed order. The first available one wins.

Think of it like a phone tree: call your primary contact first, if they don't answer, call the backup, then the emergency number.

```yaml
gateway:
  defaultStrategy: priority-chain

providers:
  primary:
    url: ws://primary:3000
    priority: 1        # Always tried first

  secondary:
    url: ws://secondary:3000
    priority: 2        # Only when primary is full or down

  emergency:
    url: ws://emergency:3000
    priority: 3        # Last resort
```

**When to use this**:
- You have a preferred provider (cheaper, faster, or free tier) and want to maximize its usage
- You have a clear hierarchy: production → staging → backup
- You want predictable routing: "traffic always goes to X unless it can't"

**Real-world example**: You have a free tier with 3 concurrent sessions. You want to use all 3 free slots before paying for overflow on a second provider. Set the free tier as priority 1, paid as priority 2.

## round-robin

**What it does**: Distributes connections evenly by rotating through providers. First request goes to A, second to B, third to C, fourth back to A, and so on.

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

**When to use this**:
- All your providers are identical (same hardware, same capacity)
- You want simple, even distribution
- You don't care which specific provider handles which request

**Real-world example**: You run 3 identical Playwright servers on your own hardware. Each can handle 10 sessions. Round-robin spreads the load evenly so no single server gets overloaded.

## least-connections

**What it does**: Each new connection goes to whichever provider has the fewest active connections at that moment. If Provider A has 2 active sessions and Provider B has 5, the next connection goes to A.

```yaml
gateway:
  defaultStrategy: least-connections
```

**When to use this**:
- Providers have different capacities and you want to keep them balanced by actual load
- Some connections are long-lived and others are short, so round-robin would create uneven load
- You want the gateway to actively balance based on real usage, not just take turns

**Real-world example**: You have two providers - one can handle 5 concurrent sessions, the other can handle 20. If you used round-robin, they'd each get the same number of connections, but the smaller one would hit its limit while the bigger one sits half-empty. Least-connections naturally sends more traffic to the provider with more capacity available.

## latency-optimized

**What it does**: Tracks how long it takes to establish a connection to each provider. Sends traffic to the fastest one.

The gateway measures connection time (how long the WebSocket handshake takes) for every connection. Over time, it learns which providers respond fastest and prefers them.

```yaml
gateway:
  defaultStrategy: latency-optimized
```

**When to use this**:
- You have a mix of local and cloud providers
- Network latency varies between providers
- You want the fastest possible connection time for your clients

**Real-world example**: You have a local Playwright server (connects in 5ms) and a cloud provider (connects in 200ms). Latency-optimized will heavily prefer the local server because it's faster. If the local server is full, it falls back to the cloud provider.

**Note**: This strategy needs a few connections to each provider before it has reliable latency data. The first few connections are distributed normally while it learns.

## weighted

**What it does**: Distributes traffic proportionally based on weights you assign. A provider with `weight: 3` gets 3x more traffic than a provider with `weight: 1`.

Think of it like dividing a pie. If Provider A has weight 3 and Provider B has weight 1, the pie is cut into 4 slices: A gets 3, B gets 1. That means A handles 75% of connections and B handles 25%.

```yaml
gateway:
  defaultStrategy: weighted

providers:
  big-server:
    url: ws://big-server:3000
    weight: 3          # Gets 75% of traffic (3 out of 4)

  small-server:
    url: ws://small-server:3000
    weight: 1          # Gets 25% of traffic (1 out of 4)
```

**When to use this**:
- Providers have different capacities and you want to reflect that in routing
- You want fine-grained control over traffic distribution
- You're doing gradual migrations (shift traffic slowly from old to new provider)

**Real-world example**: You have a powerful server (32GB RAM, handles 30 sessions) and a smaller one (8GB RAM, handles 10 sessions). Set the big server to `weight: 3` and the small one to `weight: 1`. The gateway sends roughly 3 connections to the big server for every 1 to the small server, matching their actual capacity.

### How the math works

Weights are relative to each other:

| Provider | Weight | Share of Traffic |
|----------|--------|-----------------|
| A | 5 | 5/(5+3+2) = 50% |
| B | 3 | 3/(5+3+2) = 30% |
| C | 2 | 2/(5+3+2) = 20% |

The default weight is 1. If you don't set weights, all providers get equal traffic (same as round-robin).

### Smooth distribution

The gateway uses a smooth round-robin algorithm (the same approach nginx uses). Instead of sending 3 requests in a row to the heavy provider, it interleaves them:

With weights A=3, B=1: the actual order is `A, A, B, A, A, A, B, A...` — not `A, A, A, B, A, A, A, B`. This prevents bursts hitting a single provider.

---

## How Strategy Interacts with Failover

The strategy determines the **order** providers are tried. Failover still applies on top of it:

1. Strategy picks the order: [A, B, C]
2. A is tried first — if it's in cooldown or at capacity, skip to B
3. B is tried — if it fails to connect, skip to C
4. C succeeds — connection established

The strategy never overrides health checks or concurrency limits. An unhealthy or full provider is always skipped regardless of which strategy you use.

## How Strategy Interacts with the Queue

If the strategy tries every provider and they're ALL full or in cooldown, the connection enters the [request queue](./request-queue.md) (if enabled). The client waits until a slot opens up on any provider.

See [Request Queue](./request-queue.md) for details.

## Providers with Same Priority

When multiple providers have the same priority:

- **priority-chain**: Tries them in config file order
- **round-robin**: Rotates through them
- **least-connections**: Picks the least busy one
- **latency-optimized**: Picks the fastest one
- **weighted**: Distributes by weight

## Changing Strategy

Set the strategy in your `gateway.yml`:

```yaml
gateway:
  defaultStrategy: weighted   # or: priority-chain, round-robin, least-connections, latency-optimized
```

You can change it while the gateway is running by editing the config through the dashboard or API. Existing sessions are not affected — only new connections use the new strategy.

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

### Capacity-Matched Distribution

Match traffic to each server's actual capacity:

```yaml
gateway:
  defaultStrategy: weighted

providers:
  powerful-server:
    url: ws://10.0.1.1:3000
    limits:
      maxConcurrent: 30
    weight: 3

  medium-server:
    url: ws://10.0.1.2:3000
    limits:
      maxConcurrent: 15
    weight: 2

  small-server:
    url: ws://10.0.1.3:3000
    limits:
      maxConcurrent: 5
    weight: 1
```

### Fastest Provider Wins

Let the gateway figure out which provider is fastest:

```yaml
gateway:
  defaultStrategy: latency-optimized

providers:
  local-playwright:
    url: ws://localhost:4000
    limits:
      maxConcurrent: 5

  cloud-provider:
    url: wss://provider.example.com?token=${TOKEN}
    limits:
      maxConcurrent: 20
```

### Gradual Migration

Slowly move traffic from old to new provider:

```yaml
gateway:
  defaultStrategy: weighted

providers:
  old-provider:
    url: wss://old.example.com?token=${OLD_TOKEN}
    weight: 7          # 70% of traffic (decreasing over time)

  new-provider:
    url: wss://new.example.com?token=${NEW_TOKEN}
    weight: 3          # 30% of traffic (increasing over time)
```

Start at 90/10, then 70/30, then 50/50, then 30/70, then cut over fully. Update the weights in the dashboard or config file — no restart needed.
