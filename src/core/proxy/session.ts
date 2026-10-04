import type { Session } from "../types.js";

export class SessionTracker {
  private sessions: Map<string, Session> = new Map();
  private closers: Map<string, () => void> = new Map();

  create(id: string, providerId: string, profileId?: string): Session {
    const session: Session = {
      id,
      providerId,
      profileId,
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
    this.closers.delete(id);
    return session;
  }

  /** Registers how to end a live session; `close` runs at most once. */
  setCloser(id: string, close: () => void): void {
    if (this.sessions.has(id)) this.closers.set(id, close);
  }

  /** Ends a live session through its registered closer. Returns false when none is registered. */
  close(id: string): boolean {
    const close = this.closers.get(id);
    if (!close) return false;
    this.closers.delete(id);
    close();
    return true;
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
