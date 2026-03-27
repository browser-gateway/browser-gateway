import WebSocket from "ws";
import type { Logger } from "pino";
import type { ProviderState } from "../types.js";
import type { ProviderRegistry } from "./registry.js";

export class HealthChecker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private consecutiveFailures: Map<string, number> = new Map();

  constructor(
    private registry: ProviderRegistry,
    private logger: Logger,
    private intervalMs: number = 30000,
    private failureThreshold: number = 3,
    private probeTimeoutMs: number = 5000
  ) {}

  start(): void {
    if (this.registry.size() === 0) return;

    this.timer = setInterval(() => this.checkAll(), this.intervalMs);
    this.logger.info(
      { intervalMs: this.intervalMs, threshold: this.failureThreshold },
      "health checks started"
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async checkAll(): Promise<void> {
    const providers = this.registry.getAll();
    await Promise.allSettled(providers.map((b) => this.checkOne(b)));
  }

  private async checkOne(provider: ProviderState): Promise<void> {
    const { id, config } = provider;

    try {
      await this.probe(config.url);

      this.consecutiveFailures.set(id, 0);

      if (!provider.healthy && !provider.cooldownUntil) {
        provider.healthy = true;
        this.logger.info({ providerId: id }, "health check recovered");
      }
    } catch (err) {
      const failures = (this.consecutiveFailures.get(id) ?? 0) + 1;
      this.consecutiveFailures.set(id, failures);

      if (failures >= this.failureThreshold && provider.healthy) {
        provider.healthy = false;
        this.logger.warn(
          { providerId: id, consecutiveFailures: failures },
          "health check failed, marking unhealthy"
        );
      } else {
        this.logger.debug(
          { providerId: id, consecutiveFailures: failures, threshold: this.failureThreshold },
          "health check failed"
        );
      }
    }
  }

  private probe(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error("probe timeout"));
      }, this.probeTimeoutMs);

      const ws = new WebSocket(url, { handshakeTimeout: this.probeTimeoutMs });

      ws.on("open", () => {
        clearTimeout(timeout);
        ws.close();
        resolve();
      });

      ws.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }
}
