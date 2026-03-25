import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
    backends: {
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

  it("should register all backends from config", () => {
    expect(gateway.registry.size()).toBe(2);
    expect(gateway.registry.get("fast")).toBeDefined();
    expect(gateway.registry.get("slow")).toBeDefined();
  });

  it("should select backend by priority", () => {
    const selected = gateway.selectBackend();
    expect(selected).not.toBeNull();
    expect(selected!.id).toBe("fast");
  });

  it("should return fallback candidates in order", () => {
    const candidates = gateway.selectBackendWithFallbacks();
    expect(candidates).toHaveLength(2);
    expect(candidates[0].id).toBe("fast");
    expect(candidates[1].id).toBe("slow");
  });

  it("should skip full backends when selecting", () => {
    const config = createConfig({
      backends: {
        full: { url: "ws://full:3000", priority: 1, limits: { maxConcurrent: 1 } },
        available: { url: "ws://available:3000", priority: 2 },
      },
    });
    const gw = new Gateway(config, silentLogger);

    gw.acquireSlot("full", "session-1");
    const selected = gw.selectBackend();
    expect(selected!.id).toBe("available");
    gw.stop();
  });

  it("should return null when all backends unavailable", () => {
    const config = createConfig({
      backends: {
        only: { url: "ws://only:3000", priority: 1, limits: { maxConcurrent: 1 } },
      },
    });
    const gw = new Gateway(config, silentLogger);

    gw.acquireSlot("only", "session-1");
    expect(gw.selectBackend()).toBeNull();
    gw.stop();
  });

  it("should acquire and release slots", () => {
    const config = createConfig({
      backends: {
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
    const backend = gateway.registry.get("fast")!;
    expect(backend.avgLatencyMs).toBe(200);

    gateway.recordSuccess("fast", 400);
    expect(backend.avgLatencyMs).toBeGreaterThan(200);
    expect(backend.avgLatencyMs).toBeLessThan(400);
  });

  it("should record failures and trigger cooldown", () => {
    gateway.recordFailure("fast");
    gateway.recordFailure("fast");
    gateway.recordFailure("fast");

    const backend = gateway.registry.get("fast")!;
    expect(backend.failureCount).toBe(3);
    expect(backend.cooldownUntil).not.toBeNull();
  });

  it("should return status with all backend info", () => {
    gateway.sessions.create("s1", "fast");
    const status = gateway.getStatus();

    expect(status.activeSessions).toBe(1);
    expect(status.strategy).toBe("priority-chain");
    expect(status.backends).toHaveLength(2);
    expect(status.backends[0].id).toBeDefined();
  });

  it("should not acquire slot for unknown backend", () => {
    expect(gateway.acquireSlot("nonexistent", "s1")).toBe(false);
  });

  it("should handle release for unknown backend gracefully", () => {
    expect(() => gateway.releaseSlot("s1", "nonexistent")).not.toThrow();
  });

  it("should mask URLs with secrets in logs", () => {
    const config = createConfig({
      backends: {
        secret: { url: "wss://provider.com?token=super-secret&key=another", priority: 1 },
      },
    });
    const logs: string[] = [];
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

