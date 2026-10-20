import { describe, expect, it } from "vitest";
import { ProxyContextPlugin } from "../../../src/pipeline/plugins/proxy-context.js";
import { PluginCdpClient } from "../../../src/pipeline/plugins/profile-cdp-client.js";
import type { SessionState } from "../../../src/pipeline/types.js";

function fakeState(targets: Array<{ targetId: string; type: string; url: string; browserContextId?: string }>) {
  const sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const state = {
    upstreamUrl: "ws://test",
    targets: new Map(),
    async sendInternal(method: string, params?: Record<string, unknown>) {
      sent.push({ method, params });
      if (method === "Target.createBrowserContext") return { browserContextId: "CTX" };
      if (method === "Target.getTargets") return { targetInfos: targets };
      return {};
    },
    sendInternalOneWay() {},
    close() {},
  } as unknown as SessionState;
  return { state, sent };
}

async function started(targets = [{ targetId: "T1", type: "page", url: "about:blank", browserContextId: "DEFAULT" }]) {
  const plugin = new ProxyContextPlugin({ proxyServer: "http://p.example.com:3128", bypass: ["<-loopback>", "*.internal"] });
  const fake = fakeState(targets);
  await plugin.onSessionStart(fake.state);
  return { plugin, ...fake };
}

describe("ProxyContextPlugin", () => {
  it("opens one proxied context with the bypass list, opens its own tab, closes the blank default tab", async () => {
    const { sent } = await started();
    expect(sent[0]).toEqual({
      method: "Target.createBrowserContext",
      params: { proxyServer: "http://p.example.com:3128", proxyBypassList: "<-loopback>;*.internal" },
    });
    expect(sent).toContainEqual({ method: "Target.createTarget", params: { url: "about:blank", browserContextId: "CTX" } });
    expect(sent).toContainEqual({ method: "Target.closeTarget", params: { targetId: "T1" } });
  });

  it("keeps default-context pages that are not blank", async () => {
    const { sent } = await started([{ targetId: "T2", type: "page", url: "https://example.org/", browserContextId: "DEFAULT" }]);
    expect(sent.some((m) => m.method === "Target.closeTarget")).toBe(false);
  });

  it("points default-context browser commands at the proxied context", async () => {
    const { plugin } = await started();
    for (const method of ["Target.createTarget", "Storage.getCookies", "Storage.setCookies", "Browser.setDownloadBehavior", "Browser.grantPermissions"]) {
      expect(plugin.onCommand({ id: 1, method, params: {} })?.params?.browserContextId, method).toBe("CTX");
    }
  });

  it("leaves page-session commands and commands that already name a context alone", async () => {
    const { plugin } = await started();
    expect(plugin.onCommand({ id: 1, method: "Target.createTarget", params: {}, sessionId: "S" })).toBeUndefined();
    expect(plugin.onCommand({ id: 2, method: "Target.createTarget", params: { browserContextId: "OTHER" } })).toBeUndefined();
    expect(plugin.onCommand({ id: 3, method: "Page.navigate", params: { url: "x" } })).toBeUndefined();
  });

  it("adds the proxy to contexts the client creates", async () => {
    const { plugin } = await started();
    expect(plugin.onCommand({ id: 4, method: "Target.createBrowserContext", params: {} })?.params).toMatchObject({ proxyServer: "http://p.example.com:3128" });
  });

  it("hides its own context from the client's context list, only for that request", async () => {
    const { plugin } = await started();
    plugin.onCommand({ id: 7, method: "Target.getBrowserContexts" });
    const rewritten = plugin.onResponse({ id: 7, result: { browserContextIds: ["CTX", "A"] } });
    expect(rewritten?.result).toEqual({ browserContextIds: ["A"] });
    expect(plugin.onResponse({ id: 7, result: { browserContextIds: ["CTX"] } })).toBeUndefined();
  });

  it("disposes its context at the end", async () => {
    const { plugin, state, sent } = await started();
    await plugin.onSessionEnd(state);
    expect(sent.at(-1)).toEqual({ method: "Target.disposeBrowserContext", params: { browserContextId: "CTX" } });
  });
});

describe("PluginCdpClient browser context", () => {
  it("sends the profile plugin's browser-level commands into the given context and leaves page commands alone", async () => {
    const { state, sent } = fakeState([]);
    const client = new PluginCdpClient(state, () => "CTX");
    await client.send("Storage.setCookies", { cookies: [] });
    await client.send("Target.createTarget", { url: "about:blank" });
    await client.sendOn("Storage.getCookies", {});
    await client.sendOn("Runtime.evaluate", { expression: "1" }, "S1");
    await client.send("Browser.getVersion");
    expect(sent.map((m) => m.params?.browserContextId)).toEqual(["CTX", "CTX", "CTX", undefined, undefined]);
  });

  it("leaves commands untouched without a context", async () => {
    const { state, sent } = fakeState([]);
    await new PluginCdpClient(state).send("Storage.setCookies", { cookies: [] });
    expect(sent[0]?.params).toEqual({ cookies: [] });
  });
});
