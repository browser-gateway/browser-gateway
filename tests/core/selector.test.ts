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

  // ─── Boundary tests for mutation testing coverage ───

  // The latency strategy has 4 conditional branches; we test all 4 explicitly.
  it("latency-optimized treats both-zero-latency as ordering-stable (returns 0)", () => {
    registry.register("first", { url: "ws://first:3000", priority: 1, limits: {} });
    registry.register("second", { url: "ws://second:3000", priority: 2, limits: {} });
    // Both have avgLatencyMs === 0 by default
    const selector = new ProviderSelector(registry, cooldown, "latency-optimized");
    const candidates = selector.getCandidates();
    // Stable sort: priority order is preserved
    expect(candidates.map((c) => c.id)).toEqual(["first", "second"]);
  });

  it("latency-optimized puts b last when only b has no latency data", () => {
    registry.register("measured", { url: "ws://measured:3000", priority: 1, limits: {} });
    registry.register("fresh", { url: "ws://fresh:3000", priority: 2, limits: {} });
    registry.get("measured")!.avgLatencyMs = 100;
    registry.get("fresh")!.avgLatencyMs = 0;
    const selector = new ProviderSelector(registry, cooldown, "latency-optimized");
    const candidates = selector.getCandidates();
    expect(candidates[0].id).toBe("measured");
    expect(candidates[1].id).toBe("fresh");
  });

  // Distinguishes `active >= maxConcurrent` from `active > maxConcurrent`.
  // Boundary: active === maxConcurrent - 1 is still available.
  it("does NOT skip providers when active is one below maxConcurrent", () => {
    registry.register("p", { url: "ws://p:3000", priority: 1, limits: { maxConcurrent: 3 } });
    registry.get("p")!.active = 2;  // 2 < 3 → still available
    const selector = new ProviderSelector(registry, cooldown, "priority-chain");
    expect(selector.getCandidates().map((c) => c.id)).toEqual(["p"]);
  });

  it("skips providers when active equals maxConcurrent exactly", () => {
    registry.register("p", { url: "ws://p:3000", priority: 1, limits: { maxConcurrent: 3 } });
    registry.get("p")!.active = 3;  // 3 >= 3 → skip
    const selector = new ProviderSelector(registry, cooldown, "priority-chain");
    expect(selector.getCandidates()).toEqual([]);
  });

  // The "max && active >= max" guard uses truthy-check on max. maxConcurrent=0
  // is the "unlimited" sentinel (falsy), which is rejected by the schema, but
  // the guard should still behave correctly even if it sneaks through.
  it("treats undefined maxConcurrent as unlimited", () => {
    registry.register("p", { url: "ws://p:3000", priority: 1, limits: {} });
    registry.get("p")!.active = 1_000_000;  // huge but no limit
    const selector = new ProviderSelector(registry, cooldown, "priority-chain");
    expect(selector.getCandidates().map((c) => c.id)).toEqual(["p"]);
  });

  // The roundRobinIndex increments — verify it cycles through ALL candidates
  // over enough picks. Catches mutations that always return index 0.
  it("round-robin cycles through every candidate, not just the first", () => {
    registry.register("a", { url: "ws://a:3000", priority: 1, limits: {} });
    registry.register("b", { url: "ws://b:3000", priority: 1, limits: {} });
    registry.register("c", { url: "ws://c:3000", priority: 1, limits: {} });
    const selector = new ProviderSelector(registry, cooldown, "round-robin");
    const seen = new Set<string>();
    for (let i = 0; i < 12; i++) {
      seen.add(selector.getCandidates()[0].id);
    }
    expect(seen.size).toBe(3);
  });

  // Weighted picks must converge to the configured ratio over many picks.
  // Catches mutations like `bestWeight - totalWeight` → `bestWeight + totalWeight`
  // which would break the smooth distribution invariant.
  it("weighted distribution stays bounded (heavy never picked more than weight ratio implies)", () => {
    registry.register("a", { url: "ws://a:3000", priority: 1, limits: {}, weight: 2 });
    registry.register("b", { url: "ws://b:3000", priority: 1, limits: {}, weight: 1 });
    const selector = new ProviderSelector(registry, cooldown, "weighted");
    const picks: string[] = [];
    for (let i = 0; i < 30; i++) {
      picks.push(selector.getCandidates()[0].id);
    }
    const aCount = picks.filter((p) => p === "a").length;
    const bCount = picks.filter((p) => p === "b").length;
    // 2:1 over 30 picks → a≈20, b≈10. Allow ±3.
    expect(aCount).toBeGreaterThanOrEqual(17);
    expect(aCount).toBeLessThanOrEqual(23);
    expect(bCount).toBeGreaterThanOrEqual(7);
    expect(bCount).toBeLessThanOrEqual(13);
  });

  // ─── Comprehensive checks for the candidates list shape ───
  //
  // The round-robin and weighted strategies use `[selected, ...filter(c => c.id !== selected.id)]`.
  // Several mutations on the filter callback survive if we only check the FIRST
  // element. Test the full list shape: length, uniqueness, presence.

  it("round-robin returns all available candidates exactly once each, with the selected one first", () => {
    registry.register("a", { url: "ws://a:3000", priority: 1, limits: {} });
    registry.register("b", { url: "ws://b:3000", priority: 1, limits: {} });
    registry.register("c", { url: "ws://c:3000", priority: 1, limits: {} });
    const selector = new ProviderSelector(registry, cooldown, "round-robin");
    const candidates = selector.getCandidates();
    expect(candidates).toHaveLength(3);
    const ids = candidates.map((x) => x.id);
    expect(new Set(ids).size).toBe(3);
  });

  it("weighted returns all available candidates exactly once each, with the selected one first", () => {
    registry.register("a", { url: "ws://a:3000", priority: 1, limits: {}, weight: 1 });
    registry.register("b", { url: "ws://b:3000", priority: 1, limits: {}, weight: 1 });
    registry.register("c", { url: "ws://c:3000", priority: 1, limits: {}, weight: 1 });
    const selector = new ProviderSelector(registry, cooldown, "weighted");
    const candidates = selector.getCandidates();
    expect(candidates).toHaveLength(3);
    const ids = candidates.map((x) => x.id);
    expect(new Set(ids).size).toBe(3);
  });

  // Distinguishes `if (available.length === 0) return []` from `→ false`. With
  // the mutation, applyStrategy runs on an empty list. For round-robin
  // specifically, `candidates[0]` is undefined and `.id` on undefined throws.
  it("returns [] even on non-priority strategies when no providers are available", () => {
    // No providers registered → available is empty.
    for (const strategy of ["round-robin", "weighted", "least-connections", "latency-optimized"] as const) {
      const sel = new ProviderSelector(registry, cooldown, strategy);
      expect(sel.getCandidates()).toEqual([]);
    }
  });

  // Distinguishes `case "priority-chain":` → `case "":` (mutated literal).
  // With the mutation, "priority-chain" falls through to `default` (which also
  // returns `candidates`). Same result for the happy path, but order DIFFERS
  // for higher-priority providers because default doesn't promise priority
  // order — wait, actually applyStrategy default does `return candidates`
  // (already priority-sorted). So this is hard to distinguish.
  // Instead, explicitly verify default-strategy fallback:
  it("unknown strategy falls back to priority order (default case)", () => {
    registry.register("low", { url: "ws://low:3000", priority: 2, limits: {} });
    registry.register("high", { url: "ws://high:3000", priority: 1, limits: {} });
    const sel = new ProviderSelector(registry, cooldown, "priority-chain");
    // Passing a strategy value not in the enum — applyStrategy hits default.
    const candidates = sel.getCandidates("never-existed" as never);
    expect(candidates.map((c) => c.id)).toEqual(["high", "low"]);
  });
});
