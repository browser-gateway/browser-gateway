import type { Logger } from "pino";
import type { Gateway } from "../gateway.js";
import { deliverWebhook, type WebhookPayload } from "./deliver.js";

interface WebhookConfig {
  url: string;
  events?: string[];
}

export class WebhookNotifier {
  constructor(
    private webhooks: WebhookConfig[],
    private logger: Logger,
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

      deliverWebhook(webhook.url, payload, {
        onSuccess: () => {
          this.logger.debug({ url: webhook.url.slice(0, 50), event }, "webhook delivered");
        },
        onAttemptFailed: (attempt, err) => {
          this.logger.debug(
            { url: webhook.url.slice(0, 50), attempt: attempt + 1, error: err.message },
            "webhook retry",
          );
        },
        onFailure: (err) => {
          this.logger.warn(
            { url: webhook.url.slice(0, 50), event, error: err.message },
            "webhook delivery failed after retries",
          );
        },
      }).catch(() => {});
    }
  }
}
