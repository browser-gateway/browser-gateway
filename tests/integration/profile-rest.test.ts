/**
 * Phase 4 integration: REST API for profile management.
 *
 * Spawns the gateway with profiles enabled + a CDP-aware mock provider, drives
 * a brief WS session to write a profile, then exercises every REST endpoint:
 * list, get, delete, export, import.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocket, WebSocketServer } from "ws";

const GATEWAY_PORT = 20200;
const PROVIDER_PORT = 20201;
const TOKEN = "phase4-secret-token";
const CONFIG_PATH = "/tmp/bg-profile-rest-test.yml";
const PROFILE_DIR = mkdtempSync(join(tmpdir(), "bg-profile-rest-test-"));
const ENCRYPTION_KEY = Buffer.alloc(32, "r").toString("base64");

interface MockProvider {
  server: Server;
  wss: WebSocketServer;
  cookies: Array<Record<string, unknown>>;
  setCookies: (cookies: Array<Record<string, unknown>>) => void;
}

function createMockProvider(port: number): MockProvider {
  const server = createServer();
  const wss = new WebSocketServer({ server, path: "/devtools/browser/test" });
  const state: MockProvider = {
    server,
    wss,
    cookies: [],
    setCookies(cs) { state.cookies = cs; },
  };

  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      let msg: { id?: number; method?: string; params?: { cookies?: Array<Record<string, unknown>> } };
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.method === "Storage.getCookies") {
        ws.send(JSON.stringify({ id: msg.id, result: { cookies: state.cookies } }));
        return;
      }
      if (msg.method === "Storage.setCookies") {
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

const authHeaders = { authorization: `Bearer ${TOKEN}` };

async function getJson(path: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  const r = await fetch(`http://localhost:${GATEWAY_PORT}${path}`, init);
  const body = (await r.json()) as unknown;
  return { status: r.status, body };
}

async function getBinary(path: string, init: RequestInit = {}): Promise<{ status: number; bytes: Buffer; contentType: string | null; disposition: string | null }> {
  const r = await fetch(`http://localhost:${GATEWAY_PORT}${path}`, init);
  const bytes = Buffer.from(await r.arrayBuffer());
  return {
    status: r.status,
    bytes,
    contentType: r.headers.get("content-type"),
    disposition: r.headers.get("content-disposition"),
  };
}

async function writeProfileViaWs(profileId: string): Promise<void> {
  const ws = new WebSocket(
    `ws://localhost:${GATEWAY_PORT}/v1/connect?profile=${encodeURIComponent(profileId)}&token=${TOKEN}`,
  );
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  ws.close();
  // wait for gateway to commit
  await sleep(800);
}

let provider: MockProvider;
let gatewayProcess: ChildProcess;

beforeAll(async () => {
  provider = createMockProvider(PROVIDER_PORT);
  writeFileSync(CONFIG_PATH, buildConfig());

  gatewayProcess = spawn(
    "npx",
    ["tsx", "src/server/index.ts", "serve", "--config", CONFIG_PATH],
    {
      cwd: process.cwd(),
      stdio: "pipe",
      env: { ...process.env, BG_TOKEN: TOKEN, BG_ENCRYPTION_KEY: ENCRYPTION_KEY },
    },
  );

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

describe("Phase 4: profile REST API", () => {
  it("auth: returns 401 without token", async () => {
    const r = await getJson("/v1/profiles");
    expect(r.status).toBe(401);
  });

  it("list: returns empty array when no profiles", async () => {
    const r = await getJson("/v1/profiles", { headers: authHeaders });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ enabled: true, count: 0, profiles: [] });
  });

  it("create: explicit POST writes an empty profile so it appears in the list immediately", async () => {
    const r = await getJson("/v1/profiles/create", {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ id: "explicit-create" }),
    });
    expect(r.status).toBe(201);
    expect((r.body as { id?: string }).id).toBe("explicit-create");

    const list = await getJson("/v1/profiles", { headers: authHeaders });
    const items = (list.body as { profiles: { id: string }[] }).profiles;
    expect(items.find((p) => p.id === "explicit-create")).toBeTruthy();

    // Clean up so downstream tests start clean.
    await getJson("/v1/profiles/explicit-create", { method: "DELETE", headers: authHeaders });
  });

  it("create: rejects invalid id and duplicate id", async () => {
    const bad = await getJson("/v1/profiles/create", {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ id: "-leading-dash" }),
    });
    expect(bad.status).toBe(400);

    await getJson("/v1/profiles/create", {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ id: "dup-test" }),
    });
    const dup = await getJson("/v1/profiles/create", {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ id: "dup-test" }),
    });
    expect(dup.status).toBe(409);

    await getJson("/v1/profiles/dup-test", { method: "DELETE", headers: authHeaders });
  });

  it("auth/info: returns the configured BG_TOKEN to authenticated callers", async () => {
    const r = await getJson("/v1/auth/info", { headers: authHeaders });
    expect(r.status).toBe(200);
    expect((r.body as { token: string }).token).toBe(TOKEN);
    expect((r.body as { authEnabled: boolean }).authEnabled).toBe(true);
  });

  it("creates a profile via WS session, then lists it", async () => {
    provider.setCookies([
      { name: "rest-test", value: "v1", domain: ".example.com", path: "/", secure: true, httpOnly: true },
    ]);
    await writeProfileViaWs("rest-alpha");

    const r = await getJson("/v1/profiles", { headers: authHeaders });
    expect(r.status).toBe(200);
    const body = r.body as { count: number; profiles: Array<{ id: string; sizeBytes: number; dekVersion: number }> };
    expect(body.count).toBe(1);
    expect(body.profiles[0]!.id).toBe("rest-alpha");
    expect(body.profiles[0]!.sizeBytes).toBeGreaterThan(0);
    expect(body.profiles[0]!.dekVersion).toBe(1);
  });

  it("get single: returns metadata for one profile", async () => {
    const r = await getJson("/v1/profiles/rest-alpha", { headers: authHeaders });
    expect(r.status).toBe(200);
    const body = r.body as { id: string; sizeBytes: number };
    expect(body.id).toBe("rest-alpha");
    expect(body.sizeBytes).toBeGreaterThan(0);
  });

  it("get single: 404 for missing", async () => {
    const r = await getJson("/v1/profiles/does-not-exist", { headers: authHeaders });
    expect(r.status).toBe(404);
  });

  it("get single: 400 for invalid id", async () => {
    const r = await getJson("/v1/profiles/.hidden", { headers: authHeaders });
    expect(r.status).toBe(400);
  });

  it("export: returns binary blob with the right content-type and disposition", async () => {
    const r = await getBinary("/v1/profiles/rest-alpha/export", { headers: authHeaders });
    expect(r.status).toBe(200);
    expect(r.contentType).toBe("application/octet-stream");
    expect(r.disposition).toContain('filename="rest-alpha.bgp"');
    expect(r.bytes.length).toBeGreaterThan(40);
    expect(r.bytes.subarray(0, 4).toString()).toBe("BGP1");
  });

  it("export: 404 for missing", async () => {
    const r = await getBinary("/v1/profiles/missing/export", { headers: authHeaders });
    expect(r.status).toBe(404);
  });

  it("export → delete → import round-trip restores the profile", async () => {
    // 1. Export
    const exported = await getBinary("/v1/profiles/rest-alpha/export", { headers: authHeaders });
    expect(exported.status).toBe(200);
    const blob = exported.bytes;

    // 2. Delete
    const del = await fetch(`http://localhost:${GATEWAY_PORT}/v1/profiles/rest-alpha`, {
      method: "DELETE",
      headers: authHeaders,
    });
    expect(del.status).toBe(200);

    // confirm gone
    const after = await getJson("/v1/profiles", { headers: authHeaders });
    expect((after.body as { count: number }).count).toBe(0);

    // 3. Import the saved blob back
    const imp = await fetch(`http://localhost:${GATEWAY_PORT}/v1/profiles/import`, {
      method: "POST",
      headers: { ...authHeaders, "content-type": "application/octet-stream" },
      body: new Uint8Array(blob),
    });
    expect(imp.status).toBe(200);
    const impBody = (await imp.json()) as { imported: string; bytes: number };
    expect(impBody.imported).toBe("rest-alpha");
    expect(impBody.bytes).toBe(blob.length);

    // confirm restored
    const restored = await getJson("/v1/profiles/rest-alpha", { headers: authHeaders });
    expect(restored.status).toBe(200);
    expect((restored.body as { id: string }).id).toBe("rest-alpha");
  });

  it("import: rejects empty body", async () => {
    const r = await fetch(`http://localhost:${GATEWAY_PORT}/v1/profiles/import`, {
      method: "POST",
      headers: { ...authHeaders, "content-type": "application/octet-stream" },
      body: new Uint8Array(0),
    });
    expect(r.status).toBe(400);
  });

  it("import: rejects bytes with wrong magic", async () => {
    const r = await fetch(`http://localhost:${GATEWAY_PORT}/v1/profiles/import`, {
      method: "POST",
      headers: { ...authHeaders, "content-type": "application/octet-stream" },
      body: new Uint8Array(Buffer.alloc(64, 0xff)),
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toMatch(/magic|invalid/i);
  });

  it("delete: 400 for invalid id", async () => {
    const r = await fetch(`http://localhost:${GATEWAY_PORT}/v1/profiles/..weird`, {
      method: "DELETE",
      headers: authHeaders,
    });
    expect(r.status).toBe(400);
  });
});
