import type { Logger } from "pino";
import type { Gateway } from "../gateway.js";

interface WebhookConfig {
  url: string;
  events?: string[];
}

interface WebhookPayload {
  version: string;
  timestamp: string;
  event: string;
  status: "firing" | "resolved";
  source: string;
  data: Record<string, unknown>;
}

export class WebhookNotifier {
  private retryDelays = [1000, 5000, 15000];

  constructor(
    private webhooks: WebhookConfig[],
    private logger: Logger
  ) {}

  static fromGateway(gateway: Gateway, webhooks: WebhookConfig[], logger: Logger): WebhookNotifier {
    const notifier = new WebhookNotifier(webhooks, logger);

    gateway.on("provider.cooldown", (data) => {
      notifier.send("provider.cooldown", "firing", data);
    });

    gateway.on("provider.down", (data) => {
      notifier.send("provider.down", "firing", data);
    });

    gateway.on("provider.up", (data) => {
      notifier.send("provider.up", "resolved", data);
    });

    gateway.on("shutdown.start", () => {
      notifier.send("shutdown.start", "firing", {});
    });

    gateway.on("queue.timeout", (data) => {
      notifier.send("queue.timeout", "firing", data);
    });

    return notifier;
  }

  async send(event: string, status: "firing" | "resolved", data: Record<string, unknown>): Promise<void> {
    const payload: WebhookPayload = {
      version: "1",
      timestamp: new Date().toISOString(),
      event,
      status,
      source: "browser-gateway",
      data,
    };

    for (const webhook of this.webhooks) {
      if (webhook.events && !webhook.events.includes(event)) continue;

      this.deliver(webhook.url, payload).catch(() => {});
    }
  }

  private async deliver(url: string, payload: WebhookPayload, attempt = 0): Promise<void> {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      this.logger.debug({ url: url.slice(0, 50), event: payload.event }, "webhook delivered");
    } catch (err: any) {
      if (attempt < this.retryDelays.length) {
        const delay = this.retryDelays[attempt];
        this.logger.debug({ url: url.slice(0, 50), attempt: attempt + 1, delay }, "webhook retry");
        await new Promise((r) => setTimeout(r, delay));
        return this.deliver(url, payload, attempt + 1);
      }

      this.logger.warn(
        { url: url.slice(0, 50), event: payload.event, error: err.message },
        "webhook delivery failed after retries"
      );
    }
  }
}
