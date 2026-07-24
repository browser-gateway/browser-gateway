import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { createConnection } from "node:net";
import { connect as tlsConnect } from "node:tls";
import type {
  RelayCloseReason,
  RelayOptions,
  RelayResult,
  RelayTransport,
} from "../../core/transport.js";

interface NodeClientMeta {
  req: IncomingMessage;
  head: Buffer;
}

/**
 * Node-native WebSocket relay: raw TCP/TLS + `Duplex.pipe`.
 *
 * The workhorse transport for the OSS gateway CLI. It owns:
 *   - opening the upstream TCP/TLS connection
 *   - writing the WebSocket upgrade request
 *   - parsing the 101 response
 *   - injecting the `X-Session-Id` response header when a session id is provided
 *   - bidirectional byte piping
 *   - tearing both sockets down on any terminal event
 *
 * It does NOT own session tracking, provider health, reconnect parking,
 * profile handoff, or replay recording — those are caller concerns and
 * are surfaced via the `RelayCallbacks` in `RelayOptions`.
 */
export class NodeTcpPipeTransport implements RelayTransport {
  readonly name = "node-tcp-pipe";

  async relay(opts: RelayOptions): Promise<RelayResult> {
    const clientSocket = opts.client as Duplex;
    const meta = opts.clientMeta as NodeClientMeta | undefined;
    if (!meta?.req || meta.head === undefined) {
      throw new Error(
        "NodeTcpPipeTransport requires clientMeta: { req: IncomingMessage, head: Buffer }",
      );
    }
    const { req, head } = meta;
    const connectionTimeoutMs = opts.connectionTimeoutMs ?? 30_000;

    const providerUrl = new URL(opts.upstreamUrl);
    const isSecure = providerUrl.protocol === "wss:";
    const port = parseInt(providerUrl.port || (isSecure ? "443" : "80"), 10);
    const hostname = providerUrl.hostname;

    return new Promise<RelayResult>((resolve) => {
      let gotUpgrade = false;
      let cleanedUp = false;
      let responseBuffer = Buffer.alloc(0);

      const timeout = setTimeout(() => {
        if (gotUpgrade) return;
        providerSocket.destroy();
        resolve({ connected: false, reason: { kind: "upstream-timeout" } });
      }, connectionTimeoutMs);

      const providerSocket = isSecure
        ? tlsConnect({ host: hostname, port, servername: hostname }, onConnect)
        : createConnection({ host: hostname, port }, onConnect);

      function onConnect(): void {
        clearTimeout(timeout);
        providerSocket.write(buildUpgradeRequest(providerUrl, req));
        if (head.length > 0) providerSocket.write(head);
      }

      // Only fires after a successful upgrade. Pre-upgrade failures resolve
      // via the returned RelayResult so the caller retains ownership of the
      // client socket and can try the next provider.
      const emitPostUpgradeClose = (reason: RelayCloseReason): void => {
        if (cleanedUp) return;
        cleanedUp = true;
        if (!clientSocket.destroyed) clientSocket.destroy();
        if (!providerSocket.destroyed) providerSocket.destroy();
        opts.onClose?.(reason);
      };

      providerSocket.on("data", function onData(chunk: Buffer) {
        if (gotUpgrade) return;
        responseBuffer = Buffer.concat([responseBuffer, chunk]);
        const headerEnd = responseBuffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;
        providerSocket.removeListener("data", onData);

        const headerStr = responseBuffer.subarray(0, headerEnd).toString();
        if (!headerStr.startsWith("HTTP/1.1 101")) {
          const statusMatch = /^HTTP\/1\.1 (\d{3})/.exec(headerStr);
          const status = statusMatch ? parseInt(statusMatch[1] ?? "500", 10) : 500;
          providerSocket.destroy();
          resolve({
            connected: false,
            reason: {
              kind: "upstream-rejected",
              status,
              body: headerStr.slice(0, 200),
            },
          });
          return;
        }

        gotUpgrade = true;
        opts.onUpgrade?.({ upstreamStatus: 101 });

        const headerPart = responseBuffer.subarray(0, headerEnd).toString();
        const afterHeaders = responseBuffer.subarray(headerEnd + 4);
        const forwardedHeaders = opts.sessionId
          ? `${headerPart}\r\nX-Session-Id: ${opts.sessionId}\r\n\r\n`
          : `${headerPart}\r\n\r\n`;
        clientSocket.write(forwardedHeaders);
        if (afterHeaders.length > 0) clientSocket.write(afterHeaders);

        if (opts.onBytes || opts.onMessage) {
          clientSocket.on("data", (buf: Buffer) => {
            opts.onBytes?.("out", buf.length);
            opts.onMessage?.("out");
          });
          providerSocket.on("data", (buf: Buffer) => {
            opts.onBytes?.("in", buf.length);
            opts.onMessage?.("in");
          });
        }

        // Now that the pipe is live, take ownership of the client socket.
        // These listeners deliberately only get wired AFTER a successful upgrade;
        // pre-upgrade the caller owns the client socket for provider fallback.
        clientSocket.on("close", () => emitPostUpgradeClose({ kind: "client-closed" }));
        clientSocket.on("error", (err) =>
          emitPostUpgradeClose({ kind: "client-error", error: err }),
        );
        providerSocket.on("close", () => emitPostUpgradeClose({ kind: "upstream-closed" }));

        clientSocket.pipe(providerSocket);
        providerSocket.pipe(clientSocket);

        resolve({ connected: true });
      });

      providerSocket.on("error", (err: Error) => {
        clearTimeout(timeout);
        if (!gotUpgrade) {
          resolve({ connected: false, reason: { kind: "upstream-error", error: err } });
        } else {
          emitPostUpgradeClose({ kind: "upstream-error", error: err });
        }
      });
    });
  }
}

function buildUpgradeRequest(providerUrl: URL, originalReq: IncomingMessage): string {
  const path = providerUrl.pathname + providerUrl.search;
  let request = `GET ${path} HTTP/1.1\r\n`;
  request += `Host: ${providerUrl.host}\r\n`;
  const skipHeaders = new Set(["host", "connection", "upgrade", "authorization"]);
  for (let i = 0; i < originalReq.rawHeaders.length; i += 2) {
    const key = originalReq.rawHeaders[i];
    if (key && !skipHeaders.has(key.toLowerCase())) {
      request += `${key}: ${originalReq.rawHeaders[i + 1]}\r\n`;
    }
  }
  request += `Connection: Upgrade\r\n`;
  request += `Upgrade: websocket\r\n`;
  request += `\r\n`;
  return request;
}
