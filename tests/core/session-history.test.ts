import { describe, it, expect, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import {
  SessionHistory,
  SESSION_HISTORY_FILE,
  SESSION_HISTORY_MAX_ENTRIES,
  SESSION_HISTORY_DAYS,
  type SessionHistoryEntry,
} from "../../src/server/history/session-history.js";
import type { Gateway } from "../../src/core/gateway.js";
import type { Session } from "../../src/core/types.js";

const NOW = Date.parse("2026-11-24T12:00:00Z");
const DAY = 86_400_000;
const logger = pino({ level: "silent" });
const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "bg-history-"));
  dirs.push(dir);
  return dir;
}

function entry(id: string, endedAt: number): SessionHistoryEntry {
  return {
    id,
    providerId: "p1",
    profileId: null,
    proxyName: null,
    startedAt: new Date(endedAt - 1000).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    durationMs: 1000,
    messageCount: 3,
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("SessionHistory", () => {
  it("records sessions newest first and counts them per UTC day", () => {
    const history = new SessionHistory(null, logger, () => NOW);
    history.record(entry("a", NOW - DAY));
    history.record(entry("b", NOW));
    history.record(entry("c", NOW));

    const snap = history.snapshot(10);
    expect(snap.total).toBe(3);
    expect(snap.sessions.map((s) => s.id)).toEqual(["c", "b", "a"]);
    expect(snap.days).toHaveLength(SESSION_HISTORY_DAYS);
    expect(snap.days.at(-1)).toEqual({ date: "2026-11-24", count: 2 });
    expect(snap.days.at(-2)).toEqual({ date: "2026-11-23", count: 1 });
    expect(snap.days[0].count).toBe(0);
  });

  it("caps the stored sessions but keeps counting the total", () => {
    const history = new SessionHistory(null, logger, () => NOW);
    for (let i = 0; i < SESSION_HISTORY_MAX_ENTRIES + 5; i++) history.record(entry(`s${i}`, NOW));
    const snap = history.snapshot(1000);
    expect(snap.sessions).toHaveLength(SESSION_HISTORY_MAX_ENTRIES);
    expect(snap.total).toBe(SESSION_HISTORY_MAX_ENTRIES + 5);
    expect(snap.days.at(-1)?.count).toBe(SESSION_HISTORY_MAX_ENTRIES + 5);
  });

  it("drops day counts older than the window", () => {
    const history = new SessionHistory(null, logger, () => NOW);
    history.record(entry("old", NOW - SESSION_HISTORY_DAYS * DAY));
    const snap = history.snapshot(10);
    expect(snap.days.reduce((n, d) => n + d.count, 0)).toBe(0);
    expect(snap.total).toBe(1);
  });

  it("survives a restart through its file", () => {
    const dir = tempDir();
    const first = new SessionHistory(dir, logger, () => NOW);
    first.record(entry("a", NOW));
    first.record(entry("b", NOW));
    first.flush();
    expect(existsSync(join(dir, SESSION_HISTORY_FILE))).toBe(true);

    const second = new SessionHistory(dir, logger, () => NOW);
    const snap = second.snapshot(10);
    expect(snap.total).toBe(2);
    expect(snap.sessions.map((s) => s.id)).toEqual(["b", "a"]);
    expect(snap.days.at(-1)?.count).toBe(2);
  });

  it("starts empty when the file is unreadable and overwrites it on the next save", () => {
    const dir = tempDir();
    writeFileSync(join(dir, SESSION_HISTORY_FILE), "{not json");
    const history = new SessionHistory(dir, logger, () => NOW);
    expect(history.snapshot(10).total).toBe(0);
    history.record(entry("a", NOW));
    history.flush();
    expect(JSON.parse(readFileSync(join(dir, SESSION_HISTORY_FILE), "utf8")).total).toBe(1);
  });

  it("ignores malformed rows in the file", () => {
    const dir = tempDir();
    writeFileSync(join(dir, SESSION_HISTORY_FILE), JSON.stringify({
      total: 2,
      days: { "2026-11-24": 2, junk: 4 },
      sessions: [entry("ok", NOW), { id: 5 }],
    }));
    const snap = new SessionHistory(dir, logger, () => NOW).snapshot(10);
    expect(snap.sessions.map((s) => s.id)).toEqual(["ok"]);
    expect(snap.total).toBe(2);
    expect(snap.days.at(-1)?.count).toBe(2);
  });

  it("builds entries from the gateway's session events", () => {
    const emitter = new EventEmitter();
    const live: Session = {
      id: "s1",
      providerId: "p1",
      profileId: "work",
      proxyName: "paris",
      connectedAt: NOW - 5000,
      lastActivity: NOW,
      messageCount: 0,
    };
    const gateway = Object.assign(emitter, {
      sessions: { get: (id: string) => (id === "s1" ? live : undefined) },
    }) as unknown as Gateway;

    const history = new SessionHistory(null, logger, () => NOW);
    history.attach(gateway);
    emitter.emit("session.created", { sessionId: "s1", providerId: "p1" });
    live.messageCount = 7;
    emitter.emit("session.ended", { sessionId: "s1", providerId: "p1", durationMs: 5000 });

    const [recorded] = history.snapshot(1).sessions;
    expect(recorded).toEqual({
      id: "s1",
      providerId: "p1",
      profileId: "work",
      proxyName: "paris",
      startedAt: new Date(NOW - 5000).toISOString(),
      endedAt: new Date(NOW).toISOString(),
      durationMs: 5000,
      messageCount: 7,
    });
  });
});
