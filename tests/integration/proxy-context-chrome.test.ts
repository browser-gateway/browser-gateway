import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, request as httpRequest, type Server } from "node:http";
import { connect as netConnect, type AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";
import { chromium } from "playwright-core";
import WebSocket from "ws";
import { chromePath, startRealChrome, type RealChrome } from "../helpers/real-chrome.js";
import { reservePort, runToken, waitForOwnGateway, waitUntil } from "../helpers/harness.js";

const RUN = runToken();
const TMP = mkdtempSync(join(tmpdir(), "bg-proxy-context-"));
const ENCRYPTION_KEY = Buffer.alloc(32, "p").toString("base64");
const PROFILE_ID = `proxied-${RUN}`;
const PAGE = "<html><head><title>proxied</title></head><body>proxied page</body></html>";

let chrome: RealChrome;
let proxyServer: Server;
let gateway: ChildProcess;
let gatewayPort = 0;
const seenByProxy: string[] = [];

function startForwardProxy(): Promise<number> {
  const server = createServer((req, res) => {
    seenByProxy.push(req.url ?? "");
    const target = new URL(req.url ?? "");
    const upstream = httpRequest({ host: target.hostname, port: target.port, path: target.pathname + target.search, method: req.method, headers: req.headers }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    });
    upstream.on("error", () => res.destroy());
    res.on("error", () => upstream.destroy());
    req.pipe(upstream);
  });
  server.on("connect", (req, client, head) => {
    seenByProxy.push(`CONNECT ${req.url}`);
    const [host, port] = (req.url ?? "").split(":");
    const up = netConnect(Number(port), host!, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      up.write(head);
      up.pipe(client);
      client.pipe(up);
    });
    up.on("error", () => client.destroy());
    client.on("error", () => up.destroy());
  });
  proxyServer = server;
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}



function proxiedHits(path: string): number {
  return seenByProxy.filter((u) => u.includes(path)).length;
}

function connectUrl(query: string): string {
  return `ws://127.0.0.1:${gatewayPort}/v1/connect${query}`;
}

async function upgradeStatus(query: string): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(connectUrl(query));
    ws.on("unexpected-response", (_req, res) => { resolve(res.statusCode ?? 0); ws.terminate(); });
    ws.on("open", () => { resolve(101); ws.close(); });
    ws.on("error", () => undefined);
  });
}

function openLive(query: string): Promise<{ ws: WebSocket; status: number; urls: string[] }> {
  return new Promise((resolve) => {
    const urls: string[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${gatewayPort}/v1/live${query}`);
    ws.on("unexpected-response", (_req, res) => { resolve({ ws, status: res.statusCode ?? 0, urls }); ws.terminate(); });
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      const msg = JSON.parse(data.toString()) as { type: string; url?: string };
      if (msg.type === "url" && msg.url) urls.push(msg.url);
      if (msg.type === "ready" || msg.type === "frameMeta") resolve({ ws, status: 101, urls });
    });
    ws.on("error", () => undefined);
  });
}

async function viewInPlayground(query: string, path: string): Promise<void> {
  const live = await openLive(query);
  expect(live.status).toBe(101);
  try {
    live.ws.send(JSON.stringify({ type: "navigate", url: `${chrome.baseUrl}${path}` }));
    await waitUntil(async () => live.urls.some((u) => u.endsWith(path)), `playground reached ${path}`);
  } finally {
    live.ws.send(JSON.stringify({ type: "close" }));
    live.ws.close();
  }
}

async function setDefaults(defaults: Record<string, unknown>): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${gatewayPort}/v1/config/session-defaults`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ record: false, profile: null, saveProfile: false, proxy: null, ...defaults }),
  });
  expect(res.status).toBe(200);
}

async function visit(query: string, path: string, act?: (page: import("puppeteer-core").Page) => Promise<void>): Promise<string | undefined> {
  const browser = await puppeteer.connect({ browserWSEndpoint: connectUrl(query), defaultViewport: null });
  try {
    const page = await browser.newPage();
    await page.goto(`${chrome.baseUrl}${path}`);
    await act?.(page);
    return (await page.cookies()).find((c) => c.name === "bg_login")?.value;
  } finally {
    await browser.disconnect();
  }
}

async function replayCount(): Promise<number> {
  const { count } = await (await fetch(`http://127.0.0.1:${gatewayPort}/v1/replays`)).json() as { count: number };
  return count;
}

describe.skipIf(!chromePath)("proxy applied through a proxied browser context", () => {
  beforeAll(async () => {
    chrome = await startRealChrome({ "/rest-cookie": "<html><body><script>document.body.textContent = document.cookie</script></body></html>", "/rest-a": PAGE, "/rest-b": PAGE, "/rest-c": PAGE, "/rest-d": PAGE, "/rest-e": PAGE, "/a": PAGE, "/b": PAGE, "/c": PAGE, "/d": PAGE, "/e": PAGE, "/f": PAGE, "/g": PAGE, "/live-a": PAGE, "/live-b": PAGE, "/def-a": PAGE, "/def-b": PAGE, "/def-c": PAGE, "/def-d": PAGE, "/def-e": PAGE });
    const proxyPort = await startForwardProxy();
    gatewayPort = await reservePort();
    const config = join(TMP, "gateway.yml");
    writeFileSync(config, `version: 1
gateway:
  port: ${gatewayPort}
  connectionTimeout: 10000
providers:
  own-chrome-${RUN}:
    url: ${chrome.browserWsUrl}
    injectProxy: true
    priority: 1
  other-${RUN}:
    url: ${chrome.browserWsUrl}
    priority: 2
proxies:
  local:
    url: http://127.0.0.1:${proxyPort}
    bypass: ["<-loopback>"]
  with-password:
    url: http://user:secret@127.0.0.1:${proxyPort}
profiles:
  enabled: true
  store: filesystem
  filesystem:
    path: ${join(TMP, "profiles")}
  encryption:
    keyEnv: BG_ENCRYPTION_KEY
rest:
  allowedPrivateHosts: ["127.0.0.1"]
logging:
  level: error
`);
    gateway = spawn("npx", ["tsx", "src/server/index.ts", "serve", "--config", config], { cwd: process.cwd(), stdio: "ignore", env: { ...process.env, BG_TOKEN: "", BG_ENCRYPTION_KEY: ENCRYPTION_KEY } });
    await waitForOwnGateway(gatewayPort, gateway, RUN);
  }, 60_000);

  afterAll(async () => {
    gateway?.kill("SIGTERM");
    proxyServer?.close();
    await chrome?.stop();
    rmSync(TMP, { recursive: true, force: true });
  });

  it("sends a Puppeteer newPage through the proxy and keeps cookie reads in the same context", async () => {
    const browser = await puppeteer.connect({ browserWSEndpoint: connectUrl("?proxy=local"), defaultViewport: null });
    try {
      const page = await browser.newPage();
      await page.goto(`${chrome.baseUrl}/a`);
      expect(await page.title()).toBe("proxied");
      expect(proxiedHits("/a")).toBeGreaterThan(0);
      await page.setCookie({ name: "bg_proxy", value: "1", url: chrome.baseUrl });
      expect((await browser.cookies()).some((c) => c.name === "bg_proxy")).toBe(true);
      expect(browser.browserContexts()).toHaveLength(1);
    } finally {
      await browser.disconnect();
    }
  });

  it("sends the first existing Playwright page and contexts the client creates through the proxy", async () => {
    const browser = await chromium.connectOverCDP(connectUrl("?proxy=local"));
    try {
      const first = browser.contexts()[0]!.pages().find((p) => p.url() === "about:blank")!;
      await first.goto(`${chrome.baseUrl}/b`);
      expect(proxiedHits("/b")).toBeGreaterThan(0);
      const own = await browser.newContext();
      await (await own.newPage()).goto(`${chrome.baseUrl}/c`);
      expect(proxiedHits("/c")).toBeGreaterThan(0);
      await own.close();
    } finally {
      await browser.close();
    }
  });

  it("leaves a connection without ?proxy on the provider's own network", async () => {
    const browser = await puppeteer.connect({ browserWSEndpoint: connectUrl(""), defaultViewport: null });
    try {
      const page = await browser.newPage();
      await page.goto(`${chrome.baseUrl}/d`);
      expect(await page.title()).toBe("proxied");
      expect(proxiedHits("/d")).toBe(0);
    } finally {
      await browser.disconnect();
    }
  });

  it("refuses an unknown proxy and a provider not marked injectProxy", async () => {
    expect(await upgradeStatus("?proxy=missing")).toBe(400);
    expect(await upgradeStatus(`?proxy=local&provider=other-${RUN}`)).toBe(400);
    expect(await upgradeStatus("?proxy=with-password")).toBe(400);
    expect(proxiedHits("/e")).toBe(0);
  });

  it("loads and saves a profile inside the proxied context", async () => {
    const first = await puppeteer.connect({ browserWSEndpoint: connectUrl(`?proxy=local&profile=${PROFILE_ID}`), defaultViewport: null });
    const page = await first.newPage();
    await page.goto(`${chrome.baseUrl}/f`);
    await page.setCookie({ name: "bg_login", value: "kept", url: chrome.baseUrl });
    await page.evaluate(() => localStorage.setItem("bg_ls", "kept"));
    await first.disconnect();
    await waitUntil(async () => (await fetch(`http://127.0.0.1:${gatewayPort}/v1/profiles/${PROFILE_ID}`)).status === 200, "profile saved");

    const hitsBefore = proxiedHits("/g");
    const second = await puppeteer.connect({ browserWSEndpoint: connectUrl(`?proxy=local&profile=${PROFILE_ID}&readOnly=1`), defaultViewport: null });
    try {
      const again = await second.newPage();
      await again.goto(`${chrome.baseUrl}/g`);
      expect(proxiedHits("/g")).toBeGreaterThan(hitsBefore);
      expect((await again.cookies()).find((c) => c.name === "bg_login")?.value).toBe("kept");
      expect(await again.evaluate(() => localStorage.getItem("bg_ls"))).toBe("kept");
    } finally {
      await second.disconnect();
    }
  });

  it("lists proxies without credentials and shows which providers apply them", async () => {
    const base = `http://127.0.0.1:${gatewayPort}`;
    const raw = await (await fetch(`${base}/v1/proxies`)).text();
    expect(raw).not.toContain("secret");
    expect(raw).not.toContain("user");
    const { proxies } = JSON.parse(raw) as { proxies: Array<{ name: string; usable: boolean; server: string; bypass: string[] }> };
    expect(proxies.find((p) => p.name === "local")).toMatchObject({ usable: true, bypass: ["<-loopback>"] });
    expect(proxies.find((p) => p.name === "with-password")?.usable).toBe(false);
    const { providers } = await (await fetch(`${base}/v1/providers`)).json() as { providers: Array<{ id: string; injectProxy: boolean }> };
    expect(providers.find((p) => p.id === `own-chrome-${RUN}`)?.injectProxy).toBe(true);
    expect(providers.find((p) => p.id === `other-${RUN}`)?.injectProxy).toBe(false);
  });

  it("shows the proxy and profile on a live session", async () => {
    const browser = await puppeteer.connect({ browserWSEndpoint: connectUrl(`?proxy=local&profile=${PROFILE_ID}&readOnly=1`), defaultViewport: null });
    try {
      const { sessions } = await (await fetch(`http://127.0.0.1:${gatewayPort}/v1/sessions`)).json() as { sessions: Array<{ proxyName: string | null; profileId: string | null }> };
      expect(sessions).toContainEqual(expect.objectContaining({ proxyName: "local", profileId: PROFILE_ID }));
    } finally {
      await browser.disconnect();
    }
  });

  it("sends the playground page through the proxy", async () => {
    await viewInPlayground(`?provider=own-chrome-${RUN}&proxy=local`, "/live-a");
    expect(proxiedHits("/live-a")).toBeGreaterThan(0);
  });

  it("leaves a playground without a proxy on the provider's own network", async () => {
    await viewInPlayground(`?provider=own-chrome-${RUN}`, "/live-b");
    expect(proxiedHits("/live-b")).toBe(0);
  });

  it("refuses a playground proxy on a provider that does not apply proxies", async () => {
    expect((await openLive(`?provider=other-${RUN}&proxy=local`)).status).toBe(400);
    expect((await openLive(`?provider=own-chrome-${RUN}&proxy=missing`)).status).toBe(400);
  });

  it("sends a connection with no proxy through the default proxy, and proxy=none opts out", async () => {
    await setDefaults({ proxy: "local" });
    try {
      await visit("", "/def-a");
      expect(proxiedHits("/def-a")).toBeGreaterThan(0);
      await visit("?proxy=none", "/def-b");
      expect(proxiedHits("/def-b")).toBe(0);
    } finally {
      await setDefaults({});
    }
  });

  it("loads the default profile read-only unless saving is on, and profile=none opts out", async () => {
    const before = await (await fetch(`http://127.0.0.1:${gatewayPort}/v1/profiles/${PROFILE_ID}`)).json() as { updatedAt: string };
    await setDefaults({ profile: PROFILE_ID });
    try {
      const seen = await visit("?proxy=local", "/def-c", (page) => page.setCookie({ name: "bg_extra", value: "1", url: chrome.baseUrl }));
      expect(seen).toBe("kept");
      await new Promise((r) => setTimeout(r, 500));
      const after = await (await fetch(`http://127.0.0.1:${gatewayPort}/v1/profiles/${PROFILE_ID}`)).json() as { updatedAt: string };
      expect(after.updatedAt).toBe(before.updatedAt);
      expect(await visit("?proxy=local&profile=none", "/def-d")).toBeUndefined();
    } finally {
      await setDefaults({});
    }
  });

  it("records a connection when recording is on by default, and session_record=false opts out", async () => {
    await setDefaults({ record: true });
    try {
      const start = await replayCount();
      await visit("", "/def-e", (page) => new Promise((r) => setTimeout(r, 300)).then(() => page.title()).then(() => undefined));
      await waitUntil(async () => (await replayCount()) === start + 1, "default recording saved");
      await visit("?session_record=false", "/def-e");
      await new Promise((r) => setTimeout(r, 1000));
      expect(await replayCount()).toBe(start + 1);
    } finally {
      await setDefaults({});
    }
  });

  it("refuses a profile named none and deleting the default profile", async () => {
    const base = `http://127.0.0.1:${gatewayPort}`;
    const created = await fetch(`${base}/v1/profiles/create`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: "None" }) });
    expect(created.status).toBe(400);
    await setDefaults({ profile: PROFILE_ID });
    try {
      expect((await fetch(`${base}/v1/profiles/${PROFILE_ID}`, { method: "DELETE" })).status).toBe(409);
    } finally {
      await setDefaults({});
    }
  });

  it("keeps injectProxy when a provider is edited without it", async () => {
    const base = `http://127.0.0.1:${gatewayPort}`;
    const res = await fetch(`${base}/v1/providers/other-${RUN}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ injectProxy: true }) });
    expect(res.status).toBe(200);
    await fetch(`${base}/v1/providers/other-${RUN}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ priority: 3 }) });
    const { providers } = await (await fetch(`${base}/v1/providers`)).json() as { providers: Array<{ id: string; injectProxy: boolean; priority: number }> };
    expect(providers.find((p) => p.id === `other-${RUN}`)).toMatchObject({ injectProxy: true, priority: 3 });
    await fetch(`${base}/v1/providers/other-${RUN}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ injectProxy: false, priority: 2 }) });
  });


  describe("REST endpoints", () => {
    async function content(body: Record<string, unknown>): Promise<{ status: number; json: { success?: boolean; error?: string; message?: string } }> {
      const res = await fetch(`http://127.0.0.1:${gatewayPort}/v1/content`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ formats: ["text"], retries: 0, ...body }),
      });
      return { status: res.status, json: await res.json() as { success?: boolean; error?: string; message?: string } };
    }

    it("loads a page through the proxy the request names, and refuses one with a password", async () => {
      expect((await content({ url: `${chrome.baseUrl}/rest-a`, proxy: "local" })).status).toBe(200);
      expect(proxiedHits("/rest-a")).toBeGreaterThan(0);
      const refused = await content({ url: `${chrome.baseUrl}/rest-a`, proxy: "with-password" });
      expect(refused.status).toBe(400);
      expect(JSON.stringify(refused.json)).not.toContain("secret");
    });

    it("follows the default proxy, and proxy none opts out", async () => {
      await setDefaults({ proxy: "local" });
      try {
        expect((await content({ url: `${chrome.baseUrl}/rest-b` })).status).toBe(200);
        expect(proxiedHits("/rest-b")).toBeGreaterThan(0);
        expect((await content({ url: `${chrome.baseUrl}/rest-c`, proxy: "none" })).status).toBe(200);
        expect(proxiedHits("/rest-c")).toBe(0);
      } finally {
        await setDefaults({});
      }
    });

    it("refuses an unknown proxy and a provider that does not apply proxies", async () => {
      const unknown = await content({ url: `${chrome.baseUrl}/rest-d`, proxy: "missing" });
      expect(unknown.status).toBe(400);
      expect(JSON.stringify(unknown.json)).toContain("missing");
      expect((await content({ url: `${chrome.baseUrl}/rest-d`, proxy: "local", provider: `other-${RUN}` })).status).toBe(400);
      expect(proxiedHits("/rest-d")).toBe(0);
    });

    it("loads and saves a profile on a proxied REST request", async () => {
      const id = `rest-${RUN}`;
      await visit(`?proxy=local&profile=${id}`, "/rest-a", (page) => page.setCookie({ name: "bg_login", value: "rest", url: chrome.baseUrl }));
      await waitUntil(async () => (await fetch(`http://127.0.0.1:${gatewayPort}/v1/profiles/${id}`)).status === 200, "profile saved");
      const before = proxiedHits("/rest-cookie");
      const res = await fetch(`http://127.0.0.1:${gatewayPort}/v1/content`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: `${chrome.baseUrl}/rest-cookie`, proxy: "local", profile: id, formats: ["text"] }),
      });
      expect(res.status).toBe(200);
      expect(proxiedHits("/rest-cookie")).toBeGreaterThan(before);
      expect(((await res.json()) as { data: { content: { text: string } } }).data.content.text).toContain("bg_login=rest");
    });

    it("keeps the default profile and recording off pooled REST sessions", async () => {
      await setDefaults({ profile: PROFILE_ID, saveProfile: true, record: true });
      const before = await replayCount();
      const saved = await (await fetch(`http://127.0.0.1:${gatewayPort}/v1/profiles/${PROFILE_ID}`)).json() as { updatedAt: string };
      try {
        expect((await content({ url: `${chrome.baseUrl}/rest-e`, proxy: "none" })).status).toBe(200);
        await new Promise((r) => setTimeout(r, 1000));
        expect(await replayCount()).toBe(before);
        const after = await (await fetch(`http://127.0.0.1:${gatewayPort}/v1/profiles/${PROFILE_ID}`)).json() as { updatedAt: string };
        expect(after.updatedAt).toBe(saved.updatedAt);
      } finally {
        await setDefaults({});
      }
    });
  });
});
