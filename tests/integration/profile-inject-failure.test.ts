/**
 * Pinned-external CDP-inject failure scenarios that complement
 * profile-failure-injection.test.ts (the browserserve-marked D1-D6 cases).
 *
 * Under the 0.4.12 invariant, external CDP providers must be pinned to
 * a single profile via `profile: "<id>"`. These tests exercise the
 * ProfilePlugin inject path (Storage.setCookies/getCookies over CDP)
 * that browserserve providers deliberately skip in favour of the
 * drop-off HTTP channel.
 *
 *   D3-pinned. inject fails on provider A, gateway fails over to provider B.
 *   D7-pinned. capture-on-close hangs past commitTimeoutMs → previous state
 *              preserved, lock released.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocket, WebSocketServer } from "ws";

const GATEWAY_PORT = 20700;
const PROVIDER_PORT_A = 20701;
const PROVIDER_PORT_B = 20702;
const PROFILE_ID = "pinned-alpha";
const CONFIG_PATH = "/tmp/bg-profile-inject-failure-test.yml";
const PROFILE_DIR = mkdtempSync(join(tmpdir(), "bg-profile-inject-failure-"));
const ENCRYPTION_KEY = Buffer.alloc(32, "p").toString("base64");

interface MockProvider {
  port: number;
  server: Server;
  state: {
    storedCookies: Array<Record<string, unknown>>;
    setCookiesCalls: number;
    getCookiesCalls: number;
    rejectSetCookies: boolean;
    getCookiesDelayMs: number;
  };
  close: () => Promise<void>;
}

function createPinnedMock(port: number, label: string): MockProvider {
  const state = {
    storedCookies: [] as Array<Record<string, unknown>>,
    setCookiesCalls: 0,
    getCookiesCalls: 0,
    rejectSetCookies: false,
    getCookiesDelayMs: 0,
  };
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws) => {
    ws.on("message", async (raw) => {
      const msg = JSON.parse(raw.toString()) as {
        id: number;
        method: string;
        params?: { cookies?: Array<Record<string, unknown>> };
      };
      if (msg.method === "Storage.getCookies") {
        state.getCookiesCalls++;
        if (state.getCookiesDelayMs > 0) await sleep(state.getCookiesDelayMs);
        ws.send(JSON.stringify({ id: msg.id, result: { cookies: state.storedCookies } }));
        return;
      }
      if (msg.method === "Storage.setCookies") {
        state.setCookiesCalls++;
        if (state.rejectSetCookies) {
          ws.send(JSON.stringify({ id: msg.id, error: { code: -32000, message: "intentional: setCookies rejected" } }));
          return;
        }
        // Real Chromium merges cookies (upsert by name+domain+path). Test mocks
        // that overwrite the whole array hide the residue-marker interaction
        // and stop the profile from ever growing across sessions.
        const incoming = msg.params?.cookies ?? [];
        for (const c of incoming) {
          const key = `${c.name}|${c.domain}|${c.path ?? "/"}`;
          const existingIndex = state.storedCookies.findIndex((e) => `${e.name}|${e.domain}|${e.path ?? "/"}` === key);
          if (existingIndex >= 0) state.storedCookies[existingIndex] = c;
          else state.storedCookies.push(c);
        }
        ws.send(JSON.stringify({ id: msg.id, result: {} }));
        return;
      }
      if (msg.id !== undefined) ws.send(JSON.stringify({ id: msg.id, result: {} }));
    });
  });

  server.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws_) => wss.emit("connection", ws_, req));
  });

  server.on("request", (req: IncomingMessage, res) => {
    // No Browserserve-Version header — treated as plain external CDP.
    if (req.url === "/json/version") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        Browser: `MockCDP-${label}`,
        "Protocol-Version": "1.3",
        webSocketDebuggerUrl: `ws://localhost:${port}/devtools/browser/pipe`,
      }));
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(port);

  return {
    port,
    server,
    state,
    async close() {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function buildConfig(): string {
  return `
version: 1
gateway:
  port: ${GATEWAY_PORT}
  defaultStrategy: priority-chain
  connectionTimeout: 5000
  shutdownDrainMs: 6000
  cooldown:
    defaultMs: 100
    failureThreshold: 0.99
    minRequestVolume: 1000
providers:
  prov-a:
    url: http://localhost:${PROVIDER_PORT_A}
    limits:
      maxConcurrent: 10
    priority: 1
    profile: ${PROFILE_ID}
  prov-b:
    url: http://localhost:${PROVIDER_PORT_B}
    limits:
      maxConcurrent: 10
    priority: 2
    profile: ${PROFILE_ID}
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
  cdpTimeoutMs: 4000
  commitTimeoutMs: 1500
`;
}

let provA: MockProvider;
let provB: MockProvider;
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

async function startGateway(): Promise<void> {
  writeFileSync(CONFIG_PATH, buildConfig());
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
    setTimeout(resolve, 10_000);
  });
}

async function openProfile(): Promise<WebSocket> {
  const ws = new WebSocket(`ws://localhost:${GATEWAY_PORT}/v1/connect?profile=${PROFILE_ID}`);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("unexpected-response", (_req, res) => {
      reject(new Error(`HTTP ${res.statusCode}`));
      ws.terminate();
    });
    ws.once("error", reject);
  });
  return ws;
}

async function checkConnect(): Promise<{ ok: boolean; status?: number }> {
  try {
    const ws = await openProfile();
    ws.close();
    await new Promise((r) => setTimeout(r, 100));
    return { ok: true };
  } catch (err) {
    const m = (err as Error).message;
    const match = /HTTP (\d+)/.exec(m);
    return { ok: false, status: match ? Number(match[1]) : undefined };
  }
}

beforeAll(async () => {
  provA = createPinnedMock(PROVIDER_PORT_A, "A");
  provB = createPinnedMock(PROVIDER_PORT_B, "B");
  await startGateway();
});

afterAll(async () => {
  await stopGateway();
  await provA?.close();
  await provB?.close();
  try { unlinkSync(CONFIG_PATH); } catch {}
  try { rmSync(PROFILE_DIR, { recursive: true, force: true }); } catch {}
});

describe("D3-pinned: inject fails on provider A, gateway fails over to provider B", () => {
  it("when inject fails on the priority-1 pinned provider, the gateway retries on priority-2", async () => {
    provA.state.rejectSetCookies = false;
    provB.state.rejectSetCookies = false;
    const SEED = [{ name: "d3p", value: "seed", domain: ".t", path: "/", secure: true, httpOnly: false }];
    provA.state.storedCookies = SEED;
    provB.state.storedCookies = SEED;

    // Seed the profile blob on disk
    const ws1 = await openProfile();
    ws1.close();
    await sleep(2_000);

    const blobPath = join(PROFILE_DIR, PROFILE_ID, "data.enc");
    expect(existsSync(blobPath)).toBe(true);
    expect(readFileSync(blobPath).length).toBeGreaterThan(150);

    // Now provA rejects setCookies. Reconnect must succeed by failover to provB.
    provA.state.rejectSetCookies = true;
    provB.state.rejectSetCookies = false;

    const setCallsA_before = provA.state.setCookiesCalls;
    const setCallsB_before = provB.state.setCookiesCalls;

    const second = await checkConnect();
    expect(second.ok).toBe(true);
    await sleep(800);

    // provB MUST have received setCookies during inject (failover proof)
    expect(provB.state.setCookiesCalls).toBeGreaterThan(setCallsB_before);
    const totalAttempts = (provA.state.setCookiesCalls - setCallsA_before)
      + (provB.state.setCookiesCalls - setCallsB_before);
    expect(totalAttempts).toBeGreaterThanOrEqual(1);

    provA.state.rejectSetCookies = false;
  }, 30_000);
});

describe("D7-pinned: capture-on-close hangs past commitTimeoutMs — previous state preserved + lock released", () => {
  it("when Storage.getCookies hangs, lock releases and previous state stays", async () => {
    provA.state.rejectSetCookies = false;
    provB.state.rejectSetCookies = false;
    provA.state.getCookiesDelayMs = 0;
    provB.state.getCookiesDelayMs = 0;
    const SEED = [{ name: "d7p", value: "good", domain: ".t", path: "/", secure: true, httpOnly: false }];
    provA.state.storedCookies = SEED;
    provB.state.storedCookies = SEED;

    // Seed the profile blob on disk
    const ws1 = await openProfile();
    ws1.close();
    await sleep(1_800);

    const blobPath = join(PROFILE_DIR, PROFILE_ID, "data.enc");
    const blobBefore = readFileSync(blobPath);
    expect(blobBefore.length).toBeGreaterThan(150);

    // Hang BOTH providers' Storage.getCookies past commitTimeoutMs (1500ms).
    provA.state.getCookiesDelayMs = 5_000;
    provB.state.getCookiesDelayMs = 5_000;

    const ws2 = await openProfile();
    ws2.close();
    await sleep(3_000);

    // Previous state preserved — bytes unchanged on disk
    const blobAfter = readFileSync(blobPath);
    expect(blobAfter.equals(blobBefore)).toBe(true);

    // Lock must have been released — restoring quick capture lets reconnect succeed
    provA.state.getCookiesDelayMs = 0;
    provB.state.getCookiesDelayMs = 0;
    const third = await checkConnect();
    expect(third.ok).toBe(true);
  }, 30_000);
});
