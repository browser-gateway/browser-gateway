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
import type { IncomingMessage } from "node:http";
import type { RelayTransport } from "../../src/core/transport.js";
import pino from "pino";
import { Gateway } from "../../src/core/gateway.js";
import { createWebSocketHandler } from "../../src/server/ws/upgrade.js";
import { GatewayConfigSchema } from "../../src/core/types.js";

const TOKEN = "test-token-32chars-long-abcdefgh";

let server: Server;
let port: number;
let gateway: Gateway;

async function start(opts: { token?: string | null; transport?: RelayTransport } = {}) {
  const config = GatewayConfigSchema.parse({
    providers: { stub: { url: "ws://localhost:9999", limits: { maxConcurrent: 1 }, priority: 1 } },
  });
  gateway = new Gateway(config, pino({ level: "silent" }));
  const token = opts.token === null ? undefined : (opts.token ?? TOKEN);
  const handler = createWebSocketHandler(gateway, pino({ level: "silent" }), token, undefined, undefined, opts.transport);
  server = createServer(() => { /* http path unused */ });
  server.on("upgrade", handler.handleUpgrade);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  port = addr.port;
}

async function rawUpgrade(opts: {
  origin?: string;
  token?: string;
  forwardedProto?: string;
  path?: string;
  host?: string;
  bearer?: string;
}): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const sock = connect(port, "127.0.0.1", () => {
      const lines = [
        `GET ${opts.path ?? "/v1/connect"}${opts.token ? `?token=${opts.token}` : ""} HTTP/1.1`,
        `Host: ${opts.host ?? `127.0.0.1:${port}`}`,
        `Upgrade: websocket`,
        `Connection: Upgrade`,
        `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==`,
        `Sec-WebSocket-Version: 13`,
      ];
      if (opts.origin) lines.push(`Origin: ${opts.origin}`);
      if (opts.forwardedProto) lines.push(`X-Forwarded-Proto: ${opts.forwardedProto}`);
      if (opts.bearer) lines.push(`Authorization: Bearer ${opts.bearer}`);
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

async function restart(opts: { token?: string | null }) {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await gateway.gracefulShutdown();
  await start(opts);
}

describe("WS /v1/live Origin guard", () => {
  it("rejects a foreign Origin on /v1/live with a valid token", async () => {
    const out = await rawUpgrade({ path: "/v1/live", origin: "https://attacker.example", token: TOKEN });
    expect(out.status).toBe(403);
  });

  it("rejects a foreign Origin on /v1/live when BG_TOKEN is unset", async () => {
    await restart({ token: null });
    const out = await rawUpgrade({ path: "/v1/live", origin: "https://attacker.example" });
    expect(out.status).toBe(403);
  });
});

describe("WS Host guard without BG_TOKEN (DNS rebinding)", () => {
  it("rejects a rebound Host on /v1/connect, even with a matching Origin", async () => {
    await restart({ token: null });
    const out = await rawUpgrade({ host: "attacker.example:9500", origin: "http://attacker.example:9500" });
    expect(out.status).toBe(403);
  });

  it("rejects a rebound Host on /v1/live", async () => {
    await restart({ token: null });
    const out = await rawUpgrade({ path: "/v1/live", host: "attacker.example:9500" });
    expect(out.status).toBe(403);
  });

  it("allows a loopback Host without BG_TOKEN", async () => {
    await restart({ token: null });
    const out = await rawUpgrade({});
    expect(out.status).not.toBe(403);
  });

  it("does not apply the Host guard when BG_TOKEN is set", async () => {
    const out = await rawUpgrade({ host: "gateway.example.com", token: TOKEN });
    expect(out.status).not.toBe(403);
    expect(out.status).not.toBe(401);
  });
});

describe("WS /v1/connect gateway credential forwarding", () => {
  async function relayedHeaders(upgrade: Parameters<typeof rawUpgrade>[0]): Promise<string[]> {
    let capture!: (headers: string[]) => void;
    const seen = new Promise<string[]>((resolve) => (capture = resolve));
    const transport: RelayTransport = {
      name: "capture",
      async relay(opts) {
        capture([...(opts.clientMeta?.req as IncomingMessage).rawHeaders]);
        return { connected: false, reason: { kind: "upstream-error", error: new Error("capture only") } };
      },
    };
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await gateway.gracefulShutdown();
    await start({ transport });
    const upgraded = rawUpgrade(upgrade).catch(() => undefined);
    const headers = await seen;
    await upgraded;
    return headers;
  }

  it("does not relay the gateway Bearer token to the provider", async () => {
    const headers = await relayedHeaders({ bearer: TOKEN });
    expect(headers.length).toBeGreaterThan(0);
    expect(headers.map((h) => h.toLowerCase())).not.toContain("authorization");
    expect(headers).not.toContain(`Bearer ${TOKEN}`);
  });

  it("still relays a client Authorization header that is not the gateway token", async () => {
    const headers = await relayedHeaders({ token: TOKEN, bearer: "provider-only-credential" });
    expect(headers).toContain("Bearer provider-only-credential");
  });
});
