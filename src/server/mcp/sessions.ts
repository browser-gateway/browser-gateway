import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { Gateway } from "../../core/index.js";
import { CdpClient } from "./cdp-client.js";

export interface McpBrowserSession {
  sessionId: string;
  providerId: string;
  cdp: CdpClient;
  createdAt: number;
  lastActivity: number;
}

export interface LazyProviderSetup {
  (): Promise<void>;
}

export class McpSessionManager {
  private sessions = new Map<string, McpBrowserSession>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private providerSetupPromise: Promise<void> | undefined;
  private providerSetup: LazyProviderSetup | undefined;

  constructor(
    private gateway: Gateway,
    private logger: Logger,
  ) {}

  setLazyProviderSetup(setup: LazyProviderSetup): void {
    this.providerSetup = setup;
  }

  private async ensureProviders(): Promise<void> {
    if (this.gateway.registry.size() > 0) return;
    if (!this.providerSetup) return;

    if (!this.providerSetupPromise) {
      this.providerSetupPromise = this.providerSetup().catch((e) => {
        this.providerSetupPromise = undefined;
        throw e;
      });
    }

    await this.providerSetupPromise;
  }

  async createSession(options?: {
    timeout?: number;
  }): Promise<McpBrowserSession | null> {
    await this.ensureProviders();

    const sessionId = randomUUID();
    const timeout = options?.timeout ?? this.gateway.config.gateway.queue?.timeoutMs ?? 30000;

    const tryAcquire = async (): Promise<McpBrowserSession | null> => {
      const candidates = this.gateway.selectProviderWithFallbacks();

      for (const provider of candidates) {
        if (!this.gateway.acquireSlot(provider.id, sessionId)) {
          continue;
        }

        const cdp = new CdpClient();
        try {
          await cdp.connect(provider.config.url, this.gateway.config.gateway.connectionTimeout);
          await cdp.enableDomains();

          const session: McpBrowserSession = {
            sessionId,
            providerId: provider.id,
            cdp,
            createdAt: Date.now(),
            lastActivity: Date.now(),
          };

          this.sessions.set(sessionId, session);
          this.gateway.recordSuccess(provider.id, Date.now() - session.createdAt);

          this.logger.info(
            { sessionId, providerId: provider.id },
            "mcp browser session created",
          );

          return session;
        } catch (err) {
          cdp.close();
          this.gateway.releaseSlot(sessionId, provider.id);
          this.gateway.recordFailure(provider.id);
          this.logger.warn(
            { sessionId, providerId: provider.id, error: (err as Error).message },
            "failed to connect to provider, trying next",
          );
        }
      }

      return null;
    };

    const result = await tryAcquire();
    if (result) return result;

    const slotAvailable = await this.gateway.waitForSlot(timeout);
    if (slotAvailable) {
      return tryAcquire();
    }

    this.logger.warn({ sessionId }, "mcp session creation failed - all providers unavailable");
    return null;
  }

  async releaseSession(sessionId: string): Promise<{ success: boolean; durationMs?: number }> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { success: false };
    }

    const durationMs = Date.now() - session.createdAt;

    try {
      await session.cdp.send("Browser.close").catch(() => {});
    } catch {}

    session.cdp.close();
    this.sessions.delete(sessionId);
    this.gateway.releaseSlot(sessionId, session.providerId);

    this.logger.info(
      { sessionId, providerId: session.providerId, durationMs },
      "mcp session released",
    );

    return { success: true, durationMs };
  }

  getSession(sessionId: string): McpBrowserSession | undefined {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastActivity = Date.now();
    }
    return session;
  }

  getFirstSession(): McpBrowserSession | undefined {
    const first = this.sessions.values().next();
    if (first.done) return undefined;
    first.value.lastActivity = Date.now();
    return first.value;
  }

  getAll(): McpBrowserSession[] {
    return Array.from(this.sessions.values());
  }

  count(): number {
    return this.sessions.size;
  }

  startCleanupTimer(idleTimeoutMs: number = 300000): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(async () => {
      const now = Date.now();
      for (const [id, session] of this.sessions) {
        if (now - session.lastActivity > idleTimeoutMs) {
          this.logger.info({ sessionId: id }, "mcp session idle - releasing");
          await this.releaseSession(id);
        }
      }
    }, 30000);
  }

  stopCleanupTimer(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  async releaseAll(): Promise<void> {
    for (const [id] of this.sessions) {
      await this.releaseSession(id);
    }
  }
}
