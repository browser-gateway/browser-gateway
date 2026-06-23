/**
 * ScreencastBridge tests — focused on the spec's anti-list invariants:
 *
 *  1. setDeviceMetricsOverride is called BEFORE startScreencast
 *  2. Page.screencastFrameAck uses the INTEGER sessionId from the frame
 *     event (NOT the string attach session id)
 *  3. Ack happens before the dashboard ws.send (ack ordering)
 *  4. Backpressure: when dashboard.bufferedAmount exceeds the threshold,
 *     the frame is dropped but the ack still fires
 *  5. Frame goes to dashboard as binary (Buffer), not as base64 text
 *  6. close() sends Page.stopScreencast + Target.detachFromTarget and
 *     terminates the dashboard ws
 *  7. Invalid client messages are rejected; valid ones map to correct
 *     CDP commands
 *
 * Mocks a CDP server and a fake "dashboard ws" object (since we don't need
 * the full ws lifecycle for these checks — just the two surfaces the bridge
 * touches: send() and bufferedAmount).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket as WsClient } from "ws";
import pino from "pino";
import { ScreencastBridge } from "../../../src/server/live/screencast-bridge.js";

interface MockProvider {
  url: string;
  close: () => Promise<void>;
  /** Every command envelope received from the bridge, in order. */
  received: Array<{ id: number; method: string; sessionId?: string; params: Record<string, unknown> }>;
  /** Push an event to the connected client. */
  pushEvent: (method: string, params: Record<string, unknown>, sessionId?: string) => void;
  /** Wait until N envelopes have arrived (or timeout). */
  waitFor: (n: number, timeoutMs?: number) => Promise<void>;
}

const ATTACH_SESSION_ID = "ATTACH_SID_42";

async function startMockProvider(): Promise<MockProvider> {
  const received: MockProvider["received"] = [];
  let client: WsClient | null = null;
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  const { port } = wss.address() as AddressInfo;

  wss.on("connection", (ws) => {
    client = ws;
    ws.on("message", (raw) => {
      const env = JSON.parse(raw.toString("utf8")) as { id?: number; method?: string; sessionId?: string; params?: Record<string, unknown> };
      if (env.id !== undefined && env.method) {
        received.push({
          id: env.id,
          method: env.method,
          sessionId: env.sessionId,
          params: env.params ?? {},
        });

        // Auto-reply for the setup-phase commands.
        let result: Record<string, unknown> | undefined;
        switch (env.method) {
          case "Target.createTarget":
            result = { targetId: "T1" };
            break;
          case "Target.attachToTarget":
            result = { sessionId: ATTACH_SESSION_ID };
            break;
          case "Page.getNavigationHistory":
            result = { currentIndex: 0, entries: [{ id: 1 }] };
            break;
          default:
            // For everything else (Page.enable, setDeviceMetricsOverride,
            // startScreencast, screencastFrameAck, Input.*, Target.closeTarget,
            // etc) reply OK.
            result = {};
        }
        ws.send(JSON.stringify({ id: env.id, result }));
      }
    });
  });

  return {
    url: `ws://localhost:${port}`,
    received,
    pushEvent: (method, params, sessionId) => {
      if (client && client.readyState === client.OPEN) {
        const envelope: Record<string, unknown> = { method, params };
        if (sessionId) envelope.sessionId = sessionId;
        client.send(JSON.stringify(envelope));
      }
    },
    waitFor: async (n, timeoutMs = 1000) => {
      const start = Date.now();
      while (received.length < n) {
        if (Date.now() - start > timeoutMs) {
          throw new Error(`waitFor(${n}) timed out — got ${received.length}`);
        }
        await new Promise((r) => setTimeout(r, 5));
      }
    },
    close: async () => {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

interface FakeDashboardWs {
  readyState: 1;
  readonly OPEN: 1;
  bufferedAmount: number;
  send: (data: Buffer | string, opts?: { binary?: boolean }) => void;
  close: (code?: number, reason?: string) => void;
  on: (event: string, listener: (...args: unknown[]) => void) => void;
  /** Bytes/text we've recorded. */
  sentBinary: Buffer[];
  sentText: string[];
  closed: boolean;
}

function createFakeDashboard(): FakeDashboardWs {
  const sentBinary: Buffer[] = [];
  const sentText: string[] = [];
  return {
    OPEN: 1,
    readyState: 1,
    bufferedAmount: 0,
    sentBinary,
    sentText,
    closed: false,
    send(data, opts) {
      if (opts?.binary && Buffer.isBuffer(data)) {
        sentBinary.push(data);
      } else if (typeof data === "string") {
        sentText.push(data);
      }
    },
    close() {
      this.closed = true;
    },
    on() {
      // bridge calls .on('message'|'close'|'error') — we drive them via test code,
      // so we don't need to wire real handlers for these tests.
    },
  };
}

const silentLogger = pino({ level: "silent" });

let mock: MockProvider;

beforeEach(async () => {
  mock = await startMockProvider();
});

afterEach(async () => {
  await mock.close();
});

describe("ScreencastBridge setup order (spec anti-list: setDeviceMetricsOverride MUST precede startScreencast)", () => {
  it("calls setDeviceMetricsOverride before startScreencast", async () => {
    const bridge = new ScreencastBridge({ providerWsUrl: mock.url, logger: silentLogger });
    await bridge.setup();

    const methods = mock.received.map((r) => r.method);
    const overrideIdx = methods.indexOf("Page.setDeviceMetricsOverride");
    const startIdx = methods.indexOf("Page.startScreencast");

    expect(overrideIdx).toBeGreaterThan(-1);
    expect(startIdx).toBeGreaterThan(-1);
    expect(overrideIdx).toBeLessThan(startIdx);

    bridge.close();
  });

  it("attaches BEFORE Page.enable / setDeviceMetricsOverride / startScreencast", async () => {
    const bridge = new ScreencastBridge({ providerWsUrl: mock.url, logger: silentLogger });
    await bridge.setup();

    const methods = mock.received.map((r) => r.method);
    const attachIdx = methods.indexOf("Target.attachToTarget");
    expect(attachIdx).toBeGreaterThanOrEqual(0);
    expect(attachIdx).toBeLessThan(methods.indexOf("Page.enable"));
    expect(attachIdx).toBeLessThan(methods.indexOf("Page.setDeviceMetricsOverride"));
    expect(attachIdx).toBeLessThan(methods.indexOf("Page.startScreencast"));

    bridge.close();
  });

  it("tags Page.* envelopes with the attach sessionId returned from attachToTarget", async () => {
    const bridge = new ScreencastBridge({ providerWsUrl: mock.url, logger: silentLogger });
    await bridge.setup();

    const startScreencast = mock.received.find((r) => r.method === "Page.startScreencast");
    expect(startScreencast?.sessionId).toBe(ATTACH_SESSION_ID);

    bridge.close();
  });

  it("uses 'jpeg' (lowercase) as the format and includes everyNthFrame:2 by default", async () => {
    const bridge = new ScreencastBridge({ providerWsUrl: mock.url, logger: silentLogger });
    await bridge.setup();

    const sc = mock.received.find((r) => r.method === "Page.startScreencast");
    expect(sc?.params).toMatchObject({ format: "jpeg", everyNthFrame: 2 });

    bridge.close();
  });
});

describe("ScreencastBridge frame ack (spec anti-list: integer frame sessionId, not the attach string)", () => {
  it("acks with the INTEGER sessionId from the frame event, never the string attach session", async () => {
    const bridge = new ScreencastBridge({ providerWsUrl: mock.url, logger: silentLogger });
    await bridge.setup();
    bridge.attachDashboard(createFakeDashboard() as unknown as WsClient);

    // Push a screencastFrame event with frame number 7 (integer).
    mock.pushEvent(
      "Page.screencastFrame",
      {
        data: Buffer.from("test-frame-bytes").toString("base64"),
        metadata: {
          offsetTop: 0,
          pageScaleFactor: 1,
          deviceWidth: 1280,
          deviceHeight: 720,
          scrollOffsetX: 0,
          scrollOffsetY: 0,
        },
        sessionId: 7,
      },
      ATTACH_SESSION_ID,
    );

    // Wait for the ack to be sent.
    await new Promise((r) => setTimeout(r, 40));
    const ack = mock.received.find((r) => r.method === "Page.screencastFrameAck");
    expect(ack).toBeTruthy();
    // params.sessionId is the INTEGER frame counter
    expect(ack!.params.sessionId).toBe(7);
    // envelope sessionId is the STRING attach session id
    expect(ack!.sessionId).toBe(ATTACH_SESSION_ID);
    // They are not equal — that's the whole point.
    expect(ack!.params.sessionId).not.toBe(ack!.sessionId);

    bridge.close();
  });
});

describe("ScreencastBridge dashboard forwarding", () => {
  it("forwards frames to the dashboard as binary (Buffer), not as base64 text", async () => {
    const bridge = new ScreencastBridge({ providerWsUrl: mock.url, logger: silentLogger });
    await bridge.setup();
    const dashboard = createFakeDashboard();
    bridge.attachDashboard(dashboard as unknown as WsClient);

    const originalBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]); // JPEG magic + JFIF
    mock.pushEvent(
      "Page.screencastFrame",
      {
        data: originalBytes.toString("base64"),
        metadata: {
          offsetTop: 0,
          pageScaleFactor: 1,
          deviceWidth: 1280,
          deviceHeight: 720,
          scrollOffsetX: 0,
          scrollOffsetY: 0,
        },
        sessionId: 1,
      },
      ATTACH_SESSION_ID,
    );

    await new Promise((r) => setTimeout(r, 40));
    expect(dashboard.sentBinary.length).toBe(1);
    expect(dashboard.sentBinary[0].equals(originalBytes)).toBe(true);

    bridge.close();
  });

  it("emits frameMeta when dimensions change, suppresses redundant ones", async () => {
    const bridge = new ScreencastBridge({ providerWsUrl: mock.url, logger: silentLogger });
    await bridge.setup();
    const dashboard = createFakeDashboard();
    bridge.attachDashboard(dashboard as unknown as WsClient);

    const baseFrame = (sid: number, deviceWidth: number) => ({
      data: "AA==",
      metadata: {
        offsetTop: 0,
        pageScaleFactor: 1,
        deviceWidth,
        deviceHeight: 720,
        scrollOffsetX: 0,
        scrollOffsetY: 0,
      },
      sessionId: sid,
    });

    mock.pushEvent("Page.screencastFrame", baseFrame(1, 1280), ATTACH_SESSION_ID);
    mock.pushEvent("Page.screencastFrame", baseFrame(2, 1280), ATTACH_SESSION_ID); // identical
    mock.pushEvent("Page.screencastFrame", baseFrame(3, 1600), ATTACH_SESSION_ID); // new width

    await new Promise((r) => setTimeout(r, 40));
    const metas = dashboard.sentText
      .map((t) => JSON.parse(t) as { type: string; deviceWidth?: number })
      .filter((m) => m.type === "frameMeta");
    expect(metas.length).toBe(2);
    expect(metas[0].deviceWidth).toBe(1280);
    expect(metas[1].deviceWidth).toBe(1600);

    bridge.close();
  });

  it("drops the frame but still acks when dashboard bufferedAmount exceeds threshold", async () => {
    const bridge = new ScreencastBridge({
      providerWsUrl: mock.url,
      logger: silentLogger,
      dropThresholdBytes: 100,
    });
    await bridge.setup();
    const dashboard = createFakeDashboard();
    dashboard.bufferedAmount = 500; // > threshold
    bridge.attachDashboard(dashboard as unknown as WsClient);

    mock.pushEvent(
      "Page.screencastFrame",
      {
        data: Buffer.alloc(50).toString("base64"),
        metadata: {
          offsetTop: 0,
          pageScaleFactor: 1,
          deviceWidth: 1280,
          deviceHeight: 720,
          scrollOffsetX: 0,
          scrollOffsetY: 0,
        },
        sessionId: 1,
      },
      ATTACH_SESSION_ID,
    );

    await new Promise((r) => setTimeout(r, 40));
    expect(dashboard.sentBinary.length).toBe(0);
    expect(mock.received.some((r) => r.method === "Page.screencastFrameAck")).toBe(true);
    expect(bridge.getStats().framesDropped).toBeGreaterThan(0);
    expect(bridge.getStats().framesSent).toBe(0);

    bridge.close();
  });

  it("forwards Page.frameNavigated top-frame URL changes as a url control message", async () => {
    const bridge = new ScreencastBridge({ providerWsUrl: mock.url, logger: silentLogger });
    await bridge.setup();
    const dashboard = createFakeDashboard();
    bridge.attachDashboard(dashboard as unknown as WsClient);

    mock.pushEvent(
      "Page.frameNavigated",
      { frame: { url: "https://example.com/", parentId: undefined } },
      ATTACH_SESSION_ID,
    );

    await new Promise((r) => setTimeout(r, 30));
    const urlMsg = dashboard.sentText
      .map((t) => JSON.parse(t) as { type: string; url?: string })
      .find((m) => m.type === "url");
    expect(urlMsg?.url).toBe("https://example.com/");

    bridge.close();
  });

  it("ignores iframe Page.frameNavigated events (only top-level matters)", async () => {
    const bridge = new ScreencastBridge({ providerWsUrl: mock.url, logger: silentLogger });
    await bridge.setup();
    const dashboard = createFakeDashboard();
    bridge.attachDashboard(dashboard as unknown as WsClient);

    mock.pushEvent(
      "Page.frameNavigated",
      { frame: { url: "https://ads.example.com/", parentId: "PARENT1" } },
      ATTACH_SESSION_ID,
    );

    await new Promise((r) => setTimeout(r, 30));
    const hasUrl = dashboard.sentText.some((t) => JSON.parse(t).type === "url");
    expect(hasUrl).toBe(false);

    bridge.close();
  });
});

describe("ScreencastBridge client input validation + mapping", () => {
  function simulate(bridge: ScreencastBridge, msg: unknown): void {
    // Bridge exposes message handling via the dashboard.on('message', ...) wire.
    // We bypass that by accessing the private method directly via the bracket
    // accessor — this is a tier-1 test, not a public contract test.
    (bridge as unknown as { handleDashboardMessage: (s: string) => void }).handleDashboardMessage(
      JSON.stringify(msg),
    );
  }

  it("maps {type:'mouse',kind:'press'} → Input.dispatchMouseEvent type:'mousePressed'", async () => {
    const bridge = new ScreencastBridge({ providerWsUrl: mock.url, logger: silentLogger });
    await bridge.setup();
    const setupCount = mock.received.length;

    simulate(bridge, { type: "mouse", event: { kind: "press", x: 100, y: 200, button: "left" } });
    await new Promise((r) => setTimeout(r, 30));

    const mouseEnv = mock.received.slice(setupCount).find((r) => r.method === "Input.dispatchMouseEvent");
    expect(mouseEnv).toBeTruthy();
    expect(mouseEnv!.params).toMatchObject({
      type: "mousePressed",
      x: 100,
      y: 200,
      button: "left",
      buttons: 1, // non-none button
    });

    bridge.close();
  });

  it("maps {type:'mouse',kind:'wheel'} with deltaX/deltaY", async () => {
    const bridge = new ScreencastBridge({ providerWsUrl: mock.url, logger: silentLogger });
    await bridge.setup();
    const setupCount = mock.received.length;

    simulate(bridge, {
      type: "mouse",
      event: { kind: "wheel", x: 50, y: 50, deltaX: 0, deltaY: 120 },
    });
    await new Promise((r) => setTimeout(r, 30));

    const env = mock.received.slice(setupCount).find((r) => r.method === "Input.dispatchMouseEvent");
    expect(env!.params).toMatchObject({ type: "mouseWheel", deltaY: 120 });

    bridge.close();
  });

  it("maps {type:'key',kind:'char',text:'A'} → Input.dispatchKeyEvent type:'char' with text/unmodifiedText", async () => {
    const bridge = new ScreencastBridge({ providerWsUrl: mock.url, logger: silentLogger });
    await bridge.setup();
    const setupCount = mock.received.length;

    simulate(bridge, { type: "key", event: { kind: "char", text: "A" } });
    await new Promise((r) => setTimeout(r, 30));

    const env = mock.received.slice(setupCount).find((r) => r.method === "Input.dispatchKeyEvent");
    expect(env!.params).toMatchObject({ type: "char", text: "A", unmodifiedText: "a" });

    bridge.close();
  });

  it("maps {type:'paste',text:'...'} → Input.insertText as one CDP call, no per-char keys", async () => {
    const bridge = new ScreencastBridge({ providerWsUrl: mock.url, logger: silentLogger });
    await bridge.setup();
    const setupCount = mock.received.length;

    simulate(bridge, { type: "paste", text: "hello world\nline two" });
    await new Promise((r) => setTimeout(r, 30));

    const env = mock.received.slice(setupCount).find((r) => r.method === "Input.insertText");
    expect(env).toBeTruthy();
    expect(env!.params).toEqual({ text: "hello world\nline two" });
    const keyEvents = mock.received.slice(setupCount).filter((r) => r.method === "Input.dispatchKeyEvent");
    expect(keyEvents.length).toBe(0);

    bridge.close();
  });

  it("rejects paste with text longer than 64 KB", async () => {
    const bridge = new ScreencastBridge({ providerWsUrl: mock.url, logger: silentLogger });
    await bridge.setup();
    const setupCount = mock.received.length;

    simulate(bridge, { type: "paste", text: "x".repeat(65_000) });
    await new Promise((r) => setTimeout(r, 30));

    expect(mock.received.slice(setupCount).some((r) => r.method === "Input.insertText")).toBe(false);

    bridge.close();
  });

  it("maps {type:'navigate',url:'...'} → Page.navigate", async () => {
    const bridge = new ScreencastBridge({ providerWsUrl: mock.url, logger: silentLogger });
    await bridge.setup();
    const setupCount = mock.received.length;

    simulate(bridge, { type: "navigate", url: "https://example.com/" });
    await new Promise((r) => setTimeout(r, 30));

    const env = mock.received.slice(setupCount).find((r) => r.method === "Page.navigate");
    expect(env!.params).toMatchObject({ url: "https://example.com/" });

    bridge.close();
  });

  it("rejects malformed messages without crashing", async () => {
    const bridge = new ScreencastBridge({ providerWsUrl: mock.url, logger: silentLogger });
    await bridge.setup();
    const setupCount = mock.received.length;

    simulate(bridge, { type: "mouse" }); // missing event
    simulate(bridge, { type: "unknown", event: {} });
    simulate(bridge, "not even an object");
    simulate(bridge, { type: "mouse", event: { kind: "press", x: -1, y: 0 } }); // negative x rejected by zod

    await new Promise((r) => setTimeout(r, 30));
    const newEnvelopes = mock.received.slice(setupCount).filter((r) => r.method.startsWith("Input.") || r.method === "Page.navigate");
    expect(newEnvelopes.length).toBe(0);

    bridge.close();
  });
});

describe("ScreencastBridge cleanup", () => {
  it("close() sends Page.stopScreencast and Target.detachFromTarget", async () => {
    const bridge = new ScreencastBridge({ providerWsUrl: mock.url, logger: silentLogger });
    await bridge.setup();
    const setupCount = mock.received.length;

    bridge.close();
    // sendMayFail is fire-and-forget — give it a moment to land.
    await new Promise((r) => setTimeout(r, 50));

    const aftermath = mock.received.slice(setupCount).map((r) => r.method);
    expect(aftermath).toContain("Page.stopScreencast");
    expect(aftermath).toContain("Target.detachFromTarget");
  });

  it("setup() ALWAYS creates a fresh target (never reuses existing tabs)", async () => {
    // Regression pin: an earlier version of the bridge called
    // `Target.getTargets` and reused whatever page was open, which leaked
    // previous-session state into the next playground session.
    const bridge = new ScreencastBridge({ providerWsUrl: mock.url, logger: silentLogger });
    await bridge.setup();

    expect(mock.received.some((r) => r.method === "Target.getTargets")).toBe(false);
    expect(mock.received.some((r) => r.method === "Target.createTarget")).toBe(true);

    bridge.close();
  });

  it("close() closes the tab it created so the provider doesn't accumulate orphans", async () => {
    const bridge = new ScreencastBridge({ providerWsUrl: mock.url, logger: silentLogger });
    await bridge.setup();
    const setupCount = mock.received.length;

    bridge.close();
    await new Promise((r) => setTimeout(r, 50));

    const closeTargetCall = mock.received.slice(setupCount).find((r) => r.method === "Target.closeTarget");
    expect(closeTargetCall).toBeTruthy();
    expect(closeTargetCall!.params).toMatchObject({ targetId: "T1" });
  });

  it("close() terminates the dashboard ws", async () => {
    const bridge = new ScreencastBridge({ providerWsUrl: mock.url, logger: silentLogger });
    await bridge.setup();
    const dashboard = createFakeDashboard();
    bridge.attachDashboard(dashboard as unknown as WsClient);

    bridge.close();
    expect(dashboard.closed).toBe(true);
  });

  it("close() is idempotent — second call is a no-op", async () => {
    const bridge = new ScreencastBridge({ providerWsUrl: mock.url, logger: silentLogger });
    await bridge.setup();

    bridge.close();
    expect(() => bridge.close()).not.toThrow();
  });
});

describe("ScreencastBridge setup error propagation", () => {
  it("throws when the provider WS is unreachable", async () => {
    const dead = new ScreencastBridge({
      providerWsUrl: "ws://127.0.0.1:1", // port 1 is unprivileged + unused
      logger: silentLogger,
    });
    // Spy was never used; just confirm we reject.
    vi.spyOn(silentLogger, "warn").mockImplementation(() => {});

    await expect(dead.setup()).rejects.toThrow();
  });
});
