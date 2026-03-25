#!/usr/bin/env node

import { createServer } from "node:http";
import type { Duplex } from "node:stream";
import pino from "pino";
import { Gateway } from "../core/index.js";
import { loadConfig } from "./config/loader.js";
import { createApp } from "./app.js";
import { createWebSocketHandler } from "./ws/upgrade.js";

const args = process.argv.slice(2);
const command = args[0] ?? "serve";

if (command === "version" || args.includes("--version") || args.includes("-v")) {
  console.log("browser-gateway v0.1.0");
  process.exit(0);
}

if (command === "help" || args.includes("--help") || args.includes("-h")) {
  console.log(`
browser-gateway - The Unified Interface for Headless Browsers

Usage:
  browser-gateway serve [options]    Start the gateway server
  browser-gateway check              Test connectivity to backends
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
  BG_BACKEND_URL     Single backend URL (alternative to config file)
  BG_PORT            Server port
  BG_CONFIG_PATH     Config file path

Examples:
  browser-gateway serve
  browser-gateway serve --config ./my-config.yml --port 8080
  BG_BACKEND_URL=ws://localhost:4000 browser-gateway serve
`);
  process.exit(0);
}

if (command === "serve" || !["check", "version", "help"].includes(command)) {
  startServer();
}

if (command === "check") {
  checkBackends();
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
  const app = createApp(gateway, token);

  if (token) {
    logger.info("auth enabled - BG_TOKEN is set");
  } else {
    logger.info("auth disabled - set BG_TOKEN to enable");
  }

  const { handleUpgrade } = createWebSocketHandler(gateway, logger, token);

  const activeSockets = new Map<string, { client: Duplex; backend: Duplex }>();

  gateway.setIdleSessionHandler((sessionId) => {
    const sockets = activeSockets.get(sessionId);
    if (sockets) {
      sockets.client.destroy();
      sockets.backend.destroy();
      activeSockets.delete(sessionId);
    }
  });

  const server = createServer(async (req, res) => {
    const response = await app.fetch(
      new Request(`http://localhost${req.url}`, {
        method: req.method,
        headers: req.headers as Record<string, string>,
      })
    );

    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    const body = await response.arrayBuffer();
    res.end(Buffer.from(body));
  });

  server.on("upgrade", handleUpgrade);

  gateway.start();

  server.listen(config.gateway.port, () => {
    logger.info(
      { port: config.gateway.port, backends: gateway.registry.size() },
      `browser-gateway running on http://localhost:${config.gateway.port}`
    );
    logger.info(`WebSocket proxy at ws://localhost:${config.gateway.port}/v1/connect`);
    logger.info(`Status API at http://localhost:${config.gateway.port}/v1/status`);
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

async function checkBackends() {
  const { default: WebSocket } = await import("ws");

  let config;
  try {
    config = loadConfig(getArg("--config"));
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }

  console.log("\nBackend Connectivity Check\n");

  let allHealthy = true;

  for (const [id, backend] of Object.entries(config.backends)) {
    const start = Date.now();
    try {
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(backend.url, { handshakeTimeout: 5000 });
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

  console.log(`\n${Object.keys(config.backends).length} backend(s) checked\n`);
  process.exit(allHealthy ? 0 : 1);
}

function getArg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}
