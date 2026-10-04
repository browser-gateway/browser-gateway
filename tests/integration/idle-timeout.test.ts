import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import { ChildProcess, spawn } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { reservePort, waitForGatewayHealth, waitUntil } from "../helpers/harness.js";

const IDLE_MS = 1500;
const TMP_DIR = mkdtempSync(join(tmpdir(), "bg-idle-test-"));
const CONFIG_PATH = join(TMP_DIR, "gateway.yml");

let gatewayPort = 0;
let provider: WebSocketServer;
let gatewayProcess: ChildProcess;

beforeAll(async () => {
  gatewayPort = await reservePort();
  const providerPort = await reservePort();
  provider = new WebSocketServer({ port: providerPort });
  provider.on("connection", (ws) => ws.on("message", (data) => ws.send(data)));

  writeFileSync(
    CONFIG_PATH,
    `version: 1
gateway:
  port: ${gatewayPort}
  sessions:
    idleTimeoutMs: ${IDLE_MS}
providers:
  echo:
    url: ws://127.0.0.1:${providerPort}
    limits:
      maxConcurrent: 1
logging:
  level: error
`,
  );

  gatewayProcess = spawn("npx", ["tsx", "src/server/index.ts", "serve", "--config", CONFIG_PATH], {
    cwd: process.cwd(),
    stdio: "pipe",
    env: { ...process.env, BG_TOKEN: "" },
  });
  await waitForGatewayHealth(gatewayPort, gatewayProcess);
}, 20000);

afterAll(async () => {
  gatewayProcess?.kill("SIGTERM");
  provider?.close();
  try { rmSync(TMP_DIR, { recursive: true, force: true }); } catch {}
  await sleep(300);
});

function connect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${gatewayPort}/v1/connect`);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

async function sessionCount(): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${gatewayPort}/v1/sessions`);
  return ((await res.json()) as { count: number }).count;
}

describe("session idle timeout", () => {
  it("closes a session that sends nothing and frees its provider slot", async () => {
    const ws = await connect();
    let closed = false;
    ws.once("close", () => { closed = true; });

    await waitUntil(() => closed, "idle session to be closed", IDLE_MS * 4, 100);
    expect(await sessionCount()).toBe(0);

    const next = await connect();
    expect(next.readyState).toBe(WebSocket.OPEN);
    next.close();
    await sleep(200);
  }, 15000);

  it("keeps a session open while the client keeps talking", async () => {
    const ws = await connect();
    let closed = false;
    ws.once("close", () => { closed = true; });

    for (let i = 0; i < 10; i++) {
      ws.send(`ping ${i}`);
      await sleep(IDLE_MS / 3);
    }
    expect(closed).toBe(false);
    expect(await sessionCount()).toBe(1);
    ws.close();
    await sleep(200);
  }, 15000);
});
