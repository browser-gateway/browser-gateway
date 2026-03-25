import { describe, it, expect, beforeEach } from "vitest";
import { SessionTracker } from "../../src/core/proxy/session.js";

describe("SessionTracker", () => {
  let tracker: SessionTracker;

  beforeEach(() => {
    tracker = new SessionTracker();
  });

  it("should create and retrieve a session", () => {
    const session = tracker.create("s1", "backend-a");
    expect(session.id).toBe("s1");
    expect(session.backendId).toBe("backend-a");
    expect(session.messageCount).toBe(0);
    expect(session.connectedAt).toBeGreaterThan(0);

    const retrieved = tracker.get("s1");
    expect(retrieved).toBe(session);
  });

  it("should return undefined for unknown session", () => {
    expect(tracker.get("nonexistent")).toBeUndefined();
  });

  it("should track count", () => {
    expect(tracker.count()).toBe(0);
    tracker.create("s1", "b1");
    expect(tracker.count()).toBe(1);
    tracker.create("s2", "b2");
    expect(tracker.count()).toBe(2);
  });

  it("should record activity", () => {
    tracker.create("s1", "b1");
    const before = tracker.get("s1")!.lastActivity;
    const beforeCount = tracker.get("s1")!.messageCount;

    // Small delay to ensure timestamp changes
    const start = Date.now();
    while (Date.now() - start < 5) {}

    tracker.recordActivity("s1");
    const after = tracker.get("s1")!;
    expect(after.lastActivity).toBeGreaterThanOrEqual(before);
    expect(after.messageCount).toBe(beforeCount + 1);
  });

  it("should not crash on recording activity for unknown session", () => {
    expect(() => tracker.recordActivity("nonexistent")).not.toThrow();
  });

  it("should remove a session and return it", () => {
    tracker.create("s1", "b1");
    expect(tracker.count()).toBe(1);

    const removed = tracker.remove("s1");
    expect(removed).toBeDefined();
    expect(removed!.id).toBe("s1");
    expect(tracker.count()).toBe(0);
    expect(tracker.get("s1")).toBeUndefined();
  });

  it("should return undefined when removing nonexistent session", () => {
    expect(tracker.remove("nonexistent")).toBeUndefined();
  });

  it("should list all sessions", () => {
    tracker.create("s1", "b1");
    tracker.create("s2", "b2");
    const all = tracker.getAll();
    expect(all).toHaveLength(2);
    expect(all.map((s) => s.id).sort()).toEqual(["s1", "s2"]);
  });

  it("should find idle sessions", () => {
    tracker.create("active", "b1");
    tracker.create("idle", "b2");

    // Make "idle" session have old lastActivity
    const idle = tracker.get("idle")!;
    idle.lastActivity = Date.now() - 60000;

    const idleSessions = tracker.getIdleSessions(30000);
    expect(idleSessions).toHaveLength(1);
    expect(idleSessions[0].id).toBe("idle");
  });

  it("should not flag active sessions as idle", () => {
    tracker.create("active", "b1");
    tracker.recordActivity("active");
    const idleSessions = tracker.getIdleSessions(30000);
    expect(idleSessions).toHaveLength(0);
  });
});
