import type { ProviderState } from "../types.js";

export class ConcurrencyTracker {
  private sessions: Map<string, { providerId: string; timestamp: number }> =
    new Map();

  acquire(providerId: string, sessionId: string, provider: ProviderState): boolean {
    const maxConcurrent = provider.config.limits?.maxConcurrent;
    if (maxConcurrent && provider.active >= maxConcurrent) {
      return false;
    }

    this.sessions.set(sessionId, { providerId, timestamp: Date.now() });
    provider.active++;
    provider.totalConnections++;
    return true;
  }

  release(sessionId: string, provider: ProviderState): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    this.sessions.delete(sessionId);
    provider.active = Math.max(0, provider.active - 1);
  }

  getActive(providerId: string): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.providerId === providerId) count++;
    }
    return count;
  }

  reconcile(providers: Map<string, ProviderState>, maxAgeMs: number): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [sessionId, session] of this.sessions) {
      if (now - session.timestamp > maxAgeMs) {
        const provider = providers.get(session.providerId);
        if (provider) {
          provider.active = Math.max(0, provider.active - 1);
        }
        this.sessions.delete(sessionId);
        cleaned++;
      }
    }

    return cleaned;
  }
}
