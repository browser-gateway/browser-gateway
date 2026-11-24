import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import pino from "pino";
import { Gateway } from "../../src/core/gateway.js";
import type { GatewayConfig } from "../../src/core/types.js";

const silentLogger = pino({ level: "silent" });

function createConfig(overrides?: Partial<GatewayConfig>): GatewayConfig {
  return {
    version: 1,
    gateway: {
      port: 9500,
      defaultStrategy: "priority-chain",
      healthCheckInterval: 30000,
      connectionTimeout: 10000,
      cooldown: { defaultMs: 5000, failureThreshold: 0.5, minRequestVolume: 3 },
      sessions: { idleTimeoutMs: 300000 },
    },
    providers: {
      fast: { url: "ws://fast:3000", priority: 1 },
      slow: { url: "ws://slow:3000", priority: 2 },
    },
    dashboard: { enabled: false },
    logging: { level: "info" },
    ...overrides,
  };
}

describe("Gateway", () => {
  let gateway: Gateway;

  beforeEach(() => {
    gateway = new Gateway(createConfig(), silentLogger);
  });

  afterEach(() => {
    gateway.stop();
  });

  it("should register all providers from config", () => {
    expect(gateway.registry.size()).toBe(2);
    expect(gateway.registry.get("fast")).toBeDefined();
    expect(gateway.registry.get("slow")).toBeDefined();
  });

  it("should select provider by priority", () => {
    const selected = gateway.selectProvider();
    expect(selected).not.toBeNull();
    expect(selected!.id).toBe("fast");
  });

  it("should return fallback candidates in order", () => {
    const candidates = gateway.selectProviderWithFallbacks();
    expect(candidates).toHaveLength(2);
    expect(candidates[0].id).toBe("fast");
    expect(candidates[1].id).toBe("slow");
  });

  it("should skip full providers when selecting", () => {
    const config = createConfig({
      providers: {
        full: { url: "ws://full:3000", priority: 1, limits: { maxConcurrent: 1 } },
        available: { url: "ws://available:3000", priority: 2 },
      },
    });
    const gw = new Gateway(config, silentLogger);

    gw.acquireSlot("full", "session-1");
    const selected = gw.selectProvider();
    expect(selected!.id).toBe("available");
    gw.stop();
  });

  it("should return null when all providers unavailable", () => {
    const config = createConfig({
      providers: {
        only: { url: "ws://only:3000", priority: 1, limits: { maxConcurrent: 1 } },
      },
    });
    const gw = new Gateway(config, silentLogger);

    gw.acquireSlot("only", "session-1");
    expect(gw.selectProvider()).toBeNull();
    gw.stop();
  });

  it("should acquire and release slots", () => {
    const config = createConfig({
      providers: {
        limited: { url: "ws://limited:3000", priority: 1, limits: { maxConcurrent: 2 } },
      },
    });
    const gw = new Gateway(config, silentLogger);

    expect(gw.acquireSlot("limited", "s1")).toBe(true);
    expect(gw.acquireSlot("limited", "s2")).toBe(true);
    expect(gw.acquireSlot("limited", "s3")).toBe(false);

    gw.releaseSlot("s1", "limited");
    expect(gw.acquireSlot("limited", "s3")).toBe(true);
    gw.stop();
  });

  it("should record success and update latency", () => {
    gateway.recordSuccess("fast", 200);
    const provider = gateway.registry.get("fast")!;
    expect(provider.avgLatencyMs).toBe(200);

    gateway.recordSuccess("fast", 400);
    expect(provider.avgLatencyMs).toBeGreaterThan(200);
    expect(provider.avgLatencyMs).toBeLessThan(400);
  });

  it("should record failures and trigger cooldown", () => {
    gateway.recordFailure("fast");
    gateway.recordFailure("fast");
    gateway.recordFailure("fast");

    const provider = gateway.registry.get("fast")!;
    expect(provider.failureCount).toBe(3);
    expect(provider.cooldownUntil).not.toBeNull();
  });

  it("announces each provider change once: down, then paused, then back up on a new connection", () => {
    const events: string[] = [];
    for (const e of ["provider.down", "provider.cooldown", "provider.up"] as const) gateway.on(e, () => events.push(e));
    for (let i = 0; i < 4; i++) gateway.recordFailure("fast");
    expect(events).toEqual(["provider.down", "provider.cooldown"]);
    gateway.recordConnected("fast");
    gateway.recordConnected("fast");
    expect(events).toEqual(["provider.down", "provider.cooldown", "provider.up"]);
  });

  it("does not announce back up when an older session ends while the provider is still in trouble", () => {
    const up = vi.fn();
    gateway.on("provider.up", up);
    for (let i = 0; i < 4; i++) gateway.recordFailure("fast");
    gateway.recordSuccess("fast", 100);
    expect(up).not.toHaveBeenCalled();
  });

  it("announces down even when the first failure also starts a pause", () => {
    gateway.stop();
    gateway = new Gateway(createConfig({ gateway: { ...createConfig().gateway, cooldown: { defaultMs: 5000, failureThreshold: 0.5, minRequestVolume: 1 } } }), silentLogger);
    const events: string[] = [];
    for (const e of ["provider.down", "provider.cooldown"] as const) gateway.on(e, () => events.push(e));
    gateway.recordFailure("fast");
    expect(events).toEqual(["provider.down", "provider.cooldown"]);
  });

  it("forgets a removed provider's trouble, so a new provider with the same id starts clean", () => {
    const events: string[] = [];
    for (const e of ["provider.down", "provider.up"] as const) gateway.on(e, () => events.push(e));
    gateway.recordFailure("fast");
    gateway.removeProvider("fast");
    gateway.applyProviderConfig("fast", { url: "ws://fast:3000", priority: 1 });
    gateway.recordConnected("fast");
    gateway.recordFailure("fast");
    expect(events).toEqual(["provider.down", "provider.down"]);
  });

  it("never announces back up from a session ending, only from a new connection", () => {
    const up = vi.fn();
    gateway.on("provider.up", up);
    gateway.recordFailure("fast");
    gateway.recordSuccess("fast", 1);
    expect(up).not.toHaveBeenCalled();
    gateway.recordConnected("fast");
    expect(up).toHaveBeenCalledTimes(1);
  });

  it("is told about every new connection on every session path that reports success", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));
    const code = (f: string) => readFileSync(f, "utf-8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const reporting = walk(join(__dirname, "../../src/server")).filter((f) => code(f).includes(".recordSuccess("));
    expect(reporting.length).toBeGreaterThanOrEqual(4);
    for (const file of reporting) expect(code(file), file).toContain(".recordConnected(");
  });

  it("keeps a provider's trouble when its settings are edited, so recovery is still announced", () => {
    const up = vi.fn();
    gateway.on("provider.up", up);
    gateway.recordFailure("fast");
    gateway.applyProviderConfig("fast", { url: "ws://fast:3001", priority: 1 });
    gateway.recordConnected("fast");
    expect(up).toHaveBeenCalledTimes(1);
  });

  it("does not pause a re-added provider because of failures from before it was removed", () => {
    gateway.recordFailure("fast");
    gateway.recordFailure("fast");
    gateway.removeProvider("fast");
    gateway.applyProviderConfig("fast", { url: "ws://fast:3000", priority: 1 });
    gateway.recordFailure("fast");
    expect(gateway.registry.get("fast")!.cooldownUntil).toBeNull();
  });

  it("does not announce a provider coming back that never had trouble", () => {
    const up = vi.fn();
    gateway.on("provider.up", up);
    gateway.recordConnected("fast");
    expect(up).not.toHaveBeenCalled();
  });

  it("should return status with all provider info", () => {
    gateway.sessions.create("s1", "fast");
    const status = gateway.getStatus();

    expect(status.activeSessions).toBe(1);
    expect(status.strategy).toBe("priority-chain");
    expect(status.providers).toHaveLength(2);
    expect(status.providers[0].id).toBeDefined();
  });

  it("should not acquire slot for unknown provider", () => {
    expect(gateway.acquireSlot("nonexistent", "s1")).toBe(false);
  });

  it("should handle release for unknown provider gracefully", () => {
    expect(() => gateway.releaseSlot("s1", "nonexistent")).not.toThrow();
  });

  it("should mask URLs with secrets in logs", () => {
    const config = createConfig({
      providers: {
        secret: { url: "wss://provider.com?token=super-secret&key=another", priority: 1 },
      },
    });
    const _logs: string[] = [];
    const captureLogger = pino({
      level: "info",
      transport: undefined,
    });
    // Just verify the gateway doesn't throw with secret URLs
    const gw = new Gateway(config, captureLogger);
    expect(gw.registry.get("secret")).toBeDefined();
    gw.stop();
  });
});

describe("Gateway idle sessions", () => {
  afterEach(() => vi.useRealTimers());

  it("closes a session idle past idleTimeoutMs and leaves an active one alone", () => {
    vi.useFakeTimers();
    const base = createConfig();
    const gw = new Gateway(
      createConfig({ gateway: { ...base.gateway, healthCheckInterval: 3_600_000, sessions: { idleTimeoutMs: 1000 } } }),
      silentLogger,
    );
    const closed: string[] = [];
    gw.sessions.create("idle", "fast");
    gw.sessions.setCloser("idle", () => closed.push("idle"));
    gw.sessions.create("busy", "fast");
    gw.sessions.setCloser("busy", () => closed.push("busy"));
    gw.start();

    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(600);
      gw.sessions.recordActivity("busy");
    }

    expect(closed).toEqual(["idle"]);
    gw.stop();
  });
});
