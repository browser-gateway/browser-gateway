import { EventEmitter } from "node:events";
import type { Logger } from "pino";
import type { GatewayConfig, ProviderState, Session } from "./types.js";
import { ProviderRegistry } from "./providers/registry.js";
import { HealthChecker } from "./providers/health.js";
import { ProviderSelector, type Strategy } from "./router/selector.js";
import { ConcurrencyTracker } from "./tracking/concurrency.js";
import { CooldownTracker } from "./tracking/cooldown.js";
import { SessionTracker } from "./proxy/session.js";

export interface GatewayEvents {
  "session.created": { sessionId: string; providerId: string };
  "session.ended": { sessionId: string; providerId: string; durationMs: number };
  "provider.down": { providerId: string; reason: string };
  "provider.up": { providerId: string };
  "provider.cooldown": { providerId: string; cooldownMs: number };
  "queue.added": { position: number; total: number };
  "queue.timeout": { waitMs: number };
  "shutdown.start": {};
  "shutdown.draining": { activeSessions: number };
  "shutdown.complete": {};
}

interface QueueEntry {
  resolve: (value: boolean) => void;
  enqueuedAt: number;
  timer: ReturnType<typeof setTimeout>;
}

export class Gateway extends EventEmitter {
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
  private queue: QueueEntry[] = [];
  private _shuttingDown = false;

  get shuttingDown(): boolean {
    return this._shuttingDown;
  }

  get queueSize(): number {
    return this.queue.length;
  }

  constructor(config: GatewayConfig, logger: Logger) {
    super();
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

    this.dequeueNext();
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

    const wasCooledDown = !!provider.cooldownUntil;
    this.cooldown.recordFailure(provider);

    if (provider.cooldownUntil && !wasCooledDown) {
      this.emit("provider.cooldown", {
        providerId,
        cooldownMs: provider.cooldownUntil - Date.now(),
      });
    }

    this.logger.warn(
      {
        providerId,
        failureCount: provider.failureCount,
        cooldownUntil: provider.cooldownUntil,
      },
      provider.cooldownUntil ? "provider entered cooldown" : "provider failure recorded"
    );
  }

  // --- Queue ---

  async waitForSlot(timeoutMs?: number): Promise<boolean> {
    if (this._shuttingDown) return false;

    const candidates = this.selector.getCandidates();
    if (candidates.length > 0) return true;

    const maxQueue = this.config.gateway.queue?.maxSize ?? 50;
    const queueTimeout = timeoutMs ?? this.config.gateway.queue?.timeoutMs ?? 30000;

    if (this.queue.length >= maxQueue) {
      this.logger.warn({ queueSize: this.queue.length, maxQueue }, "queue full, rejecting");
      return false;
    }

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.queue.findIndex((e) => e.resolve === resolve);
        if (idx !== -1) this.queue.splice(idx, 1);
        this.logger.debug({ waitMs: queueTimeout }, "queue timeout");
        this.emit("queue.timeout", { waitMs: queueTimeout });
        resolve(false);
      }, queueTimeout);

      this.queue.push({ resolve, enqueuedAt: Date.now(), timer });

      this.logger.info(
        { position: this.queue.length, total: this.queue.length },
        "request queued"
      );
      this.emit("queue.added", { position: this.queue.length, total: this.queue.length });
    });
  }

  private dequeueNext(): void {
    if (this.queue.length === 0) return;

    const candidates = this.selector.getCandidates();
    if (candidates.length === 0) return;

    const entry = this.queue.shift();
    if (!entry) return;

    clearTimeout(entry.timer);
    const waitMs = Date.now() - entry.enqueuedAt;
    this.logger.info({ waitMs, remaining: this.queue.length }, "request dequeued");
    entry.resolve(true);
  }

  private drainQueue(): void {
    for (const entry of this.queue) {
      clearTimeout(entry.timer);
      entry.resolve(false);
    }
    this.queue = [];
  }

  // --- Shutdown ---

  async gracefulShutdown(drainTimeoutMs?: number): Promise<void> {
    if (this._shuttingDown) return;
    this._shuttingDown = true;

    const timeout = drainTimeoutMs ?? this.config.gateway.shutdownDrainMs ?? 30000;

    this.logger.info("graceful shutdown initiated");
    this.emit("shutdown.start", {});

    this.drainQueue();

    const activeSessions = this.sessions.count();
    if (activeSessions > 0) {
      this.logger.info({ activeSessions, drainTimeoutMs: timeout }, "draining active sessions");
      this.emit("shutdown.draining", { activeSessions });

      await new Promise<void>((resolve) => {
        const checkInterval = setInterval(() => {
          if (this.sessions.count() === 0) {
            clearInterval(checkInterval);
            clearTimeout(forceTimer);
            resolve();
          }
        }, 500);

        const forceTimer = setTimeout(() => {
          clearInterval(checkInterval);
          const remaining = this.sessions.count();
          if (remaining > 0) {
            this.logger.warn({ remaining }, "drain timeout, force closing remaining sessions");
          }
          resolve();
        }, timeout);
      });
    }

    this.stop();
    this.logger.info("graceful shutdown complete");
    this.emit("shutdown.complete", {});
  }

  // --- Status ---

  getStatus(): {
    providers: ProviderState[];
    activeSessions: number;
    strategy: string;
    queueSize: number;
    shuttingDown: boolean;
  } {
    return {
      providers: this.registry.getAll(),
      activeSessions: this.sessions.count(),
      strategy: this.config.gateway.defaultStrategy,
      queueSize: this.queue.length,
      shuttingDown: this._shuttingDown,
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
