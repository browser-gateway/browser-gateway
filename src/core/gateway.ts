import type { Logger } from "pino";
import type { GatewayConfig, ProviderState, Session } from "./types.js";
import { ProviderRegistry } from "./providers/registry.js";
import { HealthChecker } from "./providers/health.js";
import { ProviderSelector, type Strategy } from "./router/selector.js";
import { ConcurrencyTracker } from "./tracking/concurrency.js";
import { CooldownTracker } from "./tracking/cooldown.js";
import { SessionTracker } from "./proxy/session.js";

export class Gateway {
  readonly config: GatewayConfig;
  readonly registry: ProviderRegistry;
  readonly selector: ProviderSelector;
  readonly concurrency: ConcurrencyTracker;
  readonly cooldown: CooldownTracker;
  readonly sessions: SessionTracker;
  readonly healthChecker: HealthChecker;
  readonly logger: Logger;

  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private idleCheckTimer: ReturnType<typeof setInterval> | null = null;
  private onIdleSession?: (sessionId: string) => void;

  constructor(config: GatewayConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;

    this.registry = new ProviderRegistry();
    this.concurrency = new ConcurrencyTracker();
    this.cooldown = new CooldownTracker(config.gateway.cooldown);
    this.sessions = new SessionTracker();

    for (const [id, providerConfig] of Object.entries(config.providers)) {
      this.registry.register(id, providerConfig);
      this.logger.info({ providerId: id, url: this.maskUrl(providerConfig.url) }, "provider registered");
    }

    this.selector = new ProviderSelector(
      this.registry,
      this.cooldown,
      config.gateway.defaultStrategy as Strategy
    );

    this.healthChecker = new HealthChecker(
      this.registry,
      this.logger,
      config.gateway.healthCheckInterval
    );

    this.logger.info(
      { providers: this.registry.size(), strategy: config.gateway.defaultStrategy },
      "gateway initialized"
    );
  }

  selectProvider(): ProviderState | null {
    const candidates = this.selector.getCandidates();
    return candidates[0] ?? null;
  }

  selectProviderWithFallbacks(): ProviderState[] {
    return this.selector.getCandidates();
  }

  acquireSlot(providerId: string, sessionId: string): boolean {
    const provider = this.registry.get(providerId);
    if (!provider) return false;
    return this.concurrency.acquire(providerId, sessionId, provider);
  }

  releaseSlot(sessionId: string, providerId: string): void {
    const provider = this.registry.get(providerId);
    if (!provider) return;
    this.concurrency.release(sessionId, provider);
  }

  recordSuccess(providerId: string, latencyMs: number): void {
    const provider = this.registry.get(providerId);
    if (!provider) return;
    this.cooldown.recordSuccess(provider);

    const alpha = 0.3;
    provider.avgLatencyMs = provider.avgLatencyMs === 0
      ? latencyMs
      : alpha * latencyMs + (1 - alpha) * provider.avgLatencyMs;
  }

  recordFailure(providerId: string): void {
    const provider = this.registry.get(providerId);
    if (!provider) return;
    this.cooldown.recordFailure(provider);

    this.logger.warn(
      {
        providerId,
        failureCount: provider.failureCount,
        cooldownUntil: provider.cooldownUntil,
      },
      provider.cooldownUntil ? "provider entered cooldown" : "provider failure recorded"
    );
  }

  getStatus(): {
    providers: ProviderState[];
    activeSessions: number;
    strategy: string;
  } {
    return {
      providers: this.registry.getAll(),
      activeSessions: this.sessions.count(),
      strategy: this.config.gateway.defaultStrategy,
    };
  }

  setIdleSessionHandler(handler: (sessionId: string) => void): void {
    this.onIdleSession = handler;
  }

  start(): void {
    this.reconcileTimer = setInterval(() => {
      const providers = new Map(
        this.registry.getAll().map((b) => [b.id, b])
      );
      const cleaned = this.concurrency.reconcile(
        providers,
        this.config.gateway.sessions.idleTimeoutMs * 2
      );
      if (cleaned > 0) {
        this.logger.warn({ cleaned }, "reconciled stale concurrency entries");
      }
    }, 30_000);

    const idleTimeoutMs = this.config.gateway.sessions.idleTimeoutMs;
    this.idleCheckTimer = setInterval(() => {
      const idleSessions = this.sessions.getIdleSessions(idleTimeoutMs);
      for (const session of idleSessions) {
        this.logger.warn(
          { sessionId: session.id, providerId: session.providerId, idleMs: Date.now() - session.lastActivity },
          "terminating idle session"
        );
        this.onIdleSession?.(session.id);
      }
    }, Math.min(idleTimeoutMs, 30_000));

    this.healthChecker.start();
    this.logger.info("gateway started");
  }

  stop(): void {
    this.healthChecker.stop();
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    if (this.idleCheckTimer) clearInterval(this.idleCheckTimer);
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
