import { describe, it, expect, beforeEach } from "vitest";
import { ProviderRegistry } from "../../src/core/providers/registry.js";

describe("ProviderRegistry", () => {
  let registry: ProviderRegistry;

  beforeEach(() => {
    registry = new ProviderRegistry();
  });

  it("should register and retrieve a provider", () => {
    registry.register("test", { url: "ws://test:3000", priority: 1 });
    const provider = registry.get("test");
    expect(provider).toBeDefined();
    expect(provider!.id).toBe("test");
    expect(provider!.config.url).toBe("ws://test:3000");
  });

  it("should return undefined for unknown provider", () => {
    expect(registry.get("nonexistent")).toBeUndefined();
  });

  it("should track size", () => {
    expect(registry.size()).toBe(0);
    registry.register("a", { url: "ws://a:3000", priority: 1 });
    expect(registry.size()).toBe(1);
    registry.register("b", { url: "ws://b:3000", priority: 2 });
    expect(registry.size()).toBe(2);
  });

  it("should return all providers", () => {
    registry.register("a", { url: "ws://a:3000", priority: 1 });
    registry.register("b", { url: "ws://b:3000", priority: 2 });
    const all = registry.getAll();
    expect(all).toHaveLength(2);
    expect(all.map((b) => b.id)).toContain("a");
    expect(all.map((b) => b.id)).toContain("b");
  });

  it("should sort by priority", () => {
    registry.register("low", { url: "ws://low:3000", priority: 3 });
    registry.register("high", { url: "ws://high:3000", priority: 1 });
    registry.register("mid", { url: "ws://mid:3000", priority: 2 });
    const sorted = registry.getAllSortedByPriority();
    expect(sorted.map((b) => b.id)).toEqual(["high", "mid", "low"]);
  });

  it("should initialize provider state correctly", () => {
    registry.register("test", { url: "ws://test:3000", priority: 1 });
    const provider = registry.get("test")!;
    expect(provider.active).toBe(0);
    expect(provider.healthy).toBe(true);
    expect(provider.cooldownUntil).toBeNull();
    expect(provider.failureCount).toBe(0);
    expect(provider.successCount).toBe(0);
    expect(provider.avgLatencyMs).toBe(0);
    expect(provider.totalConnections).toBe(0);
  });
});
