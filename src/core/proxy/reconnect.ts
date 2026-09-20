export interface ParkedSession {
  sessionId: string;
  providerId: string;
  providerUrl: string;
  parkedAt: number;
  originalConnectedAt: number;
  messageCount: number;
}

export class ReconnectRegistry {
  private parked = new Map<string, ParkedSession>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly ttlMs = Number.POSITIVE_INFINITY) {}

  private expired(entry: ParkedSession): boolean {
    return Date.now() - entry.parkedAt > this.ttlMs;
  }

  private live(sessionId: string): ParkedSession | undefined {
    const entry = this.parked.get(sessionId);
    if (!entry) return undefined;
    if (!this.expired(entry)) return entry;
    this.parked.delete(sessionId);
    return undefined;
  }

  park(
    sessionId: string,
    providerId: string,
    providerUrl: string,
    connectedAt: number,
    messageCount: number,
  ): void {
    this.parked.set(sessionId, {
      sessionId,
      providerId,
      providerUrl,
      parkedAt: Date.now(),
      originalConnectedAt: connectedAt,
      messageCount,
    });
  }

  claim(sessionId: string): ParkedSession | undefined {
    const entry = this.live(sessionId);
    if (entry) {
      this.parked.delete(sessionId);
    }
    return entry;
  }

  get(sessionId: string): ParkedSession | undefined {
    return this.live(sessionId);
  }

  has(sessionId: string): boolean {
    return this.live(sessionId) !== undefined;
  }

  count(): number {
    return this.getAll().length;
  }

  getAll(): ParkedSession[] {
    this.sweep();
    return Array.from(this.parked.values());
  }

  private sweep(): void {
    for (const [id, entry] of this.parked) {
      if (this.expired(entry)) this.parked.delete(id);
    }
  }

  startCleanup(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => this.sweep(), 15000);
  }

  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}
