import type { BackendState } from "../types.js";

export class ConcurrencyTracker {
  private sessions: Map<string, { backendId: string; timestamp: number }> =
    new Map();

  acquire(backendId: string, sessionId: string, backend: BackendState): boolean {
    const maxConcurrent = backend.config.limits?.maxConcurrent;
    if (maxConcurrent && backend.active >= maxConcurrent) {
      return false;
    }

    this.sessions.set(sessionId, { backendId, timestamp: Date.now() });
    backend.active++;
    backend.totalConnections++;
    return true;
  }

  release(sessionId: string, backend: BackendState): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    this.sessions.delete(sessionId);
    backend.active = Math.max(0, backend.active - 1);
  }

  getActive(backendId: string): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.backendId === backendId) count++;
    }
    return count;
  }

  reconcile(backends: Map<string, BackendState>, maxAgeMs: number): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [sessionId, session] of this.sessions) {
      if (now - session.timestamp > maxAgeMs) {
        const backend = backends.get(session.backendId);
        if (backend) {
          backend.active = Math.max(0, backend.active - 1);
        }
        this.sessions.delete(sessionId);
        cleaned++;
      }
    }

    return cleaned;
  }
}
