import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server, type IncomingMessage } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { NodeTcpPipeTransport } from "../../src/server/transport/node.js";
import { resolveProviderOutbound } from "../../src/core/transport.js";
import { setTimeout as sleep } from "node:timers/promises";

interface CapturedUpgrade {
  headers: Record<string, string | string[] | undefined>;
  url: string;
}

async function startEchoServer(port: number): Promise<{
  server: Server;
  captured: CapturedUpgrade[];
  close: () => Promise<void>;
}> {
  const captured: CapturedUpgrade[] = [];
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req: IncomingMessage, socket, head) => {
    captured.push({ headers: { ...req.headers }, url: req.url ?? "" });
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on("message", (data) => ws.send(data));
    });
  });
  await new Promise<void>((resolve) => server.listen(port, resolve));
  return {
    server,
    captured,
    close: () =>
      new Promise((resolve) => {
        wss.close();
        server.close(() => resolve());
      }),
  };
}

const UPSTREAM_PORT = 15040;

describe("NodeTcpPipeTransport header forwarding (Gaps 1 + 2)", () => {
  let echo: Awaited<ReturnType<typeof startEchoServer>>;

  beforeAll(async () => {
    echo = await startEchoServer(UPSTREAM_PORT);
  });

  afterAll(async () => {
    await echo.close();
  });

  async function driveUpgrade(
    upstreamUrl: string,
    upstreamHeaders: Record<string, string>,
    clientHeaders: Record<string, string> = {},
  ): Promise<CapturedUpgrade> {
    const capturedBefore = echo.captured.length;
    const transport = new NodeTcpPipeTransport();
    const client = await new Promise<WebSocket>((resolve) => {
      const clientServer = createServer();
      const clientWss = new WebSocketServer({ noServer: true });
      clientServer.on("upgrade", async (req, socket, head) => {
        const clientPromise = new Promise<WebSocket>((r) => {
          clientWss.handleUpgrade(req, socket as never, head, (ws) => r(ws));
        });
        await transport.relay({
          client: socket,
          clientMeta: { req, head },
          upstreamUrl,
          upstreamHeaders,
        });
        clientServer.close();
        resolve(await clientPromise);
      });
      clientServer.listen(0, () => {
        const port = (clientServer.address() as { port: number }).port;
        const ws = new WebSocket(`ws://localhost:${port}/`, {
          headers: clientHeaders,
        });
        ws.on("open", () => ws.close());
      });
    });
    client.close();
    for (let i = 0; i < 50 && echo.captured.length === capturedBefore; i++) {
      await sleep(20);
    }
    return echo.captured[echo.captured.length - 1]!;
  }

  it("forwards Authorization header from upstreamHeaders (Gap 1)", async () => {
    const cap = await driveUpgrade(`ws://localhost:${UPSTREAM_PORT}/`, {
      Authorization: "Bearer provider-token",
    });
    expect(cap.headers["authorization"]).toBe("Bearer provider-token");
  });

  it("forwards X-API-Key from upstreamHeaders", async () => {
    const cap = await driveUpgrade(`ws://localhost:${UPSTREAM_PORT}/`, {
      "X-API-Key": "provider-secret",
    });
    expect(cap.headers["x-api-key"]).toBe("provider-secret");
  });

  it("upstreamHeaders override client-forwarded headers of same name", async () => {
    const cap = await driveUpgrade(
      `ws://localhost:${UPSTREAM_PORT}/`,
      { Authorization: "Bearer wins" },
      { Authorization: "Bearer loses" },
    );
    expect(cap.headers["authorization"]).toBe("Bearer wins");
  });

  it("forwards client Authorization when no override present (removed strip in Gap 1)", async () => {
    const cap = await driveUpgrade(
      `ws://localhost:${UPSTREAM_PORT}/`,
      {},
      { Authorization: "Bearer client-only" },
    );
    expect(cap.headers["authorization"]).toBe("Bearer client-only");
  });

  it("resolveProviderOutbound + transport together produce Basic from URL userinfo (Gap 2)", async () => {
    const outbound = resolveProviderOutbound(
      `ws://alice:secret@localhost:${UPSTREAM_PORT}/path`,
    );
    expect(outbound.upstreamUrl).toBe(`ws://localhost:${UPSTREAM_PORT}/path`);
    const cap = await driveUpgrade(outbound.upstreamUrl, outbound.upstreamHeaders);
    expect(cap.headers["authorization"]).toBe(`Basic ${globalThis.btoa("alice:secret")}`);
    expect(cap.url).toBe("/path");
  });

  it("no headers + no userinfo: no Authorization sent (regression check for I6)", async () => {
    const cap = await driveUpgrade(`ws://localhost:${UPSTREAM_PORT}/`, {});
    expect(cap.headers["authorization"]).toBeUndefined();
  });

  it("preserves other client headers unchanged", async () => {
    const cap = await driveUpgrade(
      `ws://localhost:${UPSTREAM_PORT}/`,
      {},
      { "X-Client-Custom": "hello" },
    );
    expect(cap.headers["x-client-custom"]).toBe("hello");
  });
});
