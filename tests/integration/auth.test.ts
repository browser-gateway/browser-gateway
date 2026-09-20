import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { reservePort, waitForGatewayHealth } from "../helpers/harness.js";

let GATEWAY_PORT = 0;
let PROVIDER_PORT = 0;
const AUTH_TOKEN = "test-secret-token-12345";
const TMP_DIR = mkdtempSync(join(tmpdir(), "bg-auth-test-"));
const CONFIG_PATH = join(TMP_DIR, "gateway.yml");

let echoServer: Server;
let gatewayProcess: ChildProcess;

beforeAll(async () => {
  GATEWAY_PORT = await reservePort();
  PROVIDER_PORT = await reservePort();

  const server = createServer();
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws) => {
    ws.on("message", (data) => ws.send(data));
  });
  echoServer = server;
  server.listen(PROVIDER_PORT, "127.0.0.1");

  writeFileSync(
    CONFIG_PATH,
    `
version: 1
gateway:
  port: ${GATEWAY_PORT}
  connectionTimeout: 5000
providers:
  echo:
    url: ws://127.0.0.1:${PROVIDER_PORT}
    priority: 1
logging:
  level: error
`
  );

  gatewayProcess = spawn(
    "npx",
    ["tsx", "src/server/index.ts", "serve", "--config", CONFIG_PATH],
    {
      cwd: process.cwd(),
      stdio: "pipe",
      env: { ...process.env, BG_TOKEN: AUTH_TOKEN },
    }
  );

  await waitForGatewayHealth(GATEWAY_PORT, gatewayProcess);
}, 15000);

afterAll(async () => {
  gatewayProcess?.kill("SIGTERM");
  echoServer?.close();
  try { rmSync(TMP_DIR, { recursive: true, force: true }); } catch {}
  await sleep(500);
});

describe("Auth - BG_TOKEN enforcement", () => {
  it("should reject WebSocket without token", async () => {
    try {
      const ws = await new Promise<WebSocket>((resolve, reject) => {
        const w = new WebSocket(`ws://127.0.0.1:${GATEWAY_PORT}/v1/connect`);
        w.on("open", () => resolve(w));
        w.on("error", reject);
        setTimeout(() => reject(new Error("timeout")), 5000);
      });
      ws.close();
      expect.fail("should have been rejected");
    } catch (err: any) {
      expect(err.message).toContain("401");
    }
  });

  it("should reject WebSocket with wrong token", async () => {
    try {
      const ws = await new Promise<WebSocket>((resolve, reject) => {
        const w = new WebSocket(
          `ws://127.0.0.1:${GATEWAY_PORT}/v1/connect?token=wrong-token`
        );
        w.on("open", () => resolve(w));
        w.on("error", reject);
        setTimeout(() => reject(new Error("timeout")), 5000);
      });
      ws.close();
      expect.fail("should have been rejected");
    } catch (err: any) {
      expect(err.message).toContain("401");
    }
  });

  it("should accept WebSocket with correct token via query param", async () => {
    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const w = new WebSocket(
        `ws://127.0.0.1:${GATEWAY_PORT}/v1/connect?token=${AUTH_TOKEN}`
      );
      w.on("open", () => resolve(w));
      w.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 5000);
    });

    expect(ws.readyState).toBe(WebSocket.OPEN);

    const echo = await new Promise<string>((resolve) => {
      ws.once("message", (data) => resolve(data.toString()));
      ws.send("authenticated");
    });
    expect(echo).toBe("authenticated");

    ws.close();
  });

  it("should accept WebSocket with correct token via Authorization header", async () => {
    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const w = new WebSocket(
        `ws://127.0.0.1:${GATEWAY_PORT}/v1/connect`,
        { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } }
      );
      w.on("open", () => resolve(w));
      w.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 5000);
    });

    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it("should reject HTTP /v1/status without token", async () => {
    const res = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/v1/status`);
    expect(res.status).toBe(401);
  });

  it("should reject HTTP /v1/sessions without token", async () => {
    const res = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/v1/sessions`);
    expect(res.status).toBe(401);
  });

  it("should reject HTTP /v1/status with the token in the query string", async () => {
    const res = await fetch(
      `http://127.0.0.1:${GATEWAY_PORT}/v1/status?token=${AUTH_TOKEN}`
    );
    expect(res.status).toBe(401);
  });

  it("should accept HTTP /v1/status with Authorization header", async () => {
    const res = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/v1/status`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });
    expect(res.status).toBe(200);
  });

  it("should return health check without auth (always public)", async () => {
    const res = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/health`);
    expect(res.status).toBe(200);
  });
});
