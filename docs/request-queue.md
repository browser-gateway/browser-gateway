# Request Queue

When all your providers are busy (every slot is taken), incoming connections wait in a queue instead of being rejected immediately.

## The Problem It Solves

Without a queue, if all providers are at capacity, the next connection attempt gets an immediate `503 Service Unavailable` error. The client has to handle retrying on its own.

With the queue, the gateway holds the connection and waits for a slot to open up. As soon as any provider has capacity, the queued connection is routed to it automatically. Your client code doesn't need retry logic — it just waits a bit longer for the connection.

```
Without queue:                          With queue:
All providers full                      All providers full
  → 503 error                             → Wait in queue
  → Client must retry                     → Slot opens on Provider B
  → Client retries                        → Automatically routed to B
  → Maybe gets through                    → Connected (client never knew)
```

## How It Works

1. Client connects to `/v1/connect`
2. Gateway tries all providers — they're all full or in cooldown
3. Instead of returning 503, the connection enters the queue
4. The client's WebSocket connection stays open (pending)
5. When any provider gets a free slot (another session ends), the first request in the queue is dequeued
6. The gateway connects the waiting client to the now-available provider
7. From the client's perspective, the connection just took a bit longer

The queue is FIFO (first in, first out) — whoever's been waiting longest gets connected first.

## Configuration

```yaml
gateway:
  queue:
    maxSize: 50          # Max requests waiting in queue (default: 50)
    timeoutMs: 30000     # How long a request waits before giving up (default: 30000 = 30 seconds)
```

### maxSize

The maximum number of connections that can wait in the queue at the same time. If the queue is full, the next connection gets a `503 Service Unavailable` immediately.

Set this based on your expected burst traffic. If you normally have 20 concurrent sessions and occasionally spike to 30, a queue size of 10-20 should handle the spikes.

### timeoutMs

How long a connection will wait in the queue before the gateway gives up and returns `503`. The default is 30 seconds.

If your clients have their own timeout (e.g., Playwright's `timeout` option), make sure the queue timeout is shorter than the client timeout. Otherwise the client will timeout before the queue does, and you'll see confusing errors.

**Tip**: If your providers have slow cold starts (some cloud providers take 10-15 seconds to spin up a browser), increase this to 45000-60000ms to give them time.

## Real-World Examples

### Handling Traffic Spikes

You have 2 providers with 5 slots each (10 total). Normally you use 6-8 slots. But occasionally a batch job kicks off 15 connections at once.

```yaml
gateway:
  queue:
    maxSize: 10        # Handle up to 10 extra requests
    timeoutMs: 30000   # Wait up to 30s for a slot

providers:
  server-a:
    url: ws://server-a:3000
    limits:
      maxConcurrent: 5

  server-b:
    url: ws://server-b:3000
    limits:
      maxConcurrent: 5
```

When the spike hits: 10 connections go through immediately, the remaining 5 wait in the queue. As the first batch of connections finish their work and disconnect, the queued connections are served.

### AI Agent Workloads

AI agents often fire off many browser sessions in parallel (scraping, form filling, testing). They don't care if a connection takes 2 seconds or 20 seconds — they just need it to eventually connect.

```yaml
gateway:
  queue:
    maxSize: 100       # Agents can queue up many requests
    timeoutMs: 60000   # Willing to wait up to 60s
```

### Low-Tolerance Workloads

For user-facing applications where speed matters, you might want a small queue with a short timeout — or no queue at all:

```yaml
gateway:
  queue:
    maxSize: 5         # Small buffer
    timeoutMs: 5000    # Give up after 5s — better to show an error than make the user wait
```

## Disabling the Queue

Set `maxSize` to 0 to disable queuing entirely. Connections will get `503` immediately when all providers are full:

```yaml
gateway:
  queue:
    maxSize: 0
```

## Monitoring the Queue

Check current queue status via the API:

```bash
curl http://localhost:9500/v1/status
```

```json
{
  "status": "ok",
  "activeSessions": 15,
  "queueSize": 3,
  "providers": [...]
}
```

`queueSize` shows how many requests are currently waiting. If you consistently see a non-zero queue, you probably need more provider capacity.

The web dashboard also shows the queue count on the overview page.

## Tips

- **Queue size is not a substitute for capacity.** If your queue is always full, add more providers or increase `maxConcurrent` limits. The queue is for handling temporary spikes, not permanent under-capacity.
- **Monitor queue wait times.** If requests are timing out in the queue regularly, your providers can't keep up with demand.
- **Combine with priority-chain for overflow.** Use priority-chain strategy with a high-priority provider (your preferred) and a low-priority overflow provider with lots of capacity. The queue only kicks in if even the overflow is full.
