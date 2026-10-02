import { describe, it, expect } from "vitest";
import { Pipeline, type PipelineSocket } from "../../../src/pipeline/pipeline.js";
import { BrowserCloseAsDisconnectPlugin } from "../../../src/pipeline/plugins/browser-close-as-disconnect.js";

class FakeSocket implements PipelineSocket {
  readonly sent: string[] = [];
  closed = false;
  private listeners = new Map<string, Array<(ev: unknown) => void>>();
  send(data: string | ArrayBuffer | ArrayBufferView): void { if (!this.closed) this.sent.push(String(data)); }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const l of this.listeners.get("close") ?? []) l({});
  }
  addEventListener(type: string, listener: (ev: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  receive(obj: unknown): void {
    for (const l of this.listeners.get("message") ?? []) l({ data: JSON.stringify(obj) });
  }
}

async function start() {
  const client = new FakeSocket();
  const upstream = new FakeSocket();
  const p = new Pipeline(upstream, "wss://test/", { plugins: [new BrowserCloseAsDisconnectPlugin()], onSessionEndTimeoutMs: 100 });
  await p.start();
  const done = p.run(client);
  await new Promise((r) => setTimeout(r, 1));
  return { client, upstream, done };
}

describe("BrowserCloseAsDisconnectPlugin", () => {
  it("never sends Browser.close upstream, answers the client, then ends the session", async () => {
    const { client, upstream, done } = await start();
    client.receive({ id: 5, method: "Browser.close" });
    expect(upstream.sent.map((s) => JSON.parse(s))).toEqual([{ id: 5, method: "Browser.getVersion" }]);
    upstream.receive({ id: 5, result: { product: "Chrome" } });
    expect(client.sent.map((s) => JSON.parse(s))).toEqual([{ id: 5, result: { product: "Chrome" } }]);
    const result = await done;
    expect(result.reason).toBe("client-closed-browser");
    expect(client.closed).toBe(true);
    expect(upstream.closed).toBe(true);
  });

  it("leaves other commands and page-level closes alone", async () => {
    const { client, upstream, done } = await start();
    client.receive({ id: 1, method: "Page.close", sessionId: "s1" });
    client.receive({ id: 2, method: "Browser.close", sessionId: "s1" });
    expect(upstream.sent.map((s) => JSON.parse(s).method)).toEqual(["Page.close", "Browser.close"]);
    upstream.receive({ id: 1, result: {} });
    expect(client.closed).toBe(false);
    client.close();
    await done;
  });
});
