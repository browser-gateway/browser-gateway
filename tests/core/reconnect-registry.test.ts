import { describe, it, expect, vi, afterEach } from "vitest";
import { ReconnectRegistry } from "../../src/core/proxy/reconnect.js";

function park(registry: ReconnectRegistry, sessionId: string): void {
  registry.park(sessionId, "provider-1", "ws://provider-1:3000", Date.now(), 0);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ReconnectRegistry", () => {
  it("claims a session parked within its ttl", () => {
    const registry = new ReconnectRegistry(10_000);
    park(registry, "s1");
    expect(registry.claim("s1")?.sessionId).toBe("s1");
  });

  it("claims a session only once", () => {
    const registry = new ReconnectRegistry(10_000);
    park(registry, "s1");
    registry.claim("s1");
    expect(registry.claim("s1")).toBeUndefined();
  });

  it("refuses a session whose ttl passed, without waiting for the sweep", () => {
    vi.useFakeTimers();
    const registry = new ReconnectRegistry(10_000);
    park(registry, "s1");
    vi.advanceTimersByTime(10_001);
    expect(registry.claim("s1")).toBeUndefined();
    expect(registry.has("s1")).toBe(false);
    expect(registry.get("s1")).toBeUndefined();
  });

  it("drops expired sessions from the parked listing and count", () => {
    vi.useFakeTimers();
    const registry = new ReconnectRegistry(10_000);
    park(registry, "s1");
    park(registry, "s2");
    vi.advanceTimersByTime(5_000);
    park(registry, "s3");
    vi.advanceTimersByTime(5_001);

    expect(registry.getAll().map((p) => p.sessionId)).toEqual(["s3"]);
    expect(registry.count()).toBe(1);
  });

  it("keeps sessions indefinitely when no ttl is configured", () => {
    vi.useFakeTimers();
    const registry = new ReconnectRegistry();
    park(registry, "s1");
    vi.advanceTimersByTime(30 * 24 * 60 * 60 * 1000);
    expect(registry.claim("s1")?.sessionId).toBe("s1");
  });

  it("sweeps expired sessions on the cleanup interval", () => {
    vi.useFakeTimers();
    const registry = new ReconnectRegistry(10_000);
    park(registry, "s1");
    registry.startCleanup();
    vi.advanceTimersByTime(30_000);
    registry.stopCleanup();
    expect(registry.count()).toBe(0);
  });
});
