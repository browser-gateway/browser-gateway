import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { WebSocketServer } from "ws";
import { ChildProcess, spawn } from "node:child_process";
import { writeFileSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const GATEWAY_PORT = 16000;
const ECHO_PORT = 16001;
const CONFIG_PATH = "/tmp/bg-crud-test.yml";
const BASE = `http://localhost:${GATEWAY_PORT}`;
const fetchOpts: RequestInit = { credentials: "include" as const };

let echoServer: Server;
let gatewayProcess: ChildProcess;

beforeAll(async () => {
  const server = createServer();
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws) => { ws.on("message", (d) => ws.send(d)); });
  echoServer = server;
  server.listen(ECHO_PORT);

  writeFileSync(CONFIG_PATH, `
version: 1
gateway:
  port: ${GATEWAY_PORT}
providers:
  existing:
    url: ws://localhost:${ECHO_PORT}
    limits:
      maxConcurrent: 5
    priority: 1
logging:
  level: error
`);

  gatewayProcess = spawn("npx", ["tsx", "src/server/index.ts", "serve", "--config", CONFIG_PATH], {
    cwd: process.cwd(),
    stdio: "pipe",
    env: { ...process.env, BG_TOKEN: "" },
  });

  await sleep(3000);
}, 15000);

afterAll(async () => {
  gatewayProcess?.kill("SIGTERM");
  echoServer?.close();
  try { unlinkSync(CONFIG_PATH); } catch {}
  try { unlinkSync(`${CONFIG_PATH}.backup`); } catch {}
  await sleep(500);
});

describe("Provider CRUD - List", () => {
  it("should list providers", async () => {
    const res = await fetch(`${BASE}/v1/providers`);
    const data = await res.json() as any;
    expect(data.providers).toHaveLength(1);
    expect(data.providers[0].id).toBe("existing");
  });

  it("should mask secrets in provider URLs", async () => {
    const res = await fetch(`${BASE}/v1/providers`);
    const data = await res.json() as any;
    expect(data.providers[0].url).not.toContain("secret");
  });
});

describe("Provider CRUD - Add", () => {
  it("should add a new provider", async () => {
    const res = await fetch(`${BASE}/v1/providers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "new-one", url: "ws://localhost:9999", maxConcurrent: 3, priority: 2 }),
    });
    const data = await res.json() as any;
    expect(res.status).toBe(201);
    expect(data.ok).toBe(true);
  });

  it("should reject duplicate provider ID", async () => {
    const res = await fetch(`${BASE}/v1/providers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "new-one", url: "ws://localhost:8888" }),
    });
    expect(res.status).toBe(409);
  });

  it("should reject invalid provider ID", async () => {
    const res = await fetch(`${BASE}/v1/providers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "has spaces", url: "ws://localhost:8888" }),
    });
    expect(res.status).toBe(400);
  });

  it("should reject invalid URL", async () => {
    const res = await fetch(`${BASE}/v1/providers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "bad-url", url: "not-a-url" }),
    });
    expect(res.status).toBe(400);
  });

  it("should reject missing fields", async () => {
    const res = await fetch(`${BASE}/v1/providers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("should persist to YAML file", async () => {
    const content = readFileSync(CONFIG_PATH, "utf-8");
    expect(content).toContain("new-one");
  });
});

describe("Provider CRUD - Update", () => {
  it("should update a provider", async () => {
    const res = await fetch(`${BASE}/v1/providers/new-one`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxConcurrent: 20 }),
    });
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
  });

  it("should reject update for nonexistent provider", async () => {
    const res = await fetch(`${BASE}/v1/providers/nonexistent`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxConcurrent: 5 }),
    });
    expect(res.status).toBe(404);
  });
});

describe("Provider CRUD - Test Connection", () => {
  it("should test existing provider", async () => {
    const res = await fetch(`${BASE}/v1/providers/existing/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("should report failure for unreachable provider", async () => {
    const res = await fetch(`${BASE}/v1/providers/new-one/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    const data = await res.json() as any;
    expect(data.ok).toBe(false);
  });
});

describe("Provider CRUD - Delete", () => {
  it("should delete a provider", async () => {
    const res = await fetch(`${BASE}/v1/providers/new-one`, { method: "DELETE" });
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
  });

  it("should reject delete for nonexistent provider", async () => {
    const res = await fetch(`${BASE}/v1/providers/new-one`, { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("should remove from YAML file", async () => {
    const content = readFileSync(CONFIG_PATH, "utf-8");
    expect(content).not.toContain("new-one");
  });
});

describe("Config Endpoints", () => {
  it("should read config as YAML", async () => {
    const res = await fetch(`${BASE}/v1/config`);
    const data = await res.json() as any;
    expect(data.exists).toBe(true);
    expect(data.yaml).toContain("providers");
    expect(data.path).toBe(CONFIG_PATH);
  });

  it("should validate valid YAML", async () => {
    const res = await fetch(`${BASE}/v1/config/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        yaml: "version: 1\nproviders:\n  test:\n    url: ws://localhost:3000\n",
      }),
    });
    const data = await res.json() as any;
    expect(data.valid).toBe(true);
    expect(data.providerCount).toBe(1);
  });

  it("should reject invalid YAML", async () => {
    const res = await fetch(`${BASE}/v1/config/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ yaml: "providers:\n  test:\n    url: not-a-url\n" }),
    });
    const data = await res.json() as any;
    expect(data.valid).toBe(false);
    expect(data.errors).toBeDefined();
    expect(data.errors.length).toBeGreaterThan(0);
  });

  it("should reject malformed YAML", async () => {
    const res = await fetch(`${BASE}/v1/config/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ yaml: "{{invalid yaml" }),
    });
    const data = await res.json() as any;
    expect(data.valid).toBe(false);
    expect(data.errors?.[0]).toContain("YAML parse error");
  });
});
