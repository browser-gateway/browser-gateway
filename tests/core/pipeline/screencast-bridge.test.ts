import { describe, it, expect } from "vitest";
import { ScreencastBridgePlugin } from "../../../src/pipeline/plugins/screencast-bridge.js";
import type { PipelineSocket } from "../../../src/pipeline/pipeline.js";
import type { CdpMessage, SessionState, TargetInfo } from "../../../src/pipeline/types.js";

class FakeViewer implements PipelineSocket {
  readonly sent: unknown[] = [];
  private listeners = new Map<string, Array<(ev: unknown) => void>>();
  send(data: string | ArrayBuffer | ArrayBufferView): void { this.sent.push(data); }
  close(): void { for (const l of this.listeners.get("close") ?? []) l({}); }
  addEventListener(type: string, listener: (ev: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  receive(obj: unknown): void {
    for (const l of this.listeners.get("message") ?? []) l({ data: JSON.stringify(obj) });
  }
}

class FakeState implements SessionState {
  readonly upstreamUrl = "wss://test/";
  readonly targets = new Map<string, TargetInfo>();
  readonly log: string[] = [];
  async sendInternal<T>(method: string): Promise<T> {
    this.log.push(method);
    if (method === "Target.createTarget") return { targetId: "t1" } as T;
    if (method === "Target.attachToTarget") return { sessionId: "s1" } as T;
    if (method === "Page.getNavigationHistory") return { currentIndex: 1, entries: [{ id: 10 }, { id: 11 }] } as T;
    return {} as T;
  }
  sendInternalOneWay(method: string): void { this.log.push(`oneway:${method}`); }
  close(): void {}
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("ScreencastBridgePlugin cookie clearing", () => {
  it("clears cookies on start by default", async () => {
    const state = new FakeState();
    await new ScreencastBridgePlugin({ viewer: new FakeViewer() }).onSessionStart(state);
    expect(state.log).toContain("oneway:Storage.clearCookies");
  });

  it("leaves cookies alone when a profile is loaded", async () => {
    const state = new FakeState();
    await new ScreencastBridgePlugin({ viewer: new FakeViewer(), clearCookiesOnStart: false }).onSessionStart(state);
    expect(state.log).not.toContain("oneway:Storage.clearCookies");
  });
});

describe("ScreencastBridgePlugin onBeforeNavigate", () => {
  async function start() {
    const viewer = new FakeViewer();
    const state = new FakeState();
    const calls: string[] = [];
    const bridge = new ScreencastBridgePlugin({
      viewer,
      onBeforeNavigate: (sessionId) => { calls.push(sessionId); state.log.push("before-navigate"); },
    });
    await bridge.onSessionStart(state);
    return { viewer, state, calls, bridge };
  }

  it("fires with the page session before a url navigation is sent", async () => {
    const { viewer, state, calls } = await start();
    viewer.receive({ type: "navigate", url: "https://b.test/" });
    await settle();
    expect(calls).toEqual(["s1"]);
    const i = state.log.indexOf("before-navigate");
    expect(i).toBeGreaterThan(-1);
    expect(state.log[i + 1]).toBe("Page.navigate");
  });

  it("fires before a back navigation and not before a reload", async () => {
    const { viewer, state, calls } = await start();
    viewer.receive({ type: "navigate", action: "reload" });
    await settle();
    expect(calls).toEqual([]);
    viewer.receive({ type: "navigate", action: "back" });
    await settle();
    expect(calls).toEqual(["s1"]);
    expect(state.log[state.log.indexOf("before-navigate") + 1]).toBe("Page.navigateToHistoryEntry");
  });

  it("waits for an async observer before navigating", async () => {
    const viewer = new FakeViewer();
    const state = new FakeState();
    let release: () => void = () => undefined;
    const bridge = new ScreencastBridgePlugin({
      viewer,
      onBeforeNavigate: () => new Promise<void>((r) => { release = r; }),
    });
    await bridge.onSessionStart(state);
    viewer.receive({ type: "navigate", url: "https://b.test/" });
    await settle();
    expect(state.log).not.toContain("Page.navigate");
    release();
    await settle();
    expect(state.log).toContain("Page.navigate");
  });

  it("navigates even when the observer throws", async () => {
    const viewer = new FakeViewer();
    const state = new FakeState();
    const bridge = new ScreencastBridgePlugin({ viewer, onBeforeNavigate: () => { throw new Error("boom"); } });
    await bridge.onSessionStart(state);
    viewer.receive({ type: "navigate", url: "https://b.test/" });
    await settle();
    expect(state.log).toContain("Page.navigate");
  });

  it("drops nothing from the event stream it does not own", () => {
    const viewer = new FakeViewer();
    const bridge = new ScreencastBridgePlugin({ viewer });
    const msg: CdpMessage = { method: "Network.requestWillBeSent", sessionId: "other" };
    expect(bridge.onEvent(msg, new FakeState())).toBeUndefined();
  });
});
