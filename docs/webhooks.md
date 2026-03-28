# Webhooks

Get notified when things happen in the gateway. Webhooks send HTTP POST requests to URLs you configure — useful for alerting, logging, or triggering automation.

## The Problem It Solves

You're running browser-gateway in production. A provider goes down at 3am. Without webhooks, nobody knows until users start complaining. With webhooks, you get a Slack message (or PagerDuty alert, or Discord notification) the moment it happens.

## Configuration

Add a `webhooks` section to your `gateway.yml`:

```yaml
webhooks:
  - url: https://hooks.slack.com/services/T00/B00/xxx
    events: [provider.cooldown, provider.down]
```

### Multiple webhooks

You can configure multiple webhook URLs. Each can listen to different events:

```yaml
webhooks:
  # Alert the team when a provider has issues
  - url: https://hooks.slack.com/services/T00/B00/xxx
    events: [provider.cooldown, provider.down, provider.up]

  # Log everything to a monitoring service
  - url: https://your-logging-service.com/webhooks/browser-gateway
    # No events filter = receives ALL events
```

### Filtering events

The `events` field is optional. If you omit it, that webhook receives every event. If you specify it, only those events are sent.

## Available Events

| Event | Status | When It Fires |
|-------|--------|--------------|
| `provider.cooldown` | `firing` | A provider failed too many times and entered cooldown (temporarily skipped) |
| `provider.down` | `firing` | A provider failed a health check and is marked as down |
| `provider.up` | `resolved` | A provider that was down is now healthy again |
| `shutdown.start` | `firing` | The gateway is shutting down (SIGTERM/SIGINT received) |
| `queue.timeout` | `firing` | A request waited in the queue too long and timed out |

### What each event means

**provider.cooldown** — The gateway tried to connect to a provider and it failed too often (over 50% failure rate). The provider is being skipped for 30 seconds (configurable). This is a warning sign — the provider might be having issues.

**provider.down** — A health check probe failed. The provider didn't respond to a WebSocket connection test. This is more serious than a cooldown — it means the provider is completely unreachable.

**provider.up** — A provider that was previously marked as down is now responding again. This is a recovery notification.

**shutdown.start** — The gateway received a shutdown signal (Ctrl+C or SIGTERM from Docker/systemd). It's stopping gracefully — active sessions are draining, and new connections are being rejected.

**queue.timeout** — A connection was waiting in the queue for a free provider slot, but the wait exceeded the configured `timeoutMs`. The client received a 503 error. If you see this often, you need more provider capacity.

## Webhook Payload

Every webhook receives a JSON POST body with this structure:

```json
{
  "version": "1",
  "timestamp": "2026-03-27T14:30:00.000Z",
  "event": "provider.down",
  "status": "firing",
  "source": "browser-gateway",
  "data": {
    "providerId": "my-cloud-provider",
    "reason": "connection timeout"
  }
}
```

| Field | Description |
|-------|-------------|
| `version` | Payload version (currently "1") |
| `timestamp` | ISO 8601 timestamp of when the event occurred |
| `event` | Event name (e.g., `provider.down`) |
| `status` | `"firing"` for problems, `"resolved"` for recoveries |
| `source` | Always `"browser-gateway"` |
| `data` | Event-specific details (provider ID, reason, etc.) |

## Delivery and Retries

Webhooks are delivered with automatic retries:

1. First attempt — immediate
2. Retry 1 — after 1 second
3. Retry 2 — after 5 seconds
4. Retry 3 — after 15 seconds
5. Give up — logged as a warning

Each delivery attempt has a 5-second timeout. If your webhook endpoint is slow or down, the gateway won't block — deliveries happen in the background.

## Real-World Examples

### Slack Notifications

Send provider status alerts to a Slack channel:

```yaml
webhooks:
  - url: https://hooks.slack.com/services/T00000000/B00000000/xxxxxxxxxxxxxxxxxxxxxxxx
    events: [provider.down, provider.up, provider.cooldown]
```

Slack incoming webhooks accept any JSON payload. You'll see the raw JSON in the channel. For formatted messages, put a small proxy service in between that transforms the payload into Slack's Block Kit format.

### Discord Notifications

Discord webhooks also accept JSON POST:

```yaml
webhooks:
  - url: https://discord.com/api/webhooks/000000000/xxxxxxxxxxxx
```

### Custom Monitoring

Send all events to your own monitoring endpoint:

```yaml
webhooks:
  - url: https://your-app.com/api/gateway-events
```

Your endpoint receives the JSON payload and can store it, graph it, trigger alerts — whatever you need.

### Environment Variable for Secrets

Never put webhook URLs with tokens directly in the config file. Use environment variables:

```yaml
webhooks:
  - url: ${SLACK_WEBHOOK_URL}
    events: [provider.down, provider.up]
```

```bash
# .env
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/T00/B00/xxx
```

## Tips

- **Start with `provider.down` and `provider.up`** — these are the most important events. You want to know when a provider goes offline and when it recovers.
- **Don't alert on every cooldown** — cooldowns are short (30 seconds) and auto-recover. They're more of a heads-up than an emergency. Consider logging them rather than alerting.
- **`queue.timeout` means you need more capacity** — if you're getting these regularly, add more providers or increase `maxConcurrent` limits.
- **`shutdown.start` is useful for ops** — know when the gateway is restarting, especially in Docker/Kubernetes environments.
