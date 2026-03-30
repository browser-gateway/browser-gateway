import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { WebSocketServer } from "ws";
import pino from "pino";
import { Gateway } from "../../src/core/gateway.js";
import { McpSessionManager } from "../../src/server/mcp/sessions.js";

const silentLogger = pino({ level: "silent" });
const ECHO_PORT = 19001;

let echoServer: Server;

beforeAll(async () => {
  echoServer = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost`);
    if (url.pathname === "/json") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify([{
        type: "page",
        webSocketDebuggerUrl: `ws://localhost:${ECHO_PORT}/devtools/page/test`,
      }]));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const wss = new WebSocketServer({ server: echoServer });
  wss.on("connection", (ws) => {
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.id !== undefined) {
          ws.send(JSON.stringify({ id: msg.id, result: {} }));
        }
      } catch {
        ws.send(data);
      }
    });
  });
  await new Promise<void>((resolve) => echoServer.listen(ECHO_PORT, resolve));
});

afterAll(() => {
  echoServer.close();
});

function createTestConfig() {
  return {
    version: 1 as const,
    gateway: {
      port: 9500,
      defaultStrategy: "priority-chain" as const,
      healthCheckInterval: 30000,
      connectionTimeout: 5000,
      shutdownDrainMs: 30000,
      cooldown: { defaultMs: 5000, failureThreshold: 0.5, minRequestVolume: 3 },
      sessions: { idleTimeoutMs: 300000 },
      queue: { maxSize: 10, timeoutMs: 2000 },
    },
    providers: {
      "echo-1": {
        url: `ws://localhost:${ECHO_PORT}`,
        priority: 1,
        limits: { maxConcurrent: 2 },
      },
    } as Record<string, { url: string; priority: number; limits: { maxConcurrent: number }; weight?: number }>,
    webhooks: [] as { url: string; events?: string[] }[],
    dashboard: { enabled: false },
    logging: { level: "silent" as const },
  };
}

describe("McpSessionManager", () => {
  let gateway: Gateway;
  let manager: McpSessionManager;

  beforeEach(() => {
    gateway = new Gateway(createTestConfig(), silentLogger);
    manager = new McpSessionManager(gateway, silentLogger);
  });

  afterEach(() => {
    manager.releaseAll();
    manager.stopCleanupTimer();
  });

  describe("createSession", () => {
    it("should create a session with CDP connection", async () => {
      const session = await manager.createSession();

      expect(session).not.toBeNull();
      expect(session!.sessionId).toBeTruthy();
      expect(session!.providerId).toBe("echo-1");
      expect(session!.cdp.connected).toBe(true);
    });

    it("should acquire concurrency slot", async () => {
      await manager.createSession();
      expect(gateway.registry.get("echo-1")!.active).toBe(1);
    });

    it("should create multiple concurrent sessions", async () => {
      const s1 = await manager.createSession();
      const s2 = await manager.createSession();

      expect(s1).not.toBeNull();
      expect(s2).not.toBeNull();
      expect(s1!.sessionId).not.toBe(s2!.sessionId);
      expect(manager.count()).toBe(2);
    });

    it("should return null when at capacity", async () => {
      await manager.createSession();
      await manager.createSession();
      const s3 = await manager.createSession({ timeout: 500 });

      expect(s3).toBeNull();
    });
  });

  describe("releaseSession", () => {
    it("should release session and close CDP", async () => {
      const session = await manager.createSession();
      const result = manager.releaseSession(session!.sessionId);

      expect(result.success).toBe(true);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(session!.cdp.connected).toBe(false);
      expect(gateway.registry.get("echo-1")!.active).toBe(0);
    });

    it("should return failure for unknown session", () => {
      expect(manager.releaseSession("nonexistent").success).toBe(false);
    });
  });

  describe("getFirstSession", () => {
    it("should return first session for auto-session pattern", async () => {
      const s1 = await manager.createSession();
      await manager.createSession();

      const first = manager.getFirstSession();
      expect(first!.sessionId).toBe(s1!.sessionId);
    });

    it("should return undefined when no sessions", () => {
      expect(manager.getFirstSession()).toBeUndefined();
    });
  });

  describe("releaseAll", () => {
    it("should release all sessions and close all CDP connections", async () => {
      const s1 = await manager.createSession();
      const s2 = await manager.createSession();
      manager.releaseAll();

      expect(manager.count()).toBe(0);
      expect(s1!.cdp.connected).toBe(false);
      expect(s2!.cdp.connected).toBe(false);
      expect(gateway.registry.get("echo-1")!.active).toBe(0);
    });
  });
});
