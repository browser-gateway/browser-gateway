import { IncomingMessage } from "node:http";
import { Duplex } from "node:stream";
import { createConnection, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { Gateway } from "../../core/index.js";
import type { BackendState } from "../../core/types.js";

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
        req.headers.authorization?.replace("Bearer ", "");

      if (reqToken !== token) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
    }

    const sessionId = randomUUID();
    const candidates = gateway.selectBackendWithFallbacks();

    if (candidates.length === 0) {
      logger.warn({ sessionId }, "no backends available");
      socket.write(
        "HTTP/1.1 503 Service Unavailable\r\n" +
          "Content-Type: application/json\r\n\r\n" +
          JSON.stringify({ error: "No backends available" })
      );
      socket.destroy();
      return;
    }

    for (const backend of candidates) {
      if (!gateway.acquireSlot(backend.id, sessionId)) {
        logger.debug({ sessionId, backendId: backend.id }, "backend at capacity, trying next");
        continue;
      }

      const connected = await pipeToBackend(
        gateway, logger, socket, head, req, sessionId, backend
      );

      if (connected) return;

      gateway.releaseSlot(sessionId, backend.id);
      gateway.recordFailure(backend.id);
    }

    logger.error({ sessionId }, "all backends exhausted");
    socket.write(
      "HTTP/1.1 503 Service Unavailable\r\n" +
        "Content-Type: application/json\r\n\r\n" +
        JSON.stringify({ error: "All backends unavailable" })
    );
    socket.destroy();
  }

  return { handleUpgrade };
}

function pipeToBackend(
  gateway: Gateway,
  logger: Logger,
  clientSocket: Duplex,
  head: Buffer,
  req: IncomingMessage,
  sessionId: string,
  backend: BackendState
): Promise<boolean> {
  return new Promise((resolve) => {
    const backendUrl = new URL(backend.config.url);
    const isSecure = backendUrl.protocol === "wss:";
    const port = parseInt(backendUrl.port || (isSecure ? "443" : "80"), 10);
    const hostname = backendUrl.hostname;

    logger.info({ sessionId, backendId: backend.id }, "connecting to backend");

    const timeout = setTimeout(() => {
      logger.warn({ sessionId, backendId: backend.id }, "backend connection timed out");
      backendSocket.destroy();
      resolve(false);
    }, gateway.config.gateway.connectionTimeout);

    const backendSocket = isSecure
      ? tlsConnect({ host: hostname, port, servername: hostname }, onConnect)
      : createConnection({ host: hostname, port }, onConnect);

    function onConnect() {
      clearTimeout(timeout);
      logger.debug({ sessionId, backendId: backend.id }, "TCP connection established");

      const upgradeReq = buildUpgradeRequest(backendUrl, req);
      backendSocket.write(upgradeReq);

      if (head.length > 0) {
        backendSocket.write(head);
      }
    }

    let gotUpgradeResponse = false;
    let messageCount = 0;
    const startTime = Date.now();

    backendSocket.once("data", (data) => {
      const response = data.toString();

      if (response.includes("101")) {
        gotUpgradeResponse = true;

        gateway.sessions.create(sessionId, backend.id);
        logger.info({ sessionId, backendId: backend.id }, "session established");

        clientSocket.write(data);

        clientSocket.pipe(backendSocket);
        backendSocket.pipe(clientSocket);

        const trackActivity = () => {
          messageCount++;
          gateway.sessions.recordActivity(sessionId);
        };
        clientSocket.on("data", trackActivity);
        backendSocket.on("data", trackActivity);

        resolve(true);
      } else {
        logger.warn(
          { sessionId, backendId: backend.id, response: response.slice(0, 200) },
          "backend rejected upgrade"
        );
        backendSocket.destroy();
        resolve(false);
      }
    });

    const cleanup = (source: string) => () => {
      if (!gotUpgradeResponse) return;

      const session = gateway.sessions.remove(sessionId);
      gateway.releaseSlot(sessionId, backend.id);

      const durationMs = Date.now() - startTime;
      gateway.recordSuccess(backend.id, durationMs);

      logger.info(
        {
          sessionId,
          backendId: backend.id,
          durationMs,
          messageCount: session?.messageCount ?? messageCount,
          source,
        },
        "session ended"
      );

      if (!clientSocket.destroyed) clientSocket.destroy();
      if (!backendSocket.destroyed) backendSocket.destroy();
    };

    clientSocket.on("close", cleanup("client"));
    clientSocket.on("error", cleanup("client-error"));
    backendSocket.on("close", cleanup("backend"));
    backendSocket.on("error", (err) => {
      clearTimeout(timeout);
      if (!gotUpgradeResponse) {
        logger.warn(
          { sessionId, backendId: backend.id, error: err.message },
          "backend connection failed"
        );
        resolve(false);
      } else {
        cleanup("backend-error")();
      }
    });
  });
}

function buildUpgradeRequest(backendUrl: URL, originalReq: IncomingMessage): string {
  const path = backendUrl.pathname + backendUrl.search;

  let request = `GET ${path} HTTP/1.1\r\n`;
  request += `Host: ${backendUrl.host}\r\n`;

  const skipHeaders = new Set(["host", "connection", "upgrade"]);

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
