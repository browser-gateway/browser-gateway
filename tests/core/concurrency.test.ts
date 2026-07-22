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
    detectedKind: null,
    discoveredMaxConcurrent: null,
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

  // ─── Boundary tests for mutation testing coverage ───

  it("getActive counts only sessions for the given providerId", () => {
    const provA = createProvider("a", 10);
    const provB = createProvider("b", 10);
    tracker.acquire("a", "s1", provA);
    tracker.acquire("a", "s2", provA);
    tracker.acquire("b", "s3", provB);
    expect(tracker.getActive("a")).toBe(2);
    expect(tracker.getActive("b")).toBe(1);
    expect(tracker.getActive("c")).toBe(0);
  });

  // ─── reconcile() — was not tested before ───

  it("reconcile removes sessions older than maxAgeMs and decrements active", async () => {
    const provider = createProvider("test", 10);
    const providerMap = new Map<string, ProviderState>([[provider.id, provider]]);
    tracker.acquire("test", "s-old", provider);
    expect(provider.active).toBe(1);

    // Wait a tiny bit so session timestamp is older than threshold.
    await new Promise((r) => setTimeout(r, 30));

    const cleaned = tracker.reconcile(providerMap, 20);
    expect(cleaned).toBe(1);
    expect(provider.active).toBe(0);
    expect(tracker.getActive("test")).toBe(0);
  });

  it("reconcile does NOT remove sessions younger than maxAgeMs", () => {
    const provider = createProvider("test", 10);
    const providerMap = new Map<string, ProviderState>([[provider.id, provider]]);
    tracker.acquire("test", "s-young", provider);

    const cleaned = tracker.reconcile(providerMap, 60_000);
    expect(cleaned).toBe(0);
    expect(provider.active).toBe(1);
  });

  it("reconcile returns 0 and does nothing when no sessions exist", () => {
    const provider = createProvider("test", 10);
    const providerMap = new Map<string, ProviderState>([[provider.id, provider]]);
    const cleaned = tracker.reconcile(providerMap, 1000);
    expect(cleaned).toBe(0);
    expect(provider.active).toBe(0);
  });

  it("reconcile tolerates a stale session whose provider is no longer registered", async () => {
    const provider = createProvider("test", 10);
    tracker.acquire("test", "s1", provider);
    await new Promise((r) => setTimeout(r, 30));

    // Pass an empty provider map — the session points at a missing provider.
    // reconcile must still remove the session but not crash.
    const cleaned = tracker.reconcile(new Map(), 20);
    expect(cleaned).toBe(1);
    expect(tracker.getActive("test")).toBe(0);
  });

  it("release does NOT touch state when sessionId is unknown", () => {
    const provider = createProvider("test", 10);
    tracker.acquire("test", "real", provider);
    expect(provider.active).toBe(1);

    tracker.release("ghost-session", provider);
    // Must remain unchanged since the session was never acquired.
    expect(provider.active).toBe(1);
  });
});
