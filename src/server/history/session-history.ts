import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "pino";
import type { Gateway } from "../../core/gateway.js";
import type { Session } from "../../core/types.js";

export const SESSION_HISTORY_FILE = "session-history.json";
export const SESSION_HISTORY_MAX_ENTRIES = 500;
export const SESSION_HISTORY_DAYS = 90;
export const SESSION_HISTORY_SAVE_DELAY_MS = 2000;

const DAY_MS = 86_400_000;

export interface SessionHistoryEntry {
  id: string;
  providerId: string;
  profileId: string | null;
  proxyName: string | null;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  messageCount: number;
}

export interface SessionHistoryDay {
  date: string;
  count: number;
}

export interface SessionHistorySnapshot {
  total: number;
  days: SessionHistoryDay[];
  sessions: SessionHistoryEntry[];
}

interface StoredHistory {
  total: number;
  days: Record<string, number>;
  sessions: SessionHistoryEntry[];
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function isEntry(value: unknown): value is SessionHistoryEntry {
  if (!value || typeof value !== "object") return false;
  const e = value as Record<string, unknown>;
  return typeof e.id === "string" && typeof e.providerId === "string"
    && typeof e.startedAt === "string" && typeof e.endedAt === "string"
    && typeof e.durationMs === "number" && typeof e.messageCount === "number";
}

/** Keeps a capped record of finished sessions and a per-day count, saved as one JSON file. */
export class SessionHistory {
  private total = 0;
  private days = new Map<string, number>();
  private sessions: SessionHistoryEntry[] = [];
  private live = new Map<string, Session>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly filePath: string | null;

  constructor(
    dataDir: string | null,
    private readonly logger?: Logger,
    private readonly now: () => number = Date.now,
  ) {
    this.filePath = dataDir ? join(dataDir, SESSION_HISTORY_FILE) : null;
    this.load();
  }

  attach(gateway: Gateway): void {
    gateway.on("session.created", ({ sessionId }: { sessionId: string }) => {
      const session = gateway.sessions.get(sessionId);
      if (session) this.live.set(sessionId, session);
    });
    gateway.on("session.ended", ({ sessionId, providerId, durationMs }: { sessionId: string; providerId: string; durationMs: number }) => {
      const session = this.live.get(sessionId);
      this.live.delete(sessionId);
      const endedAt = this.now();
      this.record({
        id: sessionId,
        providerId,
        profileId: session?.profileId ?? null,
        proxyName: session?.proxyName ?? null,
        startedAt: new Date(session?.connectedAt ?? endedAt - durationMs).toISOString(),
        endedAt: new Date(endedAt).toISOString(),
        durationMs,
        messageCount: session?.messageCount ?? 0,
      });
    });
  }

  record(entry: SessionHistoryEntry): void {
    this.total++;
    const day = utcDay(Date.parse(entry.endedAt));
    this.days.set(day, (this.days.get(day) ?? 0) + 1);
    this.sessions.unshift(entry);
    if (this.sessions.length > SESSION_HISTORY_MAX_ENTRIES) this.sessions.length = SESSION_HISTORY_MAX_ENTRIES;
    this.pruneDays();
    this.scheduleSave();
  }

  snapshot(limit: number): SessionHistorySnapshot {
    const today = Date.parse(utcDay(this.now()));
    const days: SessionHistoryDay[] = [];
    for (let i = SESSION_HISTORY_DAYS - 1; i >= 0; i--) {
      const date = utcDay(today - i * DAY_MS);
      days.push({ date, count: this.days.get(date) ?? 0 });
    }
    return { total: this.total, days, sessions: this.sessions.slice(0, limit) };
  }

  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.save();
  }

  private pruneDays(): void {
    const oldest = utcDay(this.now() - (SESSION_HISTORY_DAYS - 1) * DAY_MS);
    for (const day of this.days.keys()) {
      if (day < oldest) this.days.delete(day);
    }
  }

  private scheduleSave(): void {
    if (!this.filePath || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, SESSION_HISTORY_SAVE_DELAY_MS);
    this.saveTimer.unref?.();
  }

  private save(): void {
    if (!this.filePath) return;
    const data: StoredHistory = { total: this.total, days: Object.fromEntries(this.days), sessions: this.sessions };
    const tmp = `${this.filePath}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
      renameSync(tmp, this.filePath);
    } catch (err) {
      this.logger?.warn({ error: err instanceof Error ? err.message : String(err) }, "session history not saved");
    }
  }

  private load(): void {
    if (!this.filePath || !existsSync(this.filePath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<StoredHistory>;
      this.sessions = Array.isArray(raw.sessions) ? raw.sessions.filter(isEntry).slice(0, SESSION_HISTORY_MAX_ENTRIES) : [];
      for (const [day, count] of Object.entries(raw.days ?? {})) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isInteger(count) && count > 0) this.days.set(day, count);
      }
      this.total = Number.isInteger(raw.total) && (raw.total as number) >= this.sessions.length ? (raw.total as number) : this.sessions.length;
      this.pruneDays();
    } catch (err) {
      this.logger?.warn({ error: err instanceof Error ? err.message : String(err) }, "session history unreadable, starting empty");
    }
  }
}
