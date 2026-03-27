import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { ChildProcess, spawn } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const GATEWAY_PORT = 13000;
const PROVIDER_PORT_1 = 13001;
const PROVIDER_PORT_2 = 13002;
const CONFIG_PATH = "/tmp/bg-integration-test.yml";

let echoServer1: Server;
let echoServer2: Server;
let providerWss1: WebSocketServer;
let providerWss2: WebSocketServer;
let gatewayProcess: ChildProcess;

function createEchoProvider(port: number): { server: Server; wss: WebSocketServer } {
  const server = createServer();
  const wss = new WebSocketServer({ server });

  wss.on("connection", (ws) => {
    ws.on("message", (data) => {
      ws.send(data);
    });
  });

  server.listen(port);
  return { server, wss };
}

beforeAll(async () => {
  const b1 = createEchoProvider(PROVIDER_PORT_1);
  echoServer1 = b1.server;
  providerWss1 = b1.wss;

  const b2 = createEchoProvider(PROVIDER_PORT_2);
  echoServer2 = b2.server;
  providerWss2 = b2.wss;

  writeFileSync(
    CONFIG_PATH,
    `
version: 1
gateway:
  port: ${GATEWAY_PORT}
  connectionTimeout: 5000
  cooldown:
    defaultMs: 3000
    failureThreshold: 0.5
    minRequestVolume: 2
  sessions:
    idleTimeoutMs: 10000
providers:
  echo-1:
    url: ws://localhost:${PROVIDER_PORT_1}
    limits:
      maxConcurrent: 1
    priority: 1
  echo-2:
    url: ws://localhost:${PROVIDER_PORT_2}
    limits:
      maxConcurrent: 2
    priority: 2
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
  echoServer1?.close();
  echoServer2?.close();
  try { unlinkSync(CONFIG_PATH); } catch {}
  await sleep(500);
});

function connectToGateway(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${GATEWAY_PORT}/v1/connect`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
    setTimeout(() => reject(new Error("connect timeout")), 5000);
  });
}

function sendAndReceive(ws: WebSocket, message: string): Promise<string> {
  return new Promise((resolve, reject) => {
    ws.once("message", (data) => resolve(data.toString()));
    ws.send(message);
    setTimeout(() => reject(new Error("echo timeout")), 5000);
  });
}

describe("Proxy Integration", () => {
  it("should proxy WebSocket messages bidirectionally", async () => {
    const ws = await connectToGateway();
    const echo = await sendAndReceive(ws, "hello gateway");
    expect(echo).toBe("hello gateway");
    ws.close();
    await sleep(200);
  });

  it("should proxy binary data", async () => {
    const ws = await connectToGateway();
    const binaryData = Buffer.from([0x00, 0x01, 0x02, 0xff]);

    const response = await new Promise<Buffer>((resolve, reject) => {
      ws.once("message", (data) => resolve(Buffer.from(data as ArrayBuffer)));
      ws.send(binaryData);
      setTimeout(() => reject(new Error("binary echo timeout")), 5000);
    });

    expect(Buffer.compare(response, binaryData)).toBe(0);
    ws.close();
    await sleep(200);
  });

  it("should proxy multiple messages in sequence", async () => {
    const ws = await connectToGateway();
    const messages = ["msg1", "msg2", "msg3", "msg4", "msg5"];
    const received: string[] = [];

    for (const msg of messages) {
      const echo = await sendAndReceive(ws, msg);
      received.push(echo);
    }

    expect(received).toEqual(messages);
    ws.close();
    await sleep(200);
  });

  it("should handle large messages", async () => {
    const ws = await connectToGateway();
    const largeMessage = "x".repeat(100_000);
    const echo = await sendAndReceive(ws, largeMessage);
    expect(echo.length).toBe(100_000);
    ws.close();
    await sleep(200);
  });
});

describe("Proxy - Health and Status", () => {
  it("should return healthy status", async () => {
    const res = await fetch(`http://localhost:${GATEWAY_PORT}/health`);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.status).toBe("ok");
  });

  it("should show providers in status", async () => {
    const res = await fetch(`http://localhost:${GATEWAY_PORT}/v1/status`);
    const data = await res.json() as any;
    expect(data.providers).toHaveLength(2);
    expect(data.providers.map((b: any) => b.id).sort()).toEqual(["echo-1", "echo-2"]);
  });

  it("should track active sessions", async () => {
    const ws = await connectToGateway();
    await sleep(300);

    const res = await fetch(`http://localhost:${GATEWAY_PORT}/v1/sessions`);
    const data = await res.json() as any;
    expect(data.count).toBeGreaterThanOrEqual(1);

    ws.close();
    await sleep(500);

    const res2 = await fetch(`http://localhost:${GATEWAY_PORT}/v1/sessions`);
    const data2 = await res2.json() as any;
    expect(data2.count).toBe(0);
  });
});

describe("Proxy - Concurrency Limits", () => {
  it("should enforce maxConcurrent per provider", async () => {
    // echo-1 has maxConcurrent: 1, echo-2 has maxConcurrent: 2
    const ws1 = await connectToGateway();
    await sleep(200);

    // ws1 should be on echo-1 (priority 1)
    const status1 = await fetch(`http://localhost:${GATEWAY_PORT}/v1/status`).then(r => r.json()) as any;
    const echo1 = status1.providers.find((b: any) => b.id === "echo-1");
    expect(echo1.active).toBe(1);

    // ws2 should go to echo-2 (echo-1 is full)
    const ws2 = await connectToGateway();
    await sleep(200);

    const status2 = await fetch(`http://localhost:${GATEWAY_PORT}/v1/status`).then(r => r.json()) as any;
    const echo2 = status2.providers.find((b: any) => b.id === "echo-2");
    expect(echo2.active).toBe(1);

    // Both should still work
    const r1 = await sendAndReceive(ws1, "from-ws1");
    expect(r1).toBe("from-ws1");
    const r2 = await sendAndReceive(ws2, "from-ws2");
    expect(r2).toBe("from-ws2");

    ws1.close();
    ws2.close();
    await sleep(500);
  });

  it("should return 503 when all providers at capacity", async () => {
    // Fill all: echo-1 (max 1) + echo-2 (max 2) = 3 total
    const ws1 = await connectToGateway();
    const ws2 = await connectToGateway();
    const ws3 = await connectToGateway();
    await sleep(300);

    // 4th should fail
    try {
      const ws4 = await connectToGateway();
      ws4.close();
      expect.fail("should have been rejected");
    } catch (err: any) {
      expect(err.message).toContain("Unexpected server response: 503");
    }

    ws1.close();
    ws2.close();
    ws3.close();
    await sleep(500);
  });
});

describe("Proxy - Failover", () => {
  it("should failover when primary provider goes down", async () => {
    // Close echo-1 to simulate failure
    echoServer1.close();
    providerWss1.close();
    await sleep(500);

    // Should still connect via echo-2
    const ws = await connectToGateway();
    const echo = await sendAndReceive(ws, "failover test");
    expect(echo).toBe("failover test");

    const status = await fetch(`http://localhost:${GATEWAY_PORT}/v1/sessions`).then(r => r.json()) as any;
    expect(status.sessions[0].providerId).toBe("echo-2");

    ws.close();
    await sleep(300);

    // Restart echo-1 for subsequent tests
    const b1 = createEchoProvider(PROVIDER_PORT_1);
    echoServer1 = b1.server;
    providerWss1 = b1.wss;
    await sleep(500);
  });
});

describe("Proxy - Clean Disconnect", () => {
  it("should clean up when client disconnects", async () => {
    const ws = await connectToGateway();
    await sleep(200);

    const before = await fetch(`http://localhost:${GATEWAY_PORT}/v1/status`).then(r => r.json()) as any;
    const totalBefore = before.providers.reduce((sum: number, b: any) => sum + b.active, 0);
    expect(totalBefore).toBeGreaterThanOrEqual(1);

    ws.close();
    await sleep(500);

    const after = await fetch(`http://localhost:${GATEWAY_PORT}/v1/status`).then(r => r.json()) as any;
    const totalAfter = after.providers.reduce((sum: number, b: any) => sum + b.active, 0);
    expect(totalAfter).toBe(0);
  });

  it("should increment totalConnections after session ends", async () => {
    const statusBefore = await fetch(`http://localhost:${GATEWAY_PORT}/v1/status`).then(r => r.json()) as any;
    const totalBefore = statusBefore.providers.reduce((sum: number, b: any) => sum + b.totalConnections, 0);

    const ws = await connectToGateway();
    await sendAndReceive(ws, "test");
    ws.close();
    await sleep(500);

    const statusAfter = await fetch(`http://localhost:${GATEWAY_PORT}/v1/status`).then(r => r.json()) as any;
    const totalAfter = statusAfter.providers.reduce((sum: number, b: any) => sum + b.totalConnections, 0);
    expect(totalAfter).toBeGreaterThan(totalBefore);
  });
});
