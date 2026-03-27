import type { Session } from "../types.js";

export class SessionTracker {
  private sessions: Map<string, Session> = new Map();

  create(id: string, providerId: string): Session {
    const session: Session = {
      id,
      providerId,
      connectedAt: Date.now(),
      lastActivity: Date.now(),
      messageCount: 0,
    };
    this.sessions.set(id, session);
    return session;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  recordActivity(id: string): void {
    const session = this.sessions.get(id);
    if (session) {
      session.lastActivity = Date.now();
      session.messageCount++;
    }
  }

  remove(id: string): Session | undefined {
    const session = this.sessions.get(id);
    if (session) {
      this.sessions.delete(id);
    }
    return session;
  }

  getAll(): Session[] {
    return [...this.sessions.values()];
  }

  count(): number {
    return this.sessions.size;
  }

  getIdleSessions(idleTimeoutMs: number): Session[] {
    const now = Date.now();
    return this.getAll().filter(
      (s) => now - s.lastActivity > idleTimeoutMs
    );
  }
}
