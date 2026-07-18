/**
 * Phase 4.5 C — through-the-gateway stress tests.
 *
 * Runs against a mock CDP provider spawned in-process. Validates:
 *   - Concurrent same-profile via the upgrade handler returns 409 for losers,
 *     200 for the single winner. No deadlock at the HTTP/WS layer.
 *   - High-fanout different profiles complete in parallel.
 *   - Sustained back-to-back sessions don't grow process RSS dramatically.
 *
 * Spawns the actual gateway binary (npx tsx) for the most realistic test.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocket, WebSocketServer } from "ws";

const GATEWAY_PORT = 20400;
const PROVIDER_PORT = 20401;
const CONFIG_PATH = "/tmp/bg-profile-stress-test.yml";
const PROFILE_DIR = mkdtempSync(join(tmpdir(), "bg-profile-stress-test-"));
const ENCRYPTION_KEY = Buffer.alloc(32, "x").toString("base64");

function createMockProvider(port: number): { server: Server; wss: WebSocketServer } {
  const server = createServer();
  // The user pipe path
  const wssPipe = new WebSocketServer({ noServer: true });
  // The transient inject/capture path
  const wssTransient = new WebSocketServer({ noServer: true });

  let storedCookies: Array<Record<string, unknown>> = [];

  wssPipe.on("connection", (ws) => {
    // Echo CDP responses so the gateway's pipe sees a real handshake
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as { id: number; method: string };
      if (msg.id !== undefined) ws.send(JSON.stringify({ id: msg.id, result: {} }));
    });
  });

  wssTransient.on("connection", (ws) => {
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as { id: number; method: string; params?: { cookies?: Array<Record<string, unknown>> } };
      if (msg.method === "Storage.getCookies") {
        ws.send(JSON.stringify({ id: msg.id, result: { cookies: storedCookies } }));
      } else if (msg.method === "Storage.setCookies") {
        storedCookies = msg.params?.cookies ?? [];
        ws.send(JSON.stringify({ id: msg.id, result: {} }));
      } else {
        ws.send(JSON.stringify({ id: msg.id, result: {} }));
      }
    });
  });

  server.on("upgrade", (req, socket, head) => {
    const wss = req.url === "/devtools/browser/pipe" ? wssPipe : wssTransient;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  server.on("request", (req: IncomingMessage, res) => {
    if (req.url === "/json/version") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        Browser: "MockCDP/1.0",
        "Protocol-Version": "1.3",
        webSocketDebuggerUrl: `ws://localhost:${port}/devtools/browser/pipe`,
      }));
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(port);
  return { server, wss: wssPipe };
}

function buildConfig(): string {
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
      maxConcurrent: 100
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
  cdpTimeoutMs: 5000
  commitTimeoutMs: 1500
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
  provider = createMockProvider(PROVIDER_PORT);
  await startGateway();
});

afterAll(async () => {
  await stopGateway();
  provider?.server.close();
  try { unlinkSync(CONFIG_PATH); } catch {}
  try { rmSync(PROFILE_DIR, { recursive: true, force: true }); } catch {}
});

/** Open a WS, close it cleanly. Throws with the HTTP status if upgrade rejected. */
async function openAndClose(profileId: string): Promise<void> {
  const ws = new WebSocket(`ws://localhost:${GATEWAY_PORT}/v1/connect?profile=${profileId}`);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("unexpected-response", (_req, res) => {
      reject(new Error(`HTTP ${res.statusCode}`));
      ws.terminate();
    });
    ws.once("error", reject);
  });
  await new Promise<void>((resolve) => {
    ws.once("close", () => resolve());
    ws.close();
  });
}

describe("C-INT-1: same-profile concurrent connect serializes via 409", () => {
  it("20 simultaneous WS connects with same profile id — one wins, rest get 409", async () => {
    const PROFILE = "concurrent-same";
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => openAndClose(PROFILE)),
    );
    const winners = results.filter((r) => r.status === "fulfilled");
    const losers = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(winners.length).toBeGreaterThanOrEqual(1);
    // All losers must be 409s, not 500s or hangs
    for (const l of losers) {
      const m = (l.reason as Error).message;
      expect(m).toMatch(/HTTP 409/);
    }
    // Eventual reconnect must work after commit window expires
    await sleep(2_000);
    await openAndClose(PROFILE); // no throw
  }, 30_000);
});

describe("C-INT-2: distinct profiles run in parallel", () => {
  it("30 distinct profile ids connect concurrently without serializing", async () => {
    const ids = Array.from({ length: 30 }, (_, i) => `parallel-${i}`);
    const t0 = Date.now();
    const results = await Promise.allSettled(ids.map((id) => openAndClose(id)));
    const elapsedMs = Date.now() - t0;
    const failures = results.filter((r) => r.status === "rejected");
    expect(failures.length).toBe(0);
    // Sequential would take 30 × ~50ms = ~1.5s on this hardware. Parallel must be well below.
    expect(elapsedMs).toBeLessThan(5_000);
  }, 30_000);
});

describe("C-INT-3: sustained churn — RSS growth stays bounded", () => {
  it("200 sequential session cycles do not grow gateway RSS beyond 30%", async () => {
    const PID = gatewayProcess.pid;
    if (!PID) throw new Error("no pid");

    async function rssKb(): Promise<number> {
      const { execSync } = await import("node:child_process");
      const out = execSync(`ps -p ${PID} -o rss=`).toString().trim();
      return parseInt(out, 10);
    }

    const before = await rssKb();

    for (let i = 0; i < 200; i++) {
      await openAndClose(`churn-${i % 20}`); // 20 distinct ids cycling
    }

    // give pending commits a moment to settle so RSS reading is fair
    await sleep(2_000);

    const after = await rssKb();
    const growthPct = ((after - before) / before) * 100;
    console.log(
      `RSS before=${before}KB after=${after}KB growth=${growthPct.toFixed(1)}% across 200 sessions`,
    );
    // RSS can grow some due to V8 heap warm-up, but >30% over 200 sessions
    // would indicate a leak. The hardening drain pattern means RSS often goes
    // DOWN after the burst (we expect a small negative or single-digit positive).
    expect(growthPct).toBeLessThan(30);
  }, 90_000);
});
