import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { WebSocketServer } from "ws";
import { ChildProcess, spawn } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const GATEWAY_PORT = 17500;
const ECHO_PORT = 17501;
const AUTH_TOKEN = "rest-test-token";
const CONFIG_PATH = "/tmp/bg-rest-test.yml";
const BASE = `http://localhost:${GATEWAY_PORT}`;

let echoServer: Server;
let gatewayProcess: ChildProcess;

beforeAll(async () => {
  const server = createServer();
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws) => {
    ws.on("message", (d) => ws.send(d));
  });
  echoServer = server;
  server.listen(ECHO_PORT);

  writeFileSync(
    CONFIG_PATH,
    `
version: 1
gateway:
  port: ${GATEWAY_PORT}
  connectionTimeout: 5000
providers:
  echo:
    url: ws://localhost:${ECHO_PORT}
    limits:
      maxConcurrent: 2
    priority: 1
logging:
  level: error
`,
  );

  gatewayProcess = spawn(
    "npx",
    ["tsx", "src/server/index.ts", "serve", "--config", CONFIG_PATH],
    {
      cwd: process.cwd(),
      stdio: "pipe",
      env: { ...process.env, BG_TOKEN: AUTH_TOKEN },
    },
  );

  await sleep(3000);
}, 15000);

afterAll(async () => {
  gatewayProcess?.kill("SIGTERM");
  echoServer?.close();
  try { unlinkSync(CONFIG_PATH); } catch {}
  await sleep(500);
});

describe("REST API - Auth", () => {
  it("should reject screenshot without token", async () => {
    const res = await fetch(`${BASE}/v1/screenshot`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com" }),
    });
    expect(res.status).toBe(401);
  });

  it("should reject content without token", async () => {
    const res = await fetch(`${BASE}/v1/content`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com" }),
    });
    expect(res.status).toBe(401);
  });

  it("should reject scrape without token", async () => {
    const res = await fetch(`${BASE}/v1/scrape`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com", formats: ["text"] }),
    });
    expect(res.status).toBe(401);
  });
});

describe("REST API - Validation", () => {
  const authHeader = { Authorization: `Bearer ${AUTH_TOKEN}` };

  it("should reject screenshot with invalid URL", async () => {
    const res = await fetch(`${BASE}/v1/screenshot`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader },
      body: JSON.stringify({ url: "not-a-url" }),
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as any;
    expect(data.success).toBe(false);
    expect(data.error).toBe("Validation error");
  });

  it("should reject screenshot with invalid format", async () => {
    const res = await fetch(`${BASE}/v1/screenshot`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader },
      body: JSON.stringify({ url: "https://example.com", format: "bmp" }),
    });
    expect(res.status).toBe(400);
  });

  it("should reject content with empty formats", async () => {
    const res = await fetch(`${BASE}/v1/content`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader },
      body: JSON.stringify({ url: "https://example.com", formats: [] }),
    });
    expect(res.status).toBe(400);
  });

  it("should reject scrape without selectors or formats", async () => {
    const res = await fetch(`${BASE}/v1/scrape`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader },
      body: JSON.stringify({ url: "https://example.com" }),
    });
    expect(res.status).toBe(400);
  });

  it("should reject content with missing URL", async () => {
    const res = await fetch(`${BASE}/v1/content`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader },
      body: JSON.stringify({ formats: ["markdown"] }),
    });
    expect(res.status).toBe(400);
  });
});

describe("REST API - Provider Connection", () => {
  const authHeader = { Authorization: `Bearer ${AUTH_TOKEN}` };

  it("should fail screenshot with non-CDP provider (echo server)", { timeout: 15000 }, async () => {
    const res = await fetch(`${BASE}/v1/screenshot`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader },
      body: JSON.stringify({
        url: "https://example.com",
        timeout: 5000,
        retries: 0,
      }),
    });
    expect([500, 503]).toContain(res.status);
    const data = (await res.json()) as any;
    expect(data.success).toBe(false);
  });

  it("should fail content with non-CDP provider (echo server)", { timeout: 15000 }, async () => {
    const res = await fetch(`${BASE}/v1/content`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader },
      body: JSON.stringify({
        url: "https://example.com",
        formats: ["text"],
        timeout: 5000,
        retries: 0,
      }),
    });
    expect([500, 503]).toContain(res.status);
    const data = (await res.json()) as any;
    expect(data.success).toBe(false);
  });

  it("should fail scrape with non-CDP provider (echo server)", { timeout: 15000 }, async () => {
    const res = await fetch(`${BASE}/v1/scrape`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader },
      body: JSON.stringify({
        url: "https://example.com",
        selectors: [{ name: "title", selector: "h1" }],
        timeout: 5000,
        retries: 0,
      }),
    });
    expect([500, 503]).toContain(res.status);
    const data = (await res.json()) as any;
    expect(data.success).toBe(false);
  });
});
