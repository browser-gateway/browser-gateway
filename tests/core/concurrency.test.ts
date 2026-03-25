import { describe, it, expect, beforeEach } from "vitest";
import { ConcurrencyTracker } from "../../src/core/tracking/concurrency.js";
import type { BackendState, BackendConfig } from "../../src/core/types.js";

function createBackend(id: string, maxConcurrent?: number): BackendState {
  return {
    id,
    config: {
      url: `ws://${id}:3000`,
      priority: 1,
      limits: maxConcurrent ? { maxConcurrent } : undefined,
    } as BackendConfig,
    active: 0,
    healthy: true,
    cooldownUntil: null,
    failureCount: 0,
    successCount: 0,
    lastFailure: null,
    avgLatencyMs: 0,
    totalConnections: 0,
  };
}

describe("ConcurrencyTracker", () => {
  let tracker: ConcurrencyTracker;

  beforeEach(() => {
    tracker = new ConcurrencyTracker();
  });

  it("should acquire and release slots", () => {
    const backend = createBackend("test", 5);
    expect(tracker.acquire("test", "session-1", backend)).toBe(true);
    expect(backend.active).toBe(1);

    tracker.release("session-1", backend);
    expect(backend.active).toBe(0);
  });

  it("should reject when at max concurrency", () => {
    const backend = createBackend("test", 2);
    expect(tracker.acquire("test", "s1", backend)).toBe(true);
    expect(tracker.acquire("test", "s2", backend)).toBe(true);
    expect(tracker.acquire("test", "s3", backend)).toBe(false);
    expect(backend.active).toBe(2);
  });

  it("should allow unlimited when no maxConcurrent set", () => {
    const backend = createBackend("test");
    for (let i = 0; i < 100; i++) {
      expect(tracker.acquire("test", `s${i}`, backend)).toBe(true);
    }
    expect(backend.active).toBe(100);
  });

  it("should not go below zero on release", () => {
    const backend = createBackend("test", 5);
    tracker.release("nonexistent", backend);
    expect(backend.active).toBe(0);
  });

  it("should track total connections", () => {
    const backend = createBackend("test", 5);
    tracker.acquire("test", "s1", backend);
    tracker.acquire("test", "s2", backend);
    expect(backend.totalConnections).toBe(2);

    tracker.release("s1", backend);
    expect(backend.totalConnections).toBe(2);
  });
});
