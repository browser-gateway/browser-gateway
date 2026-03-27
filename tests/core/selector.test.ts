import { describe, it, expect, beforeEach } from "vitest";
import { ProviderRegistry } from "../../src/core/providers/registry.js";
import { ProviderSelector } from "../../src/core/router/selector.js";
import { CooldownTracker } from "../../src/core/tracking/cooldown.js";

describe("ProviderSelector", () => {
  let registry: ProviderRegistry;
  let cooldown: CooldownTracker;

  beforeEach(() => {
    registry = new ProviderRegistry();
    cooldown = new CooldownTracker({
      defaultMs: 30000,
      failureThreshold: 0.5,
      minRequestVolume: 3,
    });
  });

  it("should return providers sorted by priority", () => {
    registry.register("slow", { url: "ws://slow:3000", priority: 3, limits: {} });
    registry.register("fast", { url: "ws://fast:3000", priority: 1, limits: {} });
    registry.register("mid", { url: "ws://mid:3000", priority: 2, limits: {} });

    const selector = new ProviderSelector(registry, cooldown, "priority-chain");
    const candidates = selector.getCandidates();

    expect(candidates.map((c) => c.id)).toEqual(["fast", "mid", "slow"]);
  });

  it("should skip providers at max concurrency", () => {
    registry.register("full", { url: "ws://full:3000", priority: 1, limits: { maxConcurrent: 1 } });
    registry.register("available", { url: "ws://available:3000", priority: 2, limits: {} });

    const full = registry.get("full")!;
    full.active = 1;

    const selector = new ProviderSelector(registry, cooldown, "priority-chain");
    const candidates = selector.getCandidates();

    expect(candidates.map((c) => c.id)).toEqual(["available"]);
  });

  it("should skip providers in cooldown", () => {
    registry.register("cooled", { url: "ws://cooled:3000", priority: 1, limits: {} });
    registry.register("ok", { url: "ws://ok:3000", priority: 2, limits: {} });

    const cooled = registry.get("cooled")!;
    cooled.cooldownUntil = Date.now() + 30000;

    const selector = new ProviderSelector(registry, cooldown, "priority-chain");
    const candidates = selector.getCandidates();

    expect(candidates.map((c) => c.id)).toEqual(["ok"]);
  });

  it("should return empty when all providers unavailable", () => {
    registry.register("full", { url: "ws://full:3000", priority: 1, limits: { maxConcurrent: 1 } });
    registry.get("full")!.active = 1;

    const selector = new ProviderSelector(registry, cooldown, "priority-chain");
    expect(selector.getCandidates()).toEqual([]);
  });

  it("should apply round-robin strategy", () => {
    registry.register("a", { url: "ws://a:3000", priority: 1, limits: {} });
    registry.register("b", { url: "ws://b:3000", priority: 1, limits: {} });
    registry.register("c", { url: "ws://c:3000", priority: 1, limits: {} });

    const selector = new ProviderSelector(registry, cooldown, "round-robin");

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

    const selector = new ProviderSelector(registry, cooldown, "least-connections");
    const candidates = selector.getCandidates();

    expect(candidates[0].id).toBe("idle");
  });

  it("should apply latency-optimized strategy", () => {
    registry.register("slow", { url: "ws://slow:3000", priority: 1, limits: {} });
    registry.register("fast", { url: "ws://fast:3000", priority: 2, limits: {} });

    registry.get("slow")!.avgLatencyMs = 500;
    registry.get("fast")!.avgLatencyMs = 50;

    const selector = new ProviderSelector(registry, cooldown, "latency-optimized");
    const candidates = selector.getCandidates();

    expect(candidates[0].id).toBe("fast");
  });

  it("should put providers with no latency data last in latency-optimized", () => {
    registry.register("measured", { url: "ws://measured:3000", priority: 2, limits: {} });
    registry.register("fresh", { url: "ws://fresh:3000", priority: 1, limits: {} });

    registry.get("measured")!.avgLatencyMs = 200;
    registry.get("fresh")!.avgLatencyMs = 0;

    const selector = new ProviderSelector(registry, cooldown, "latency-optimized");
    const candidates = selector.getCandidates();

    expect(candidates[0].id).toBe("measured");
  });

  it("should apply weighted strategy with smooth distribution", () => {
    registry.register("heavy", { url: "ws://heavy:3000", priority: 1, limits: {}, weight: 3 });
    registry.register("light", { url: "ws://light:3000", priority: 1, limits: {}, weight: 1 });

    const selector = new ProviderSelector(registry, cooldown, "weighted");

    const picks: string[] = [];
    for (let i = 0; i < 8; i++) {
      picks.push(selector.getCandidates()[0].id);
    }

    const heavyCount = picks.filter((p) => p === "heavy").length;
    const lightCount = picks.filter((p) => p === "light").length;

    // With weights 3:1 over 8 picks, heavy should get ~6, light ~2
    expect(heavyCount).toBeGreaterThanOrEqual(5);
    expect(lightCount).toBeGreaterThanOrEqual(1);
  });
});
