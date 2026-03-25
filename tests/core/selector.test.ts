import { describe, it, expect, beforeEach } from "vitest";
import { BackendRegistry } from "../../src/core/backends/registry.js";
import { BackendSelector } from "../../src/core/router/selector.js";
import { CooldownTracker } from "../../src/core/tracking/cooldown.js";

describe("BackendSelector", () => {
  let registry: BackendRegistry;
  let cooldown: CooldownTracker;

  beforeEach(() => {
    registry = new BackendRegistry();
    cooldown = new CooldownTracker({
      defaultMs: 30000,
      failureThreshold: 0.5,
      minRequestVolume: 3,
    });
  });

  it("should return backends sorted by priority", () => {
    registry.register("slow", { url: "ws://slow:3000", priority: 3, limits: {} });
    registry.register("fast", { url: "ws://fast:3000", priority: 1, limits: {} });
    registry.register("mid", { url: "ws://mid:3000", priority: 2, limits: {} });

    const selector = new BackendSelector(registry, cooldown, "priority-chain");
    const candidates = selector.getCandidates();

    expect(candidates.map((c) => c.id)).toEqual(["fast", "mid", "slow"]);
  });

  it("should skip backends at max concurrency", () => {
    registry.register("full", { url: "ws://full:3000", priority: 1, limits: { maxConcurrent: 1 } });
    registry.register("available", { url: "ws://available:3000", priority: 2, limits: {} });

    const full = registry.get("full")!;
    full.active = 1;

    const selector = new BackendSelector(registry, cooldown, "priority-chain");
    const candidates = selector.getCandidates();

    expect(candidates.map((c) => c.id)).toEqual(["available"]);
  });

  it("should skip backends in cooldown", () => {
    registry.register("cooled", { url: "ws://cooled:3000", priority: 1, limits: {} });
    registry.register("ok", { url: "ws://ok:3000", priority: 2, limits: {} });

    const cooled = registry.get("cooled")!;
    cooled.cooldownUntil = Date.now() + 30000;

    const selector = new BackendSelector(registry, cooldown, "priority-chain");
    const candidates = selector.getCandidates();

    expect(candidates.map((c) => c.id)).toEqual(["ok"]);
  });

  it("should return empty when all backends unavailable", () => {
    registry.register("full", { url: "ws://full:3000", priority: 1, limits: { maxConcurrent: 1 } });
    registry.get("full")!.active = 1;

    const selector = new BackendSelector(registry, cooldown, "priority-chain");
    expect(selector.getCandidates()).toEqual([]);
  });

  it("should apply round-robin strategy", () => {
    registry.register("a", { url: "ws://a:3000", priority: 1, limits: {} });
    registry.register("b", { url: "ws://b:3000", priority: 1, limits: {} });
    registry.register("c", { url: "ws://c:3000", priority: 1, limits: {} });

    const selector = new BackendSelector(registry, cooldown, "round-robin");

    const first = selector.getCandidates()[0].id;
    const second = selector.getCandidates()[0].id;
    const third = selector.getCandidates()[0].id;

    expect(new Set([first, second, third]).size).toBeGreaterThanOrEqual(2);
  });

  it("should apply least-connections strategy", () => {
    registry.register("busy", { url: "ws://busy:3000", priority: 1, limits: {} });
    registry.register("idle", { url: "ws://idle:3000", priority: 2, limits: {} });

    registry.get("busy")!.active = 5;
    registry.get("idle")!.active = 0;

    const selector = new BackendSelector(registry, cooldown, "least-connections");
    const candidates = selector.getCandidates();

    expect(candidates[0].id).toBe("idle");
  });
});
