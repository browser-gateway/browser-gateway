import { describe, it, expect, beforeEach } from "vitest";
import { ConcurrencyTracker } from "../../src/core/tracking/concurrency.js";
import type { ProviderState, ProviderConfig } from "../../src/core/types.js";

function createProvider(id: string, maxConcurrent?: number): ProviderState {
  return {
    id,
    config: {
      url: `ws://${id}:3000`,
      priority: 1,
      limits: maxConcurrent ? { maxConcurrent } : undefined,
    } as ProviderConfig,
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
    const provider = createProvider("test", 5);
    expect(tracker.acquire("test", "session-1", provider)).toBe(true);
    expect(provider.active).toBe(1);

    tracker.release("session-1", provider);
    expect(provider.active).toBe(0);
  });

  it("should reject when at max concurrency", () => {
    const provider = createProvider("test", 2);
    expect(tracker.acquire("test", "s1", provider)).toBe(true);
    expect(tracker.acquire("test", "s2", provider)).toBe(true);
    expect(tracker.acquire("test", "s3", provider)).toBe(false);
    expect(provider.active).toBe(2);
  });

  it("should allow unlimited when no maxConcurrent set", () => {
    const provider = createProvider("test");
    for (let i = 0; i < 100; i++) {
      expect(tracker.acquire("test", `s${i}`, provider)).toBe(true);
    }
    expect(provider.active).toBe(100);
  });

  it("should not go below zero on release", () => {
    const provider = createProvider("test", 5);
    tracker.release("nonexistent", provider);
    expect(provider.active).toBe(0);
  });

  it("should track total connections", () => {
    const provider = createProvider("test", 5);
    tracker.acquire("test", "s1", provider);
    tracker.acquire("test", "s2", provider);
    expect(provider.totalConnections).toBe(2);

    tracker.release("s1", provider);
    expect(provider.totalConnections).toBe(2);
  });
});
