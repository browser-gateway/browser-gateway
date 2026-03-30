import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { WebSocketServer } from "ws";
import { type ChildProcess, spawn } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const GATEWAY_PORT = 18000;
const PROVIDER_PORT_1 = 18001;
const PROVIDER_PORT_2 = 18002;
const CONFIG_PATH = "/tmp/bg-mcp-test.yml";

function createEchoProvider(port: number): { server: Server; wss: WebSocketServer } {
  const server = createServer();
  const wss = new WebSocketServer({ server });

  wss.on("connection", (ws) => {
    ws.on("message", (data) => {
      ws.send(data);
    });
  });

  server.listen(port);
  return { server, wss };
}

function parseMcpResult(result: { content: unknown[] }): unknown {
  const content = result.content as { type: string; text?: string }[];
  if (content[0]?.type === "text" && content[0].text) {
    try { return JSON.parse(content[0].text); } catch { return content[0].text; }
  }
  return content;
}

describe("MCP Server Integration", () => {
  let provider1: { server: Server; wss: WebSocketServer };
  let provider2: { server: Server; wss: WebSocketServer };
  let gatewayProcess: ChildProcess;

  beforeAll(async () => {
    provider1 = createEchoProvider(PROVIDER_PORT_1);
    provider2 = createEchoProvider(PROVIDER_PORT_2);

    const config = `
version: 1
gateway:
  port: ${GATEWAY_PORT}
  defaultStrategy: priority-chain
  connectionTimeout: 5000
  cooldown:
    defaultMs: 5000
    failureThreshold: 0.5
    minRequestVolume: 3
  sessions:
    idleTimeoutMs: 300000
  queue:
    maxSize: 5
    timeoutMs: 5000
providers:
  echo-1:
    url: ws://localhost:${PROVIDER_PORT_1}
    limits:
      maxConcurrent: 2
    priority: 1
  echo-2:
    url: ws://localhost:${PROVIDER_PORT_2}
    limits:
      maxConcurrent: 2
    priority: 2
dashboard:
  enabled: false
logging:
  level: warn
`;
    writeFileSync(CONFIG_PATH, config);

    const env = { ...process.env, BG_TOKEN: "" };

    gatewayProcess = spawn("npx", ["tsx", "src/server/index.ts", "serve", "--config", CONFIG_PATH], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });

    gatewayProcess.on("exit", (code) => {
      if (code && code !== 0) {
        process.stderr.write(`[GATEWAY EXIT] code=${code}\n`);
      }
    });

    await sleep(4000);
  }, 10000);

  afterAll(async () => {
    gatewayProcess?.kill("SIGTERM");
    provider1?.server.close();
    provider2?.server.close();
    try { unlinkSync(CONFIG_PATH); } catch {}
    await sleep(500);
  });

  async function createMcpClient(): Promise<Client> {
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://localhost:${GATEWAY_PORT}/mcp`),
    );
    await client.connect(transport);
    return client;
  }

  it("should list available tools", async () => {
    const client = await createMcpClient();

    const tools = await client.listTools();
    const toolNames = tools.tools.map((t) => t.name);

    expect(toolNames).toContain("browser_navigate");
    expect(toolNames).toContain("browser_snapshot");
    expect(toolNames).toContain("browser_screenshot");
    expect(toolNames).toContain("browser_set_viewport");
    expect(toolNames).toContain("browser_interact");
    expect(toolNames).toContain("browser_evaluate");
    expect(toolNames).toContain("browser_close");
    expect(toolNames).toContain("browser_status");
    expect(tools.tools.length).toBe(8);

    await client.close();
  });

  it("should get gateway status via MCP", async () => {
    const client = await createMcpClient();

    const result = await client.callTool({ name: "browser_status", arguments: {} });
    const content = parseMcpResult(result) as { providers: unknown[]; mcpSessions: number };

    expect(content.providers).toHaveLength(2);
    expect(typeof content.mcpSessions).toBe("number");

    await client.close();
  });

  it("should attempt auto-session on navigate (fails with echo provider - no real CDP)", async () => {
    const client = await createMcpClient();

    const result = await client.callTool({
      name: "browser_navigate",
      arguments: { url: "https://example.com" },
    });

    // Echo providers can't handle real CDP commands, so session creation fails
    // This verifies the tool is callable and returns a proper error
    expect(result.isError).toBe(true);

    await client.close();
  }, 15000);

  it("should handle close of unknown session", async () => {
    const client = await createMcpClient();

    const result = await client.callTool({
      name: "browser_close",
      arguments: { sessionId: "nonexistent" },
    });

    expect(result.isError).toBe(true);
    await client.close();
  });

  it("should support multiple concurrent MCP clients", async () => {
    const client1 = await createMcpClient();
    const client2 = await createMcpClient();

    const [status1, status2] = await Promise.all([
      client1.callTool({ name: "browser_status", arguments: {} }),
      client2.callTool({ name: "browser_status", arguments: {} }),
    ]);

    expect(status1.isError).toBeFalsy();
    expect(status2.isError).toBeFalsy();

    await client1.close();
    await client2.close();
  });

  it("should return error when navigate fails with echo providers", async () => {
    const client = await createMcpClient();

    // Echo providers don't speak CDP, so navigate always returns error
    const result = await client.callTool({
      name: "browser_navigate",
      arguments: { url: "https://example.com" },
    });
    expect(result.isError).toBe(true);

    await client.close();
  }, 15000);
});
