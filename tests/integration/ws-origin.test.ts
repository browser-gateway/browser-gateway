/**
 * WebSocket Origin CSRF guard tests.
 *
 * Browsers attach the page's Origin header to every WebSocket upgrade
 * request. Node clients (Puppeteer, Playwright, our own WS lib) do NOT.
 * The guard:
 *   - Absent Origin → allow (CDP clients still work)
 *   - Same-origin → allow
 *   - Foreign Origin not in BG_ALLOWED_ORIGINS → 403
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import pino from "pino";
import { Gateway } from "../../src/core/gateway.js";
import { createWebSocketHandler } from "../../src/server/ws/upgrade.js";
import { GatewayConfigSchema } from "../../src/core/types.js";

const TOKEN = "test-token-32chars-long-abcdefgh";

let server: Server;
let port: number;
let gateway: Gateway;

async function start() {
  const config = GatewayConfigSchema.parse({
    providers: { stub: { url: "ws://localhost:9999", limits: { maxConcurrent: 1 }, priority: 1 } },
  });
  gateway = new Gateway(config, pino({ level: "silent" }));
  const handler = createWebSocketHandler(gateway, pino({ level: "silent" }), TOKEN);
  server = createServer(() => { /* http path unused */ });
  server.on("upgrade", handler.handleUpgrade);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  port = addr.port;
}

async function rawUpgrade(opts: { origin?: string; token?: string; forwardedProto?: string }): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const sock = connect(port, "127.0.0.1", () => {
      const lines = [
        `GET /v1/connect${opts.token ? `?token=${opts.token}` : ""} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        `Upgrade: websocket`,
        `Connection: Upgrade`,
        `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==`,
        `Sec-WebSocket-Version: 13`,
      ];
      if (opts.origin) lines.push(`Origin: ${opts.origin}`);
      if (opts.forwardedProto) lines.push(`X-Forwarded-Proto: ${opts.forwardedProto}`);
      lines.push("", "");
      sock.write(lines.join("\r\n"));
    });
    let buf = Buffer.alloc(0);
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const headerEnd = buf.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const head = buf.slice(0, headerEnd).toString("utf8");
      const status = parseInt(head.split(" ")[1] ?? "0", 10);
      sock.destroy();
      resolve({ status });
    });
    sock.on("error", reject);
    setTimeout(() => { sock.destroy(); reject(new Error("upgrade timeout")); }, 3000);
  });
}

beforeEach(async () => {
  delete process.env.BG_ALLOWED_ORIGINS;
  await start();
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await gateway.gracefulShutdown();
});

describe("WS /v1/connect Origin guard", () => {
  it("allows requests with NO Origin (CDP/Puppeteer/Playwright)", async () => {
    const out = await rawUpgrade({ token: TOKEN });
    // 101 Switching Protocols would mean a successful upgrade, but the
    // gateway will probably fail at "no providers available" → 503.
    // The point is: NOT 403 (Origin rejected) and NOT 401 (auth ok).
    expect(out.status).not.toBe(403);
    expect(out.status).not.toBe(401);
  });

  it("rejects requests from a foreign Origin (browser CSRF)", async () => {
    const out = await rawUpgrade({ origin: "https://attacker.example", token: TOKEN });
    expect(out.status).toBe(403);
  });

  it("allows same-origin requests (Origin host matches Host header)", async () => {
    const out = await rawUpgrade({ origin: `http://127.0.0.1:${port}`, token: TOKEN });
    expect(out.status).not.toBe(403);
    expect(out.status).not.toBe(401);
  });

  it("rejects foreign Origin EVEN with a valid token (auth alone isn't enough)", async () => {
    const out = await rawUpgrade({ origin: "https://attacker.example", token: TOKEN });
    expect(out.status).toBe(403);
  });

  it("allows whitelisted Origin via BG_ALLOWED_ORIGINS", async () => {
    process.env.BG_ALLOWED_ORIGINS = "https://app.example,https://dash.example";
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await gateway.gracefulShutdown();
    await start();
    const out = await rawUpgrade({ origin: "https://app.example", token: TOKEN });
    expect(out.status).not.toBe(403);
  });
});
