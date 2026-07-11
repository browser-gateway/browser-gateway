/**
 * inject-eager unit tests.
 *
 * Spins up a mock CDP WebSocket server that:
 *   - Auto-replies to Storage.setCookies, Target.createTarget,
 *     Target.attachToTarget, Fetch.enable, Page.enable, Page.navigate,
 *     Runtime.evaluate, Fetch.fulfillRequest, Fetch.disable, Target.closeTarget
 *   - Records every received envelope (method + sessionId tag)
 *
 * Pins the contract:
 *   - cookies set in ONE Storage.setCookies call (no per-cookie call)
 *   - origins ranked by lastVisitedAt descending
 *   - eagerOriginLimit caps how many origins are attempted
 *   - helper pages created and closed (Target.createTarget × N → Target.closeTarget × N)
 *   - Fetch.fulfillRequest fires for each Fetch.requestPaused
 *   - the SAME helper sessionId tags both startup (Fetch.enable, Page.enable),
 *     navigation (Page.navigate), and evaluate (Runtime.evaluate) — flat-mode contract
 *   - skipped origins are captured per-reason without aborting the rest
 *   - signal-aborted skips work in flight
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket as WsClient } from "ws";
import {
  injectStateEagerViaTransient,
  rankOrigins,
  buildLocalStorageWriteExpression,
} from "../../../src/core/profile/inject-eager.js";
import type { CapturedProfile, OriginStorage } from "../../../src/core/profile/types.js";

interface MockCdp {
  url: string;
  close: () => Promise<void>;
  received: Array<{ id: number; method: string; sessionId?: string; params: Record<string, unknown> }>;
  /** Simulate a Fetch.requestPaused event scoped to the given session. */
  pushFetchPaused: (sessionId: string, requestId: string) => void;
  /** Force-respond with an error for one specific (method, occurrence). */
  setErrorOnce: (method: string, occurrence: number, message: string) => void;
  /** Force navigate to time out by never replying. */
  hangNavigate: () => void;
  client: () => WsClient | null;
}

async function startMockCdp(): Promise<MockCdp> {
  const received: MockCdp["received"] = [];
  const sessions: string[] = [];
  let client: WsClient | null = null;
  const errors = new Map<string, { remaining: number; message: string }>();
  let navigateHangs = false;

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
      received.push({
        id: env.id,
        method: env.method,
        sessionId: env.sessionId,
        params: env.params ?? {},
      });

      // Forced error.
      const errKey = env.method;
      const e = errors.get(errKey);
      if (e && e.remaining > 0) {
        e.remaining--;
        ws.send(JSON.stringify({ id: env.id, sessionId: env.sessionId, error: { code: -32000, message: e.message } }));
        return;
      }

      // Hang navigate (never reply).
      if (navigateHangs && env.method === "Page.navigate") return;

      let result: Record<string, unknown> | undefined;
      switch (env.method) {
        case "Storage.setCookies":
        case "Network.enable":
        case "Network.clearBrowserCookies":
        case "Page.enable":
        case "Fetch.enable":
        case "Fetch.fulfillRequest":
        case "Fetch.disable":
        case "Target.closeTarget":
          result = {};
          break;
        case "Target.createTarget":
          result = { targetId: `T${received.filter((r) => r.method === "Target.createTarget").length}` };
          break;
        case "Target.attachToTarget": {
          const sid = `S${sessions.length}`;
          sessions.push(sid);
          result = { sessionId: sid };
          break;
        }
        case "Page.navigate":
          result = {};
          break;
        case "Runtime.evaluate":
          result = { result: { type: "object", value: { wrote: 1, errors: [] } } };
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
    pushFetchPaused: (sessionId, requestId) => {
      client?.send(JSON.stringify({
        method: "Fetch.requestPaused",
        sessionId,
        params: { requestId },
      }));
    },
    setErrorOnce: (method, occurrence, message) => {
      errors.set(method, { remaining: occurrence, message });
    },
    hangNavigate: () => {
      navigateHangs = true;
    },
    client: () => client,
    close: async () => {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

function makeProfile(opts: {
  cookies?: number;
  origins?: Array<{ url: string; lastVisitedAt?: string; entries?: Record<string, string> }>;
}): CapturedProfile {
  const storage: Record<string, OriginStorage> = {};
  for (const o of opts.origins ?? []) {
    storage[o.url] = {
      localStorage: o.entries ?? { token: "abc" },
      sessionStorage: {},
      lastVisitedAt: o.lastVisitedAt,
    };
  }
  return {
    version: 1,
    capturedAt: "2026-06-01T00:00:00.000Z",
    cookies: Array.from({ length: opts.cookies ?? 0 }, (_, i) => ({
      name: `c${i}`,
      value: `v${i}`,
      domain: ".example.com",
      path: "/",
      secure: false,
      httpOnly: false,
    })),
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

describe("rankOrigins", () => {
  it("sorts by lastVisitedAt descending", () => {
    const r = rankOrigins({
      "https://a.com": { localStorage: {}, sessionStorage: {}, lastVisitedAt: "2026-06-20T00:00:00Z" },
      "https://b.com": { localStorage: {}, sessionStorage: {}, lastVisitedAt: "2026-06-22T00:00:00Z" },
      "https://c.com": { localStorage: {}, sessionStorage: {}, lastVisitedAt: "2026-06-21T00:00:00Z" },
    });
    expect(r).toEqual(["https://b.com", "https://c.com", "https://a.com"]);
  });

  it("origins without lastVisitedAt rank as oldest", () => {
    const r = rankOrigins({
      "https://newer.com": { localStorage: {}, sessionStorage: {}, lastVisitedAt: "2026-06-22T00:00:00Z" },
      "https://no-ts.com": { localStorage: {}, sessionStorage: {} },
    });
    expect(r).toEqual(["https://newer.com", "https://no-ts.com"]);
  });
});

describe("buildLocalStorageWriteExpression", () => {
  it("skips sessionStorage entirely", () => {
    const expr = buildLocalStorageWriteExpression({
      localStorage: { k: "v" },
      sessionStorage: { skip: "me" },
    });
    expect(expr).toContain("localStorage.setItem");
    expect(expr).not.toContain("sessionStorage");
  });

  it("safely escapes values via JSON.stringify", () => {
    const expr = buildLocalStorageWriteExpression({
      localStorage: { weird: 'a"b\nc' },
      sessionStorage: {},
    });
    // The string literal must be properly escaped — eval'd from within JS.
    expect(() => new Function(`return ${expr}`)).not.toThrow();
  });
});

describe("injectStateEagerViaTransient — cookies", () => {
  it("sends Storage.setCookies exactly once (no per-cookie calls)", async () => {
    const profile = makeProfile({ cookies: 100 });
    const result = await injectStateEagerViaTransient(mock.url, profile);

    expect(result.cookiesSet).toBe(100);
    const cookieCalls = mock.received.filter((r) => r.method === "Storage.setCookies");
    expect(cookieCalls.length).toBe(1);
    expect((cookieCalls[0].params.cookies as unknown[]).length).toBe(100);
  });

  it("no-op when profile has zero cookies and zero origins", async () => {
    const result = await injectStateEagerViaTransient(mock.url, makeProfile({}));
    expect(result.cookiesSet).toBe(0);
    expect(result.originsInjected).toEqual([]);
    expect(result.originsDeferred).toEqual([]);
    expect(mock.received.filter((r) => r.method === "Storage.setCookies").length).toBe(0);
    // No helper pages spawned either.
    expect(mock.received.filter((r) => r.method === "Target.createTarget").length).toBe(0);
  });

  it("clears browser cookies before injecting, even for a fresh profile with zero cookies", async () => {
    await injectStateEagerViaTransient(mock.url, makeProfile({}));
    const clears = mock.received.filter((r) => r.method === "Network.clearBrowserCookies");
    expect(clears.length).toBe(1);
  });

  it("clears browser cookies before Storage.setCookies", async () => {
    await injectStateEagerViaTransient(mock.url, makeProfile({ cookies: 1 }));
    const events = mock.received.map((r) => r.method);
    const clearIdx = events.indexOf("Network.clearBrowserCookies");
    const setIdx = events.indexOf("Storage.setCookies");
    expect(clearIdx).toBeGreaterThan(-1);
    expect(setIdx).toBeGreaterThan(-1);
    expect(clearIdx).toBeLessThan(setIdx);
  });
});

describe("injectStateEagerViaTransient — eager top-K + ranking", () => {
  it("only injects the top-K origins by recency, defers the rest", async () => {
    const profile = makeProfile({
      origins: [
        { url: "https://oldest.com", lastVisitedAt: "2026-01-01T00:00:00Z" },
        { url: "https://middle.com", lastVisitedAt: "2026-04-01T00:00:00Z" },
        { url: "https://newest.com", lastVisitedAt: "2026-06-01T00:00:00Z" },
      ],
    });

    const result = await injectStateEagerViaTransient(mock.url, profile, {
      eagerOriginLimit: 2,
      helperPages: 1, // serial for deterministic order
    });

    expect(result.originsInjected.sort()).toEqual(["https://middle.com", "https://newest.com"].sort());
    expect(result.originsDeferred).toEqual(["https://oldest.com"]);
  });

  it("eagerOriginLimit=0 defers everything", async () => {
    const profile = makeProfile({
      origins: [{ url: "https://a.com" }, { url: "https://b.com" }],
    });
    const result = await injectStateEagerViaTransient(mock.url, profile, { eagerOriginLimit: 0 });
    expect(result.originsInjected).toEqual([]);
    expect(result.originsDeferred.sort()).toEqual(["https://a.com", "https://b.com"].sort());
    // No helper pages.
    expect(mock.received.filter((r) => r.method === "Target.createTarget").length).toBe(0);
  });
});

describe("injectStateEagerViaTransient — helper page lifecycle", () => {
  it("opens helperPages count of helper targets, closes them all", async () => {
    const profile = makeProfile({
      origins: [
        { url: "https://a.com" }, { url: "https://b.com" },
        { url: "https://c.com" }, { url: "https://d.com" },
      ],
    });
    await injectStateEagerViaTransient(mock.url, profile, { helperPages: 4 });

    expect(mock.received.filter((r) => r.method === "Target.createTarget").length).toBe(4);
    expect(mock.received.filter((r) => r.method === "Target.attachToTarget").length).toBe(4);
    expect(mock.received.filter((r) => r.method === "Target.closeTarget").length).toBe(4);
  });

  it("scales helper count down to origin count if fewer origins than helpers", async () => {
    const profile = makeProfile({
      origins: [{ url: "https://a.com" }, { url: "https://b.com" }],
    });
    await injectStateEagerViaTransient(mock.url, profile, { helperPages: 8 });

    expect(mock.received.filter((r) => r.method === "Target.createTarget").length).toBe(2);
  });

  it("Page.navigate and Runtime.evaluate are tagged with the helper's sessionId (flat-mode)", async () => {
    const profile = makeProfile({
      origins: [{ url: "https://a.com" }],
    });
    await injectStateEagerViaTransient(mock.url, profile, { helperPages: 1 });

    const nav = mock.received.find((r) => r.method === "Page.navigate");
    const evaluate = mock.received.find((r) => r.method === "Runtime.evaluate");
    expect(nav?.sessionId).toBe("S0");
    expect(evaluate?.sessionId).toBe("S0");
  });
});

describe("injectStateEagerViaTransient — Fetch.fulfillRequest", () => {
  it("responds to Fetch.requestPaused with empty HTML body", async () => {
    // Build a SECOND mock where Page.navigate doesn't auto-reply — instead the
    // mock emits Fetch.requestPaused first, then waits for Fetch.fulfillRequest
    // before answering navigate. This matches Chrome's real ordering and lets
    // us actually observe the fulfill handler firing.
    await mock.close();
    mock = await startMockCdpFetchAware();
    const profile = makeProfile({ origins: [{ url: "https://a.com" }] });
    await injectStateEagerViaTransient(mock.url, profile, { helperPages: 1 });

    const fulfill = mock.received.find((r) => r.method === "Fetch.fulfillRequest");
    expect(fulfill).toBeTruthy();
    expect(fulfill?.params).toMatchObject({
      requestId: "REQ-1",
      responseCode: 200,
    });
    expect(fulfill?.params.body).toBe(Buffer.from("<html></html>").toString("base64"));
  });
});

describe("injectStateEagerViaTransient — failure isolation", () => {
  it("skips an origin whose navigate errors, continues the rest", async () => {
    const profile = makeProfile({
      origins: [{ url: "https://a.com" }, { url: "https://b.com" }],
    });
    mock.setErrorOnce("Page.navigate", 1, "boom");

    const result = await injectStateEagerViaTransient(mock.url, profile, { helperPages: 1 });

    expect(result.skippedOrigins.length).toBe(1);
    expect(result.originsInjected.length).toBe(1);
  });

  it("skips an origin whose evaluate returns an exception", async () => {
    const profile = makeProfile({ origins: [{ url: "https://a.com" }] });
    // Patch the mock to return an exception envelope for Runtime.evaluate.
    mock.client();
    mock.setErrorOnce("Runtime.evaluate", 1, "synthetic eval error");

    const result = await injectStateEagerViaTransient(mock.url, profile, { helperPages: 1 });
    expect(result.skippedOrigins.length).toBe(1);
    expect(result.originsInjected).toEqual([]);
  });

  it("worker loops exit when signal is pre-aborted", async () => {
    const profile = makeProfile({
      origins: Array.from({ length: 10 }, (_, i) => ({ url: `https://o${i}.com` })),
    });
    const ctrl = new AbortController();
    ctrl.abort();

    const result = await injectStateEagerViaTransient(mock.url, profile, {
      helperPages: 1,
      signal: ctrl.signal,
    });

    // Pre-aborted: workers see signal on first iteration and exit. Cookies+helper
    // setup still happen synchronously, but zero origins get injected.
    expect(result.originsInjected.length).toBe(0);
  });
});

/**
 * Variant of the mock that simulates real Chrome ordering for Page.navigate:
 *   client → Page.navigate(url)
 *   server → Fetch.requestPaused (matches the URL)
 *   client → Fetch.fulfillRequest
 *   server → reply to fulfill, THEN reply to Page.navigate
 *
 * Lets us actually observe the fulfill handler fire.
 */
async function startMockCdpFetchAware(): Promise<MockCdp> {
  const received: MockCdp["received"] = [];
  const sessions: string[] = [];
  let client: WsClient | null = null;
  const pendingNavigateIds: number[] = [];

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
      received.push({
        id: env.id,
        method: env.method,
        sessionId: env.sessionId,
        params: env.params ?? {},
      });

      let result: Record<string, unknown> | undefined;
      switch (env.method) {
        case "Storage.setCookies":
        case "Network.enable":
        case "Network.clearBrowserCookies":
        case "Page.enable":
        case "Fetch.enable":
        case "Fetch.disable":
        case "Target.closeTarget":
          result = {};
          break;
        case "Target.createTarget":
          result = { targetId: `T${received.filter((r) => r.method === "Target.createTarget").length}` };
          break;
        case "Target.attachToTarget": {
          const sid = `S${sessions.length}`;
          sessions.push(sid);
          result = { sessionId: sid };
          break;
        }
        case "Page.navigate":
          // Defer reply — first emit Fetch.requestPaused, await fulfill.
          pendingNavigateIds.push(env.id);
          ws.send(JSON.stringify({
            method: "Fetch.requestPaused",
            sessionId: env.sessionId,
            params: { requestId: "REQ-1", request: { url: "https://a.com/" } },
          }));
          return;
        case "Fetch.fulfillRequest": {
          ws.send(JSON.stringify({ id: env.id, sessionId: env.sessionId, result: {} }));
          // Now release the deferred navigate.
          const navId = pendingNavigateIds.shift();
          if (navId !== undefined) {
            ws.send(JSON.stringify({ id: navId, sessionId: env.sessionId, result: {} }));
          }
          return;
        }
        case "Runtime.evaluate":
          result = { result: { type: "object", value: { wrote: 1, errors: [] } } };
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
    pushFetchPaused: () => {},
    setErrorOnce: () => {},
    hangNavigate: () => {},
    client: () => client,
    close: async () => {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

describe("injectStateEagerViaTransient — skip empty storage", () => {
  it("skips origins with no localStorage entries (zero-cost)", async () => {
    const profile = makeProfile({
      origins: [
        { url: "https://empty.com", entries: {} },
        { url: "https://has-data.com", entries: { k: "v" } },
      ],
    });
    const result = await injectStateEagerViaTransient(mock.url, profile, { helperPages: 1 });
    expect(result.originsInjected).toEqual(["https://has-data.com"]);
  });
});
