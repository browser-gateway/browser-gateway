import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import * as chromeLauncher from "chrome-launcher";
import { CdpProtocolClient, type CdpTransport } from "../../src/core/cdp/protocol.js";
import { AgentSession, type AgentSessionOptions } from "../../src/agent-tools/index.js";

export const chromePath = ((): string | null => {
  try {
    return chromeLauncher.Launcher.getInstallations()[0] ?? null;
  } catch {
    return null;
  }
})();

export class NodeWsTransport implements CdpTransport {
  private ws: WebSocket;
  constructor(url: string) {
    this.ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
  }
  ready(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("error", reject);
    });
  }
  send(data: string): void {
    this.ws.send(data);
  }
  onMessage(cb: (data: string) => void): void {
    this.ws.on("message", (raw) => cb(String(raw)));
  }
  onClose(cb: (reason?: string) => void): void {
    this.ws.on("close", () => cb("closed"));
  }
  async close(): Promise<void> {
    this.ws.close();
  }
}

export interface RealChrome {
  baseUrl: string;
  browserWsUrl: string;
  connect(opts?: AgentSessionOptions): Promise<{ session: AgentSession; dispose: () => Promise<void> }>;
  stop(): Promise<void>;
}

/** A local headless Chrome plus an HTTP server serving `pages` by path. */
export type FixturePage = string | { body: string; headers: Record<string, string>; status?: number };

export async function startRealChrome(pages: Record<string, FixturePage>): Promise<RealChrome> {
  const server: Server = createServer((req, res) => {
    const page = pages[req.url ?? ""];
    if (page === undefined) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    const { body, headers, status } =
      typeof page === "string" ? { body: page, headers: { "content-type": "text/html" }, status: 200 } : page;
    res.writeHead(status ?? 200, headers);
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const userDataDir = await mkdtemp(join(tmpdir(), "bg-real-chrome-"));
  const launched = await chromeLauncher.launch({
    chromePath: chromePath!,
    userDataDir,
    chromeFlags: ["--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--no-first-run", "--disable-extensions", "--window-size=1280,720"],
    handleSIGINT: false,
  });
  const version = (await (await fetch(`http://127.0.0.1:${launched.port}/json/version`)).json()) as {
    webSocketDebuggerUrl: string;
  };
  return {
    baseUrl,
    browserWsUrl: version.webSocketDebuggerUrl,
    async connect(opts = {}) {
      const wire = new NodeWsTransport(version.webSocketDebuggerUrl);
      await wire.ready();
      const cdp = new CdpProtocolClient(wire);
      const session = new AgentSession(cdp, { navigationTimeoutMs: 20_000, ...opts });
      return {
        session,
        dispose: async () => {
          await session.close().catch(() => undefined);
          await cdp.close().catch(() => undefined);
        },
      };
    },
    async stop() {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
      try {
        await launched.kill();
      } catch {
        /* already gone */
      }
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}
