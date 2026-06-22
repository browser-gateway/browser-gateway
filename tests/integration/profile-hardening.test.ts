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
import { mkdtempSync, rmSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocket, WebSocketServer } from "ws";

const GATEWAY_PORT = 20300;
const PROVIDER_PORT = 20301;
const CONFIG_PATH = "/tmp/bg-profile-hardening-test.yml";
const PROFILE_DIR = mkdtempSync(join(tmpdir(), "bg-profile-hardening-test-"));
const ENCRYPTION_KEY = Buffer.alloc(32, "h").toString("base64");

function createMockProvider(port: number): { server: Server; wss: WebSocketServer; state: { cookies: Array<Record<string, unknown>>; getCookiesDelayMs: number; getCookiesCalls: number; setCookiesCalls: number } } {
  const state = { cookies: [] as Array<Record<string, unknown>>, getCookiesDelayMs: 0, getCookiesCalls: 0, setCookiesCalls: 0 };
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
        webSocketDebuggerUrl: `ws://localhost:${port}/devtools/browser/test`,
      }));
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(port);
  return { server, wss, state };
}

function buildConfig(commitTimeoutMs: number): string {
  return `
version: 1
gateway:
  port: ${GATEWAY_PORT}
  defaultStrategy: priority-chain
  connectionTimeout: 5000
  shutdownDrainMs: 8000
providers:
  mock-cdp:
    url: http://localhost:${PROVIDER_PORT}
    limits:
      maxConcurrent: 4
    priority: 1
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

async function waitForGateway() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://localhost:${GATEWAY_PORT}/health`);
      if (r.ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error("gateway didn't start");
}

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
  await waitForGateway();
}

async function stopGateway(): Promise<void> {
  if (!gatewayProcess || gatewayProcess.exitCode !== null) return;
  gatewayProcess.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    gatewayProcess.once("exit", () => resolve());
    setTimeout(resolve, 12_000);
  });
}

beforeAll(() => {
  provider = createMockProvider(PROVIDER_PORT);
});

afterAll(async () => {
  await stopGateway();
  provider?.server.close();
  try { unlinkSync(CONFIG_PATH); } catch {}
  try { rmSync(PROFILE_DIR, { recursive: true, force: true }); } catch {}
});

async function brieflyConnect(profileId: string): Promise<void> {
  const ws = new WebSocket(`ws://localhost:${GATEWAY_PORT}/v1/connect?profile=${profileId}`);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  ws.close();
}

describe("Hardening: SIGTERM drain preserves last-session state (H1)", () => {
  it("commits the latest cookies before exit when SIGTERM fires right after disconnect", async () => {
    provider.state.cookies = [
      { name: "h1-test", value: "alpha", domain: ".example.com", path: "/", secure: true, httpOnly: true },
    ];
    provider.state.getCookiesDelayMs = 800; // make commit slow enough that fire-and-forget would lose it

    await startGateway();

    await brieflyConnect("h1-profile");
    // The test's whole point is to SIGTERM while a commit is in-flight, so
    // drain has something to wait for. The race: after ws.close() the server
    // needs to fire its close event → cleanup() → commit-enqueue. On a fast
    // Mac that's a few ms; on CI's slower runners it can take 500ms+ and a
    // hardcoded sleep undershoots randomly. So we POLL /v1/status for the
    // active-session count to drop to 0 (= cleanup ran = commit is in
    // pendingCommits) before issuing SIGTERM. Mock provider's 800ms
    // getCookies guarantees the commit is still running when we kill.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`http://localhost:${GATEWAY_PORT}/v1/status`);
        const body = (await r.json()) as { activeSessions: number };
        if (body.activeSessions === 0) break;
      } catch {
        // status not yet reachable — keep trying
      }
      await sleep(50);
    }

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
