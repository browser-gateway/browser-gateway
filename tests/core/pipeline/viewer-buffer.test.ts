import { describe, it, expect } from "vitest";
import { bufferViewerMessages } from "../../../src/pipeline/viewer-buffer.js";
import { ClientMessageSchema } from "../../../src/live-client/protocol.js";
import type { PipelineSocket } from "../../../src/pipeline/pipeline.js";

class RawSocket implements PipelineSocket {
  private listeners = new Map<string, Array<(ev: unknown) => void>>();
  send(): void {}
  close(): void { this.emit("close", {}); }
  addEventListener(type: string, listener: (ev: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  emit(type: string, ev: unknown): void { for (const l of this.listeners.get(type) ?? []) l(ev); }
}

describe("bufferViewerMessages", () => {
  it("replays messages that arrived before the listener, in order, then passes new ones through", () => {
    const raw = new RawSocket();
    const viewer = bufferViewerMessages(raw);
    raw.emit("message", { data: "a" });
    raw.emit("message", { data: "b" });
    const got: unknown[] = [];
    viewer.addEventListener?.("message", (ev) => got.push((ev as { data: string }).data));
    raw.emit("message", { data: "c" });
    expect(got).toEqual(["a", "b", "c"]);
  });

  it("passes close events straight through", () => {
    const raw = new RawSocket();
    const viewer = bufferViewerMessages(raw);
    let closed = false;
    viewer.addEventListener?.("close", () => { closed = true; });
    raw.close();
    expect(closed).toBe(true);
  });

  it("keeps a bounded number of early messages", () => {
    const raw = new RawSocket();
    const viewer = bufferViewerMessages(raw);
    for (let i = 0; i < 1000; i++) raw.emit("message", { data: String(i) });
    const got: unknown[] = [];
    viewer.addEventListener?.("message", (ev) => got.push(ev));
    expect(got.length).toBe(256);
  });
});

describe("live protocol click count", () => {
  it("treats clicks quicker than a triple click as a triple click instead of rejecting them", () => {
    const parsed = ClientMessageSchema.parse({ type: "mouse", event: { kind: "press", x: 1, y: 1, button: "left", clickCount: 5 } });
    expect(parsed.type === "mouse" && parsed.event.clickCount).toBe(3);
  });
});
