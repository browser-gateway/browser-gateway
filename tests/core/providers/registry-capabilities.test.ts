import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { ProviderRegistry } from "../../../src/core/providers/registry.js";

interface Probe {
  url: string;
  close: () => Promise<void>;
}

async function startProbe(): Promise<Probe> {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  const port = (wss.address() as AddressInfo).port;
  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      const env = JSON.parse(raw.toString("utf8")) as { id: number; method: string; sessionId?: string };
      let result: Record<string, unknown> = {};
      switch (env.method) {
        case "Storage.getCookies": result = { cookies: [] }; break;
        case "Target.createTarget": result = { targetId: "T0" }; break;
        case "Target.getTargets": result = { targetInfos: [{ targetId: "T0", type: "page" }] }; break;
        case "Target.attachToTarget": result = { sessionId: "S0" }; break;
      }
      ws.send(JSON.stringify({ id: env.id, sessionId: env.sessionId, result }));
    });
  });
  return {
    url: `ws://localhost:${port}`,
    close: async () => new Promise<void>((r) => wss.close(() => r())),
  };
}

let probe: Probe;

beforeEach(async () => {
  probe = await startProbe();
});

afterEach(async () => {
  await probe.close();
});

const cfg = (url: string) => ({
  url,
  limits: { maxConcurrent: 4 },
  priority: 1,
  weight: 1,
  healthCheck: { enabled: false as const, intervalMs: 60_000, path: "/" },
  cooldown: { thresholdFailures: 3, cooldownMs: 60_000, halfOpenAttempts: 1 },
  queue: { enabled: false, maxSize: 0, maxWaitMs: 0 },
});

describe("ProviderRegistry — capability lifecycle", () => {
  it("register() starts a probe; capabilities transition pending → ready", async () => {
    const reg = new ProviderRegistry();
    reg.register("p1", cfg(probe.url));
    expect(reg.getCapabilityRecord("p1")?.status).toMatch(/pending|probing/);
    await reg.probe("p1");
    const after = reg.getCapabilityRecord("p1");
    expect(after?.status).toBe("ready");
    expect(after?.capabilities?.browserCookies).toBe("supported");
    expect(after?.capabilities?.fetchInterception).toBe("supported");
  });

  it("autoProbe: false skips the probe — record stays pending until explicit probe()", async () => {
    const reg = new ProviderRegistry();
    reg.register("p1", cfg(probe.url), { autoProbe: false });
    await new Promise((r) => setTimeout(r, 30));
    expect(reg.getCapabilityRecord("p1")?.status).toBe("pending");
    await reg.probe("p1");
    expect(reg.getCapabilityRecord("p1")?.status).toBe("ready");
  });

  it("concurrent probe() calls coalesce — only one CDP roundtrip even with three callers", async () => {
    const reg = new ProviderRegistry();
    reg.register("p1", cfg(probe.url), { autoProbe: false });
    const [a, b, c] = await Promise.all([reg.probe("p1"), reg.probe("p1"), reg.probe("p1")]);
    expect(a).toBeUndefined();
    expect(b).toBeUndefined();
    expect(c).toBeUndefined();
    expect(reg.getCapabilityRecord("p1")?.status).toBe("ready");
  });

  it("revalidation: a second probe() updates the record", async () => {
    const reg = new ProviderRegistry();
    reg.register("p1", cfg(probe.url), { autoProbe: false });
    await reg.probe("p1");
    const t1 = reg.getCapabilityRecord("p1")?.capabilities?.probedAt;
    await new Promise((r) => setTimeout(r, 20));
    await reg.probe("p1");
    const t2 = reg.getCapabilityRecord("p1")?.capabilities?.probedAt;
    expect(t2).not.toBe(t1);
  });

  it("remove() drops the capability record", async () => {
    const reg = new ProviderRegistry();
    reg.register("p1", cfg(probe.url), { autoProbe: false });
    await reg.probe("p1");
    reg.remove("p1");
    expect(reg.getCapabilityRecord("p1")).toBeUndefined();
  });

  it("probe of an unreachable URL marks the record failed without throwing", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const reg = new ProviderRegistry();
    reg.register("dead", cfg("http://127.0.0.1:1"), { autoProbe: false });
    await reg.probe("dead");
    const rec = reg.getCapabilityRecord("dead");
    expect(rec?.status).toBe("failed");
    vi.useRealTimers();
  });
});
