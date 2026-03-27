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
import { loadConfig } from "./config/loader.js";
import { createApp } from "./app.js";
import { createWebSocketHandler } from "./ws/upgrade.js";

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
  console.log("browser-gateway v0.1.3");
  process.exit(0);
}

if (command === "help" || args.includes("--help") || args.includes("-h")) {
  console.log(`
browser-gateway - The Unified Interface for Headless Browsers

Usage:
  browser-gateway serve [options]    Start the gateway server
  browser-gateway check              Test connectivity to providers
  browser-gateway version            Print version
  browser-gateway help               Show this help

Options:
  --config <path>    Path to gateway.yml (default: ./gateway.yml)
  --port <number>    Override port (default: 9500)
  --no-ui            Disable the web dashboard
  -v, --version      Print version
  -h, --help         Show help

Environment:
  BG_TOKEN           Auth token for gateway access (optional)
  BG_PORT            Server port
  BG_CONFIG_PATH     Config file path

Examples:
  browser-gateway serve
  browser-gateway serve --config ./my-config.yml --port 8080
`);
  process.exit(0);
}

if (command === "serve" || !["check", "version", "help"].includes(command)) {
  startServer();
}

if (command === "check") {
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

  const server = createServer(async (req, res) => {
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

  const shutdown = () => {
    logger.info("shutting down...");
    gateway.stop();
    server.close(() => {
      logger.info("server stopped");
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000);
  };

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
