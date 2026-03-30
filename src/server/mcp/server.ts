import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Gateway } from "../../core/index.js";
import type { Logger } from "pino";
import { McpSessionManager } from "./sessions.js";
import { registerTools } from "./tools.js";

function getVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../package.json"), "utf-8"),
    );
    return pkg.version;
  } catch {
    return "0.0.0";
  }
}

export function createSessionManager(
  gateway: Gateway,
  logger: Logger,
): McpSessionManager {
  const sessionManager = new McpSessionManager(gateway, logger);
  sessionManager.startCleanupTimer(300000);
  return sessionManager;
}

export function createMcpServer(
  gateway: Gateway,
  logger: Logger,
  sessionManager?: McpSessionManager,
): {
  mcpServer: McpServer;
  sessionManager: McpSessionManager;
} {
  const mcpServer = new McpServer({
    name: "browser-gateway",
    version: getVersion(),
  });

  const mgr = sessionManager ?? createSessionManager(gateway, logger);
  registerTools(mcpServer, gateway, mgr, logger);

  return { mcpServer, sessionManager: mgr };
}
