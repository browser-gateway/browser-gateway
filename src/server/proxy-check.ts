import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import type { ParsedProxy } from "../core/proxy-config.js";

export const PROXY_CHECK_URL = "https://ipinfo.io/json";
export const PROXY_CHECK_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

/** What sites see when a request leaves through the proxy. */
export interface ProxyExit {
  ip: string;
  country: string | null;
  region: string | null;
  city: string | null;
  /** Network that owns the address, such as an ISP or hosting company. */
  org: string | null;
  timezone: string | null;
}

export type ProxyCheckResult =
  | ({ ok: true; latencyMs: number } & ProxyExit)
  | { ok: false; error: string; latencyMs: number };

function waitForConnect(socket: Socket, event: "connect" | "secureConnect"): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once(event, () => resolve());
    socket.once("error", reject);
  });
}

function readUntil(socket: Socket, done: (buf: Buffer) => boolean): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > MAX_RESPONSE_BYTES) finish(new Error("response too large"));
      else if (done(buf)) finish();
    };
    const finish = (err?: Error) => {
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("error", finish);
      if (err) reject(err);
      else resolve(buf);
    };
    const onEnd = () => finish();
    socket.on("data", onData);
    socket.once("end", onEnd);
    socket.once("error", finish);
  });
}

async function openToProxy(proxy: ParsedProxy): Promise<Socket> {
  if (proxy.scheme === "https") {
    const socket = tlsConnect({ host: proxy.host, port: proxy.port, servername: proxy.host });
    await waitForConnect(socket, "secureConnect");
    return socket;
  }
  const socket = netConnect(proxy.port, proxy.host);
  await waitForConnect(socket, "connect");
  return socket;
}

async function httpConnectTunnel(socket: Socket, proxy: ParsedProxy, host: string, port: number): Promise<void> {
  const auth = proxy.username !== undefined || proxy.password !== undefined
    ? `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username ?? ""}:${proxy.password ?? ""}`).toString("base64")}\r\n`
    : "";
  socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`);
  const head = await readUntil(socket, (b) => b.includes("\r\n\r\n"));
  const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head.toString("latin1"))?.[1]);
  if (status === 407) throw new Error("the proxy refused the username or password");
  if (status !== 200) throw new Error(`the proxy answered ${Number.isNaN(status) ? "with an unreadable reply" : `HTTP ${status}`}`);
}

async function socksTunnel(socket: Socket, host: string, port: number): Promise<void> {
  socket.write(Buffer.from([0x05, 0x01, 0x00]));
  const greeting = await readUntil(socket, (b) => b.length >= 2);
  if (greeting[0] !== 0x05 || greeting[1] !== 0x00) throw new Error("the socks5 proxy requires a login");
  const name = Buffer.from(host);
  socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, name.length]), name, Buffer.from([port >> 8, port & 0xff])]));
  const reply = await readUntil(socket, (b) => b.length >= 10);
  if (reply[1] !== 0x00) throw new Error(`the socks5 proxy could not reach the check address (code ${reply[1]})`);
}

const nonEmpty = (value: unknown): string | null => (typeof value === "string" && value ? value : null);

/** Reads an IP echo service's JSON reply. */
export function parseExitJson(body: Record<string, unknown>): ProxyExit {
  if (typeof body.ip !== "string") throw new Error("the check address did not report an IP");
  return { ip: body.ip, country: nonEmpty(body.country), region: nonEmpty(body.region), city: nonEmpty(body.city), org: nonEmpty(body.org), timezone: nonEmpty(body.timezone) };
}

function parseCheckBody(raw: Buffer): ProxyExit {
  const text = raw.toString("utf8");
  const split = text.indexOf("\r\n\r\n");
  const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(text)?.[1]);
  if (split < 0 || status !== 200) throw new Error(`the check address answered ${Number.isNaN(status) ? "with an unreadable reply" : `HTTP ${status}`}`);
  return parseExitJson(JSON.parse(text.slice(split + 4)) as Record<string, unknown>);
}

/** Connects through the proxy to an IP echo service and reports the address and country sites see. Never includes credentials in errors. */
export async function checkProxyExit(
  proxy: ParsedProxy,
  opts: { checkUrl?: string; timeoutMs?: number } = {},
): Promise<ProxyCheckResult> {
  const target = new URL(opts.checkUrl ?? PROXY_CHECK_URL);
  const secure = target.protocol === "https:";
  const port = Number(target.port) || (secure ? 443 : 80);
  const start = Date.now();
  let socket: Socket | undefined;
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error("timed out")), opts.timeoutMs ?? PROXY_CHECK_TIMEOUT_MS).unref();
  });
  const run = async () => {
    socket = await openToProxy(proxy);
    if (proxy.scheme.startsWith("socks")) await socksTunnel(socket, target.hostname, port);
    else await httpConnectTunnel(socket, proxy, target.hostname, port);
    let channel: Socket = socket;
    if (secure) {
      channel = tlsConnect({ socket, servername: target.hostname });
      await waitForConnect(channel, "secureConnect");
    }
    channel.write(`GET ${target.pathname}${target.search} HTTP/1.0\r\nHost: ${target.host}\r\nAccept: application/json\r\nUser-Agent: browser-gateway\r\n\r\n`);
    return parseCheckBody(await readUntil(channel, () => false));
  };
  try {
    const exit = await Promise.race([run(), timeout]);
    return { ok: true, ...exit, latencyMs: Date.now() - start };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, error: proxy.password ? reason.replaceAll(proxy.password, "***") : reason, latencyMs: Date.now() - start };
  } finally {
    socket?.destroy();
  }
}
