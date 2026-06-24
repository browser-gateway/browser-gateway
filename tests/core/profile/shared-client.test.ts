/**
 * Persistent-client integration test.
 *
 * Verifies that one connected WsCDPClient can serve all three profile phases
 * (inject eager + run background + capture) with a single underlying WS
 * connection. The mock counts WS-level connects to make the assertion precise.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import {
  injectStateEager,
  runBackgroundInjectOnClient,
  captureFullStateOnClient,
  type CapturedProfile,
  type OriginStorage,
} from "../../../src/core/profile/index.js";
import { WsCDPClient } from "../../../src/core/profile/cdp-client.js";

interface MockCdp {
  url: string;
  connectionCount: () => number;
  received: Array<{ method: string; sessionId?: string }>;
  close: () => Promise<void>;
}

async function startMockCdp(): Promise<MockCdp> {
  const received: MockCdp["received"] = [];
  let connectionCount = 0;
  let sessionsCreated = 0;
  let targetsCreated = 0;
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  const { port } = wss.address() as AddressInfo;

  wss.on("connection", (ws) => {
    connectionCount++;
    ws.on("message", (raw) => {
      const env = JSON.parse(raw.toString("utf8")) as {
        id?: number;
        method?: string;
        sessionId?: string;
        params?: Record<string, unknown>;
      };
      if (env.id === undefined || !env.method) return;
      received.push({ method: env.method, sessionId: env.sessionId });

      let result: Record<string, unknown>;
      switch (env.method) {
        case "Storage.getCookies":
          result = { cookies: [] };
          break;
        case "Target.createTarget":
          result = { targetId: `T${targetsCreated++}` };
          break;
        case "Target.attachToTarget":
          result = { sessionId: `S${sessionsCreated++}` };
          break;
        case "Runtime.evaluate":
          result = { result: { type: "string", value: JSON.stringify({ token: "x" }) } };
          break;
        default:
          result = {};
      }
      ws.send(JSON.stringify({ id: env.id, sessionId: env.sessionId, result }));
    });
  });

  return {
    url: `ws://localhost:${port}`,
    connectionCount: () => connectionCount,
    received,
    close: async () => {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

function makeProfile(opts: { eagerOrigins?: number; backgroundOrigins?: number }): CapturedProfile {
  const storage: Record<string, OriginStorage> = {};
  const eagerCount = opts.eagerOrigins ?? 0;
  const bgCount = opts.backgroundOrigins ?? 0;
  for (let i = 0; i < eagerCount + bgCount; i++) {
    storage[`https://o${i}.com`] = {
      localStorage: { k: String(i) },
      sessionStorage: {},
      lastVisitedAt: new Date(Date.now() - i * 60_000).toISOString(),
    };
  }
  return {
    version: 1,
    capturedAt: new Date().toISOString(),
    cookies: [{ name: "c", value: "v", domain: ".example.com", path: "/", secure: false, httpOnly: false }],
    storage,
    meta: { capturedOrigins: [], skippedOrigins: [], durationMs: 0 },
  };
}

let mock: MockCdp;
beforeEach(async () => {
  mock = await startMockCdp();
});
afterEach(async () => {
  await mock.close();
});

describe("persistent client across profile phases", () => {
  it("eager + background + capture all run on ONE underlying WS connection", async () => {
    const profile = makeProfile({ eagerOrigins: 5, backgroundOrigins: 5 });
    const alreadyInjected = new Set<string>();
    const client = new WsCDPClient();
    await client.connect(mock.url);

    try {
      const eagerResult = await injectStateEager(client, profile, {
        eagerOriginLimit: 5,
        helperPages: 2,
      });
      for (const o of eagerResult.originsInjected) alreadyInjected.add(o);

      const bgResult = await runBackgroundInjectOnClient(client, {
        origins: eagerResult.originsDeferred,
        storage: profile.storage,
        alreadyInjected,
        helperPages: 2,
      });

      const capResult = await captureFullStateOnClient(client, Object.keys(profile.storage), {
        helperPages: 2,
      });

      // The mock counts only WS-level upgrades. Three phases, one connect.
      expect(mock.connectionCount()).toBe(1);
      expect(eagerResult.originsInjected.length).toBe(5);
      expect(bgResult.injected.length).toBe(5);
      expect(Object.keys(capResult.storage).length).toBe(10);
    } finally {
      await client.close();
    }
  });

  it("transient wrappers still open + close their own WS when called standalone", async () => {
    const { injectStateEagerViaTransient, runBackgroundInject, captureFullStateViaTransient } = await import(
      "../../../src/core/profile/index.js"
    );
    const profile = makeProfile({ eagerOrigins: 2 });

    await injectStateEagerViaTransient(mock.url, profile, { eagerOriginLimit: 2, helperPages: 1 });
    expect(mock.connectionCount()).toBe(1);

    await runBackgroundInject({
      origins: ["https://o0.com"],
      storage: profile.storage,
      providerWsUrl: mock.url,
      alreadyInjected: new Set(),
      helperPages: 1,
    });
    expect(mock.connectionCount()).toBe(2);

    await captureFullStateViaTransient(mock.url, ["https://o0.com"], { helperPages: 1 });
    expect(mock.connectionCount()).toBe(3);
  });

  it("a phase failure does not poison subsequent phases that share the same client", async () => {
    // Hand a zero-budget eager call that fails fast, then verify background still runs cleanly.
    const profile = makeProfile({ eagerOrigins: 0, backgroundOrigins: 3 });
    const client = new WsCDPClient();
    await client.connect(mock.url);
    try {
      const eagerResult = await injectStateEager(client, profile, {
        eagerOriginLimit: 0,
        helperPages: 1,
      });
      expect(eagerResult.originsInjected.length).toBe(0);
      expect(eagerResult.originsDeferred.length).toBe(3);

      const bgResult = await runBackgroundInjectOnClient(client, {
        origins: eagerResult.originsDeferred,
        storage: profile.storage,
        alreadyInjected: new Set(),
        helperPages: 1,
      });

      expect(bgResult.injected.length).toBe(3);
      expect(mock.connectionCount()).toBe(1);
    } finally {
      await client.close();
    }
  });
});
