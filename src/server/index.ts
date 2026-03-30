#!/usr/bin/env node

import { createServer } from "node:http";
import type { Duplex } from "node:stream";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";

loadEnvFile();

function loadEnvFile(): void {
  const envPath = join(process.cwd(), ".env");
  if (!existsSync(envPath)) return;

  const content = readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();

    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
import { Gateway } from "../core/index.js";
import { WebhookNotifier } from "../core/notifications/webhooks.js";
import { loadConfig } from "./config/loader.js";
import { createApp } from "./app.js";
import { createWebSocketHandler } from "./ws/upgrade.js";
import { createMcpServer, createSessionManager } from "./mcp/server.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID, timingSafeEqual } from "node:crypto";

function findWebDir(): string | undefined {
  const candidates = [
    join(process.cwd(), "web", "dist"),
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "dist"),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, "index.html"))) return dir;
  }
  return undefined;
}

const args = process.argv.slice(2);
const command = args[0] ?? "serve";

if (command === "version" || args.includes("--version") || args.includes("-v")) {
  const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../package.json"), "utf-8"));
  console.log(`browser-gateway v${pkg.version}`);
  process.exit(0);
}

if (command === "help" || args.includes("--help") || args.includes("-h")) {
  console.log(`
browser-gateway - Reliable, scalable browser infrastructure for AI agents and automation

Usage:
  browser-gateway serve [options]    Start the gateway server
  browser-gateway mcp [options]      Start MCP server for AI agents (stdio)
  browser-gateway check              Test connectivity to providers
  browser-gateway version            Print version
  browser-gateway help               Show this help

Options:
  --config <path>         Path to gateway.yml (default: ./gateway.yml)
  --port <number>         Override port (default: 9500)
  --cdp-endpoint <url>    CDP WebSocket URL to connect to (mcp command)
  --headless              Run browser in headless mode (mcp command, headed by default)
  --no-ui                 Disable the web dashboard
  -v, --version           Print version
  -h, --help              Show help

Environment:
  BG_TOKEN           Auth token for gateway access (optional)
  BG_PORT            Server port
  BG_CONFIG_PATH     Config file path

Examples:
  browser-gateway serve
  browser-gateway serve --config ./my-config.yml --port 8080
  browser-gateway mcp
  browser-gateway mcp --cdp-endpoint ws://localhost:9222/devtools/browser/xxx
  browser-gateway mcp --config gateway.yml
`);
  process.exit(0);
}

if (command === "mcp") {
  startMcpStdio();
} else if (command === "serve" || !["check", "version", "help"].includes(command)) {
  startServer();
} else if (command === "check") {
  checkProviders();
}

async function startServer() {
  const configPath = getArg("--config");
  const portOverride = getArg("--port");

  let config;
  try {
    config = loadConfig(configPath);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }

  if (portOverride) {
    config.gateway.port = parseInt(portOverride, 10);
  }

  const logger = pino({
    level: config.logging.level,
    transport:
      process.stdout.isTTY
        ? { target: "pino-pretty", options: { colorize: true } }
        : undefined,
  });

  const gateway = new Gateway(config, logger);
  const token = process.env.BG_TOKEN;

  if (config.webhooks.length > 0) {
    WebhookNotifier.fromGateway(gateway, config.webhooks, logger);
    logger.info({ count: config.webhooks.length }, "webhooks configured");
  }

  const webDir = findWebDir();
  const app = createApp(gateway, token, webDir);

  if (token) {
    logger.info("auth enabled - BG_TOKEN is set");
  } else {
    logger.info("auth disabled - set BG_TOKEN to enable");
  }

  if (gateway.registry.size() === 0) {
    logger.warn("no providers configured - add providers to gateway.yml");
    logger.warn("run `browser-gateway init` to create a config file");
  }

  const sessionManager = createSessionManager(gateway, logger);
  logger.info("mcp server initialized (Streamable HTTP at /mcp)");

  const { handleUpgrade } = createWebSocketHandler(gateway, logger, token);

  const activeSockets = new Map<string, { client: Duplex; provider: Duplex }>();

  gateway.setIdleSessionHandler((sessionId) => {
    const sockets = activeSockets.get(sessionId);
    if (sockets) {
      sockets.client.destroy();
      sockets.provider.destroy();
      activeSockets.delete(sessionId);
    }
  });

  const mcpTransports = new Map<string, StreamableHTTPServerTransport>();

  const server = createServer(async (req, res) => {
    const reqUrl = new URL(req.url ?? "/", `http://localhost`);

    if (reqUrl.pathname === "/mcp") {
      if (token) {
        const reqToken =
          reqUrl.searchParams.get("token") ??
          (req.headers.authorization?.startsWith("Bearer ")
            ? req.headers.authorization.slice(7)
            : undefined);
        if (!reqToken || reqToken.length !== token.length || !timingSafeEqual(Buffer.from(reqToken), Buffer.from(token))) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }
      }

      if (req.method === "POST") {
        const sessionId = req.headers["mcp-session-id"] as string | undefined;

        if (sessionId && mcpTransports.has(sessionId)) {
          const transport = mcpTransports.get(sessionId)!;
          await transport.handleRequest(req, res);
          return;
        }

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
        });

        transport.onclose = () => {
          if (transport.sessionId) {
            mcpTransports.delete(transport.sessionId);
          }
        };

        const { mcpServer: perSessionServer } = createMcpServer(gateway, logger, sessionManager);
        await perSessionServer.connect(transport);
        await transport.handleRequest(req, res);

        if (transport.sessionId) {
          mcpTransports.set(transport.sessionId, transport);
        }
        return;
      }

      if (req.method === "GET") {
        const sessionId = req.headers["mcp-session-id"] as string | undefined;
        if (sessionId && mcpTransports.has(sessionId)) {
          await mcpTransports.get(sessionId)!.handleRequest(req, res);
          return;
        }
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid or missing session ID" }));
        return;
      }

      if (req.method === "DELETE") {
        const sessionId = req.headers["mcp-session-id"] as string | undefined;
        if (sessionId && mcpTransports.has(sessionId)) {
          const transport = mcpTransports.get(sessionId)!;
          await transport.handleRequest(req, res);
          mcpTransports.delete(sessionId);
          return;
        }
        res.writeHead(200);
        res.end();
        return;
      }

      res.writeHead(405);
      res.end();
      return;
    }

    const url = `http://localhost${req.url}`;
    const headers = req.headers as Record<string, string>;
    const method = req.method ?? "GET";

    let body: ReadableStream | null = null;
    if (method !== "GET" && method !== "HEAD") {
      body = new ReadableStream({
        start(controller) {
          req.on("data", (chunk: Buffer) => controller.enqueue(chunk));
          req.on("end", () => controller.close());
          req.on("error", (err) => controller.error(err));
        },
      });
    }

    const response = await app.fetch(
      new Request(url, {
        method,
        headers,
        body,
        // @ts-ignore - duplex required for streaming body in Node.js
        duplex: body ? "half" : undefined,
      })
    );

    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    const responseBody = await response.arrayBuffer();
    res.end(Buffer.from(responseBody));
  });

  server.on("upgrade", handleUpgrade);

  gateway.start();

  server.listen(config.gateway.port, () => {
    logger.info(
      { port: config.gateway.port, providers: gateway.registry.size() },
      `browser-gateway running on http://localhost:${config.gateway.port}`
    );
    logger.info(`WebSocket proxy at ws://localhost:${config.gateway.port}/v1/connect`);
    logger.info(`Status API at http://localhost:${config.gateway.port}/v1/status`);
    if (webDir) {
      logger.info(`Dashboard at http://localhost:${config.gateway.port}/web`);
    }
  });

  const shutdown = async () => {
    logger.info("shutdown signal received");

    sessionManager.stopCleanupTimer();
    sessionManager.releaseAll();
    for (const [, transport] of mcpTransports) {
      await transport.close();
    }
    mcpTransports.clear();

    server.close();

    await gateway.gracefulShutdown();

    logger.info("server stopped");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function startMcpStdio() {
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const configPath = getArg("--config");
  const cdpEndpoint = getArg("--cdp-endpoint");
  const portOverride = getArg("--port");

  const log = (msg: string) => process.stderr.write(msg + "\n");

  let config;
  let isZeroConfig = false;

  if (configPath) {
    try {
      config = loadConfig(configPath);
    } catch (err) {
      log(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  } else if (cdpEndpoint) {
    const port = parseInt(portOverride ?? process.env.BG_PORT ?? "9500", 10);
    config = {
      version: 1 as const,
      gateway: {
        port,
        defaultStrategy: "priority-chain" as const,
        healthCheckInterval: 30000,
        connectionTimeout: 10000,
        shutdownDrainMs: 30000,
        cooldown: { defaultMs: 30000, failureThreshold: 0.5, minRequestVolume: 3 },
        sessions: { idleTimeoutMs: 300000 },
        queue: { maxSize: 20, timeoutMs: 30000 },
      },
      providers: {
        "remote-cdp": {
          url: cdpEndpoint,
          limits: { maxConcurrent: 5 },
          priority: 1,
          weight: 1,
        },
      },
      webhooks: [] as { url: string; events?: string[] }[],
      dashboard: { enabled: false },
      logging: { level: "info" as const },
    };
    log(`Using CDP endpoint: ${cdpEndpoint}`);
  } else {
    // Zero-config mode: defer Chrome launch until first tool call (same pattern as playwright-mcp)
    const port = parseInt(portOverride ?? process.env.BG_PORT ?? "9500", 10);
    config = {
      version: 1 as const,
      gateway: {
        port,
        defaultStrategy: "priority-chain" as const,
        healthCheckInterval: 30000,
        connectionTimeout: 10000,
        shutdownDrainMs: 30000,
        cooldown: { defaultMs: 30000, failureThreshold: 0.5, minRequestVolume: 3 },
        sessions: { idleTimeoutMs: 300000 },
        queue: { maxSize: 20, timeoutMs: 30000 },
      },
      providers: {} as Record<string, { url: string; limits: { maxConcurrent: number }; priority: number; weight: number }>,
      webhooks: [] as { url: string; events?: string[] }[],
      dashboard: { enabled: false },
      logging: { level: "info" as const },
    };
    isZeroConfig = true;
    log("Zero-config mode - Chrome will launch on first browser tool use");
  }

  if (portOverride) {
    config.gateway.port = parseInt(portOverride, 10);
  }

  const logger = pino({ level: "silent" });
  const gateway = new Gateway(config, logger);
  const token = process.env.BG_TOKEN;

  const { mcpServer, sessionManager } = createMcpServer(gateway, logger);

  if (isZeroConfig) {
    sessionManager.setLazyProviderSetup(async () => {
      const { setupLocalChrome } = await import("./mcp/local-chrome.js");
      const headless = args.includes("--headless");
      const chromeConfig = await setupLocalChrome(log, { headless });

      for (const [id, provider] of Object.entries(chromeConfig.providers)) {
        gateway.registry.register(id, provider);
      }
    });
  }

  gateway.start();
  log("MCP server ready on stdio");

  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);

  let isShuttingDown = false;
  const shutdown = async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    setTimeout(() => process.exit(0), 15000);
    sessionManager.stopCleanupTimer();
    sessionManager.releaseAll();
    const { killLocalChrome } = await import("./mcp/local-chrome.js");
    await killLocalChrome();
    await gateway.gracefulShutdown();
    process.exit(0);
  };

  process.stdin.on("close", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function checkProviders() {
  const { default: WebSocket } = await import("ws");

  let config;
  try {
    config = loadConfig(getArg("--config"));
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }

  console.log("\nProvider Connectivity Check\n");

  let allHealthy = true;

  for (const [id, provider] of Object.entries(config.providers)) {
    const start = Date.now();
    try {
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(provider.url, { handshakeTimeout: 5000 });
        ws.on("open", () => {
          ws.close();
          resolve();
        });
        ws.on("error", reject);
        setTimeout(() => {
          ws.close();
          reject(new Error("timeout"));
        }, 5000);
      });

      const latency = Date.now() - start;
      console.log(`  ${id.padEnd(25)} OK    ${latency}ms`);
    } catch (err) {
      allHealthy = false;
      const error = err instanceof Error ? err.message : String(err);
      console.log(`  ${id.padEnd(25)} FAIL  ${error}`);
    }
  }

  console.log(`\n${Object.keys(config.providers).length} provider(s) checked\n`);
  process.exit(allHealthy ? 0 : 1);
}

function getArg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}
