import { afterEach, describe, it, expect, vi } from "vitest";
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

class RecordingState extends FakeState {
  readonly calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  loginCheck = false;
  stuck = false;
  skipNextMoves = 0;
  private moves = 0;
  override async sendInternal<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    this.calls.push({ method, params });
    if (method === "Runtime.evaluate") {
      const expression = String(params?.expression ?? "");
      if (expression.includes("defineProperty")) return { result: { value: this.moves } } as T;
      return { result: { value: this.loginCheck } } as T;
    }
    if (method === "Input.dispatchMouseEvent" && params?.type === "mouseMoved") {
      if (this.skipNextMoves > 0) this.skipNextMoves--;
      else if (!this.stuck) this.moves++;
    }
    return super.sendInternal<T>(method);
  }
  navigations(): string[] {
    return this.calls.filter((c) => c.method === "Page.navigate").map((c) => String(c.params?.url));
  }
  probes(): Array<{ x: unknown; y: unknown }> {
    return this.calls.filter((c) => c.method === "Input.dispatchMouseEvent" && c.params?.type === "mouseMoved").map((c) => ({ x: c.params?.x, y: c.params?.y }));
  }
}

describe("ScreencastBridgePlugin password warning recovery", () => {
  const pageNav = (url: string): CdpMessage => ({ method: "Page.frameNavigated", sessionId: "s1", params: { frame: { url } } });
  const loaded: CdpMessage = { method: "Page.loadEventFired", sessionId: "s1", params: {} };
  const press = { type: "mouse", event: { kind: "press", x: 100, y: 300, button: "left", clickCount: 1 } };

  async function start() {
    const viewer = new FakeViewer();
    const state = new RecordingState();
    const order: string[] = [];
    const bridge = new ScreencastBridgePlugin({ viewer, onBeforeNavigate: () => { order.push("before-navigate"); } });
    await bridge.onSessionStart(state);
    bridge.onEvent(pageNav("https://site.test/login"), state);
    bridge.onEvent(loaded, state);
    return { viewer, state, bridge, order };
  }

  async function login(viewer: FakeViewer, state: RecordingState, bridge: ScreencastBridgePlugin, landedUrl = "https://site.test/home") {
    state.loginCheck = true;
    viewer.receive(press);
    await vi.advanceTimersByTimeAsync(0);
    bridge.onEvent(pageNav(landedUrl), state);
    bridge.onEvent(loaded, state);
  }

  const refreshNotices = (viewer: FakeViewer) =>
    viewer.sent.filter((m): m is string => typeof m === "string" && m.includes('"refresh"')).map((m) => JSON.parse(m).state);

  afterEach(() => vi.useRealTimers());

  it("asks the page about the click before sending the click", async () => {
    const { viewer, state } = await start();
    viewer.receive(press);
    await settle();
    const methods = state.calls.map((c) => c.method);
    expect(methods.indexOf("Runtime.evaluate")).toBeLessThan(methods.indexOf("Input.dispatchMouseEvent"));
  });

  it("leaves and returns once the page stops receiving input after a login", async () => {
    vi.useFakeTimers();
    const { viewer, state, bridge } = await start();
    await login(viewer, state, bridge);
    state.stuck = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(state.navigations()).toEqual(["about:blank", "https://site.test/home"]);
    expect(refreshNotices(viewer)).toEqual(["started", "done"]);
  });

  it("never reloads a login whose page keeps receiving input", async () => {
    vi.useFakeTimers();
    const { viewer, state, bridge } = await start();
    await login(viewer, state, bridge);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.navigations()).toEqual([]);
    expect(refreshNotices(viewer)).toEqual([]);
  });

  it("does not reload after a single missed check", async () => {
    vi.useFakeTimers();
    const { viewer, state, bridge } = await start();
    await login(viewer, state, bridge);
    state.skipNextMoves = 1;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.navigations()).toEqual([]);
  });

  it("shows the notice on the first missed check and hides it when the page answers again", async () => {
    vi.useFakeTimers();
    const { viewer, state, bridge } = await start();
    await login(viewer, state, bridge);
    state.skipNextMoves = 1;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(refreshNotices(viewer)).toEqual(["started", "done"]);
    expect(state.navigations()).toEqual([]);
  });

  it("stops watching after the watch window", async () => {
    vi.useFakeTimers();
    const { viewer, state, bridge } = await start();
    await login(viewer, state, bridge);
    await vi.advanceTimersByTimeAsync(7000);
    const probes = state.probes().length;
    state.stuck = true;
    await vi.advanceTimersByTimeAsync(5000);
    expect(state.probes().length).toBe(probes);
    expect(state.navigations()).toEqual([]);
  });

  it("does not judge a page that is still loading", async () => {
    vi.useFakeTimers();
    const { viewer, state, bridge } = await start();
    state.loginCheck = true;
    viewer.receive(press);
    await vi.advanceTimersByTimeAsync(0);
    bridge.onEvent(pageNav("https://site.test/home"), state);
    state.stuck = true;
    await vi.advanceTimersByTimeAsync(3000);
    expect(state.navigations()).toEqual([]);
    bridge.onEvent(loaded, state);
    await vi.advanceTimersByTimeAsync(1000);
    expect(state.navigations()).toEqual(["about:blank", "https://site.test/home"]);
  });

  it("saves the profile snapshot before leaving the page", async () => {
    vi.useFakeTimers();
    const { viewer, state, bridge, order } = await start();
    await login(viewer, state, bridge);
    state.stuck = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(order).toEqual(["before-navigate"]);
  });

  it("recovers once per login and ignores its own navigations", async () => {
    vi.useFakeTimers();
    const { viewer, state, bridge } = await start();
    await login(viewer, state, bridge);
    state.stuck = true;
    await vi.advanceTimersByTimeAsync(1000);
    bridge.onEvent(pageNav("https://site.test/home"), state);
    bridge.onEvent(loaded, state);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.navigations()).toEqual(["about:blank", "https://site.test/home"]);
  });

  it("recovers a login that stays on the same page", async () => {
    vi.useFakeTimers();
    const { viewer, state } = await start();
    state.loginCheck = true;
    viewer.receive(press);
    await vi.advanceTimersByTimeAsync(0);
    state.stuck = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(state.navigations()).toEqual(["about:blank", "https://site.test/login"]);
  });

  it("does nothing for a click that is not a login", async () => {
    vi.useFakeTimers();
    const { viewer, state, bridge } = await start();
    viewer.receive(press);
    await vi.advanceTimersByTimeAsync(0);
    bridge.onEvent(pageNav("https://site.test/next"), state);
    bridge.onEvent(loaded, state);
    state.stuck = true;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.navigations()).toEqual([]);
    expect(state.probes()).toEqual([]);
  });

  it("moves the pointer to a new spot on every check", async () => {
    vi.useFakeTimers();
    const { viewer, state, bridge } = await start();
    await login(viewer, state, bridge);
    await vi.advanceTimersByTimeAsync(1000);
    const probes = state.probes();
    expect(probes.length).toBeGreaterThan(2);
    for (let i = 1; i < probes.length; i++) expect(probes[i]).not.toEqual(probes[i - 1]);
    expect(probes[0]).not.toEqual({ x: 100, y: 300 });
  });

  it("watches Enter and sends it with the text that submits a form", async () => {
    const { viewer, state } = await start();
    viewer.receive({ type: "key", event: { kind: "down", key: "Enter", code: "Enter", keyCode: 13 } });
    await settle();
    const evaluate = state.calls.find((c) => c.method === "Runtime.evaluate");
    expect(String(evaluate?.params?.expression)).toContain("activeElement");
    const key = state.calls.find((c) => c.method === "Input.dispatchKeyEvent");
    expect(key?.params).toMatchObject({ type: "keyDown", text: "\r" });
    expect(key?.params).not.toHaveProperty("nativeVirtualKeyCode");
  });

  it("does not add text to Enter held with a shortcut modifier", async () => {
    const { viewer, state } = await start();
    viewer.receive({ type: "key", event: { kind: "down", key: "Enter", code: "Enter", keyCode: 13, modifiers: 2 } });
    await settle();
    const key = state.calls.find((c) => c.method === "Input.dispatchKeyEvent");
    expect(key?.params).not.toHaveProperty("text");
  });

  it("streams every frame by default", async () => {
    const { state } = await start();
    const cast = state.calls.find((c) => c.method === "Page.startScreencast");
    expect(cast?.params).toMatchObject({ everyNthFrame: 1 });
  });
});

describe("ScreencastBridgePlugin browser name", () => {
  class NamedState extends FakeState {
    readonly oneWay: Array<{ method: string; params?: Record<string, unknown>; sessionId?: string }> = [];
    constructor(private readonly userAgent: string | undefined) { super(); }
    override async sendInternal<T>(method: string): Promise<T> {
      if (method === "Browser.getVersion") return { userAgent: this.userAgent } as T;
      return super.sendInternal<T>(method);
    }
    override sendInternalOneWay(method: string, params?: Record<string, unknown>, sessionId?: string): void {
      this.oneWay.push({ method, params, sessionId });
    }
  }

  it("tells sites the viewer's page is plain Chrome when the browser runs headless", async () => {
    const state = new NamedState("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/154.0.0.0 Safari/537.36");
    await new ScreencastBridgePlugin({ viewer: new FakeViewer() }).onSessionStart(state);
    const override = state.oneWay.find((c) => c.method === "Network.setUserAgentOverride");
    expect(override?.params?.userAgent).toBe("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36");
    expect(override?.sessionId).toBe("s1");
  });

  it("leaves a browser that already calls itself Chrome alone", async () => {
    const state = new NamedState("Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36");
    await new ScreencastBridgePlugin({ viewer: new FakeViewer() }).onSessionStart(state);
    expect(state.oneWay.some((c) => c.method === "Network.setUserAgentOverride")).toBe(false);
  });

  it("still starts when the browser does not report a name", async () => {
    const state = new NamedState(undefined);
    await new ScreencastBridgePlugin({ viewer: new FakeViewer() }).onSessionStart(state);
    expect(state.oneWay.some((c) => c.method === "Network.setUserAgentOverride")).toBe(false);
    expect(state.log).toContain("Page.startScreencast");
  });
});
