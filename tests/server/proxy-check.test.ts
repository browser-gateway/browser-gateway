import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { connect as netConnect, createServer as createNetServer, type AddressInfo, type Server as NetServer } from "node:net";
import { parseProxyUrl, type ParsedProxy } from "../../src/core/proxy-config.js";
import { checkProxyExit } from "../../src/server/proxy-check.js";

let echo: Server;
let connectProxy: Server;
let socksProxy: NetServer;
let echoUrl = "";
let connectPort = 0;
let socksPort = 0;
const tunnels: string[] = [];

function listen(server: Server | NetServer): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

function proxy(raw: string): ParsedProxy {
  const r = parseProxyUrl(raw);
  if (!r.ok) throw new Error(r.reason);
  return r.proxy;
}

beforeAll(async () => {
  echo = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ip: "203.0.113.7", country: "DE", region: "Berlin", city: "Berlin", org: "AS64500 Example Net", timezone: "Europe/Berlin" }));
  });
  echoUrl = `http://127.0.0.1:${await listen(echo)}/json`;

  connectProxy = createServer();
  connectProxy.on("connect", (req, client) => {
    if (req.headers["proxy-authorization"] !== `Basic ${Buffer.from("alice:s3cret").toString("base64")}`) {
      client.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
      return;
    }
    tunnels.push(`http ${req.url}`);
    const [host, port] = (req.url ?? "").split(":");
    const up = netConnect(Number(port), host!, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      up.pipe(client);
      client.pipe(up);
    });
    up.on("error", () => client.destroy());
  });
  connectPort = await listen(connectProxy);

  socksProxy = createNetServer((client) => {
    client.once("data", () => {
      client.write(Buffer.from([0x05, 0x00]));
      client.once("data", (req) => {
        const len = req[4]!;
        const host = req.subarray(5, 5 + len).toString();
        const port = req.readUInt16BE(5 + len);
        tunnels.push(`socks ${host}:${port}`);
        const up = netConnect(port, host, () => {
          client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          up.pipe(client);
          client.pipe(up);
        });
        up.on("error", () => client.destroy());
      });
    });
  });
  socksPort = await listen(socksProxy);
});

afterAll(() => {
  echo.close();
  connectProxy.close();
  socksProxy.close();
});

describe("checkProxyExit", () => {
  it("reports the exit address and country through an http proxy with a login", async () => {
    const r = await checkProxyExit(proxy(`http://alice:s3cret@127.0.0.1:${connectPort}`), { checkUrl: echoUrl });
    expect(r).toMatchObject({ ok: true, ip: "203.0.113.7", country: "DE", region: "Berlin", city: "Berlin", org: "AS64500 Example Net", timezone: "Europe/Berlin" });
    expect(tunnels).toContain(`http 127.0.0.1:${new URL(echoUrl).port}`);
  });

  it("reports the exit address through a socks5 proxy", async () => {
    const r = await checkProxyExit(proxy(`socks5://127.0.0.1:${socksPort}`), { checkUrl: echoUrl });
    expect(r).toMatchObject({ ok: true, ip: "203.0.113.7" });
    expect(tunnels).toContain(`socks 127.0.0.1:${new URL(echoUrl).port}`);
  });

  it("names a refused login without echoing the password", async () => {
    const r = await checkProxyExit(proxy(`http://alice:wrong-pass@127.0.0.1:${connectPort}`), { checkUrl: echoUrl });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("wrong-pass");
    expect(r.ok ? "" : r.error).toContain("username or password");
  });

  it("fails cleanly when nothing listens at the proxy address", async () => {
    const idle = createNetServer();
    const dead = await listen(idle);
    await new Promise((resolve) => idle.close(resolve));
    const r = await checkProxyExit(proxy(`http://127.0.0.1:${dead}`), { checkUrl: echoUrl, timeoutMs: 1_000 });
    expect(r.ok).toBe(false);
  });
});
