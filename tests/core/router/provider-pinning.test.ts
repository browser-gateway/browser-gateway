/**
 * Provider pinning — covers the 8 edge cases the design plan listed.
 *
 *   1. ?provider= unset → existing strategy still picks (no regression)
 *   2. ?provider=foo (not configured) → 0 candidates
 *   3. ?provider=foo healthy + slot → returns [foo] only
 *   4. ?provider=foo in cooldown → 0 candidates
 *   5. ?provider=foo at maxConcurrent → 0 candidates
 *   6. Pinned candidate is the ONLY one even when others are healthier
 *   7. Pinned ignores strategy (would have picked a different one otherwise)
 *   8. After failure → cooldown → pinned still returns 0 (no failover)
 */
import { describe, it, expect, beforeEach } from "vitest";
import { ProviderSelector } from "../../../src/core/router/selector.js";
import { ProviderRegistry } from "../../../src/core/providers/registry.js";
import { CooldownTracker } from "../../../src/core/tracking/cooldown.js";
import { GatewayConfigSchema } from "../../../src/core/types.js";

const cfg = (overrides = {}) =>
  GatewayConfigSchema.parse({
    providers: {
      "fast-a": { url: "ws://a", priority: 1, limits: { maxConcurrent: 2 } },
      "fast-b": { url: "ws://b", priority: 1, limits: { maxConcurrent: 2 } },
      "slow-c": { url: "ws://c", priority: 2, limits: { maxConcurrent: 2 } },
    },
    ...overrides,
  });

let registry: ProviderRegistry;
let cooldown: CooldownTracker;
let selector: ProviderSelector;

beforeEach(() => {
  registry = new ProviderRegistry();
  for (const [id, p] of Object.entries(cfg().providers)) {
    registry.register(id, p, { autoProbe: false });
  }
  cooldown = new CooldownTracker(cfg().gateway.cooldown);
  selector = new ProviderSelector(registry, cooldown, "priority-chain");
});

describe("ProviderSelector pinning", () => {
  it("unset target → existing strategy (no regression)", () => {
    const got = selector.getCandidates();
    expect(got.map((p) => p.id)).toEqual(["fast-a", "fast-b", "slow-c"]);
  });

  it("unknown id → empty", () => {
    expect(selector.getCandidates({ targetProviderId: "does-not-exist" })).toEqual([]);
  });

  it("known + healthy + slot → exactly that one provider", () => {
    const got = selector.getCandidates({ targetProviderId: "slow-c" });
    expect(got.map((p) => p.id)).toEqual(["slow-c"]);
  });

  it("pinned at maxConcurrent → empty (no fallback)", () => {
    const c = registry.get("slow-c")!;
    c.active = c.config.limits!.maxConcurrent!;
    expect(selector.getCandidates({ targetProviderId: "slow-c" })).toEqual([]);
  });

  it("pinned in cooldown → empty", () => {
    const c = registry.get("slow-c")!;
    c.cooldownUntil = Date.now() + 60_000;
    expect(selector.getCandidates({ targetProviderId: "slow-c" })).toEqual([]);
  });

  it("pinned ignores load-balancer strategy", () => {
    const lat = new ProviderSelector(registry, cooldown, "latency-optimized");
    registry.get("fast-a")!.avgLatencyMs = 10;
    registry.get("fast-b")!.avgLatencyMs = 20;
    registry.get("slow-c")!.avgLatencyMs = 5;
    expect(
      lat.getCandidates({ targetProviderId: "fast-b" }).map((p) => p.id),
    ).toEqual(["fast-b"]);
  });

  it("pinned never spills over to siblings, even when siblings are free", () => {
    const c = registry.get("slow-c")!;
    c.active = c.config.limits!.maxConcurrent!;
    const got = selector.getCandidates({ targetProviderId: "slow-c" });
    expect(got).toEqual([]);
  });

  it("after cooldown clears, pinned candidate comes back", () => {
    const c = registry.get("slow-c")!;
    c.cooldownUntil = Date.now() - 1; // already expired
    expect(selector.getCandidates({ targetProviderId: "slow-c" }).map((p) => p.id)).toEqual(["slow-c"]);
  });
});
