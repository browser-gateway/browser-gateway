import type { Logger } from "pino";
import type { GatewayConfig, BackendState, Session } from "./types.js";
import { BackendRegistry } from "./backends/registry.js";
import { BackendSelector, type Strategy } from "./router/selector.js";
import { ConcurrencyTracker } from "./tracking/concurrency.js";
import { CooldownTracker } from "./tracking/cooldown.js";
import { SessionTracker } from "./proxy/session.js";

export class Gateway {
  readonly config: GatewayConfig;
  readonly registry: BackendRegistry;
  readonly selector: BackendSelector;
  readonly concurrency: ConcurrencyTracker;
  readonly cooldown: CooldownTracker;
  readonly sessions: SessionTracker;
  readonly logger: Logger;

  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: GatewayConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;

    this.registry = new BackendRegistry();
    this.concurrency = new ConcurrencyTracker();
    this.cooldown = new CooldownTracker(config.gateway.cooldown);
    this.sessions = new SessionTracker();

    for (const [id, backendConfig] of Object.entries(config.backends)) {
      this.registry.register(id, backendConfig);
      this.logger.info({ backendId: id, url: this.maskUrl(backendConfig.url) }, "backend registered");
    }

    this.selector = new BackendSelector(
      this.registry,
      this.cooldown,
      config.gateway.defaultStrategy as Strategy
    );

    this.logger.info(
      { backends: this.registry.size(), strategy: config.gateway.defaultStrategy },
      "gateway initialized"
    );
  }

  selectBackend(): BackendState | null {
    const candidates = this.selector.getCandidates();
    return candidates[0] ?? null;
  }

  selectBackendWithFallbacks(): BackendState[] {
    return this.selector.getCandidates();
  }

  acquireSlot(backendId: string, sessionId: string): boolean {
    const backend = this.registry.get(backendId);
    if (!backend) return false;
    return this.concurrency.acquire(backendId, sessionId, backend);
  }

  releaseSlot(sessionId: string, backendId: string): void {
    const backend = this.registry.get(backendId);
    if (!backend) return;
    this.concurrency.release(sessionId, backend);
  }

  recordSuccess(backendId: string, latencyMs: number): void {
    const backend = this.registry.get(backendId);
    if (!backend) return;
    this.cooldown.recordSuccess(backend);

    const alpha = 0.3;
    backend.avgLatencyMs = backend.avgLatencyMs === 0
      ? latencyMs
      : alpha * latencyMs + (1 - alpha) * backend.avgLatencyMs;
  }

  recordFailure(backendId: string): void {
    const backend = this.registry.get(backendId);
    if (!backend) return;
    this.cooldown.recordFailure(backend);

    this.logger.warn(
      {
        backendId,
        failureCount: backend.failureCount,
        cooldownUntil: backend.cooldownUntil,
      },
      backend.cooldownUntil ? "backend entered cooldown" : "backend failure recorded"
    );
  }

  getStatus(): {
    backends: BackendState[];
    activeSessions: number;
    strategy: string;
  } {
    return {
      backends: this.registry.getAll(),
      activeSessions: this.sessions.count(),
      strategy: this.config.gateway.defaultStrategy,
    };
  }

  start(): void {
    this.reconcileTimer = setInterval(() => {
      const backends = new Map(
        this.registry.getAll().map((b) => [b.id, b])
      );
      const cleaned = this.concurrency.reconcile(
        backends,
        this.config.gateway.sessions.idleTimeoutMs * 2
      );
      if (cleaned > 0) {
        this.logger.warn({ cleaned }, "reconciled stale concurrency entries");
      }
    }, 30_000);

    this.logger.info("gateway started");
  }

  stop(): void {
    if (this.healthCheckTimer) clearInterval(this.healthCheckTimer);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.logger.info("gateway stopped");
  }

  private maskUrl(url: string): string {
    try {
      const parsed = new URL(url);
      for (const [key] of parsed.searchParams) {
        parsed.searchParams.set(key, "***");
      }
      return parsed.toString();
    } catch {
      return "***";
    }
  }
}
