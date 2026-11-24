import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import { ChildProcess, spawn } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { reservePort, waitForGatewayHealth, waitUntil } from "../helpers/harness.js";

const TMP_DIR = mkdtempSync(join(tmpdir(), "bg-history-it-"));
const CONFIG_PATH = join(TMP_DIR, "gateway.yml");

let gatewayPort = 0;
let provider: WebSocketServer;
let gatewayProcess: ChildProcess;

interface HistoryResponse {
  total: number;
  days: { date: string; count: number }[];
  sessions: { id: string; providerId: string; durationMs: number; messageCount: number }[];
}

async function history(query = ""): Promise<HistoryResponse> {
  const res = await fetch(`http://127.0.0.1:${gatewayPort}/v1/sessions/history${query}`);
  expect(res.status).toBe(200);
  return (await res.json()) as HistoryResponse;
}

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
providers:
  echo:
    url: ws://127.0.0.1:${providerPort}
logging:
  level: error
`,
  );

  gatewayProcess = spawn("npx", ["tsx", "src/server/index.ts", "serve", "--config", CONFIG_PATH], {
    cwd: process.cwd(),
    stdio: "pipe",
    env: { ...process.env, BG_TOKEN: "", BG_DATA_DIR: TMP_DIR },
  });
  await waitForGatewayHealth(gatewayPort, gatewayProcess);
}, 20000);

afterAll(async () => {
  gatewayProcess?.kill("SIGTERM");
  provider?.close();
  await sleep(300);
  try { rmSync(TMP_DIR, { recursive: true, force: true }); } catch {}
});

describe("session history", () => {
  it("starts empty with 90 zero-filled days", async () => {
    const body = await history();
    expect(body.total).toBe(0);
    expect(body.sessions).toEqual([]);
    expect(body.days).toHaveLength(90);
  });

  it("lists a finished session with its provider and message count", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${gatewayPort}/v1/connect`);
    await new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); });
    const echoed = new Promise<void>((resolve) => ws.once("message", () => resolve()));
    ws.send(JSON.stringify({ id: 1, method: "Browser.getVersion" }));
    await echoed;
    ws.close();

    let body = await history();
    await waitUntil(async () => { body = await history(); return body.total === 1; }, "session in history", 5000, 100);
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].providerId).toBe("echo");
    expect(body.sessions[0].messageCount).toBeGreaterThanOrEqual(1);
    expect(body.days.at(-1)?.count).toBe(1);
  });

  it("honours the limit and caps it", async () => {
    expect((await history("?limit=0")).sessions.length).toBeLessThanOrEqual(10);
    expect((await history("?limit=abc")).sessions.length).toBeLessThanOrEqual(10);
  });
});
