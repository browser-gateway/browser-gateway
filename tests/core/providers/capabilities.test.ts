import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket as WsClient } from "ws";
import { probeProviderCapabilities } from "../../../src/core/providers/capabilities.js";

interface MockCdp {
  url: string;
  received: string[];
  close: () => Promise<void>;
  setBlocked: (methods: Set<string>) => void;
  setHanging: (methods: Set<string>) => void;
  setErrorOn: (methods: Set<string>) => void;
}

async function startMock(): Promise<MockCdp> {
  const received: string[] = [];
  let blocked = new Set<string>();
  let hanging = new Set<string>();
  let errorOn = new Set<string>();
  let client: WsClient | null = null;

  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  const { port } = wss.address() as AddressInfo;

  wss.on("connection", (ws) => {
    client = ws;
    ws.on("message", (raw) => {
      const env = JSON.parse(raw.toString("utf8")) as {
        id?: number;
        method?: string;
        sessionId?: string;
        params?: Record<string, unknown>;
      };
      if (env.id === undefined || !env.method) return;
      received.push(env.method);

      if (blocked.has(env.method)) {
        ws.send(JSON.stringify({ id: env.id, sessionId: env.sessionId, error: { code: -32601, message: "Method not implemented" } }));
        return;
      }
      if (hanging.has(env.method)) return;
      if (errorOn.has(env.method)) {
        ws.send(JSON.stringify({ id: env.id, sessionId: env.sessionId, error: { code: -32000, message: "synthetic error" } }));
        return;
      }

      let result: Record<string, unknown>;
      switch (env.method) {
        case "Storage.getCookies":
          result = { cookies: [] };
          break;
        case "Target.createTarget":
          result = { targetId: "T0" };
          break;
        case "Target.getTargets":
          result = { targetInfos: [{ targetId: "T0", type: "page" }] };
          break;
        case "Target.attachToTarget":
          result = { sessionId: "S0" };
          break;
        default:
          result = {};
      }
      ws.send(JSON.stringify({ id: env.id, sessionId: env.sessionId, result }));
    });
  });

  return {
    url: `ws://localhost:${port}`,
    received,
    setBlocked: (s) => { blocked = s; },
    setHanging: (s) => { hanging = s; },
    setErrorOn: (s) => { errorOn = s; },
    close: async () => {
      try { client?.close(); } catch {}
      await new Promise<void>((r) => wss.close(() => r()));
    },
  };
}

let mock: MockCdp;

beforeEach(async () => {
  mock = await startMock();
});

afterEach(async () => {
  await mock.close();
});

describe("probeProviderCapabilities — happy path", () => {
  it("marks all capabilities supported when the peer answers every command", async () => {
    const caps = await probeProviderCapabilities(mock.url, { perStepTimeoutMs: 1_000 });
    expect(caps.browserCookies).toBe("supported");
    expect(caps.targetCreate).toBe("supported");
    expect(caps.targetGetTargets).toBe("supported");
    expect(caps.fetchInterception).toBe("supported");
    expect(caps.pageScreencast).toBe("supported");
    expect(caps.errors).toEqual([]);
    expect(caps.targetCreateLatencyMs).toBeGreaterThanOrEqual(0);
    expect(caps.probeDurationMs).toBeGreaterThan(0);
  });

  it("stamps probedAt and probeDurationMs on every probe", async () => {
    const caps = await probeProviderCapabilities(mock.url, { perStepTimeoutMs: 1_000 });
    expect(caps.probedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("closes the temporary helper target it created", async () => {
    await probeProviderCapabilities(mock.url, { perStepTimeoutMs: 1_000 });
    expect(mock.received).toContain("Target.closeTarget");
  });
});

describe("probeProviderCapabilities — selective blocking", () => {
  it("marks targetGetTargets unsupported when peer rejects it (Steel-Cloud shape)", async () => {
    mock.setBlocked(new Set(["Target.getTargets"]));
    const caps = await probeProviderCapabilities(mock.url, { perStepTimeoutMs: 1_000 });
    expect(caps.targetGetTargets).toBe("unsupported");
    expect(caps.targetCreate).toBe("supported");
    expect(caps.fetchInterception).toBe("supported");
    expect(caps.errors.some((e) => e.includes("targetGetTargets"))).toBe(true);
  });

  it("marks fetchInterception unsupported when Fetch.enable rejects", async () => {
    mock.setBlocked(new Set(["Fetch.enable"]));
    const caps = await probeProviderCapabilities(mock.url, { perStepTimeoutMs: 1_000 });
    expect(caps.fetchInterception).toBe("unsupported");
    expect(caps.targetCreate).toBe("supported");
  });

  it("marks pageScreencast unsupported when Page.startScreencast rejects", async () => {
    mock.setBlocked(new Set(["Page.startScreencast"]));
    const caps = await probeProviderCapabilities(mock.url, { perStepTimeoutMs: 1_000 });
    expect(caps.pageScreencast).toBe("unsupported");
    expect(caps.fetchInterception).toBe("supported");
  });
});

describe("probeProviderCapabilities — timeouts", () => {
  it("treats a hung command as unsupported, captures a timeout error, does not throw", async () => {
    mock.setHanging(new Set(["Storage.getCookies"]));
    const caps = await probeProviderCapabilities(mock.url, { perStepTimeoutMs: 200 });
    expect(caps.browserCookies).toBe("unsupported");
    expect(caps.errors.some((e) => /Storage\.getCookies: timeout/.test(e))).toBe(true);
  });

  it("captures targetCreate latency separately from the support flag", async () => {
    const caps = await probeProviderCapabilities(mock.url, { perStepTimeoutMs: 1_000 });
    expect(caps.targetCreate).toBe("supported");
    expect(caps.targetCreateLatencyMs).not.toBeNull();
    expect(caps.targetCreateLatencyMs!).toBeLessThan(1_000);
  });
});

describe("probeProviderCapabilities — connect failure", () => {
  it("returns an unknown matrix with a resolveWsUrl error when the URL is unreachable", async () => {
    const caps = await probeProviderCapabilities("http://127.0.0.1:1", {
      perStepTimeoutMs: 500,
      totalTimeoutMs: 1_000,
    });
    expect(caps.errors.length).toBeGreaterThan(0);
    expect(caps.browserCookies).toBe("unknown");
    expect(caps.targetCreate).toBe("unknown");
    expect(caps.pageScreencast).toBe("unknown");
  });
});

describe("probeProviderCapabilities — error responses", () => {
  it("treats an error envelope from Fetch.enable as unsupported", async () => {
    mock.setErrorOn(new Set(["Fetch.enable"]));
    const caps = await probeProviderCapabilities(mock.url, { perStepTimeoutMs: 1_000 });
    expect(caps.fetchInterception).toBe("unsupported");
  });
});
