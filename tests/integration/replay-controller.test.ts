import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { ProviderRegistry } from "../../src/core/providers/registry.js";
import { ReplayConfigSchema } from "../../src/core/types.js";
import { ReplayController } from "../../src/server/replay/controller.js";

let dir: string;
const logger = pino({ level: "silent" });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bg-replay-ctrl-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeRegistry(opts: { providerId: string; supportsScreencast: boolean }): ProviderRegistry {
  const r = new ProviderRegistry();
  r.register(
    opts.providerId,
    { url: "ws://invalid:9999", limits: { maxConcurrent: 1 }, priority: 1, weight: 1 },
    { autoProbe: false },
  );
  r.setCapabilities(opts.providerId, {
    probedAt: new Date().toISOString(),
    probeDurationMs: 0,
    errors: [],
    targetCreateLatencyMs: null,
    browserCookies: "supported",
    targetCreate: "supported",
    targetGetTargets: "supported",
    fetchInterception: "supported",
    pageScreencast: opts.supportsScreencast ? "supported" : "unsupported",
  });
  return r;
}

function makeController(dir: string, registry: ProviderRegistry): ReplayController {
  return new ReplayController({
    storePath: dir,
    config: ReplayConfigSchema.parse({}),
    registry,
    logger,
  });
}

describe("ReplayController capability gate", () => {
  it("skips capture when sessionRecord = false", () => {
    const registry = makeRegistry({ providerId: "p1", supportsScreencast: true });
    const controller = makeController(dir, registry);
    controller.onSessionStart({
      sessionId: "s1",
      providerId: "p1",
      providerWsUrl: "ws://invalid",
      sessionRecord: false,
    });
    expect(controller.activeCount()).toBe(0);
  });

  it("skips capture when provider does not support pageScreencast", () => {
    const registry = makeRegistry({ providerId: "p1", supportsScreencast: false });
    const controller = makeController(dir, registry);
    controller.onSessionStart({
      sessionId: "s1",
      providerId: "p1",
      providerWsUrl: "ws://invalid",
      sessionRecord: true,
    });
    expect(controller.activeCount()).toBe(0);
  });

  it("kicks off capture when sessionRecord=true + provider supports screencast", () => {
    const registry = makeRegistry({ providerId: "p1", supportsScreencast: true });
    const controller = makeController(dir, registry);
    controller.onSessionStart({
      sessionId: "s1",
      providerId: "p1",
      providerWsUrl: "ws://127.0.0.1:1",
      sessionRecord: true,
    });
    expect(controller.activeCount()).toBe(1);
  });

  it("onSessionEnd removes from active map even when start failed", async () => {
    const registry = makeRegistry({ providerId: "p1", supportsScreencast: true });
    const controller = makeController(dir, registry);
    controller.onSessionStart({
      sessionId: "s1",
      providerId: "p1",
      providerWsUrl: "ws://127.0.0.1:1",
      sessionRecord: true,
    });
    controller.onSessionEnd("s1");
    await new Promise((r) => setTimeout(r, 50));
    expect(controller.activeCount()).toBe(0);
  });

  it("shutdown waits for in-flight captures", async () => {
    const registry = makeRegistry({ providerId: "p1", supportsScreencast: true });
    const controller = makeController(dir, registry);
    controller.onSessionStart({
      sessionId: "s1",
      providerId: "p1",
      providerWsUrl: "ws://127.0.0.1:1",
      sessionRecord: true,
    });
    controller.onSessionStart({
      sessionId: "s2",
      providerId: "p1",
      providerWsUrl: "ws://127.0.0.1:1",
      sessionRecord: true,
    });
    await controller.shutdown();
    expect(controller.activeCount()).toBe(0);
  });
});
