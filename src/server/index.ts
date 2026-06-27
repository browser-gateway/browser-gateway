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
import { Gateway, SessionPool } from "../core/index.js";
import { buildMcpGatewayConfig } from "./mcp/config-defaults.js";
import { printStartupBanner } from "./startup/banner.js";
import { ReconnectRegistry } from "../core/proxy/reconnect.js";
import { WebhookNotifier } from "../core/notifications/webhooks.js";
import { loadConfig } from "./config/loader.js";
import { createApp } from "./app.js";
import { createWebSocketHandler } from "./ws/upgrade.js";
import { bootstrapProfiles, ProfileBootstrapError } from "./profile/bootstrap.js";
import { resolveEncryptionKey } from "./setup/encryption-key.js";
import { resolvePort, resolveHost } from "./setup/port.js";
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

function readPackageVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../package.json"), "utf-8"),
    );
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
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
  BG_TOKEN              Auth token for gateway access (optional)
  BG_ENCRYPTION_KEY     Profile encryption key (auto-generated if unset)
  BG_DATA_DIR           Data directory (default: /data in Docker, ~/.browser-gateway otherwise)
  BG_CONFIG_PATH        gateway.yml location (default: $BG_DATA_DIR/gateway.yml)
  BG_ALLOWED_ORIGINS    CORS allowlist (comma-separated; default: same-origin only)
  PORT                  Server port (default: 9500). 12-factor convention.
  HOST                  Bind interface (default: 0.0.0.0).
  LOG_LEVEL             debug | info | warn | error (overrides gateway.yml)
  HTTP_PROXY,
  HTTPS_PROXY,
  NO_PROXY              Honored by Node's built-in fetch for outbound calls
  TZ                    Timezone for log timestamps (Node default)

Examples:
  browser-gateway serve
  browser-gateway serve --config ./my-config.yml --port 8080
  browser-gateway mcp
  browser-gateway mcp --cdp-endpoint http://localhost:9222
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

  const resolvedPort = resolvePort(portOverride);
  if (resolvedPort !== undefined) config.gateway.port = resolvedPort;

  const logger = pino({
    // LOG_LEVEL env var (12-factor / pino convention) overrides gateway.yml.
    // Sane for ops who want temporary verbosity without editing the config.
    level: process.env.LOG_LEVEL ?? config.logging.level,
    redact: {
      // Defense in depth — anything matching these JSON paths is replaced with
      // "[REDACTED]" before serialization. None of the gateway's first-party
      // log calls log these fields today, but third-party deps and future
      // contributors might. The cost of one extra regex per log line is dwarfed
      // by the cost of a token landing in a log aggregator.
      paths: [
        "BG_TOKEN",
        "BG_ENCRYPTION_KEY",
        "token",
        "password",
        "secret",
        "apiKey",
        "api_key",
        "accessToken",
        "access_token",
        "authorization",
        "Authorization",
        "headers.authorization",
        "headers.cookie",
        "*.token",
        "*.password",
        "*.apiKey",
      ],
      remove: false,
    },
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

  const pool = new SessionPool(config.gateway.port, logger, config.pool, token);

  // Materialize the encryption key eagerly so the "Enable Profiles" toggle in
  // the dashboard is a true one-click — the key file exists from the very
  // first boot, regardless of whether profiles end up being used. The
  // resolver is idempotent on the file path so subsequent boots reuse it.
  resolveEncryptionKey(logger);

  let profileBootstrap;
  try {
    profileBootstrap = await bootstrapProfiles(config.profiles, logger);
  } catch (err) {
    // Profile bootstrap failure is non-fatal — the rest of the gateway (routing,
    // REST, dashboard, MCP) is fully functional without profiles. Surface a
    // loud error so the operator can fix the underlying problem (corrupt
    // keycheck, wrong key, unreadable store) without losing access to the
    // dashboard's config editor in the meantime.
    const detail = err instanceof ProfileBootstrapError
      ? err.message + (err.hint ? `\n  hint: ${err.hint}` : "")
      : err instanceof Error
      ? err.message
      : String(err);
    logger.error({ error: detail }, "profile bootstrap failed — gateway will continue with profiles disabled");
    profileBootstrap = { enabled: false as const };
  }

  const webDir = findWebDir();
  const app = createApp(
    gateway,
    token,
    webDir,
    logger,
    pool,
    profileBootstrap.enabled
      ? {
          store: profileBootstrap.store,
          dekByVersion: profileBootstrap.dekByVersion,
          lifecycle: profileBootstrap.lifecycle,
        }
      : undefined,
  );

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

  const reconnectRegistry = new ReconnectRegistry();
  const reconnectTtl = config.gateway.sessions?.reconnectTimeoutMs ?? 300000;
  reconnectRegistry.startCleanup(reconnectTtl);

  const { handleUpgrade } = createWebSocketHandler(
    gateway,
    logger,
    token,
    reconnectRegistry,
    profileBootstrap.enabled ? profileBootstrap.lifecycle : undefined,
  );

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
        duplex: body ? "half" : undefined,
      })
    );

    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    const responseBody = await response.arrayBuffer();
    res.end(Buffer.from(responseBody));
  });

  server.on("upgrade", handleUpgrade);

  const startTime = Date.now();
  gateway.start();

  const bindHost = resolveHost();
  server.listen(config.gateway.port, bindHost, async () => {
    // Structured single-line log for log aggregators
    logger.info(
      { port: config.gateway.port, host: bindHost, providers: gateway.registry.size() },
      `browser-gateway running on http://localhost:${config.gateway.port}`,
    );

    // Human-readable boxed banner for the TTY
    printStartupBanner({
      version: readPackageVersion(),
      port: config.gateway.port,
      hasDashboard: !!webDir,
      authEnabled: !!token,
      profilesStatus: profileBootstrap.enabled ? "enabled" : "disabled",
      providers: gateway.registry.getAllSortedByPriority(),
      readyMs: Date.now() - startTime,
      config,
    });

    await pool.start();
  });

  const shutdown = async () => {
    logger.info("shutdown signal received");

    sessionManager.stopCleanupTimer();
    sessionManager.releaseAll();
    for (const [, transport] of mcpTransports) {
      await transport.close();
    }
    mcpTransports.clear();

    await pool.shutdown();
    server.close();

    await gateway.gracefulShutdown();

    // H1 fix: wait for in-flight profile commits to persist their state before exit.
    // Bounded by gateway.shutdownDrainMs so a hung provider can't block exit forever.
    if (profileBootstrap.enabled) {
      await profileBootstrap.lifecycle.drain(config.gateway.shutdownDrainMs ?? 30_000);
    }

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
    const port = (resolvePort(portOverride) ?? 9500);
    config = buildMcpGatewayConfig(port, {
      "remote-cdp": {
        url: cdpEndpoint,
        limits: { maxConcurrent: 5 },
        priority: 1,
        weight: 1,
      },
    });
    log(`Using CDP endpoint: ${cdpEndpoint}`);
  } else {
    // Zero-config mode: defer Chrome launch until first tool call (same pattern as playwright-mcp)
    const port = (resolvePort(portOverride) ?? 9500);
    config = buildMcpGatewayConfig(port, {});
    isZeroConfig = true;
    log("Zero-config mode - Chrome will launch on first browser tool use");
  }

  const resolvedPort = resolvePort(portOverride);
  if (resolvedPort !== undefined) config.gateway.port = resolvedPort;

  const logger = pino({ level: "silent" });
  const gateway = new Gateway(config, logger);

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
  const { probeWebSocket } = await import("./ws/probe.js");

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
      await probeWebSocket(provider.url, 5000);
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
