import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import * as chromeLauncher from "chrome-launcher";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const GATEWAY_PORT = 18100;

const PAGE_HTML = `<!doctype html><html><head><title>MCP fixture</title></head><body>
<h1>Agent checkout</h1>
<input id="code" value="old code">
<button id="apply" type="button" onclick="document.getElementById('out').textContent = 'applied ' + document.getElementById('code').value">Apply</button>
<div id="out">nothing yet</div>
<p>Order total is 42 dollars.</p>
</body></html>`;

const chromePath = (() => {
  try {
    return chromeLauncher.Launcher.getInstallations()[0] ?? null;
  } catch {
    return null;
  }
})();

function parse(result: unknown): Record<string, unknown> {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content;
  const first = content[0];
  if (first?.type === "text" && first.text) {
    try {
      return JSON.parse(first.text) as Record<string, unknown>;
    } catch {
      return { text: first.text };
    }
  }
  return { content };
}

describe.skipIf(!chromePath)("MCP over a real browser", () => {
  let httpServer: Server;
  let baseUrl: string;
  let launched: chromeLauncher.LaunchedChrome;
  let gateway: ChildProcess;
  let workDir: string;
  let client: Client;

  beforeAll(async () => {
    httpServer = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(PAGE_HTML);
    });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;

    workDir = await mkdtemp(join(tmpdir(), "bg-mcp-real-"));
    await mkdir(join(workDir, "chrome"), { recursive: true });
    launched = await chromeLauncher.launch({
      chromePath: chromePath!,
      userDataDir: join(workDir, "chrome"),
      chromeFlags: ["--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--window-size=1280,720"],
      handleSIGINT: false,
    });
    const version = (await (await fetch(`http://127.0.0.1:${launched.port}/json/version`)).json()) as {
      webSocketDebuggerUrl: string;
    };

    const configPath = join(workDir, "gateway.yml");
    await writeFile(
      configPath,
      `version: 1
gateway:
  port: ${GATEWAY_PORT}
  defaultStrategy: priority-chain
  connectionTimeout: 10000
providers:
  local-chrome:
    url: ${version.webSocketDebuggerUrl}
    priority: 1
    limits:
      maxConcurrent: 4
dashboard:
  enabled: false
logging:
  level: error
`,
    );

    const gatewayLog: string[] = [];
    gateway = spawn("node", ["dist/server/index.js", "serve", "--config", configPath], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, BG_DATA_DIR: join(workDir, "data"), BG_TOKEN: "" },
    });
    gateway.stdout?.on("data", (d: Buffer) => gatewayLog.push(String(d)));
    gateway.stderr?.on("data", (d: Buffer) => gatewayLog.push(String(d)));

    let healthy = false;
    for (let i = 0; i < 60 && !healthy; i++) {
      try {
        healthy = (await fetch(`http://127.0.0.1:${GATEWAY_PORT}/health`)).ok;
      } catch {
        /* not up yet */
      }
      if (!healthy) await sleep(500);
    }
    if (!healthy) throw new Error(`gateway did not start: ${gatewayLog.join("").slice(-2000)}`);

    client = new Client({ name: "test", version: "1" }, { capabilities: {} });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${GATEWAY_PORT}/mcp`)));
  }, 120_000);

  afterAll(async () => {
    await client?.close().catch(() => undefined);
    await sleep(100);
    gateway?.kill();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await launched?.kill();
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it("drives a real page end to end through MCP tools", async () => {
    const opened = parse(await client.callTool({ name: "browser_session", arguments: { action: "open" } }));
    expect(opened.opened).toBe(true);
    const sessionId = String(opened.sessionId);

    const navigated = parse(
      await client.callTool({ name: "browser_navigate", arguments: { url: baseUrl, sessionId } }),
    );
    expect(navigated.title).toBe("MCP fixture");
    const snapshot = String(navigated.snapshot);
    expect(snapshot).toMatch(/e\d textbox/);
    expect(snapshot).toContain("old code");

    const applyRef = snapshot
      .split("\n")
      .find((line) => line.includes('"Apply"'))!
      .split(" ")[0]!;
    const codeRef = snapshot
      .split("\n")
      .find((line) => line.includes("textbox"))!
      .split(" ")[0]!;

    const acted = parse(
      await client.callTool({
        name: "browser_act",
        arguments: {
          sessionId,
          steps: [
            { type: "fill", ref: codeRef, text: "AGENT10" },
            { type: "click", ref: applyRef },
          ],
        },
      }),
    );
    expect(acted.ok).toBe(true);
    expect(acted.stepsRun).toBe(2);
    expect((acted.session as { idleTimeoutS: number }).idleTimeoutS).toBe(300);

    const read = parse(
      await client.callTool({ name: "browser_extract", arguments: { sessionId, format: "text" } }),
    );
    expect(String(read.text)).toContain("applied AGENT10");
    expect(String(read.text)).toContain("Order total is 42 dollars");

    const closed = parse(
      await client.callTool({ name: "browser_session", arguments: { action: "close", sessionId } }),
    );
    expect(closed.closed).toBe(true);
  }, 120_000);

  it("keeps two MCP sessions apart and refuses to guess between them", async () => {
    const a = parse(await client.callTool({ name: "browser_session", arguments: { action: "open" } }));
    const b = parse(await client.callTool({ name: "browser_session", arguments: { action: "open" } }));
    try {
      const ambiguous = await client.callTool({ name: "browser_snapshot", arguments: {} });
      expect(String(parse(ambiguous).text)).toContain("2 sessions are open");

      await client.callTool({
        name: "browser_navigate",
        arguments: { url: baseUrl, sessionId: String(a.sessionId) },
      });
      const listed = parse(await client.callTool({ name: "browser_session", arguments: { action: "list" } }));
      expect((listed.sessions as unknown[]).length).toBe(2);
    } finally {
      await client.callTool({ name: "browser_session", arguments: { action: "close", sessionId: String(a.sessionId) } });
      await client.callTool({ name: "browser_session", arguments: { action: "close", sessionId: String(b.sessionId) } });
    }
  }, 120_000);

  it("reports a stale ref instead of clicking the wrong thing", async () => {
    const opened = parse(await client.callTool({ name: "browser_session", arguments: { action: "open" } }));
    const sessionId = String(opened.sessionId);
    try {
      await client.callTool({ name: "browser_navigate", arguments: { url: baseUrl, sessionId } });
      const result = parse(
        await client.callTool({
          name: "browser_act",
          arguments: { sessionId, steps: [{ type: "click", ref: "e99" }] },
        }),
      );
      expect(JSON.stringify(result)).toContain("no longer on the page");
    } finally {
      await client.callTool({ name: "browser_session", arguments: { action: "close", sessionId } });
    }
  }, 120_000);
});
