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
});
