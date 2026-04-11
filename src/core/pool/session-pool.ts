import { randomUUID } from "node:crypto";
import { chromium, type Browser } from "playwright-core";
import type { Logger } from "pino";
import type {
  PoolConfig,
  PoolSession,
  PageHandle,
  PoolStatus,
} from "./types.js";

interface QueueEntry {
  resolve: (value: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class SessionPool {
  private sessions = new Map<string, PoolSession>();
  private activeHandles = new Map<string, PageHandle>();
  private queue: QueueEntry[] = [];
  private maintenanceTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private creatingSession = false;

  // Serialized acquisition — prevents race conditions during concurrent page requests
  private acquireLock: Promise<void> = Promise.resolve();

  constructor(
    private readonly gatewayPort: number,
    private readonly logger: Logger,
    private readonly config: PoolConfig,
    private readonly token?: string,
  ) {}

  async start(): Promise<void> {
    this.maintenanceTimer = setInterval(
      () => this.maintenance(),
      Math.min(this.config.idleTimeoutMs, 30000),
    );

    if (this.config.minSessions > 0) {
      this.logger.info({ minSessions: this.config.minSessions }, "pool: warming up");
      const warmupPromises: Promise<void>[] = [];
      for (let i = 0; i < this.config.minSessions; i++) {
        warmupPromises.push(this.createSession().then(() => {}));
      }
      await Promise.allSettled(warmupPromises);
    }

    this.logger.info(
      { maxSessions: this.config.maxSessions, maxPagesPerSession: this.config.maxPagesPerSession },
      "pool: started",
    );
  }

  async acquirePage(): Promise<PageHandle> {
    if (this.closed) {
      throw new Error("Pool is shut down");
    }

    // Trigger proactive scaling BEFORE serialized acquisition
    // This runs in background so it doesn't block page acquisition
    this.ensureCapacity();

    return new Promise<PageHandle>((resolve, reject) => {
      this.acquireLock = this.acquireLock
        .then(() => this.doAcquirePage())
        .then(resolve)
        .catch(reject);
    });
  }

  private async doAcquirePage(): Promise<PageHandle> {
    // 1. Find a session with capacity
    let session = this.findAvailableSession();

    // 2. If none, wait briefly for in-flight session creation to complete
    if (!session && this.creatingSession) {
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 250));
        session = this.findAvailableSession();
        if (session) break;
      }
    }

    // 3. If still none, create a new session synchronously (blocks this acquire only)
    if (!session) {
      const totalActive = this.countSessionsByState("active") +
        this.countSessionsByState("starting");

      if (totalActive < this.config.maxSessions) {
        session = await this.createSession();
      }
    }

    // 4. If at maxSessions, wait for a slot to free up
    if (!session) {
      const gotSlot = await this.waitForSlot();
      if (gotSlot) {
        session = this.findAvailableSession();
      }
    }

    if (!session) {
      throw new Error("No browser sessions available");
    }

    // 5. Create BrowserContext + Page
    const handleId = randomUUID();
    const context = await session.browser.newContext({
      viewport: { width: 1280, height: 720 },
    });
    let page;
    try {
      page = await context.newPage();
    } catch (err) {
      await context.close().catch(() => {});
      throw err;
    }

    session.activePages++;
    session.totalPagesServed++;
    session.lastActivity = Date.now();

    const handle: PageHandle = {
      id: handleId,
      page,
      context,
      sessionId: session.id,
      acquiredAt: Date.now(),
    };

    this.activeHandles.set(handleId, handle);

    this.logger.info(
      {
        handleId: handleId.slice(0, 8),
        sessionId: session.id.slice(0, 8),
        activePages: session.activePages,
        totalPagesServed: session.totalPagesServed,
        totalSessions: this.sessions.size,
      },
      "pool: page acquired",
    );

    // Check if session should be retired after serving enough pages
    if (session.totalPagesServed >= this.config.retireAfterPages) {
      this.retireSession(session);
    }

    // Proactively ensure capacity for future requests
    this.ensureCapacity();

    return handle;
  }

  async releasePage(handle: PageHandle): Promise<void> {
    this.activeHandles.delete(handle.id);

    await handle.context.close().catch((err) => {
      this.logger.debug(
        { handleId: handle.id, error: (err as Error).message },
        "pool: context close failed",
      );
    });

    const session = this.sessions.get(handle.sessionId);
    if (session) {
      session.activePages = Math.max(0, session.activePages - 1);
      session.lastActivity = Date.now();

      this.logger.info(
        {
          handleId: handle.id.slice(0, 8),
          sessionId: session.id.slice(0, 8),
          activePages: session.activePages,
          totalSessions: this.sessions.size,
        },
        "pool: page released",
      );

      if (session.state === "retiring" && session.activePages === 0) {
        await this.closeSession(session);
      }

      this.dequeueNext();
    }
  }

  getStatus(): PoolStatus {
    const sessions = Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      state: s.state,
      activePages: s.activePages,
      totalPagesServed: s.totalPagesServed,
      uptime: Date.now() - s.createdAt,
    }));

    return {
      totalSessions: this.sessions.size,
      activeSessions: this.countSessionsByState("active"),
      retiringSessions: this.countSessionsByState("retiring"),
      totalActivePages: Array.from(this.sessions.values()).reduce(
        (sum, s) => sum + s.activePages,
        0,
      ),
      config: this.config,
      sessions,
    };
  }

  async shutdown(): Promise<void> {
    this.closed = true;

    if (this.maintenanceTimer) {
      clearInterval(this.maintenanceTimer);
      this.maintenanceTimer = null;
    }

    for (const entry of this.queue) {
      clearTimeout(entry.timer);
      entry.resolve(false);
    }
    this.queue = [];

    for (const session of this.sessions.values()) {
      if (session.state === "active" || session.state === "starting") {
        session.state = "retiring";
      }
    }

    const drainStart = Date.now();
    while (this.activeHandles.size > 0 && Date.now() - drainStart < 10000) {
      await new Promise((r) => setTimeout(r, 500));
    }

    for (const handle of this.activeHandles.values()) {
      await handle.context.close().catch(() => {});
    }
    this.activeHandles.clear();

    const closePromises = Array.from(this.sessions.values()).map((s) =>
      this.closeSession(s),
    );
    await Promise.allSettled(closePromises);

    this.logger.info("pool: shut down");
  }

  // --- Proactive scaling ---

  private ensureCapacity(): void {
    if (this.closed || this.creatingSession) return;

    const activeSessions = this.countSessionsByState("active");
    const startingSessions = this.countSessionsByState("starting");
    const totalManaged = activeSessions + startingSessions;

    if (totalManaged >= this.config.maxSessions) return;

    // Calculate available page capacity across active sessions
    let availableSlots = 0;
    for (const session of this.sessions.values()) {
      if (session.state === "active") {
        availableSlots += this.config.maxPagesPerSession - session.activePages;
      }
    }

    // If available capacity is low (less than 3 slots or less than 30%), create a new session in background
    const threshold = Math.max(3, Math.floor(this.config.maxPagesPerSession * 0.3));
    if (availableSlots < threshold) {
      this.logger.info(
        { availableSlots, threshold, activeSessions, totalManaged, maxSessions: this.config.maxSessions },
        "pool: proactive scale-up",
      );
      this.createSession().catch((err) => {
        this.logger.warn({ error: (err as Error).message }, "pool: proactive session creation failed");
      });
    }
  }

  // --- Internal ---

  private async createSession(): Promise<PoolSession> {
    this.creatingSession = true;
    const id = randomUUID();
    const wsUrl = this.token
      ? `ws://127.0.0.1:${this.gatewayPort}/v1/connect?token=${this.token}`
      : `ws://127.0.0.1:${this.gatewayPort}/v1/connect`;

    const session: PoolSession = {
      id,
      browser: null!,
      state: "starting",
      activePages: 0,
      totalPagesServed: 0,
      createdAt: Date.now(),
      lastActivity: Date.now(),
    };

    this.sessions.set(id, session);

    try {
      const browser = await chromium.connectOverCDP(wsUrl, {
        timeout: this.config.pageTimeoutMs,
      });

      browser.on("disconnected", () => {
        this.logger.warn({ sessionId: id }, "pool: browser disconnected");
        session.state = "closed";
        this.sessions.delete(id);

        const handleIdsToRemove: string[] = [];
        for (const [handleId, handle] of this.activeHandles) {
          if (handle.sessionId === id) {
            handleIdsToRemove.push(handleId);
          }
        }
        for (const handleId of handleIdsToRemove) {
          this.activeHandles.delete(handleId);
          session.activePages = Math.max(0, session.activePages - 1);
        }

        this.dequeueNext();
      });

      session.browser = browser;
      session.state = "active";

      this.logger.info(
        { sessionId: id, totalSessions: this.sessions.size },
        "pool: session created",
      );

      // Notify queue — new capacity available
      this.dequeueNext();

      return session;
    } catch (err) {
      this.sessions.delete(id);
      this.logger.error(
        { sessionId: id, error: (err as Error).message },
        "pool: session creation failed",
      );
      throw err;
    } finally {
      this.creatingSession = false;
    }
  }

  private findAvailableSession(): PoolSession | null {
    let best: PoolSession | null = null;

    for (const session of this.sessions.values()) {
      if (session.state !== "active") continue;
      if (session.activePages >= this.config.maxPagesPerSession) continue;

      if (!best || session.activePages < best.activePages) {
        best = session;
      }
    }

    return best;
  }

  private retireSession(session: PoolSession): void {
    if (session.state !== "active") return;

    session.state = "retiring";
    this.logger.info(
      {
        sessionId: session.id,
        totalPagesServed: session.totalPagesServed,
        activePages: session.activePages,
      },
      "pool: session retiring",
    );

    if (session.activePages === 0) {
      this.closeSession(session).catch(() => {});
    }
  }

  private async closeSession(session: PoolSession): Promise<void> {
    if (session.state === "closed") return;

    session.state = "closed";
    this.sessions.delete(session.id);

    try {
      await session.browser.close();
    } catch (err) {
      this.logger.debug(
        { sessionId: session.id, error: (err as Error).message },
        "pool: browser close failed",
      );
    }

    this.logger.info(
      {
        sessionId: session.id,
        totalPagesServed: session.totalPagesServed,
        uptime: Date.now() - session.createdAt,
      },
      "pool: session closed",
    );
  }

  private maintenance(): void {
    if (this.closed) return;
    const now = Date.now();

    const sessionsSnapshot = Array.from(this.sessions.values());
    for (const session of sessionsSnapshot) {
      if (
        session.state === "active" &&
        now - session.createdAt >= this.config.retireAfterMs
      ) {
        this.logger.info(
          { sessionId: session.id, uptimeMs: now - session.createdAt },
          "pool: session exceeded max lifetime, retiring",
        );
        this.retireSession(session);
        continue;
      }

      if (
        session.state === "active" &&
        session.activePages === 0 &&
        now - session.lastActivity >= this.config.idleTimeoutMs
      ) {
        const activeSessions = this.countSessionsByState("active");
        if (activeSessions > this.config.minSessions) {
          this.logger.info(
            { sessionId: session.id, idleMs: now - session.lastActivity },
            "pool: closing idle session",
          );
          this.retireSession(session);
        }
      }

      if (session.state === "retiring" && session.activePages === 0) {
        this.closeSession(session).catch(() => {});
      }
    }

    const staleHandles: PageHandle[] = [];
    for (const [, handle] of this.activeHandles) {
      if (now - handle.acquiredAt >= this.config.pageTimeoutMs * 2) {
        staleHandles.push(handle);
      }
    }
    for (const handle of staleHandles) {
      this.logger.warn(
        { handleId: handle.id, sessionId: handle.sessionId, heldMs: now - handle.acquiredAt },
        "pool: force-releasing page held too long",
      );
      this.releasePage(handle).catch(() => {});
    }
  }

  private async waitForSlot(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.queue.findIndex((e) => e.resolve === resolve);
        if (idx !== -1) this.queue.splice(idx, 1);
        resolve(false);
      }, this.config.pageTimeoutMs);

      this.queue.push({ resolve, timer });
    });
  }

  private dequeueNext(): void {
    if (this.queue.length === 0) return;

    const available = this.findAvailableSession();
    if (!available) return;

    const entry = this.queue.shift();
    if (!entry) return;

    clearTimeout(entry.timer);
    entry.resolve(true);
  }

  private countSessionsByState(state: PoolSession["state"]): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.state === state) count++;
    }
    return count;
  }
}
