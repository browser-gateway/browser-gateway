import { describe, it, expect } from "vitest";
import { ProfilePlugin } from "../../../src/pipeline/plugins/profile.js";
import type { CdpMessage, SessionState, TargetInfo } from "../../../src/pipeline/types.js";
import type { CapturedProfile } from "../../../src/core/profile/types.js";

class FakeBrowser implements SessionState {
  readonly upstreamUrl = "wss://test/";
  readonly targets = new Map<string, TargetInfo>();
  readonly pageOrigin = new Map<string, string>();
  readonly pageStorage = new Map<string, Record<string, string>>();
  readonly gonePages = new Set<string>();
  readonly originStorage = new Map<string, Record<string, string>>();
  private helpers = 0;
  readonly log: string[] = [];
  readonly forwarded: CdpMessage[] = [];
  cookies = [{ name: "sid", value: "1", domain: "a.test", path: "/" }];
  browserGone = false;
  hasForward = true;

  async sendInternal<T>(method: string, _params?: Record<string, unknown>, sessionId?: string): Promise<T> {
    this.log.push(`${method}${sessionId ? `@${sessionId}` : ""}`);
    await Promise.resolve();
    if (method === "Target.createTarget") return { targetId: `helper-${++this.helpers}` } as T;
    if (method === "Target.attachToTarget") return { sessionId: `h-${(_params as { targetId: string }).targetId}` } as T;
    if (method === "Page.navigate" && sessionId?.startsWith("h-")) {
      this.pageOrigin.set(sessionId, new URL((_params as { url: string }).url).origin);
      return {} as T;
    }
    if (method === "Runtime.evaluate" && sessionId?.startsWith("h-")) {
      return { result: { value: JSON.stringify(this.originStorage.get(this.pageOrigin.get(sessionId) ?? "") ?? {}) } } as T;
    }
    if (method === "Runtime.evaluate" && sessionId) {
      if (this.browserGone || this.gonePages.has(sessionId)) throw new Error("target closed");
      const origin = this.pageOrigin.get(sessionId) ?? "about:blank";
      const localStorage = this.pageStorage.get(sessionId) ?? {};
      return { result: { value: JSON.stringify({ origin, localStorage }) } } as T;
    }
    if (method === "Storage.getCookies") {
      if (this.browserGone) throw new Error("browser closed");
      return { cookies: this.cookies } as T;
    }
    return {} as T;
  }

  sendInternalOneWay(method: string, _params?: Record<string, unknown>, sessionId?: string): void {
    this.log.push(`oneway:${method}${sessionId ? `@${sessionId}` : ""}`);
  }

  forwardClientCommand?(msg: CdpMessage): void;

  close(): void {}

  openPage(sessionId: string, url: string, storage: Record<string, string>): void {
    this.targets.set(sessionId, { targetId: `t-${sessionId}`, type: "page", url });
    this.pageOrigin.set(sessionId, new URL(url).origin);
    this.pageStorage.set(sessionId, storage);
  }
}

function makeBrowser(): FakeBrowser {
  const b = new FakeBrowser();
  b.forwardClientCommand = (msg) => {
    if (!b.hasForward) return;
    b.forwarded.push(msg);
    if (msg.method === "Browser.close") b.browserGone = true;
    if (msg.method === "Target.closeTarget") {
      for (const [sid, t] of b.targets) if (t.targetId === (msg.params as { targetId: string }).targetId) b.gonePages.add(sid);
    }
  };
  return b;
}

function emptyProfile(): CapturedProfile {
  return {
    version: 1,
    capturedAt: new Date(0).toISOString(),
    cookies: [],
    storage: {},
    meta: { capturedOrigins: [], skippedOrigins: [], durationMs: 0 },
  } as CapturedProfile;
}

function makePlugin(opts: { readOnly?: boolean } = {}) {
  const saves: CapturedProfile[] = [];
  const plugin = new ProfilePlugin({
    profileId: "profile-capture-test",
    readOnly: opts.readOnly ?? false,
    skipResidueCheck: true,
    preloaded: opts.readOnly
      ? { profile: emptyProfile() }
      : { profile: emptyProfile(), onSave: async (p) => { saves.push(p); } },
  });
  return { plugin, saves };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("ProfilePlugin capture of pages it did not see open", () => {
  it("captures a page that was attached before the plugin started", async () => {
    const b = makeBrowser();
    b.openPage("s1", "https://a.test/home", { token: "abc" });
    const { plugin, saves } = makePlugin();
    await plugin.onSessionStart(b);
    await plugin.onSessionEnd(b, "test");
    expect(saves).toHaveLength(1);
    expect(saves[0]!.storage["https://a.test"]?.localStorage).toEqual({ token: "abc" });
    expect(b.log).toContain("oneway:Page.enable@s1");
  });

  it("registers a page on its first top-frame navigation", async () => {
    const b = makeBrowser();
    const { plugin, saves } = makePlugin();
    await plugin.onSessionStart(b);
    b.openPage("s2", "https://b.test/", { k: "v" });
    plugin.onEvent({ method: "Page.frameNavigated", sessionId: "s2", params: { frame: { id: "f2", url: "https://b.test/" } } });
    await plugin.onSessionEnd(b, "test");
    expect(saves[0]!.storage["https://b.test"]?.localStorage).toEqual({ k: "v" });
  });

  it("ignores navigations on sessions that are not pages", async () => {
    const b = makeBrowser();
    const { plugin, saves } = makePlugin();
    await plugin.onSessionStart(b);
    b.targets.set("w1", { targetId: "tw", type: "worker", url: "https://w.test/" });
    plugin.onEvent({ method: "Page.frameNavigated", sessionId: "w1", params: { frame: { id: "fw", url: "https://w.test/" } } });
    await plugin.onSessionEnd(b, "test");
    expect(Object.keys(saves[0]!.storage)).toEqual([]);
  });
});

describe("ProfilePlugin holds closing commands until the page is captured", () => {
  it("holds Target.closeTarget, snapshots the page, then forwards it", async () => {
    const b = makeBrowser();
    b.openPage("s1", "https://a.test/", { last: "page" });
    const { plugin, saves } = makePlugin();
    await plugin.onSessionStart(b);
    const cmd: CdpMessage = { id: 7, method: "Target.closeTarget", params: { targetId: "t-s1" } };
    expect(plugin.onCommand(cmd, b)).toBeNull();
    expect(b.forwarded).toEqual([]);
    await flush();
    expect(b.forwarded).toEqual([cmd]);
    expect(b.gonePages.has("s1")).toBe(true);
    await plugin.onSessionEnd(b, "test");
    expect(saves[0]!.storage["https://a.test"]?.localStorage).toEqual({ last: "page" });
  });

  it("holds Browser.close and keeps cookies read before the browser died", async () => {
    const b = makeBrowser();
    b.openPage("s1", "https://a.test/", { last: "page" });
    const { plugin, saves } = makePlugin();
    await plugin.onSessionStart(b);
    const cmd: CdpMessage = { id: 9, method: "Browser.close" };
    expect(plugin.onCommand(cmd, b)).toBeNull();
    await flush();
    expect(b.forwarded).toEqual([cmd]);
    expect(b.browserGone).toBe(true);
    await plugin.onSessionEnd(b, "test");
    expect(saves[0]!.cookies.map((c) => c.name)).toEqual(["sid"]);
    expect(saves[0]!.storage["https://a.test"]?.localStorage).toEqual({ last: "page" });
  });

  it("forwards a close for a page it does not know without holding it", async () => {
    const b = makeBrowser();
    const { plugin } = makePlugin();
    await plugin.onSessionStart(b);
    expect(plugin.onCommand({ id: 3, method: "Target.closeTarget", params: { targetId: "unknown" } }, b)).toBeUndefined();
  });

  it("without deferred forwarding, writes the snapshot before letting the close through", async () => {
    const b = makeBrowser();
    delete b.forwardClientCommand;
    b.openPage("s1", "https://a.test/", { x: "1" });
    const { plugin } = makePlugin();
    await plugin.onSessionStart(b);
    const before = b.log.length;
    expect(plugin.onCommand({ id: 4, method: "Target.closeTarget", params: { targetId: "t-s1" } }, b)).toBeUndefined();
    expect(b.log.slice(before)).toContain("Runtime.evaluate@s1");
  });

  it("does nothing for read-only sessions", async () => {
    const b = makeBrowser();
    b.openPage("s1", "https://a.test/", { x: "1" });
    const { plugin } = makePlugin({ readOnly: true });
    await plugin.onSessionStart(b);
    expect(plugin.onCommand({ id: 5, method: "Browser.close" }, b)).toBeUndefined();
    expect(b.log).not.toContain("Runtime.evaluate@s1");
  });
});

describe("ProfilePlugin snapshot before an internal navigation", () => {
  it("keeps the origin a sibling plugin navigates away from", async () => {
    const b = makeBrowser();
    b.openPage("s1", "https://a.test/", { left: "behind" });
    const { plugin, saves } = makePlugin();
    await plugin.onSessionStart(b);
    await plugin.snapshotPageBeforeLeave("s1");
    b.pageOrigin.set("s1", "https://c.test");
    b.pageStorage.set("s1", { now: "here" });
    plugin.onEvent({ method: "Page.frameNavigated", sessionId: "s1", params: { frame: { id: "f1", url: "https://c.test/" } } });
    await plugin.onSessionEnd(b, "test");
    expect(saves[0]!.storage["https://a.test"]?.localStorage).toEqual({ left: "behind" });
    expect(saves[0]!.storage["https://c.test"]?.localStorage).toEqual({ now: "here" });
  });
});

describe("ProfilePlugin when a page leaves by following a link", () => {
  it("re-reads the origin it left even when the snapshot on the way out missed it", async () => {
    const b = makeBrowser();
    b.openPage("s1", "https://a.test/", { kept: "yes" });
    b.originStorage.set("https://a.test", { kept: "yes" });
    const { plugin, saves } = makePlugin();
    await plugin.onSessionStart(b);
    plugin.onEvent({ method: "Page.frameNavigated", sessionId: "s1", params: { frame: { id: "f1", url: "https://a.test/" } } });
    b.pageOrigin.set("s1", "https://b.test");
    b.pageStorage.set("s1", {});
    plugin.onEvent({ method: "Page.frameRequestedNavigation", sessionId: "s1", params: { frameId: "f1", url: "https://b.test/" } });
    plugin.onEvent({ method: "Page.frameNavigated", sessionId: "s1", params: { frame: { id: "f1", url: "https://b.test/" } } });
    await plugin.onSessionEnd(b, "test");
    expect(saves[0]!.storage["https://a.test"]?.localStorage).toEqual({ kept: "yes" });
  });

  it("does not re-read origins left by a navigation it held", async () => {
    const b = makeBrowser();
    b.openPage("s1", "https://a.test/", { left: "behind" });
    const { plugin } = makePlugin();
    await plugin.onSessionStart(b);
    await plugin.snapshotPageBeforeLeave("s1");
    plugin.onEvent({ method: "Page.frameNavigated", sessionId: "s1", params: { frame: { id: "f1", url: "https://c.test/" } } });
    await plugin.onSessionEnd(b, "test");
    expect(b.log.some((l) => l.startsWith("Target.createTarget"))).toBe(false);
  });
});
