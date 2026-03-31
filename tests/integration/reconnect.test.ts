import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { type ChildProcess, spawn } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const GATEWAY_PORT = 20000;
const PROVIDER_PORT_1 = 20001;
const PROVIDER_PORT_2 = 20002;
const CONFIG_PATH = "/tmp/bg-reconnect-test.yml";

function createEchoProvider(port: number): { server: Server; wss: WebSocketServer } {
  const server = createServer();
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws) => {
    ws.on("message", (data) => ws.send(data));
  });
  server.listen(port);
  return { server, wss };
}

describe("Session Reconnection", () => {
  let provider1: { server: Server; wss: WebSocketServer };
  let provider2: { server: Server; wss: WebSocketServer };
  let gatewayProcess: ChildProcess;

  beforeAll(async () => {
    provider1 = createEchoProvider(PROVIDER_PORT_1);
    provider2 = createEchoProvider(PROVIDER_PORT_2);

    const config = `
version: 1
gateway:
  port: ${GATEWAY_PORT}
  defaultStrategy: priority-chain
  connectionTimeout: 5000
  cooldown:
    defaultMs: 5000
    failureThreshold: 0.5
    minRequestVolume: 3
  sessions:
    idleTimeoutMs: 300000
    reconnectTimeoutMs: 10000
  queue:
    maxSize: 5
    timeoutMs: 5000
providers:
  echo-1:
    url: ws://localhost:${PROVIDER_PORT_1}
    limits:
      maxConcurrent: 2
    priority: 1
  echo-2:
    url: ws://localhost:${PROVIDER_PORT_2}
    limits:
      maxConcurrent: 2
    priority: 2
dashboard:
  enabled: false
logging:
  level: warn
`;
    writeFileSync(CONFIG_PATH, config);

    const env = { ...process.env, BG_TOKEN: "" };
    gatewayProcess = spawn("npx", ["tsx", "src/server/index.ts", "serve", "--config", CONFIG_PATH], {
      cwd: process.cwd(),
      stdio: "pipe",
      env,
    });

    await sleep(4000);
  }, 10000);

  afterAll(async () => {
    gatewayProcess?.kill("SIGTERM");
    provider1?.server.close();
    provider2?.server.close();
    try { unlinkSync(CONFIG_PATH); } catch {}
    await sleep(500);
  });

  function connectToGateway(params?: string): Promise<{ ws: WebSocket; sessionId: string }> {
    return new Promise((resolve, reject) => {
      const url = `ws://localhost:${GATEWAY_PORT}/v1/connect${params ? `?${params}` : ""}`;
      const ws = new WebSocket(url);
      let sessionId = "";

      ws.on("upgrade", (res) => {
        sessionId = res.headers["x-session-id"] as string ?? "";
      });

      ws.on("open", () => resolve({ ws, sessionId }));
      ws.on("error", reject);
      setTimeout(() => reject(new Error("connect timeout")), 5000);
    });
  }

  function sendAndReceive(ws: WebSocket, msg: string): Promise<string> {
    return new Promise((resolve, reject) => {
      ws.once("message", (data) => resolve(data.toString()));
      ws.send(msg);
      setTimeout(() => reject(new Error("echo timeout")), 5000);
    });
  }

  it("should return X-Session-Id header on connect", async () => {
    const { ws, sessionId } = await connectToGateway();

    expect(sessionId).toBeTruthy();
    expect(sessionId.length).toBeGreaterThan(10); // UUID format

    ws.close();
    await sleep(200);
  });

  it("should reconnect to the same provider using sessionId", async () => {
    // Connect and send a message
    const { ws: ws1, sessionId } = await connectToGateway();
    const echo1 = await sendAndReceive(ws1, "hello-session-1");
    expect(echo1).toBe("hello-session-1");

    // Check which provider via status
    const statusRes = await fetch(`http://localhost:${GATEWAY_PORT}/v1/status`);
    const status = await statusRes.json() as any;
    const activeProvider = status.providers.find((p: any) => p.active > 0);

    // Disconnect
    ws1.close();
    await sleep(500);

    // Reconnect with sessionId
    const { ws: ws2, sessionId: newSessionId } = await connectToGateway(`sessionId=${sessionId}`);

    // Verify we got the same session ID back
    expect(newSessionId).toBe(sessionId);

    // Verify we can still communicate
    const echo2 = await sendAndReceive(ws2, "hello-reconnected");
    expect(echo2).toBe("hello-reconnected");

    ws2.close();
    await sleep(200);
  });

  it("should route to normal provider when sessionId is invalid", async () => {
    // Connect with a fake sessionId - should fall through to normal routing
    const { ws, sessionId } = await connectToGateway("sessionId=nonexistent-fake-id");

    // Should still connect (falls through to normal routing)
    expect(sessionId).toBeTruthy();
    expect(sessionId).not.toBe("nonexistent-fake-id");

    const echo = await sendAndReceive(ws, "still-works");
    expect(echo).toBe("still-works");

    ws.close();
    await sleep(200);
  });

  it("should fail reconnection after TTL expires", async () => {
    // Connect
    const { ws: ws1, sessionId } = await connectToGateway();
    ws1.close();

    // Wait longer than reconnectTimeoutMs (10s in test config)
    await sleep(12000);

    // Try to reconnect - should get a new session (parked session expired)
    const { ws: ws2, sessionId: newSessionId } = await connectToGateway(`sessionId=${sessionId}`);

    // Should get a different session ID (the old one expired)
    expect(newSessionId).not.toBe(sessionId);

    ws2.close();
    await sleep(200);
  }, 20000);

  it("should handle multiple simultaneous parked sessions", async () => {
    // Create two connections
    const { ws: ws1, sessionId: id1 } = await connectToGateway();
    const { ws: ws2, sessionId: id2 } = await connectToGateway();

    expect(id1).not.toBe(id2);

    // Disconnect both
    ws1.close();
    ws2.close();
    await sleep(500);

    // Reconnect both
    const { ws: ws1r, sessionId: reconnId1 } = await connectToGateway(`sessionId=${id1}`);
    const { ws: ws2r, sessionId: reconnId2 } = await connectToGateway(`sessionId=${id2}`);

    expect(reconnId1).toBe(id1);
    expect(reconnId2).toBe(id2);

    // Both should work
    const echo1 = await sendAndReceive(ws1r, "session-1");
    const echo2 = await sendAndReceive(ws2r, "session-2");
    expect(echo1).toBe("session-1");
    expect(echo2).toBe("session-2");

    ws1r.close();
    ws2r.close();
    await sleep(200);
  });

  it("should not allow reconnecting twice with the same sessionId", async () => {
    const { ws: ws1, sessionId } = await connectToGateway();
    ws1.close();
    await sleep(300);

    // First reconnect succeeds
    const { ws: ws2, sessionId: reconnId } = await connectToGateway(`sessionId=${sessionId}`);
    expect(reconnId).toBe(sessionId);

    // Second reconnect with same sessionId - session was claimed, should get new session
    const { ws: ws3, sessionId: newId } = await connectToGateway(`sessionId=${sessionId}`);
    expect(newId).not.toBe(sessionId); // Falls through to new session

    ws2.close();
    ws3.close();
    await sleep(200);
  });
});
