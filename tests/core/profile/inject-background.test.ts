/**
 * Background origin loader tests.
 *
 * Covers:
 *   - injects all queued origins via helper-page pool
 *   - skips origins already in alreadyInjected (no double-inject)
 *   - skips empty-storage origins (zero-cost)
 *   - opens 2 helpers by default; closes them at end
 *   - per-origin error doesn't abort the rest
 *   - abort signal stops the worker loops
 *   - sessionId tags Page.navigate + Runtime.evaluate
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket as WsClient } from "ws";
import { runBackgroundInject } from "../../../src/core/profile/inject-background.js";
import type { OriginStorage } from "../../../src/core/profile/types.js";

interface MockCdp {
  url: string;
  received: Array<{ id: number; method: string; sessionId?: string; params: Record<string, unknown> }>;
  setErrorOnce: (method: string, occurrence: number, message: string) => void;
  close: () => Promise<void>;
  client: () => WsClient | null;
}

async function startMockCdp(): Promise<MockCdp> {
  const received: MockCdp["received"] = [];
  const sessions: string[] = [];
  const errors = new Map<string, { remaining: number; message: string }>();
  let client: WsClient | null = null;
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  const { port } = wss.address() as AddressInfo;

  wss.on("connection", (ws) => {
    client = ws;
    ws.on("message", (raw) => {
      const env = JSON.parse(raw.toString("utf8")) as {
        id?: number; method?: string; sessionId?: string; params?: Record<string, unknown>;
      };
      if (env.id === undefined || !env.method) return;
      received.push({ id: env.id, method: env.method, sessionId: env.sessionId, params: env.params ?? {} });

      const e = errors.get(env.method);
      if (e && e.remaining > 0) {
        e.remaining--;
        ws.send(JSON.stringify({ id: env.id, sessionId: env.sessionId, error: { code: -32000, message: e.message } }));
        return;
      }

      let result: Record<string, unknown> | undefined;
      switch (env.method) {
        case "Target.createTarget":
          result = { targetId: `T${received.filter((r) => r.method === "Target.createTarget").length}` };
          break;
        case "Target.attachToTarget": {
          const sid = `S${sessions.length}`;
          sessions.push(sid);
          result = { sessionId: sid };
          break;
        }
        case "Runtime.evaluate":
          result = { result: { type: "object", value: { wrote: 1 } } };
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
    setErrorOnce: (method, occurrence, message) => {
      errors.set(method, { remaining: occurrence, message });
    },
    close: async () => {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
    client: () => client,
  };
}

function makeStorage(origins: string[]): Record<string, OriginStorage> {
  const out: Record<string, OriginStorage> = {};
  for (const o of origins) {
    out[o] = { localStorage: { k: "v" }, sessionStorage: {} };
  }
  return out;
}

let mock: MockCdp;
beforeEach(async () => {
  mock = await startMockCdp();
});
afterEach(async () => {
  await mock.close();
});

describe("runBackgroundInject", () => {
  it("injects all queued origins via the helper-page pool", async () => {
    const origins = ["https://a.com", "https://b.com", "https://c.com", "https://d.com"];
    const r = await runBackgroundInject({
      origins,
      storage: makeStorage(origins),
      providerWsUrl: mock.url,
      alreadyInjected: new Set(),
      helperPages: 2,
    });
    expect(r.injected.sort()).toEqual(origins.sort());
    expect(r.skipped).toEqual([]);
  });

  it("skips origins already in alreadyInjected (no duplicate work)", async () => {
    const origins = ["https://a.com", "https://b.com", "https://c.com"];
    const already = new Set(["https://b.com"]);
    await runBackgroundInject({
      origins,
      storage: makeStorage(origins),
      providerWsUrl: mock.url,
      alreadyInjected: already,
      helperPages: 1,
    });
    // b.com never gets navigated to.
    const navs = mock.received.filter((r) => r.method === "Page.navigate");
    const urls = navs.map((n) => n.params.url as string);
    expect(urls).not.toContain("https://b.com/");
    expect(urls).toContain("https://a.com/");
    expect(urls).toContain("https://c.com/");
  });

  it("skips origins with empty localStorage (zero-cost)", async () => {
    const origins = ["https://has.com", "https://empty.com"];
    const storage = makeStorage(["https://has.com"]);
    storage["https://empty.com"] = { localStorage: {}, sessionStorage: {} };
    const r = await runBackgroundInject({
      origins,
      storage,
      providerWsUrl: mock.url,
      alreadyInjected: new Set(),
      helperPages: 1,
    });
    expect(r.injected).toEqual(["https://has.com"]);
  });

  it("default helperPages = 2", async () => {
    const origins = ["https://a.com", "https://b.com", "https://c.com"];
    await runBackgroundInject({
      origins,
      storage: makeStorage(origins),
      providerWsUrl: mock.url,
      alreadyInjected: new Set(),
    });
    expect(mock.received.filter((r) => r.method === "Target.createTarget").length).toBe(2);
    expect(mock.received.filter((r) => r.method === "Target.closeTarget").length).toBe(2);
  });

  it("per-origin error doesn't abort the rest", async () => {
    const origins = ["https://a.com", "https://b.com"];
    mock.setErrorOnce("Page.navigate", 1, "navigation aborted");
    const r = await runBackgroundInject({
      origins,
      storage: makeStorage(origins),
      providerWsUrl: mock.url,
      alreadyInjected: new Set(),
      helperPages: 1,
    });
    expect(r.injected.length + r.skipped.length).toBe(2);
    expect(r.skipped.length).toBe(1);
  });

  it("startDelayMs delays the WS connection by at least the configured amount", async () => {
    const origins = ["https://a.com"];
    const t0 = Date.now();
    await runBackgroundInject({
      origins,
      storage: makeStorage(origins),
      providerWsUrl: mock.url,
      alreadyInjected: new Set(),
      helperPages: 1,
      startDelayMs: 200,
    });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(200);
  });

  it("startDelayMs is bypassed when the signal aborts during the delay", async () => {
    const origins = ["https://a.com", "https://b.com"];
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 50);
    const t0 = Date.now();
    const r = await runBackgroundInject({
      origins,
      storage: makeStorage(origins),
      providerWsUrl: mock.url,
      alreadyInjected: new Set(),
      helperPages: 1,
      startDelayMs: 5_000,
      signal: ctrl.signal,
    });
    // Returns shortly after abort, not after the full 5_000 ms delay.
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(r.injected.length).toBe(0);
  });

  it("abort signal stops the loop", async () => {
    const origins = ["https://a.com", "https://b.com", "https://c.com"];
    const ctrl = new AbortController();
    ctrl.abort();
    const r = await runBackgroundInject({
      origins,
      storage: makeStorage(origins),
      providerWsUrl: mock.url,
      alreadyInjected: new Set(),
      helperPages: 1,
      signal: ctrl.signal,
    });
    expect(r.injected.length).toBe(0);
  });

  it("Page.navigate and Runtime.evaluate are tagged with the helper sessionId", async () => {
    const origins = ["https://a.com"];
    await runBackgroundInject({
      origins,
      storage: makeStorage(origins),
      providerWsUrl: mock.url,
      alreadyInjected: new Set(),
      helperPages: 1,
    });
    const nav = mock.received.find((r) => r.method === "Page.navigate");
    const evaluate = mock.received.find((r) => r.method === "Runtime.evaluate");
    expect(nav?.sessionId).toBe("S0");
    expect(evaluate?.sessionId).toBe("S0");
  });

  it("calls onInjected and onError hooks", async () => {
    const origins = ["https://a.com", "https://b.com"];
    mock.setErrorOnce("Page.navigate", 1, "synthetic");
    const injectedHits: string[] = [];
    const errorHits: Array<{ o: string; r: string }> = [];
    await runBackgroundInject({
      origins,
      storage: makeStorage(origins),
      providerWsUrl: mock.url,
      alreadyInjected: new Set(),
      helperPages: 1,
      onInjected: (o) => injectedHits.push(o),
      onError: (o, r) => errorHits.push({ o, r }),
    });
    expect(injectedHits.length + errorHits.length).toBe(2);
  });
});
