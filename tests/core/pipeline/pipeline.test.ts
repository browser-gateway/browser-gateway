import { describe, it, expect } from "vitest";
import { Pipeline, type PipelineSocket } from "../../../src/pipeline/pipeline.js";
import type { CdpMessage, CdpPlugin, SessionState } from "../../../src/pipeline/types.js";

/** Minimal in-memory WebSocket-shaped fake for pipeline tests. Exposes a
 *  `receive()` method to simulate a peer sending frames, and records every
 *  outbound frame for assertions. */
class FakeSocket implements PipelineSocket {
  readonly sent: Array<string | ArrayBuffer | ArrayBufferView> = [];
  private listeners = new Map<string, Array<(ev: unknown) => void>>();
  bufferedAmount = 0;
  private closed = false;

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (this.closed) throw new Error("closed");
    this.sent.push(data);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("close", {});
  }
  addEventListener(type: string, listener: (ev: unknown) => void): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(listener);
    this.listeners.set(type, arr);
  }
  /** Simulate a frame arriving on this socket. */
  receive(data: string | ArrayBuffer | ArrayBufferView): void {
    this.emit("message", { data });
  }
  private emit(type: string, ev: unknown): void {
    for (const l of this.listeners.get(type) ?? []) l(ev);
  }
}

function jsonMsg(o: unknown): string { return JSON.stringify(o); }
function parseSent(s: FakeSocket): CdpMessage[] {
  return s.sent
    .filter((x): x is string => typeof x === "string")
    .map((x) => { try { return JSON.parse(x) as CdpMessage; } catch { return null; } })
    .filter((x): x is CdpMessage => x !== null);
}

async function runPipeline(client: FakeSocket, upstream: FakeSocket, plugins: CdpPlugin[]): Promise<Promise<import("../../../src/pipeline/types.js").PipelineResult>> {
  const p = new Pipeline(client, upstream, "wss://test/", { plugins, onSessionEndTimeoutMs: 100 });
  return p.run();
}

describe("Pipeline", () => {
  it("forwards client commands upstream and upstream responses to client", async () => {
    const client = new FakeSocket();
    const upstream = new FakeSocket();
    const done = runPipeline(client, upstream, []);
    await new Promise((r) => setTimeout(r, 5));

    client.receive(jsonMsg({ id: 1, method: "Page.enable" }));
    expect(parseSent(upstream)).toEqual([{ id: 1, method: "Page.enable" }]);

    upstream.receive(jsonMsg({ id: 1, result: {} }));
    expect(parseSent(client)).toEqual([{ id: 1, result: {} }]);

    client.close();
    const result = await done;
    expect(result.reason).toBe("client-closed");
    expect(result.counters.messageCount).toBe(2);
  });

  it("plugin onCommand returning null drops the message", async () => {
    const client = new FakeSocket();
    const upstream = new FakeSocket();
    const plugin: CdpPlugin = {
      name: "blocker",
      onCommand: (msg) => (msg.method === "Page.close" ? null : undefined),
    };
    const done = runPipeline(client, upstream, [plugin]);
    await new Promise((r) => setTimeout(r, 5));

    client.receive(jsonMsg({ id: 1, method: "Page.enable" }));
    client.receive(jsonMsg({ id: 2, method: "Page.close" }));

    const sent = parseSent(upstream);
    expect(sent.length).toBe(1);
    expect(sent[0].method).toBe("Page.enable");

    client.close();
    const result = await done;
    expect(result.counters.droppedByPlugin).toBe(1);
  });

  it("plugin onCommand returning modified message forwards the rewrite", async () => {
    const client = new FakeSocket();
    const upstream = new FakeSocket();
    const plugin: CdpPlugin = {
      name: "rewriter",
      onCommand: (msg) => (msg.method === "Page.navigate" ? { ...msg, params: { url: "https://rewritten/" } } : undefined),
    };
    const done = runPipeline(client, upstream, [plugin]);
    await new Promise((r) => setTimeout(r, 5));

    client.receive(jsonMsg({ id: 1, method: "Page.navigate", params: { url: "https://original/" } }));
    const sent = parseSent(upstream);
    expect(sent[0].params).toEqual({ url: "https://rewritten/" });

    client.close();
    await done;
  });

  it("plugin onEvent returning null drops the event", async () => {
    const client = new FakeSocket();
    const upstream = new FakeSocket();
    const plugin: CdpPlugin = {
      name: "muter",
      onEvent: (msg) => (msg.method === "Network.dataReceived" ? null : undefined),
    };
    const done = runPipeline(client, upstream, [plugin]);
    await new Promise((r) => setTimeout(r, 5));

    upstream.receive(jsonMsg({ method: "Page.frameNavigated", params: {} }));
    upstream.receive(jsonMsg({ method: "Network.dataReceived", params: {} }));

    const sent = parseSent(client);
    expect(sent.length).toBe(1);
    expect(sent[0].method).toBe("Page.frameNavigated");

    client.close();
    await done;
  });

  it("sendInternal routes responses to plugin, filters from client stream", async () => {
    const client = new FakeSocket();
    const upstream = new FakeSocket();
    let capturedResult: unknown = null;
    const plugin: CdpPlugin = {
      name: "injector",
      onSessionStart: async (state: SessionState) => {
        // Fire an internal command; its response should never reach the client.
        state.sendInternal("Page.captureScreenshot", { format: "jpeg" }).then((r) => {
          capturedResult = r;
        });
      },
    };
    const done = runPipeline(client, upstream, [plugin]);
    await new Promise((r) => setTimeout(r, 20));

    // Upstream should have received the injected command.
    const injected = parseSent(upstream);
    expect(injected.length).toBe(1);
    expect(injected[0].method).toBe("Page.captureScreenshot");
    expect(injected[0].id).toBe(1 << 30);

    // Simulate upstream response using our internal ID.
    upstream.receive(jsonMsg({ id: 1 << 30, result: { data: "AAAA" } }));
    await new Promise((r) => setTimeout(r, 5));

    // Client should NOT have received the response.
    expect(parseSent(client).length).toBe(0);
    // The plugin's promise should have resolved.
    expect(capturedResult).toEqual({ data: "AAAA" });

    client.close();
    const result = await done;
    expect(result.counters.injectedCount).toBe(1);
  });

  it("onSessionStart runs before wire opens; onSessionEnd runs on close", async () => {
    const events: string[] = [];
    const client = new FakeSocket();
    const upstream = new FakeSocket();
    const plugin: CdpPlugin = {
      name: "lifecycle",
      onSessionStart: async () => { events.push("start"); },
      onSessionEnd: async () => { events.push("end"); },
    };
    const done = runPipeline(client, upstream, [plugin]);
    await new Promise((r) => setTimeout(r, 5));
    expect(events).toEqual(["start"]);
    client.close();
    await done;
    expect(events).toEqual(["start", "end"]);
  });

  it("onSessionEnd timeout doesn't hang the pipeline forever", async () => {
    const client = new FakeSocket();
    const upstream = new FakeSocket();
    const plugin: CdpPlugin = {
      name: "slowpoke",
      onSessionEnd: () => new Promise(() => { /* never resolves */ }),
    };
    const done = runPipeline(client, upstream, [plugin]);
    await new Promise((r) => setTimeout(r, 5));
    client.close();
    const start = Date.now();
    const result = await done;
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500);
    expect(result.reason).toBe("client-closed");
  });

  it("plugin throw is caught and doesn't kill the session", async () => {
    const client = new FakeSocket();
    const upstream = new FakeSocket();
    const plugin: CdpPlugin = {
      name: "thrower",
      onCommand: () => { throw new Error("boom"); },
    };
    const errors: string[] = [];
    const p = new Pipeline(client, upstream, "wss://test/", {
      plugins: [plugin],
      onSessionEndTimeoutMs: 100,
      logger: (e) => { if (e.kind === "plugin-error") errors.push(String(e.data.err)); },
    });
    const done = p.run();
    await new Promise((r) => setTimeout(r, 5));

    client.receive(jsonMsg({ id: 1, method: "Page.enable" }));
    expect(parseSent(upstream).length).toBe(1); // forwarded despite throw

    client.close();
    await done;
    expect(errors.length).toBe(1);
  });

  it("session state tracks Target.attachedToTarget from upstream events", async () => {
    const client = new FakeSocket();
    const upstream = new FakeSocket();
    let seenTargets = 0;
    const plugin: CdpPlugin = {
      name: "watcher",
      onEvent: (_msg, state) => { seenTargets = state.targets.size; },
    };
    const done = runPipeline(client, upstream, [plugin]);
    await new Promise((r) => setTimeout(r, 5));

    upstream.receive(jsonMsg({
      method: "Target.attachedToTarget",
      params: { sessionId: "s1", targetInfo: { targetId: "T1", type: "page" } },
    }));
    expect(seenTargets).toBe(1);

    client.close();
    await done;
  });

  it("binary messages are forwarded without parse attempt", async () => {
    const client = new FakeSocket();
    const upstream = new FakeSocket();
    const done = runPipeline(client, upstream, []);
    await new Promise((r) => setTimeout(r, 5));

    const bin = new Uint8Array([1, 2, 3, 4]);
    client.receive(bin);
    expect(upstream.sent[0]).toBe(bin);

    client.close();
    const result = await done;
    expect(result.counters.parsedCount).toBe(0);
    expect(result.counters.messageCount).toBe(1);
  });

  it("upstream frames are dropped when client bufferedAmount exceeds threshold", async () => {
    const client = new FakeSocket();
    const upstream = new FakeSocket();
    client.bufferedAmount = 2_000_000;
    const done = runPipeline(client, upstream, []);
    await new Promise((r) => setTimeout(r, 5));

    upstream.receive(jsonMsg({ method: "Page.frameNavigated", params: {} }));
    expect(client.sent.length).toBe(0); // dropped due to backpressure

    client.close();
    await done;
  });
});
