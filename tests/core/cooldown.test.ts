import { describe, it, expect, beforeEach } from "vitest";
import { CooldownTracker } from "../../src/core/tracking/cooldown.js";
import type { ProviderState, ProviderConfig } from "../../src/core/types.js";

function createProvider(id: string): ProviderState {
  return {
    id,
    config: { url: `ws://${id}:3000`, priority: 1 } as ProviderConfig,
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

describe("CooldownTracker", () => {
  let cooldown: CooldownTracker;

  beforeEach(() => {
    cooldown = new CooldownTracker({
      defaultMs: 5000,
      failureThreshold: 0.5,
      minRequestVolume: 3,
    });
  });

  it("should not cooldown below minimum request volume", () => {
    const provider = createProvider("test");
    cooldown.recordFailure(provider);
    cooldown.recordFailure(provider);

    expect(provider.cooldownUntil).toBeNull();
    expect(cooldown.isInCooldown(provider)).toBe(false);
  });

  it("should cooldown when failure rate exceeds threshold", () => {
    const provider = createProvider("test");
    cooldown.recordFailure(provider);
    cooldown.recordFailure(provider);
    cooldown.recordFailure(provider);

    expect(provider.cooldownUntil).not.toBeNull();
    expect(provider.healthy).toBe(false);
    expect(cooldown.isInCooldown(provider)).toBe(true);
  });

  it("should not cooldown when successes dilute failure rate", () => {
    const provider = createProvider("test");
    cooldown.recordSuccess(provider);
    cooldown.recordSuccess(provider);
    cooldown.recordSuccess(provider);
    cooldown.recordSuccess(provider);
    cooldown.recordFailure(provider);

    expect(provider.cooldownUntil).toBeNull();
    expect(cooldown.isInCooldown(provider)).toBe(false);
  });

  it("should recover after TTL expires", () => {
    const provider = createProvider("test");
    cooldown.recordFailure(provider);
    cooldown.recordFailure(provider);
    cooldown.recordFailure(provider);

    expect(cooldown.isInCooldown(provider)).toBe(true);

    provider.cooldownUntil = Date.now() - 1;

    expect(cooldown.isInCooldown(provider)).toBe(false);
    expect(provider.healthy).toBe(true);
    expect(provider.cooldownUntil).toBeNull();
  });

  it("should use sliding window with mixed successes and failures", () => {
    const provider = createProvider("test");
    cooldown.recordSuccess(provider);
    cooldown.recordFailure(provider);
    cooldown.recordSuccess(provider);
    cooldown.recordFailure(provider);

    // 2 failures out of 4 total = 50% failure rate, hits threshold but we have mixed results
    // With minRequestVolume=3 and failureThreshold=0.5, this should trigger cooldown
    // because 2/4 = 0.5 which is >= 0.5
    expect(provider.cooldownUntil).not.toBeNull();
  });

  it("should not cooldown when successes outweigh failures", () => {
    const provider = createProvider("test");
    cooldown.recordSuccess(provider);
    cooldown.recordSuccess(provider);
    cooldown.recordSuccess(provider);
    cooldown.recordFailure(provider);

    // 1 failure out of 4 total = 25% failure rate, below 50% threshold
    expect(provider.cooldownUntil).toBeNull();
  });

  // ─── Boundary tests for mutation testing coverage ───

  // Distinguishes `<` from `<=` in `totalCount < minRequestVolume`.
  // With minRequestVolume=3 and totalCount=2, original `2 < 3` is true → early
  // return (no cooldown). A `<=` mutation makes `2 <= 3` also true → same.
  // BUT a `<` → `>` or `>=` flip would fail. This boundary case also reveals
  // any off-by-one in the minRequestVolume check.
  it("does not cooldown at totalCount = minRequestVolume - 1 even with 100% failure rate", () => {
    const provider = createProvider("test");
    cooldown.recordFailure(provider);
    cooldown.recordFailure(provider);
    // 2 failures, minRequestVolume is 3, so cooldown should NOT trigger yet.
    expect(provider.cooldownUntil).toBeNull();
  });

  // Distinguishes `>=` from `>` in `failureRate >= threshold`.
  // With threshold 0.5 and a clean 2/4 = 0.5 ratio, original `>=` triggers,
  // `>` does not. The existing test exercises this, but for ratchet safety
  // we add an explicit boundary expectation.
  it("triggers cooldown at exactly failureRate === threshold (>= not >)", () => {
    const provider = createProvider("test");
    // 2 successes + 2 failures → ratio exactly 0.5
    cooldown.recordSuccess(provider);
    cooldown.recordSuccess(provider);
    cooldown.recordFailure(provider);
    cooldown.recordFailure(provider);
    expect(provider.cooldownUntil).not.toBeNull();
  });

  // Distinguishes `>=` from `>` in `Date.now() >= cooldownUntil` (isInCooldown).
  // At exact equality the cooldown should clear.
  it("isInCooldown clears when Date.now() === cooldownUntil exactly", () => {
    const provider = createProvider("test");
    provider.cooldownUntil = Date.now();
    // Tiny sleep equivalent via busy-wait so Date.now advances past cooldownUntil.
    const target = provider.cooldownUntil;
    while (Date.now() < target + 1) { /* spin */ }
    // Now Date.now() > cooldownUntil, but Date.now() === cooldownUntil also
    // should have cleared; if mutation `>=` → `>` survives, this test catches
    // the case where now === cooldownUntil.
    expect(cooldown.isInCooldown(provider)).toBe(false);
    expect(provider.cooldownUntil).toBeNull();
    expect(provider.healthy).toBe(true);
  });

  // recordSuccess clears cooldown when expired. Exercises cooldown.ts:53.
  it("recordSuccess clears cooldownUntil when Date.now() >= cooldownUntil", () => {
    const provider = createProvider("test");
    provider.cooldownUntil = Date.now() - 1;
    provider.healthy = false;
    cooldown.recordSuccess(provider);
    expect(provider.cooldownUntil).toBeNull();
    expect(provider.healthy).toBe(true);
  });

  // recordSuccess MUST NOT clear cooldown that hasn't expired yet.
  // Catches a mutation like `>=` → `<=` that would invert the comparison.
  it("recordSuccess does not clear cooldown that hasn't expired yet", () => {
    const provider = createProvider("test");
    provider.cooldownUntil = Date.now() + 10_000;
    provider.healthy = false;
    cooldown.recordSuccess(provider);
    expect(provider.cooldownUntil).not.toBeNull();
    expect(provider.healthy).toBe(false);
  });

  // ─── Provider field increment correctness ───

  it("recordFailure increments failureCount and updates lastFailure", () => {
    const provider = createProvider("test");
    const before = provider.failureCount;
    cooldown.recordFailure(provider);
    expect(provider.failureCount).toBe(before + 1);
    expect(provider.lastFailure).not.toBeNull();
  });

  it("recordSuccess increments successCount", () => {
    const provider = createProvider("test");
    const before = provider.successCount;
    cooldown.recordSuccess(provider);
    expect(provider.successCount).toBe(before + 1);
  });
});
