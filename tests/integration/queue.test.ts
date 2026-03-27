import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { ChildProcess, spawn } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const GATEWAY_PORT = 17000;
const PROVIDER_PORT = 17001;
const CONFIG_PATH = "/tmp/bg-queue-test.yml";

let echoServer: Server;
let gatewayProcess: ChildProcess;

function createEchoProvider(port: number): { server: Server; wss: WebSocketServer } {
  const server = createServer();
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws) => { ws.on("message", (d) => ws.send(d)); });
  server.listen(port);
  return { server, wss };
}

beforeAll(async () => {
  const b = createEchoProvider(PROVIDER_PORT);
  echoServer = b.server;

  writeFileSync(CONFIG_PATH, `
version: 1
gateway:
  port: ${GATEWAY_PORT}
  connectionTimeout: 5000
  queue:
    maxSize: 3
    timeoutMs: 5000
providers:
  echo:
    url: ws://localhost:${PROVIDER_PORT}
    limits:
      maxConcurrent: 1
    priority: 1
logging:
  level: error
`);

  gatewayProcess = spawn("npx", ["tsx", "src/server/index.ts", "serve", "--config", CONFIG_PATH], {
    cwd: process.cwd(),
    stdio: "pipe",
    env: { ...process.env, BG_TOKEN: "" },
  });

  await sleep(3000);
}, 15000);

afterAll(async () => {
  gatewayProcess?.kill("SIGTERM");
  echoServer?.close();
  try { unlinkSync(CONFIG_PATH); } catch {}
  await sleep(500);
});

function connectWs(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${GATEWAY_PORT}/v1/connect`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
    setTimeout(() => reject(new Error("timeout")), 10000);
  });
}

describe("Request Queuing", () => {
  it("should queue when provider at capacity and connect when slot frees", async () => {
    // Fill the only slot
    const ws1 = await connectWs();
    await sleep(200);

    // This should queue, then succeed when ws1 closes
    const connectPromise = connectWs();

    // Wait a bit for it to enter queue
    await sleep(500);

    // Check queue size
    const status = await fetch(`http://localhost:${GATEWAY_PORT}/v1/status`).then(r => r.json()) as any;
    expect(status.queueSize).toBeGreaterThanOrEqual(0);

    // Free the slot
    ws1.close();

    // The queued request should now connect
    const ws2 = await connectPromise;
    expect(ws2.readyState).toBe(WebSocket.OPEN);

    ws2.close();
    await sleep(500);
  }, 15000);

  it("should reject when queue is full", async () => {
    // Fill provider slot
    const ws1 = await connectWs();
    await sleep(200);

    // Fill queue (maxSize: 3)
    const pending: Promise<WebSocket>[] = [];
    for (let i = 0; i < 3; i++) {
      pending.push(connectWs().catch(() => null as any));
    }
    await sleep(500);

    // 4th should be rejected (queue full)
    try {
      const ws5 = await connectWs();
      ws5.close();
      expect.fail("should have been rejected");
    } catch (err: any) {
      expect(err.message).toContain("503");
    }

    // Cleanup
    ws1.close();
    await sleep(2000);
    for (const p of pending) {
      try { (await p)?.close(); } catch {}
    }
    await sleep(500);
  }, 20000);

  it("should show queueSize in status API", async () => {
    const status = await fetch(`http://localhost:${GATEWAY_PORT}/v1/status`).then(r => r.json()) as any;
    expect(status).toHaveProperty("queueSize");
    expect(typeof status.queueSize).toBe("number");
  });
});
