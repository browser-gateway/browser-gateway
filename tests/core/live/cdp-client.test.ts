/**
 * CdpClient unit tests. Spins up a tiny in-process WebSocket server that
 * acts as the CDP peer, then verifies:
 *
 *  - command/response correlation across multiple in-flight commands
 *  - flat-mode sessionId tagging round-trips correctly on the envelope
 *  - error responses reject with CdpError
 *  - sendMayFail returns immediately and discards the response
 *  - events without an id are dispatched to listeners with their sessionId
 *  - close() rejects every outstanding command
 *  - sending after close rejects synchronously
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { CdpClient, CdpError } from "../../../src/server/live/cdp-client.js";

interface MockCdpServer {
  url: string;
  close: () => Promise<void>;
  /** All envelopes received from the client, in arrival order. */
  received: Array<Record<string, unknown>>;
  /** Send a raw JSON message back to the (single) connected client. */
  sendToClient: (obj: Record<string, unknown>) => void;
  /** Force-close the underlying ws from the server side. */
  closeClient: (code?: number, reason?: string) => void;
  /**
   * Auto-reply: when a command id arrives, the server invokes this with the
   * full envelope so the test can craft a response (result OR error).
   */
  setAutoReply: (fn: (env: Record<string, unknown>) => Record<string, unknown> | undefined) => void;
}

async function startMockCdp(): Promise<MockCdpServer> {
  const received: Array<Record<string, unknown>> = [];
  let client: WebSocket | null = null;
  let autoReply: ((env: Record<string, unknown>) => Record<string, unknown> | undefined) | undefined;

  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  const { port } = wss.address() as AddressInfo;

  wss.on("connection", (ws) => {
    client = ws;
    ws.on("message", (raw) => {
      const env = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
      received.push(env);
      if (autoReply) {
        const reply = autoReply(env);
        if (reply) ws.send(JSON.stringify(reply));
      }
    });
  });

  return {
    url: `ws://localhost:${port}`,
    received,
    sendToClient: (obj) => {
      if (client && client.readyState === client.OPEN) {
        client.send(JSON.stringify(obj));
      }
    },
    closeClient: (code = 1000, reason = "") => {
      client?.close(code, reason);
    },
    setAutoReply: (fn) => {
      autoReply = fn;
    },
    close: async () => {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

let mock: MockCdpServer;
let client: CdpClient;

beforeEach(async () => {
  mock = await startMockCdp();
  client = new CdpClient();
  await client.connect(mock.url);
});

afterEach(async () => {
  client.close();
  await mock.close();
});

describe("CdpClient.send", () => {
  it("correlates response with the matching command id", async () => {
    mock.setAutoReply((env) =>
      env.method === "Test.echo"
        ? { id: env.id, result: { value: (env.params as { v: number }).v + 1 } }
        : undefined,
    );

    const r = await client.send<{ value: number }>("Test.echo", { v: 41 });
    expect(r.value).toBe(42);
  });

  it("interleaves multiple in-flight commands by id", async () => {
    // Stash responses, send them out-of-order.
    const queue: Array<{ id: number; method: string }> = [];
    mock.setAutoReply((env) => {
      queue.push({ id: env.id as number, method: env.method as string });
      return undefined;
    });

    const p1 = client.send<{ tag: string }>("Test.first");
    const p2 = client.send<{ tag: string }>("Test.second");
    const p3 = client.send<{ tag: string }>("Test.third");

    // Wait for all 3 sends to land server-side.
    while (queue.length < 3) await new Promise((r) => setTimeout(r, 10));

    // Reply in reversed order — client must still resolve the right promise.
    mock.sendToClient({ id: queue[2].id, result: { tag: "third" } });
    mock.sendToClient({ id: queue[0].id, result: { tag: "first" } });
    mock.sendToClient({ id: queue[1].id, result: { tag: "second" } });

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(r1.tag).toBe("first");
    expect(r2.tag).toBe("second");
    expect(r3.tag).toBe("third");
  });

  it("tags the envelope with sessionId when flat-mode is requested", async () => {
    mock.setAutoReply((env) => ({ id: env.id, result: {} }));
    await client.send("Page.enable", {}, "ABC123");
    expect(mock.received[0]).toMatchObject({
      method: "Page.enable",
      sessionId: "ABC123",
    });
  });

  it("rejects with CdpError when peer returns an error envelope", async () => {
    mock.setAutoReply((env) => ({
      id: env.id,
      error: { code: -32000, message: "Invalid params: bad arg" },
    }));

    await expect(client.send("Bad.method")).rejects.toBeInstanceOf(CdpError);
    await expect(client.send("Bad.method")).rejects.toMatchObject({
      code: -32000,
      message: "Invalid params: bad arg",
    });
  });
});

describe("CdpClient events", () => {
  it("delivers events to listeners with their sessionId", async () => {
    const captured: Array<{ method: string; sessionId?: string }> = [];
    client.on((event) => captured.push({ method: event.method, sessionId: event.sessionId }));

    mock.sendToClient({ method: "Page.frameNavigated", sessionId: "S1", params: {} });
    mock.sendToClient({ method: "Page.loadEventFired", params: {} });

    await new Promise((r) => setTimeout(r, 30));
    expect(captured).toEqual([
      { method: "Page.frameNavigated", sessionId: "S1" },
      { method: "Page.loadEventFired", sessionId: undefined },
    ]);
  });

  it("does not deliver response envelopes (those with id) to event listeners", async () => {
    const captured: Array<{ method: string }> = [];
    client.on((event) => captured.push({ method: event.method }));

    mock.setAutoReply((env) => ({ id: env.id, result: {} }));
    await client.send("Page.enable");

    expect(captured).toEqual([]);
  });
});

describe("CdpClient.sendMayFail", () => {
  it("sends without registering a pending promise (no resolve, no reject)", async () => {
    mock.setAutoReply(() => undefined);

    client.sendMayFail("Page.screencastFrameAck", { sessionId: 42 }, "ABC");

    // Give time for it to land server-side.
    await new Promise((r) => setTimeout(r, 30));
    expect(mock.received[0]).toMatchObject({
      method: "Page.screencastFrameAck",
      sessionId: "ABC",
      params: { sessionId: 42 },
    });
  });

  it("returns without error even when the underlying ws is closed", async () => {
    client.close();
    expect(() => client.sendMayFail("Test.whatever")).not.toThrow();
  });
});

describe("CdpClient.close behavior", () => {
  it("rejects every outstanding command when the peer disconnects", async () => {
    mock.setAutoReply(() => undefined); // never reply
    const p1 = client.send("Test.one");
    const p2 = client.send("Test.two");

    // Wait until both sends have landed server-side.
    while (mock.received.length < 2) await new Promise((r) => setTimeout(r, 10));
    mock.closeClient();

    await expect(p1).rejects.toThrow(/closed/);
    await expect(p2).rejects.toThrow(/closed/);
  });

  it("fires close listeners with code + reason", async () => {
    let info: { code: number; reason: string } | null = null;
    client.onClose((i) => {
      info = i;
    });

    mock.closeClient(1011, "server fatal");

    await new Promise((r) => setTimeout(r, 30));
    expect(info).not.toBeNull();
    expect(info!.code).toBe(1011);
    expect(info!.reason).toBe("server fatal");
  });

  it("rejects sends after explicit close()", async () => {
    client.close();
    await expect(client.send("Test.afterClose")).rejects.toThrow(/not connected/);
  });

  it("is idempotent — calling close() twice is a no-op", () => {
    client.close();
    expect(() => client.close()).not.toThrow();
  });
});
