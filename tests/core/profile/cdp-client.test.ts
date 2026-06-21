/**
 * Phase 4.5 hardening — direct unit tests for WsCDPClient.
 *
 * Issue H2: close() has a 2-second timeout. If the server never sends close,
 * the timer fires, ws is nulled, and pending send() promises hang forever.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket as WSWebSocket } from "ws";
import { createServer, type Server } from "node:http";
import { WsCDPClient } from "../../../src/core/profile/cdp-client.js";

interface SilentServer {
  url: string;
  server: Server;
  wss: WebSocketServer;
  /** Disable graceful close — force the client's close-event to never fire. */
  swallowClose: () => void;
  conns: WSWebSocket[];
  close: () => Promise<void>;
}

async function startSilentServer(): Promise<SilentServer> {
  const server = createServer();
  const wss = new WebSocketServer({ server });
  const conns: WSWebSocket[] = [];
  let swallowing = false;

  wss.on("connection", (ws) => {
    conns.push(ws);
    if (swallowing) {
      // monkey-patch ws.close to do nothing — server side won't send close frame
      // this simulates an unhealthy provider that refuses to close cleanly.
      ws.terminate = () => {};
    }
    // Never respond to messages — pending sends will sit forever.
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `ws://127.0.0.1:${port}`,
    server,
    wss,
    conns,
    swallowClose() { swallowing = true; },
    async close() {
      for (const c of conns) {
        try { c.terminate(); } catch {}
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

let srv: SilentServer;

beforeEach(async () => { srv = await startSilentServer(); });
afterEach(async () => { await srv?.close(); });

describe("WsCDPClient.close — pending send rejection (H2 fix)", () => {
  it("rejects pending sends within ~2s when close() can't get a close event", async () => {
    const client = new WsCDPClient();
    await client.connect(srv.url, 2_000);

    // Subvert the server: from now on it won't acknowledge close frames.
    srv.swallowClose();
    // Patch the connection so it ignores close requests — emulates provider hang.
    for (const c of srv.conns) {
      c.close = () => undefined as unknown as void;
    }

    // Pending send that the server will never respond to.
    const pending = client.send("Storage.getCookies");

    const t0 = Date.now();
    await client.close();
    const closeMs = Date.now() - t0;

    // Pending must reject (not hang) within the close window.
    await expect(pending).rejects.toThrow(/close|closed|timeout/i);
    expect(closeMs).toBeLessThan(2_500);
  }, 10_000);
});
