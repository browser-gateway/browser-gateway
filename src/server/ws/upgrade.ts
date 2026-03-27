import { IncomingMessage } from "node:http";
import { Duplex } from "node:stream";
import { createConnection, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { Logger } from "pino";
import type { Gateway } from "../../core/index.js";
import type { ProviderState } from "../../core/types.js";

function safeTokenCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function extractBearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  if (!header.startsWith("Bearer ")) return undefined;
  return header.slice(7);
}

export function createWebSocketHandler(gateway: Gateway, logger: Logger, token?: string) {

  async function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (url.pathname !== "/v1/connect") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }

    if (token) {
      const reqToken =
        url.searchParams.get("token") ??
        extractBearerToken(req.headers.authorization);

      if (!reqToken || !safeTokenCompare(reqToken, token)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
    }

    if (gateway.shuttingDown) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\n\r\n" +
        JSON.stringify({ error: "Gateway is shutting down" }));
      socket.destroy();
      return;
    }

    const sessionId = randomUUID();

    const tryConnect = async (): Promise<boolean> => {
      const candidates = gateway.selectProviderWithFallbacks();

      if (candidates.length === 0 && gateway.registry.size() === 0) {
        return false;
      }

      for (const provider of candidates) {
        if (!gateway.acquireSlot(provider.id, sessionId)) {
          logger.debug({ sessionId, providerId: provider.id }, "provider at capacity, trying next");
          continue;
        }

        const connected = await pipeToProvider(
          gateway, logger, socket, head, req, sessionId, provider
        );

        if (connected) return true;

        gateway.releaseSlot(sessionId, provider.id);
        gateway.recordFailure(provider.id);
      }

      return false;
    };

    // Try immediate connection
    if (await tryConnect()) return;

    // Queue if all providers at capacity
    const slotAvailable = await gateway.waitForSlot();
    if (slotAvailable && await tryConnect()) return;

    // All attempts failed
    logger.warn({ sessionId, queueSize: gateway.queueSize }, "connection failed, all providers exhausted");
    socket.write(
      "HTTP/1.1 503 Service Unavailable\r\n" +
        "Content-Type: application/json\r\n\r\n" +
        JSON.stringify({ error: "All providers unavailable" })
    );
    socket.destroy();
  }

  return { handleUpgrade };
}

function pipeToProvider(
  gateway: Gateway,
  logger: Logger,
  clientSocket: Duplex,
  head: Buffer,
  req: IncomingMessage,
  sessionId: string,
  provider: ProviderState
): Promise<boolean> {
  return new Promise((resolve) => {
    const providerUrl = new URL(provider.config.url);
    const isSecure = providerUrl.protocol === "wss:";
    const port = parseInt(providerUrl.port || (isSecure ? "443" : "80"), 10);
    const hostname = providerUrl.hostname;

    logger.info({ sessionId, providerId: provider.id }, "connecting to provider");

    const timeout = setTimeout(() => {
      logger.warn({ sessionId, providerId: provider.id }, "provider connection timed out");
      providerSocket.destroy();
      resolve(false);
    }, gateway.config.gateway.connectionTimeout);

    const providerSocket = isSecure
      ? tlsConnect({ host: hostname, port, servername: hostname }, onConnect)
      : createConnection({ host: hostname, port }, onConnect);

    function onConnect() {
      clearTimeout(timeout);
      logger.debug({ sessionId, providerId: provider.id }, "TCP connection established");

      const upgradeReq = buildUpgradeRequest(providerUrl, req);
      providerSocket.write(upgradeReq);

      if (head.length > 0) {
        providerSocket.write(head);
      }
    }

    let gotUpgradeResponse = false;
    let cleanedUp = false;
    const startTime = Date.now();

    let responseBuffer = Buffer.alloc(0);

    providerSocket.on("data", function onData(chunk) {
      if (gotUpgradeResponse) return;

      responseBuffer = Buffer.concat([responseBuffer, chunk]);
      const headerEnd = responseBuffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;

      providerSocket.removeListener("data", onData);

      const headerStr = responseBuffer.subarray(0, headerEnd).toString();

      if (headerStr.startsWith("HTTP/1.1 101")) {
        gotUpgradeResponse = true;

        gateway.sessions.create(sessionId, provider.id);
        gateway.emit("session.created", { sessionId, providerId: provider.id });
        logger.info({ sessionId, providerId: provider.id }, "session established");

        clientSocket.write(responseBuffer);

        clientSocket.pipe(providerSocket);
        providerSocket.pipe(clientSocket);

        clientSocket.on("data", () => gateway.sessions.recordActivity(sessionId));
        providerSocket.on("data", () => gateway.sessions.recordActivity(sessionId));

        resolve(true);
      } else {
        logger.warn(
          { sessionId, providerId: provider.id, response: headerStr.slice(0, 200) },
          "provider rejected upgrade"
        );
        providerSocket.destroy();
        resolve(false);
      }
    });

    const cleanup = (source: string) => () => {
      if (!gotUpgradeResponse || cleanedUp) return;
      cleanedUp = true;

      const session = gateway.sessions.remove(sessionId);
      gateway.releaseSlot(sessionId, provider.id);

      const durationMs = Date.now() - startTime;
      gateway.recordSuccess(provider.id, durationMs);

      gateway.emit("session.ended", { sessionId, providerId: provider.id, durationMs });

      logger.info(
        {
          sessionId,
          providerId: provider.id,
          durationMs,
          messageCount: session?.messageCount ?? 0,
          source,
        },
        "session ended"
      );

      if (!clientSocket.destroyed) clientSocket.destroy();
      if (!providerSocket.destroyed) providerSocket.destroy();
    };

    clientSocket.on("close", cleanup("client"));
    clientSocket.on("error", cleanup("client-error"));
    providerSocket.on("close", cleanup("provider"));
    providerSocket.on("error", (err) => {
      clearTimeout(timeout);
      if (!gotUpgradeResponse) {
        logger.warn(
          { sessionId, providerId: provider.id, error: err.message },
          "provider connection failed"
        );
        resolve(false);
      } else {
        cleanup("provider-error")();
      }
    });
  });
}

function buildUpgradeRequest(providerUrl: URL, originalReq: IncomingMessage): string {
  const path = providerUrl.pathname + providerUrl.search;

  let request = `GET ${path} HTTP/1.1\r\n`;
  request += `Host: ${providerUrl.host}\r\n`;

  const skipHeaders = new Set(["host", "connection", "upgrade", "authorization"]);

  for (let i = 0; i < originalReq.rawHeaders.length; i += 2) {
    const key = originalReq.rawHeaders[i];
    if (!skipHeaders.has(key.toLowerCase())) {
      request += `${key}: ${originalReq.rawHeaders[i + 1]}\r\n`;
    }
  }

  request += `Connection: Upgrade\r\n`;
  request += `Upgrade: websocket\r\n`;
  request += `\r\n`;

  return request;
}
