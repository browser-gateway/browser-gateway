import { describe, it, expect, beforeEach } from "vitest";
import { BackendRegistry } from "../../src/core/backends/registry.js";

describe("BackendRegistry", () => {
  let registry: BackendRegistry;

  beforeEach(() => {
    registry = new BackendRegistry();
  });

  it("should register and retrieve a backend", () => {
    registry.register("test", { url: "ws://test:3000", priority: 1 });
    const backend = registry.get("test");
    expect(backend).toBeDefined();
    expect(backend!.id).toBe("test");
    expect(backend!.config.url).toBe("ws://test:3000");
  });

  it("should return undefined for unknown backend", () => {
    expect(registry.get("nonexistent")).toBeUndefined();
  });

  it("should track size", () => {
    expect(registry.size()).toBe(0);
    registry.register("a", { url: "ws://a:3000", priority: 1 });
    expect(registry.size()).toBe(1);
    registry.register("b", { url: "ws://b:3000", priority: 2 });
    expect(registry.size()).toBe(2);
  });

  it("should return all backends", () => {
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

  it("should initialize backend state correctly", () => {
    registry.register("test", { url: "ws://test:3000", priority: 1 });
    const backend = registry.get("test")!;
    expect(backend.active).toBe(0);
    expect(backend.healthy).toBe(true);
    expect(backend.cooldownUntil).toBeNull();
    expect(backend.failureCount).toBe(0);
    expect(backend.successCount).toBe(0);
    expect(backend.avgLatencyMs).toBe(0);
    expect(backend.totalConnections).toBe(0);
  });
});
