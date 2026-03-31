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
    const entry = this.parked.get(sessionId);
    if (entry) {
      this.parked.delete(sessionId);
    }
    return entry;
  }

  get(sessionId: string): ParkedSession | undefined {
    return this.parked.get(sessionId);
  }

  has(sessionId: string): boolean {
    return this.parked.has(sessionId);
  }

  count(): number {
    return this.parked.size;
  }

  getAll(): ParkedSession[] {
    return Array.from(this.parked.values());
  }

  startCleanup(ttlMs: number): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, entry] of this.parked) {
        if (now - entry.parkedAt > ttlMs) {
          this.parked.delete(id);
        }
      }
    }, 15000);
  }

  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}
