import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { WebSocketServer } from "ws";
import puppeteer from "puppeteer-core";
import { ChildProcess, spawn } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const GATEWAY_PORT = 14000;
const PROVIDER_PORT = 14001;
const CONFIG_PATH = "/tmp/bg-puppeteer-test.yml";

let echoServer: Server;
let providerWss: WebSocketServer;
let gatewayProcess: ChildProcess;

beforeAll(async () => {
  const server = createServer();
  const wss = new WebSocketServer({ server });

  wss.on("connection", (ws) => {
    ws.on("message", (data) => {
      const msg = data.toString();
      try {
        const parsed = JSON.parse(msg);
        if (parsed.method === "Target.getBrowserContexts") {
          ws.send(JSON.stringify({ id: parsed.id, result: { browserContextIds: [] } }));
        } else if (parsed.method === "Browser.getVersion") {
          ws.send(
            JSON.stringify({
              id: parsed.id,
              result: {
                protocolVersion: "1.3",
                product: "HeadlessChrome/100.0.0",
                userAgent: "test-agent",
                jsVersion: "10.0",
              },
            })
          );
        } else if (parsed.method === "Target.getTargets") {
          ws.send(JSON.stringify({ id: parsed.id, result: { targetInfos: [] } }));
        } else if (parsed.method === "Target.setDiscoverTargets") {
          ws.send(JSON.stringify({ id: parsed.id, result: {} }));
        } else if (parsed.method === "Target.setAutoAttach") {
          ws.send(JSON.stringify({ id: parsed.id, result: {} }));
        } else {
          ws.send(JSON.stringify({ id: parsed.id, result: {} }));
        }
      } catch {
        ws.send(data);
      }
    });
  });

  echoServer = server;
  providerWss = wss;
  server.listen(PROVIDER_PORT);

  writeFileSync(
    CONFIG_PATH,
    `
version: 1
gateway:
  port: ${GATEWAY_PORT}
  connectionTimeout: 5000
providers:
  cdp-mock:
    url: ws://localhost:${PROVIDER_PORT}
    limits:
      maxConcurrent: 5
    priority: 1
logging:
  level: error
`
  );

  gatewayProcess = spawn(
    "npx",
    ["tsx", "src/server/index.ts", "serve", "--config", CONFIG_PATH],
    { cwd: process.cwd(), stdio: "pipe", env: { ...process.env, BG_TOKEN: "" } }
  );

  await sleep(3000);
}, 15000);

afterAll(async () => {
  gatewayProcess?.kill("SIGTERM");
  echoServer?.close();
  try { unlinkSync(CONFIG_PATH); } catch {}
  await sleep(500);
});

describe("Puppeteer through Gateway", () => {
  it("should connect Puppeteer via browserWSEndpoint", async () => {
    const browser = await puppeteer.connect({
      browserWSEndpoint: `ws://localhost:${GATEWAY_PORT}/v1/connect`,
    });

    expect(browser).toBeDefined();
    expect(browser.connected).toBe(true);

    await browser.disconnect();
  }, 15000);

  it("should get browser version through the proxy", async () => {
    const browser = await puppeteer.connect({
      browserWSEndpoint: `ws://localhost:${GATEWAY_PORT}/v1/connect`,
    });

    const version = await browser.version();
    expect(version).toContain("HeadlessChrome");

    await browser.disconnect();
  }, 15000);

  it("should track Puppeteer session in gateway", async () => {
    const browser = await puppeteer.connect({
      browserWSEndpoint: `ws://localhost:${GATEWAY_PORT}/v1/connect`,
    });

    await sleep(300);

    const res = await fetch(`http://localhost:${GATEWAY_PORT}/v1/sessions`);
    const data = (await res.json()) as any;
    expect(data.count).toBeGreaterThanOrEqual(1);
    expect(data.sessions[0].providerId).toBe("cdp-mock");
    expect(data.sessions[0].messageCount).toBeGreaterThan(0);

    await browser.disconnect();
  }, 15000);

  it("should clean up after Puppeteer disconnects", async () => {
    const browser = await puppeteer.connect({
      browserWSEndpoint: `ws://localhost:${GATEWAY_PORT}/v1/connect`,
    });

    await sleep(300);
    await browser.disconnect();
    await sleep(1000);

    const res = await fetch(`http://localhost:${GATEWAY_PORT}/v1/sessions`);
    const data = (await res.json()) as any;
    expect(data.count).toBe(0);
  }, 15000);

  it("should handle multiple Puppeteer connections simultaneously", async () => {
    const browsers = await Promise.all([
      puppeteer.connect({ browserWSEndpoint: `ws://localhost:${GATEWAY_PORT}/v1/connect` }),
      puppeteer.connect({ browserWSEndpoint: `ws://localhost:${GATEWAY_PORT}/v1/connect` }),
      puppeteer.connect({ browserWSEndpoint: `ws://localhost:${GATEWAY_PORT}/v1/connect` }),
    ]);

    expect(browsers).toHaveLength(3);
    expect(browsers.every((b) => b.connected)).toBe(true);

    await sleep(300);

    const res = await fetch(`http://localhost:${GATEWAY_PORT}/v1/sessions`);
    const data = (await res.json()) as any;
    expect(data.count).toBe(3);

    await Promise.all(browsers.map((b) => b.disconnect()));
    await sleep(1000);

    const final = await fetch(`http://localhost:${GATEWAY_PORT}/v1/sessions`);
    const finalData = (await final.json()) as any;
    expect(finalData.count).toBe(0);
  }, 15000);
});
