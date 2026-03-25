import { describe, it, expect, beforeEach } from "vitest";
import { CooldownTracker } from "../../src/core/tracking/cooldown.js";
import type { BackendState, BackendConfig } from "../../src/core/types.js";

function createBackend(id: string): BackendState {
  return {
    id,
    config: { url: `ws://${id}:3000`, priority: 1 } as BackendConfig,
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
    const backend = createBackend("test");
    cooldown.recordFailure(backend);
    cooldown.recordFailure(backend);

    expect(backend.cooldownUntil).toBeNull();
    expect(cooldown.isInCooldown(backend)).toBe(false);
  });

  it("should cooldown when failure rate exceeds threshold", () => {
    const backend = createBackend("test");
    cooldown.recordFailure(backend);
    cooldown.recordFailure(backend);
    cooldown.recordFailure(backend);

    expect(backend.cooldownUntil).not.toBeNull();
    expect(backend.healthy).toBe(false);
    expect(cooldown.isInCooldown(backend)).toBe(true);
  });

  it("should not cooldown when successes dilute failure rate", () => {
    const backend = createBackend("test");
    cooldown.recordSuccess(backend);
    cooldown.recordSuccess(backend);
    cooldown.recordSuccess(backend);
    cooldown.recordSuccess(backend);
    cooldown.recordFailure(backend);

    expect(backend.cooldownUntil).toBeNull();
    expect(cooldown.isInCooldown(backend)).toBe(false);
  });

  it("should recover after TTL expires", () => {
    const backend = createBackend("test");
    cooldown.recordFailure(backend);
    cooldown.recordFailure(backend);
    cooldown.recordFailure(backend);

    expect(cooldown.isInCooldown(backend)).toBe(true);

    backend.cooldownUntil = Date.now() - 1;

    expect(cooldown.isInCooldown(backend)).toBe(false);
    expect(backend.healthy).toBe(true);
    expect(backend.cooldownUntil).toBeNull();
  });

  it("should use sliding window with mixed successes and failures", () => {
    const backend = createBackend("test");
    cooldown.recordSuccess(backend);
    cooldown.recordFailure(backend);
    cooldown.recordSuccess(backend);
    cooldown.recordFailure(backend);

    // 2 failures out of 4 total = 50% failure rate, hits threshold but we have mixed results
    // With minRequestVolume=3 and failureThreshold=0.5, this should trigger cooldown
    // because 2/4 = 0.5 which is >= 0.5
    expect(backend.cooldownUntil).not.toBeNull();
  });

  it("should not cooldown when successes outweigh failures", () => {
    const backend = createBackend("test");
    cooldown.recordSuccess(backend);
    cooldown.recordSuccess(backend);
    cooldown.recordSuccess(backend);
    cooldown.recordFailure(backend);

    // 1 failure out of 4 total = 25% failure rate, below 50% threshold
    expect(backend.cooldownUntil).toBeNull();
  });
});
