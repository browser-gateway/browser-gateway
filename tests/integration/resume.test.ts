import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { type ChildProcess, spawn } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { reservePort, waitForGatewayHealth } from "../helpers/harness.js";

const TMP_DIR = mkdtempSync(join(tmpdir(), "bg-resume-test-"));
const CONFIG_PATH = join(TMP_DIR, "gateway.yml");

interface ResumableProvider {
  server: Server;
  requestedUrls: string[];
  parked: Map<string, string>;
}

function createResumableProvider(port: number): ResumableProvider {
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  const requestedUrls: string[] = [];
  const parked = new Map<string, string>();

  server.on("upgrade", (req, socket, head) => {
    requestedUrls.push(req.url ?? "");
    const resume = new URL(req.url ?? "/", "http://provider").searchParams.get("resume");
    let browserId: string;
    let token: string;
    if (resume) {
      const parkedBrowser = parked.get(resume);
      if (!parkedBrowser) {
        socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      parked.delete(resume);
      browserId = parkedBrowser;
      token = resume;
    } else {
      browserId = randomUUID();
      token = randomUUID();
    }
    wss.once("headers", (headers) => headers.push(`Browserserve-Resume-Token: ${token}`));
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on("message", () => ws.send(browserId));
      ws.on("close", (code) => {
        if (code !== 1000 && code !== 1005) parked.set(token, browserId);
      });
    });
  });
  server.listen(port);
  return { server, requestedUrls, parked };
}

describe("Session resume to the same browser", () => {
  let gatewayPort = 0;
  let provider: ResumableProvider;
  let gatewayProcess: ChildProcess;

  beforeAll(async () => {
    gatewayPort = await reservePort();
    const providerPort = await reservePort();
    provider = createResumableProvider(providerPort);
    writeFileSync(CONFIG_PATH, `
version: 1
gateway:
  port: ${gatewayPort}
  connectionTimeout: 5000
  sessions:
    idleTimeoutMs: 300000
    reconnectTimeoutMs: 10000
providers:
  resumable:
    url: ws://127.0.0.1:${providerPort}/?token=provider-key
    limits:
      maxConcurrent: 2
dashboard:
  enabled: false
logging:
  level: warn
`);
    gatewayProcess = spawn("npx", ["tsx", "src/server/index.ts", "serve", "--config", CONFIG_PATH], {
      cwd: process.cwd(),
      stdio: "pipe",
      env: { ...process.env, BG_TOKEN: "" },
    });
    await waitForGatewayHealth(gatewayPort, gatewayProcess);
  }, 15000);

  afterAll(async () => {
    gatewayProcess?.kill("SIGTERM");
    provider?.server.close();
    try { rmSync(TMP_DIR, { recursive: true, force: true }); } catch {}
    await sleep(300);
  });

  function connect(params?: string): Promise<{ ws: WebSocket; headers: Record<string, string | string[] | undefined> }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${gatewayPort}/v1/connect${params ? `?${params}` : ""}`);
      let headers: Record<string, string | string[] | undefined> = {};
      ws.on("upgrade", (res) => { headers = res.headers; });
      ws.on("open", () => resolve({ ws, headers }));
      ws.on("error", reject);
      setTimeout(() => reject(new Error("connect timeout")), 5000);
    });
  }

  function browserIdOf(ws: WebSocket): Promise<string> {
    return new Promise((resolve, reject) => {
      ws.once("message", (data) => resolve(data.toString()));
      ws.send("whoami");
      setTimeout(() => reject(new Error("reply timeout")), 5000);
    });
  }

  it("reattaches to the same browser and never shows the provider token to the client", async () => {
    const first = await connect();
    expect(first.headers["x-session-resumable"]).toBe("true");
    expect(first.headers["browserserve-resume-token"]).toBeUndefined();
    const sessionId = first.headers["x-session-id"] as string;
    const browser = await browserIdOf(first.ws);
    first.ws.terminate();
    await sleep(300);

    const second = await connect(`sessionId=${sessionId}`);
    expect(second.headers["x-session-id"]).toBe(sessionId);
    expect(second.headers["x-session-resumed"]).toBe("true");
    expect(second.headers["browserserve-resume-token"]).toBeUndefined();
    expect(await browserIdOf(second.ws)).toBe(browser);
    const resumedUrl = provider.requestedUrls.at(-1) ?? "";
    expect(resumedUrl).toContain("token=provider-key");
    expect(resumedUrl).toContain("resume=");
    second.ws.close();
    await sleep(300);
  });

  it("resumes the same browser more than once", async () => {
    const first = await connect();
    const sessionId = first.headers["x-session-id"] as string;
    const browser = await browserIdOf(first.ws);
    first.ws.terminate();
    await sleep(300);
    for (let i = 0; i < 2; i += 1) {
      const next = await connect(`sessionId=${sessionId}`);
      expect(await browserIdOf(next.ws)).toBe(browser);
      next.ws.terminate();
      await sleep(300);
    }
  });

  it("starts a new session when the provider no longer holds the browser", async () => {
    const first = await connect();
    const sessionId = first.headers["x-session-id"] as string;
    const browser = await browserIdOf(first.ws);
    first.ws.terminate();
    await sleep(300);
    provider.parked.clear();

    const next = await connect(`sessionId=${sessionId}`);
    expect(next.headers["x-session-id"]).not.toBe(sessionId);
    expect(next.headers["x-session-resumed"]).toBeUndefined();
    expect(await browserIdOf(next.ws)).not.toBe(browser);
    next.ws.close();
    await sleep(300);
  });

  it("starts a session under a client-chosen key, then resumes it with the same url", async () => {
    const key = `job-${randomUUID().slice(0, 8)}`;
    const first = await connect(`sessionKey=${key}`);
    expect(first.headers["x-session-id"]).toBe(key);
    expect(first.headers["x-session-resumed"]).toBeUndefined();
    const browser = await browserIdOf(first.ws);
    first.ws.terminate();
    await sleep(300);
    const again = await connect(`sessionKey=${key}`);
    expect(again.headers["x-session-id"]).toBe(key);
    expect(again.headers["x-session-resumed"]).toBe("true");
    expect(await browserIdOf(again.ws)).toBe(browser);
    again.ws.close();
    await sleep(300);
    const fresh = await connect(`sessionKey=${key}`);
    expect(fresh.headers["x-session-id"]).toBe(key);
    expect(fresh.headers["x-session-resumed"]).toBeUndefined();
    fresh.ws.close();
    await sleep(300);
  });

  it("ignores a malformed session key and assigns its own id", async () => {
    const first = await connect("sessionKey=bad%20key");
    expect(first.headers["x-session-id"]).not.toBe("bad key");
    first.ws.close();
    await sleep(300);
  });
});
