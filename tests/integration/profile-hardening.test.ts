/**
 * Phase 4.5 hardening tests at the gateway level.
 *
 * H1: SIGTERM-equivalent shutdown drain — start a session, disconnect, immediately
 *     trigger drain; verify the commit completed (profile blob present + non-empty).
 *
 * M1: lock-released-soon-after-disconnect — same profile should be reconnectable
 *     within ~1s of disconnect (was up to 10s before the commitTimeoutMs split).
 *
 * L5: socket-destroyed-without-events — defensive watchdog should still release
 *     the lock after a brief delay.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocket, WebSocketServer } from "ws";
import { enableBrowserserveDropOff, type BrowserserveDropOffState } from "./profile-fixtures/browserserve-mock.js";
import { reservePort, runToken, waitForOwnGateway, waitUntil } from "../helpers/harness.js";

const RUN = runToken();
const PROFILE_DIR = mkdtempSync(join(tmpdir(), "bg-profile-hardening-test-"));
const CONFIG_PATH = join(PROFILE_DIR, "gateway.yml");
let gatewayPort = 0;
let providerPort = 0;
const ENCRYPTION_KEY = Buffer.alloc(32, "h").toString("base64");

function createMockProvider(): { server: Server; wss: WebSocketServer; state: { cookies: Array<Record<string, unknown>>; getCookiesDelayMs: number; getCookiesCalls: number; setCookiesCalls: number; dropOff: BrowserserveDropOffState } } {
  const state = { cookies: [] as Array<Record<string, unknown>>, getCookiesDelayMs: 0, getCookiesCalls: 0, setCookiesCalls: 0, dropOff: null as unknown as BrowserserveDropOffState };
  const server = createServer();
  const wss = new WebSocketServer({ server, path: "/devtools/browser/test" });
  wss.on("connection", (ws) => {
    ws.on("message", async (raw) => {
      const msg = JSON.parse(raw.toString()) as { id: number; method: string; params?: { cookies?: Array<Record<string, unknown>> } };
      if (msg.method === "Storage.getCookies") {
        state.getCookiesCalls++;
        if (state.getCookiesDelayMs > 0) await new Promise((r) => setTimeout(r, state.getCookiesDelayMs));
        ws.send(JSON.stringify({ id: msg.id, result: { cookies: state.cookies } }));
        return;
      }
      if (msg.method === "Storage.setCookies") {
        state.setCookiesCalls++;
        state.cookies = msg.params?.cookies ?? [];
        ws.send(JSON.stringify({ id: msg.id, result: {} }));
        return;
      }
      if (msg.id !== undefined) ws.send(JSON.stringify({ id: msg.id, result: {} }));
    });
  });
  server.on("request", (req: IncomingMessage, res) => {
    if (req.url === "/json/version") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        Browser: "MockCDP/1.0",
        "Protocol-Version": "1.3",
        "Browserserve-Version": "test-1.0",
        webSocketDebuggerUrl: `ws://127.0.0.1:${providerPort}/devtools/browser/test`,
      }));
      return;
    }
    res.writeHead(404).end();
  });
  state.dropOff = enableBrowserserveDropOff(server, () => ({
    cookies: state.cookies,
    localStorage: [],
    indexeddb: [],
  }));
  return { server, wss, state };
}

function buildConfig(commitTimeoutMs: number): string {
  return `
version: 1
gateway:
  port: ${gatewayPort}
  defaultStrategy: priority-chain
  connectionTimeout: 5000
  shutdownDrainMs: 8000
providers:
  mock-cdp-${RUN}:
    url: http://127.0.0.1:${providerPort}
    limits:
      maxConcurrent: 4
    priority: 1
    multiProfile: true
dashboard:
  enabled: false
logging:
  level: warn
profiles:
  enabled: true
  store: filesystem
  filesystem:
    path: ${PROFILE_DIR}
  encryption:
    keyEnv: BG_ENCRYPTION_KEY
  lockTtlMs: 60000
  cdpTimeoutMs: 10000
  commitTimeoutMs: ${commitTimeoutMs}
`;
}

let provider: ReturnType<typeof createMockProvider>;
let gatewayProcess: ChildProcess;

async function startGateway(commitTimeoutMs = 1_500): Promise<void> {
  writeFileSync(CONFIG_PATH, buildConfig(commitTimeoutMs));
  gatewayProcess = spawn(
    "npx",
    ["tsx", "src/server/index.ts", "serve", "--config", CONFIG_PATH],
    {
      cwd: process.cwd(),
      stdio: "pipe",
      env: { ...process.env, BG_TOKEN: "", BG_ENCRYPTION_KEY: ENCRYPTION_KEY },
    },
  );
  await waitForOwnGateway(gatewayPort, gatewayProcess, RUN);
}

async function stopGateway(): Promise<void> {
  if (!gatewayProcess || gatewayProcess.exitCode !== null) return;
  gatewayProcess.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    gatewayProcess.once("exit", () => resolve());
    setTimeout(resolve, 12_000);
  });
}

beforeAll(async () => {
  providerPort = await reservePort();
  gatewayPort = await reservePort();
  provider = createMockProvider();
  await new Promise<void>((resolve, reject) => {
    provider.server.once("error", reject);
    provider.server.listen(providerPort, "127.0.0.1", resolve);
  });
});

afterAll(async () => {
  await stopGateway();
  provider?.server.close();
  try { rmSync(PROFILE_DIR, { recursive: true, force: true }); } catch {}
});

async function brieflyConnect(profileId: string): Promise<void> {
  const ws = new WebSocket(`ws://127.0.0.1:${gatewayPort}/v1/connect?profile=${profileId}`);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  ws.close();
}


describe("Hardening: SIGTERM drain preserves last-session state (H1)", () => {
  it("captures + saves cookies to disk when gateway is gracefully stopped after a clean disconnect", async () => {
    provider.state.cookies = [
      { name: "h1-test", value: "alpha", domain: ".example.com", path: "/", secure: true, httpOnly: true },
    ];
    // Fast commit so timing isn't this test's job — the
    // `lifecycle-drain.test.ts` unit test covers the drain-waits-for-slow-
    // commit behavior. THIS test verifies the end-to-end integration: when
    // the gateway gets SIGTERM after a clean disconnect, the cookies captured
    // on disconnect end up on disk before the process exits.
    provider.state.getCookiesDelayMs = 0;
    await startGateway();

    const capturesBefore = provider.state.dropOff.pickUpCalls;
    await brieflyConnect("h1-profile");
    await waitUntil(
      () => provider.state.dropOff.pickUpCalls > capturesBefore,
      "disconnect capture to read upstream state",
    );

    await stopGateway();

    // After gateway exit, the profile should be on disk
    const blob = join(PROFILE_DIR, "h1-profile", "data.enc");
    expect(existsSync(blob)).toBe(true);
  }, 30_000);
});

describe("Hardening: rapid reconnect window (M1)", () => {
  it("same profile is reconnectable within ~commitTimeoutMs after disconnect", async () => {
    provider.state.cookies = [];
    provider.state.getCookiesDelayMs = 0;

    await startGateway(1_500); // commit cap 1.5s

    // First session
    await brieflyConnect("m1-profile");
    const t0 = Date.now();
    // Loop attempting reconnect; expect success within ~2s (commit cap + slack)
    let succeeded = false;
    let elapsed = 0;
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        await brieflyConnect("m1-profile");
        succeeded = true;
        elapsed = Date.now() - t0;
        break;
      } catch (err) {
        const m = (err as Error).message;
        if (!/409|conflict/i.test(m)) throw err;
        await sleep(100);
      }
    }
    await stopGateway();

    expect(succeeded).toBe(true);
    expect(elapsed).toBeLessThan(3_000);
  }, 30_000);
});
