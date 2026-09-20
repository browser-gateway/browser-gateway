import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Gateway } from "../../core/index.js";
import type { Logger } from "pino";
import { McpSessionManager } from "./sessions.js";
import { registerTools } from "./tools.js";
import { agentInstructions, IDLE_DEFAULT_MS } from "../../agent-tools/index.js";

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
  return new McpSessionManager(gateway, logger);
}

export function createMcpServer(
  gateway: Gateway,
  logger: Logger,
  sessionManager?: McpSessionManager,
): {
  mcpServer: McpServer;
  sessionManager: McpSessionManager;
} {
  const mcpServer = new McpServer(
    { name: "browser-gateway", version: getVersion() },
    { instructions: agentInstructions({ idleTimeoutS: IDLE_DEFAULT_MS / 1000 }) },
  );

  const mgr = sessionManager ?? createSessionManager(gateway, logger);
  registerTools(mcpServer, gateway, mgr, logger);

  return { mcpServer, sessionManager: mgr };
}
