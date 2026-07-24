/**
 * Phase 3 integration test: wire ?profile= into the WebSocket upgrade handler.
 *
 * Spawns the gateway as a child process with profiles enabled, plus a CDP-aware
 * mock provider that responds to Storage.getCookies / Storage.setCookies.
 *
 * Verifies the full round-trip:
 *  - Connect with ?profile=p1 against a provider that already has a cookie
 *  - Disconnect → gateway captures the cookie + saves it
 *  - Connect with the same profile against a fresh provider
 *  - Gateway injects the cookie before the user's pipe is established
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocket, WebSocketServer } from "ws";

const GATEWAY_PORT = 20100;
const PROVIDER_PORT = 20101;
const CONFIG_PATH = "/tmp/bg-profile-lifecycle-test.yml";
const PROFILE_DIR = mkdtempSync(join(tmpdir(), "bg-profile-lifecycle-test-"));
const ENCRYPTION_KEY = Buffer.alloc(32, "a").toString("base64");

interface MockCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
}

interface MockCdpProvider {
  server: Server;
  wss: WebSocketServer;
  cookies: MockCookie[];
  getCookiesCalls: number;
  setCookiesCalls: Array<MockCookie[]>;
  resetCallLog: () => void;
}

function createMockCdpProvider(port: number): MockCdpProvider {
  const server = createServer();
  const wss = new WebSocketServer({ server, path: "/devtools/browser/test" });

  const state: MockCdpProvider = {
    server,
    wss,
    cookies: [],
    getCookiesCalls: 0,
    setCookiesCalls: [],
    resetCallLog: () => {
      state.getCookiesCalls = 0;
      state.setCookiesCalls = [];
    },
  };

  wss.on("connection", (ws: WebSocket) => {
    ws.on("message", (raw) => {
      let msg: { id?: number; method?: string; params?: unknown };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.method === "Storage.getCookies") {
        state.getCookiesCalls += 1;
        ws.send(JSON.stringify({ id: msg.id, result: { cookies: state.cookies } }));
        return;
      }

      if (msg.method === "Storage.setCookies") {
        const cookies = ((msg.params as { cookies?: MockCookie[] })?.cookies ?? []) as MockCookie[];
        state.setCookiesCalls.push(cookies);
        state.cookies = cookies;
        ws.send(JSON.stringify({ id: msg.id, result: {} }));
        return;
      }

      // Anything else: respond with empty success so client pipes don't hang
      if (msg.id !== undefined) {
        ws.send(JSON.stringify({ id: msg.id, result: {} }));
      }
    });
  });

  // Serve /json/version for cdp auto-discovery
  server.on("request", (req: IncomingMessage, res) => {
    if (req.url === "/json/version") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          Browser: "MockCDP/1.0",
          "Protocol-Version": "1.3",
          webSocketDebuggerUrl: `ws://localhost:${port}/devtools/browser/test`,
        }),
      );
      return;
    }
    res.writeHead(404).end();
  });

  server.listen(port);
  return state;
}

function buildConfig(): string {
  return `
version: 1
gateway:
  port: ${GATEWAY_PORT}
  defaultStrategy: priority-chain
  connectionTimeout: 5000
providers:
  mock-cdp:
    url: http://localhost:${PROVIDER_PORT}
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
  cdpTimeoutMs: 5000
`;
}

async function connectGateway(profile?: string): Promise<WebSocket> {
  const query = profile ? `?profile=${encodeURIComponent(profile)}` : "";
  const ws = new WebSocket(`ws://localhost:${GATEWAY_PORT}/v1/connect${query}`);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  return ws;
}

async function expectConnectFails(profile: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `ws://localhost:${GATEWAY_PORT}/v1/connect?profile=${encodeURIComponent(profile)}`,
    );
    ws.once("open", () => {
      ws.close();
      reject(new Error("expected connect to fail but it opened"));
    });
    ws.once("unexpected-response", (_req, res) => {
      let body = "";
      res.on("data", (c) => (body += c.toString()));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    ws.once("error", (err) => {
      // websocket errors out when there's a non-101 response; that's fine.
      // Some node versions emit error AND unexpected-response. Wait briefly to see both.
      setTimeout(() => reject(err), 500);
    });
  });
}

let provider: MockCdpProvider;
let gatewayProcess: ChildProcess;

beforeAll(async () => {
  provider = createMockCdpProvider(PROVIDER_PORT);
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

  // Wait for gateway to start
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://localhost:${GATEWAY_PORT}/health`);
      if (r.ok) break;
    } catch {}
    await sleep(250);
  }
}, 20_000);

afterAll(async () => {
  gatewayProcess?.kill("SIGTERM");
  await sleep(500);
  provider?.server.close();
  try { unlinkSync(CONFIG_PATH); } catch {}
  try { rmSync(PROFILE_DIR, { recursive: true, force: true }); } catch {}
});

describe("Phase 3: ?profile= lifecycle wiring", () => {
  it("first connect with new profile id captures cookies on disconnect", async () => {
    provider.cookies = [
      { name: "session", value: "alice", domain: ".example.com", path: "/", secure: true, httpOnly: true },
    ];
    provider.resetCallLog();

    const ws = await connectGateway("acme-first");
    await sleep(200);
    ws.close();

    // Give the gateway a beat to commit
    await sleep(800);

    expect(provider.getCookiesCalls).toBeGreaterThanOrEqual(1);
  }, 15_000);

  it("second connect with same profile id injects the captured cookie", async () => {
    // Clear the provider — simulates a fresh browser
    provider.cookies = [];
    provider.resetCallLog();

    const ws = await connectGateway("acme-first");
    await sleep(200);
    ws.close();
    await sleep(800);

    expect(provider.setCookiesCalls.length).toBeGreaterThanOrEqual(1);
    const injected = provider.setCookiesCalls[0]!;
    expect(injected.find((c) => c.name === "session")?.value).toBe("alice");
  }, 15_000);

  it("rejects ?profile= with invalid characters", async () => {
    const res = await expectConnectFails("..weird/id").catch((e) => e as Error);
    if (res instanceof Error) {
      // Some node versions emit only error
      expect(res.message).toMatch(/4\d\d|invalid|unexpected/i);
    } else {
      expect(res.status).toBe(400);
    }
  }, 15_000);

  it("serializes concurrent same-profile connections: the second waits for the lock, then succeeds", async () => {
    provider.cookies = [];
    provider.resetCallLog();

    const ws1 = await connectGateway("acme-locked");

    // A second connect while the first holds the lock must WAIT (bounded), not
    // fail fast with 409 and not run concurrently.
    let settled: "pending" | "open" | "error" = "pending";
    const secondConnect = connectGateway("acme-locked").then(
      (ws) => {
        settled = "open";
        return ws;
      },
      (err: unknown) => {
        settled = "error";
        throw err;
      },
    );

    await sleep(2_000);
    expect(settled).toBe("pending");

    // Release the holder; the waiter should acquire the freed lock and connect.
    ws1.close();
    const ws2 = await secondConnect;
    expect(settled).toBe("open");
    ws2.close();
    await sleep(500);
  }, 20_000);
});
