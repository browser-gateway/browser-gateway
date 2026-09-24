import { afterEach, describe, expect, it } from "vitest";
import pino from "pino";
import { Gateway } from "../../src/core/gateway.js";
import { GatewayConfigSchema, type ProviderConfig } from "../../src/core/types.js";

const silentLogger = pino({ level: "silent" });
let gateway: Gateway;

function build(providers: Record<string, Partial<ProviderConfig> & { url: string }>): Gateway {
  gateway = new Gateway(GatewayConfigSchema.parse({ providers }), silentLogger);
  return gateway;
}

afterEach(() => {
  gateway?.stop();
});

describe("disabled provider", () => {
  it("is invisible to routing, status, and health checks", () => {
    const g = build({
      on: { url: "ws://on:3000", priority: 2 },
      off: { url: "ws://off:3000", priority: 1, enabled: false },
    });
    expect(g.registry.size()).toBe(1);
    expect(g.registry.get("off")).toBeUndefined();
    expect(g.selectProviderWithFallbacks().map((p) => p.id)).toEqual(["on"]);
    expect(g.getStatus().providers.map((p) => p.id)).toEqual(["on"]);
  });

  it("treats a pin to it like a pin to a provider that does not exist", () => {
    const g = build({ on: { url: "ws://on:3000" }, off: { url: "ws://off:3000", enabled: false } });
    expect(g.selectProviderWithFallbacks("off")).toEqual([]);
    expect(g.selectProviderWithFallbacks("off")).toEqual(g.selectProviderWithFallbacks("missing"));
  });

  it("leaves nothing routable when every provider is disabled", () => {
    const g = build({ a: { url: "ws://a:3000", enabled: false } });
    expect(g.registry.size()).toBe(0);
    expect(g.selectProvider()).toBeNull();
  });

  it("stays in the saved config so it can be switched back on", () => {
    const g = build({ off: { url: "ws://off:3000", enabled: false } });
    expect(g.config.providers["off"]?.enabled).toBe(false);
    expect(g.registry.getIncludingDisabled("off")).toBeDefined();
  });
});

describe("switching a provider off and on", () => {
  it("takes it out of routing at once and puts it back on re-enable", () => {
    const g = build({ a: { url: "ws://a:3000", priority: 1 }, b: { url: "ws://b:3000", priority: 2 } });
    const config = g.config.providers["a"]!;
    g.applyProviderConfig("a", { ...config, enabled: false });
    expect(g.selectProviderWithFallbacks().map((p) => p.id)).toEqual(["b"]);
    g.applyProviderConfig("a", { ...config, enabled: true });
    expect(g.selectProviderWithFallbacks().map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("lets a session already running on it release its slot after it is disabled", () => {
    const g = build({ a: { url: "ws://a:3000", limits: { maxConcurrent: 1 } } });
    expect(g.acquireSlot("a", "s1")).toBe(true);
    g.applyProviderConfig("a", { ...g.config.providers["a"]!, enabled: false });
    g.releaseSlot("s1", "a");
    g.applyProviderConfig("a", { ...g.config.providers["a"]!, enabled: true });
    expect(g.registry.get("a")?.active).toBe(0);
    expect(g.acquireSlot("a", "s2")).toBe(true);
  });

  it("keeps counting a session that is still running when the provider comes back", () => {
    const g = build({ a: { url: "ws://a:3000", limits: { maxConcurrent: 1 } } });
    g.acquireSlot("a", "s1");
    g.applyProviderConfig("a", { ...g.config.providers["a"]!, enabled: false });
    g.applyProviderConfig("a", { ...g.config.providers["a"]!, enabled: true });
    expect(g.registry.get("a")?.active).toBe(1);
    expect(g.acquireSlot("a", "s2")).toBe(false);
  });

  it("does not accept new sessions while disabled", () => {
    const g = build({ a: { url: "ws://a:3000" } });
    g.applyProviderConfig("a", { ...g.config.providers["a"]!, enabled: false });
    expect(g.acquireSlot("a", "s1")).toBe(false);
  });

  it("applies a settings change to a disabled provider without enabling it", () => {
    const g = build({ a: { url: "ws://a:3000", enabled: false } });
    g.applyProviderConfig("a", { ...g.config.providers["a"]!, priority: 7, enabled: false });
    expect(g.registry.get("a")).toBeUndefined();
    expect(g.registry.getIncludingDisabled("a")?.config.priority).toBe(7);
  });

  it("removing a disabled provider forgets it entirely", () => {
    const g = build({ a: { url: "ws://a:3000", enabled: false } });
    expect(g.registry.remove("a")).toBe(true);
    expect(g.registry.getIncludingDisabled("a")).toBeUndefined();
  });
});
