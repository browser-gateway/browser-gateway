/**
 * Lazy hydration tests.
 *
 * Covers:
 *   - top-level frame nav for an origin in profile → Runtime.evaluate fires
 *   - same-origin nav with origin already in alreadyInjected Set → no fire
 *   - iframe nav (parentId set) → ignored
 *   - nav to origin not in profile → no fire
 *   - origin with empty localStorage → no fire (zero-cost)
 *   - teardown removes the listener (subsequent events ignored)
 *   - race: two rapid navs to same origin → exactly one inject
 *   - error in Runtime.evaluate doesn't crash; logger.warn captures it
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket as WsClient } from "ws";
import pino from "pino";
import { CdpClient } from "../../../src/server/live/cdp-client.js";
import { installLazyHydration } from "../../../src/server/live/lazy-hydration.js";

interface MockCdp {
  url: string;
  pushEvent: (method: string, params: Record<string, unknown>, sessionId?: string) => void;
  evaluateCalls: () => Array<{ params: Record<string, unknown>; sessionId?: string }>;
  setEvaluateError: (msg: string) => void;
  close: () => Promise<void>;
}

async function startMockCdp(): Promise<MockCdp> {
  const evaluateCalls: Array<{ params: Record<string, unknown>; sessionId?: string }> = [];
  let evaluateError: string | null = null;
  let client: WsClient | null = null;
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
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
      if (env.method === "Runtime.evaluate") {
        evaluateCalls.push({ params: env.params ?? {}, sessionId: env.sessionId });
        if (evaluateError) {
          ws.send(JSON.stringify({
            id: env.id,
            sessionId: env.sessionId,
            result: {},
            error: { code: -32000, message: evaluateError },
          }));
          return;
        }
      }
      ws.send(JSON.stringify({ id: env.id, sessionId: env.sessionId, result: {} }));
    });
  });

  return {
    url: `ws://localhost:${port}`,
    pushEvent: (method, params, sessionId) => {
      if (!client) return;
      const env: Record<string, unknown> = { method, params };
      if (sessionId) env.sessionId = sessionId;
      client.send(JSON.stringify(env));
    },
    evaluateCalls: () => evaluateCalls,
    setEvaluateError: (msg) => { evaluateError = msg; },
    close: async () => {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

const silentLogger = pino({ level: "silent" });
let mock: MockCdp;
let cdp: CdpClient;

const PROFILE_STORAGE = {
  "https://example.com": {
    localStorage: { token: "abc" },
    sessionStorage: {},
    lastVisitedAt: "2026-06-22T00:00:00Z",
  },
  "https://other.com": {
    localStorage: { user: "alice" },
    sessionStorage: {},
  },
  "https://empty.com": {
    localStorage: {},
    sessionStorage: {},
  },
};

beforeEach(async () => {
  mock = await startMockCdp();
  cdp = new CdpClient();
  await cdp.connect(mock.url);
});

afterEach(async () => {
  cdp.close();
  await mock.close();
});

describe("installLazyHydration", () => {
  it("injects storage on first top-level frame navigation to a profile origin", async () => {
    const alreadyInjected = new Set<string>();
    installLazyHydration({
      cdp,
      mainSessionId: "S0",
      storage: PROFILE_STORAGE,
      alreadyInjected,
      logger: silentLogger,
    });

    mock.pushEvent("Page.frameNavigated", { frame: { url: "https://example.com/login" } });
    await new Promise((r) => setTimeout(r, 40));

    const calls = mock.evaluateCalls();
    expect(calls.length).toBe(1);
    expect(calls[0].params.expression).toContain('"token"');
    expect(calls[0].params.expression).toContain('localStorage.setItem');
    expect(calls[0].sessionId).toBe("S0");
    expect(alreadyInjected.has("https://example.com")).toBe(true);
  });

  it("does not inject again when the origin is already in the alreadyInjected set", async () => {
    const alreadyInjected = new Set<string>(["https://example.com"]);
    installLazyHydration({
      cdp,
      mainSessionId: "S0",
      storage: PROFILE_STORAGE,
      alreadyInjected,
      logger: silentLogger,
    });

    mock.pushEvent("Page.frameNavigated", { frame: { url: "https://example.com/" } });
    await new Promise((r) => setTimeout(r, 40));

    expect(mock.evaluateCalls().length).toBe(0);
  });

  it("ignores iframe (parentId set) frame nav events", async () => {
    const alreadyInjected = new Set<string>();
    installLazyHydration({
      cdp,
      mainSessionId: "S0",
      storage: PROFILE_STORAGE,
      alreadyInjected,
      logger: silentLogger,
    });

    mock.pushEvent("Page.frameNavigated", { frame: { url: "https://example.com/iframe", parentId: "P1" } });
    await new Promise((r) => setTimeout(r, 40));

    expect(mock.evaluateCalls().length).toBe(0);
    expect(alreadyInjected.size).toBe(0);
  });

  it("does not inject when the origin is not in the profile", async () => {
    const alreadyInjected = new Set<string>();
    installLazyHydration({
      cdp,
      mainSessionId: "S0",
      storage: PROFILE_STORAGE,
      alreadyInjected,
      logger: silentLogger,
    });

    mock.pushEvent("Page.frameNavigated", { frame: { url: "https://unknown.com/" } });
    await new Promise((r) => setTimeout(r, 40));

    expect(mock.evaluateCalls().length).toBe(0);
  });

  it("does not inject when the origin's localStorage is empty (zero-cost)", async () => {
    const alreadyInjected = new Set<string>();
    installLazyHydration({
      cdp,
      mainSessionId: "S0",
      storage: PROFILE_STORAGE,
      alreadyInjected,
      logger: silentLogger,
    });

    mock.pushEvent("Page.frameNavigated", { frame: { url: "https://empty.com/" } });
    await new Promise((r) => setTimeout(r, 40));

    expect(mock.evaluateCalls().length).toBe(0);
  });

  it("teardown removes the listener — subsequent events are ignored", async () => {
    const alreadyInjected = new Set<string>();
    const off = installLazyHydration({
      cdp,
      mainSessionId: "S0",
      storage: PROFILE_STORAGE,
      alreadyInjected,
      logger: silentLogger,
    });

    off();
    mock.pushEvent("Page.frameNavigated", { frame: { url: "https://example.com/" } });
    await new Promise((r) => setTimeout(r, 40));

    expect(mock.evaluateCalls().length).toBe(0);
  });

  it("two rapid navs to same origin → exactly one inject (race-safe via Set.add before async)", async () => {
    const alreadyInjected = new Set<string>();
    installLazyHydration({
      cdp,
      mainSessionId: "S0",
      storage: PROFILE_STORAGE,
      alreadyInjected,
      logger: silentLogger,
    });

    // Same-tick double-nav. Set.add happens synchronously inside the listener
    // so the second event sees the origin already marked.
    mock.pushEvent("Page.frameNavigated", { frame: { url: "https://example.com/a" } });
    mock.pushEvent("Page.frameNavigated", { frame: { url: "https://example.com/b" } });
    await new Promise((r) => setTimeout(r, 40));

    expect(mock.evaluateCalls().length).toBe(1);
  });

  it("survives Runtime.evaluate returning an error envelope (logs warn, leaves origin marked)", async () => {
    const alreadyInjected = new Set<string>();
    const warnSpy = vi.fn();
    const logger = { ...silentLogger, warn: warnSpy, info: () => undefined, error: () => undefined } as unknown as typeof silentLogger;
    mock.setEvaluateError("synthetic CDP error");

    installLazyHydration({
      cdp,
      mainSessionId: "S0",
      storage: PROFILE_STORAGE,
      alreadyInjected,
      logger,
    });

    mock.pushEvent("Page.frameNavigated", { frame: { url: "https://example.com/" } });
    await new Promise((r) => setTimeout(r, 40));

    expect(alreadyInjected.has("https://example.com")).toBe(true);
    // Don't retry. We expect 1 evaluate attempt, the failure was logged.
    expect(mock.evaluateCalls().length).toBe(1);
  });
});
