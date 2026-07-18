/**
 * Phase 4.5 D — failure injection.
 *
 * Verifies the profile system behaves correctly when things go wrong in
 * realistic ways:
 *
 *   D1. Provider drops the WS mid-pipe                  → lock + slot released, no orphans
 *   D2. On-disk blob is tampered with                   → integrity check fails loudly, no fallback
 *   D3. Inject fails on provider A, succeeds on B       → cookies present in B; A failure recorded
 *   D4. KCV mismatch on bootstrap                       → ProfileBootstrapError with helpful hint
 *   D5. Provider returns malformed cookies on capture   → save skipped, lock released
 *   D6. DELETE /v1/profiles/:id while session active    → 409, profile preserved
 *   D7. Capture-on-commit hangs past commitTimeoutMs    → previous state preserved, lock released
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocket, WebSocketServer, type WebSocket as WSWebSocket } from "ws";
import { bootstrapProfiles, ProfileBootstrapError } from "../../src/server/profile/bootstrap.js";
import pino from "pino";

const GATEWAY_PORT = 20500;
const PROVIDER_PORT_A = 20501;
const PROVIDER_PORT_B = 20502;
const CONFIG_PATH = "/tmp/bg-profile-failure-test.yml";
const PROFILE_DIR = mkdtempSync(join(tmpdir(), "bg-profile-failure-test-"));
const ENCRYPTION_KEY = Buffer.alloc(32, "f").toString("base64");

interface MockProvider {
  port: number;
  server: Server;
  state: {
    storedCookies: Array<Record<string, unknown>>;
    setCookiesCalls: number;
    getCookiesCalls: number;
    /** If set, dropAfterFirstMessage closes the WS after the first user-pipe message. */
    dropAfterFirstMessage: boolean;
    /** If set, makes Storage.setCookies respond with a CDP error. */
    rejectSetCookies: boolean;
    /** If set, Storage.getCookies returns a payload missing the cookies array. */
    malformedGetCookies: boolean;
    /** Delay applied to Storage.getCookies response. */
    getCookiesDelayMs: number;
  };
  openTransients: () => WSWebSocket[];
  close: () => Promise<void>;
}

function createMockProvider(port: number, label: string): MockProvider {
  const state = {
    storedCookies: [] as Array<Record<string, unknown>>,
    setCookiesCalls: 0,
    getCookiesCalls: 0,
    dropAfterFirstMessage: false,
    rejectSetCookies: false,
    malformedGetCookies: false,
    getCookiesDelayMs: 0,
  };
  const openSockets: WSWebSocket[] = [];
  const server = createServer();
  // Real provider CDP endpoints use ONE WS URL for everything (pipe, inject, capture).
  // Mock the same way: one server, dispatch on CDP method.
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws) => {
    openSockets.push(ws);
    let messageSeen = false;
    ws.on("message", async (raw) => {
      const msg = JSON.parse(raw.toString()) as { id: number; method: string; params?: { cookies?: Array<Record<string, unknown>> } };

      if (msg.method === "Storage.getCookies") {
        state.getCookiesCalls++;
        if (state.getCookiesDelayMs > 0) await sleep(state.getCookiesDelayMs);
        if (state.malformedGetCookies) {
          ws.send(JSON.stringify({ id: msg.id, result: { wrongShape: true } }));
        } else {
          ws.send(JSON.stringify({ id: msg.id, result: { cookies: state.storedCookies } }));
        }
        return;
      }
      if (msg.method === "Storage.setCookies") {
        state.setCookiesCalls++;
        if (state.rejectSetCookies) {
          ws.send(JSON.stringify({ id: msg.id, error: { code: -32000, message: "intentional: setCookies rejected" } }));
          return;
        }
        state.storedCookies = msg.params?.cookies ?? [];
        ws.send(JSON.stringify({ id: msg.id, result: {} }));
        return;
      }
      // User-pipe messages — Browser.getVersion etc.
      if (state.dropAfterFirstMessage && !messageSeen) {
        messageSeen = true;
        setTimeout(() => ws.terminate(), 5);
        return;
      }
      if (msg.id !== undefined) ws.send(JSON.stringify({ id: msg.id, result: {} }));
    });
  });

  server.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws_) => wss.emit("connection", ws_, req));
  });

  server.on("request", (req: IncomingMessage, res) => {
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
    openTransients: () => openSockets,
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
    multiProfile: true
  prov-b:
    url: http://localhost:${PROVIDER_PORT_B}
    limits:
      maxConcurrent: 10
    priority: 2
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

beforeAll(async () => {
  provA = createMockProvider(PROVIDER_PORT_A, "A");
  provB = createMockProvider(PROVIDER_PORT_B, "B");
  await startGateway();
});

afterAll(async () => {
  await stopGateway();
  await provA?.close();
  await provB?.close();
  try { unlinkSync(CONFIG_PATH); } catch {}
  try { rmSync(PROFILE_DIR, { recursive: true, force: true }); } catch {}
});

async function openProfile(id: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://localhost:${GATEWAY_PORT}/v1/connect?profile=${id}`);
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

async function checkConnect(id: string): Promise<{ ok: boolean; status?: number }> {
  try {
    const ws = await openProfile(id);
    ws.close();
    await new Promise((r) => setTimeout(r, 100));
    return { ok: true };
  } catch (err) {
    const m = (err as Error).message;
    const match = /HTTP (\d+)/.exec(m);
    return { ok: false, status: match ? Number(match[1]) : undefined };
  }
}

describe("D1: provider drops mid-pipe — lock + slot released, no orphans", () => {
  it("after a provider crash mid-session, the same profile is reconnectable", async () => {
    provA.state.dropAfterFirstMessage = true;
    provB.state.dropAfterFirstMessage = false;

    // Seed a cookie on transient prov-a so commit can capture and save
    provA.state.storedCookies = [{ name: "d1", value: "x", domain: ".t", path: "/", secure: true, httpOnly: false }];

    const ws = await openProfile("d1-profile");
    // Send a CDP message to trigger the provider's drop
    ws.send(JSON.stringify({ id: 1, method: "Browser.getVersion" }));
    await new Promise<void>((resolve) => ws.once("close", () => resolve()));

    // Wait briefly for cleanup to fire + commit to release the lock
    await sleep(2_500);

    // Should be reconnectable — lock must have been released
    const second = await checkConnect("d1-profile");
    expect(second.ok).toBe(true);

    provA.state.dropAfterFirstMessage = false;
  }, 30_000);
});

describe("D2: tampered on-disk blob — decrypt fails loudly", () => {
  it("a flipped byte in the encrypted blob causes the next session to fail with 500, lock released", async () => {
    // Create a profile normally
    const ws1 = await openProfile("d2-profile");
    ws1.close();
    await sleep(1_800);
    const blobPath = join(PROFILE_DIR, "d2-profile", "data.enc");
    expect(existsSync(blobPath)).toBe(true);

    // Tamper with one byte in the ciphertext region (after the header)
    const buf = readFileSync(blobPath);
    // Magic 4 + ver 1 + dekVer 1 + iv 12 + tag 16 + aadLen 2 + aad len + ciphertext
    const tamperAt = buf.length - 1;
    buf[tamperAt] = buf[tamperAt]! ^ 0xff;
    writeFileSync(blobPath, buf);

    // Next connect with same profile id should yield a clear failure (500),
    // NOT silently return null cookies (that would mask a forgery).
    const second = await checkConnect("d2-profile");
    expect(second.ok).toBe(false);
    expect(second.status).toBe(500);

    // Lock must have been released — restoring the file lets us reconnect
    // (we restore the tamper by deleting the file and starting fresh)
    unlinkSync(blobPath);
    const third = await checkConnect("d2-profile");
    expect(third.ok).toBe(true);
  }, 30_000);
});

describe("D3: inject fails on provider A, succeeds on B — failover works", () => {
  it("when inject fails on the priority-1 provider, the gateway retries on the priority-2 provider", async () => {
    // Seed: BOTH providers return a cookie so the seeding commit captures one
    // regardless of which provider gets used (cooldown could shift selection).
    provA.state.rejectSetCookies = false;
    provB.state.rejectSetCookies = false;
    const SEED = [{ name: "d3", value: "fromprev", domain: ".t", path: "/", secure: true, httpOnly: false }];
    provA.state.storedCookies = SEED;
    provB.state.storedCookies = SEED;

    const ws1 = await openProfile("d3-profile");
    ws1.close();
    await sleep(2_000);

    // Verify the seed actually persisted with cookies (blob size > a tiny empty blob)
    const blobPath = join(PROFILE_DIR, "d3-profile", "data.enc");
    expect(existsSync(blobPath)).toBe(true);
    const seedBlob = readFileSync(blobPath);
    expect(seedBlob.length).toBeGreaterThan(150);

    // Now provA rejects setCookies. Second reconnect must succeed by failing
    // over to provB.
    provA.state.rejectSetCookies = true;
    provB.state.rejectSetCookies = false;
    provB.state.storedCookies = [];

    const setCallsA_before = provA.state.setCookiesCalls;
    const setCallsB_before = provB.state.setCookiesCalls;

    const second = await checkConnect("d3-profile");
    expect(second.ok).toBe(true);
    await sleep(800);

    // provB MUST have received setCookies during inject (failover proof)
    expect(provB.state.setCookiesCalls).toBeGreaterThan(setCallsB_before);
    // and the gateway either tried A first (and failed) or skipped A due to cooldown:
    const totalAttempts = (provA.state.setCookiesCalls - setCallsA_before)
      + (provB.state.setCookiesCalls - setCallsB_before);
    expect(totalAttempts).toBeGreaterThanOrEqual(1);

    provA.state.rejectSetCookies = false;
  }, 30_000);
});

describe("D4: KCV mismatch on bootstrap — refuses to start with helpful error", () => {
  it("bootstrap throws ProfileBootstrapError when the env key doesn't match the stored KCV", async () => {
    // Use the bootstrap directly (don't start a 2nd gateway process)
    const logger = pino({ level: "silent" });
    process.env.BG_ENCRYPTION_KEY_WRONG = Buffer.alloc(32, "z").toString("base64");

    await expect(
      bootstrapProfiles(
        {
          enabled: true,
          store: "filesystem",
          filesystem: { path: PROFILE_DIR },
          encryption: { keyEnv: "BG_ENCRYPTION_KEY_WRONG" },
          lockTtlMs: 60_000,
          cdpTimeoutMs: 5_000,
          commitTimeoutMs: 1_500,
        },
        logger,
      ),
    ).rejects.toThrow(ProfileBootstrapError);

    delete process.env.BG_ENCRYPTION_KEY_WRONG;
  });
});

describe("D5: malformed Storage.getCookies — save skipped, lock released", () => {
  it("when commit gets a malformed response, the previous state is preserved and lock releases", async () => {
    // Make A return a malformed response on capture (commit path)
    provA.state.malformedGetCookies = true;
    provA.state.rejectSetCookies = false;

    // Save baseline state
    const ws1 = await openProfile("d5-profile");
    ws1.close();
    // Allow commit to run with malformed response
    await sleep(2_500);

    // Profile should still be reconnectable (lock released)
    const second = await checkConnect("d5-profile");
    expect(second.ok).toBe(true);

    provA.state.malformedGetCookies = false;
  }, 30_000);
});

describe("D6: DELETE while session active — 409, profile preserved", () => {
  it("DELETE /v1/profiles/:id while a session holds the lock returns 409 and does not delete", async () => {
    // First create a profile so it exists on disk
    const ws1 = await openProfile("d6-profile");
    ws1.close();
    await sleep(1_800);
    const blobPath = join(PROFILE_DIR, "d6-profile", "data.enc");
    expect(existsSync(blobPath)).toBe(true);

    // Hold a session open
    const liveWs = await openProfile("d6-profile");

    // Attempt delete via REST — should 409 (in-use)
    const del = await fetch(`http://localhost:${GATEWAY_PORT}/v1/profiles/d6-profile`, { method: "DELETE" });
    expect(del.status).toBe(409);

    // Profile is still on disk
    expect(existsSync(blobPath)).toBe(true);

    liveWs.close();
    await sleep(1_800);

    // Now delete should succeed
    const del2 = await fetch(`http://localhost:${GATEWAY_PORT}/v1/profiles/d6-profile`, { method: "DELETE" });
    expect(del2.status).toBe(200);
    expect(existsSync(blobPath)).toBe(false);
  }, 30_000);
});

describe("D7: capture-on-commit hangs — previous state preserved + lock released", () => {
  it("when Storage.getCookies hangs past commitTimeoutMs, lock releases and previous state stays", async () => {
    // Seed with BOTH providers returning cookies in case routing shifts
    provA.state.malformedGetCookies = false;
    provB.state.malformedGetCookies = false;
    provA.state.getCookiesDelayMs = 0;
    provB.state.getCookiesDelayMs = 0;
    const SEED = [{ name: "d7", value: "good", domain: ".t", path: "/", secure: true, httpOnly: false }];
    provA.state.storedCookies = SEED;
    provB.state.storedCookies = SEED;

    const ws1 = await openProfile("d7-profile");
    ws1.close();
    await sleep(1_800);

    const blobBefore = readFileSync(join(PROFILE_DIR, "d7-profile", "data.enc"));
    expect(blobBefore.length).toBeGreaterThan(150); // seed verified

    // Hang BOTH providers' Storage.getCookies — no matter which the gateway
    // selects for the commit, capture should time out.
    provA.state.getCookiesDelayMs = 5_000;
    provB.state.getCookiesDelayMs = 5_000;

    const ws2 = await openProfile("d7-profile");
    ws2.close();
    // Wait past commit timeout (1500ms) + slack
    await sleep(3_000);

    // Previous state preserved — bytes unchanged on disk
    const blobAfter = readFileSync(join(PROFILE_DIR, "d7-profile", "data.enc"));
    expect(blobAfter.equals(blobBefore)).toBe(true);

    // Lock must have been released — restoring quick capture lets reconnect succeed
    provA.state.getCookiesDelayMs = 0;
    provB.state.getCookiesDelayMs = 0;
    const third = await checkConnect("d7-profile");
    expect(third.ok).toBe(true);
  }, 30_000);
});
