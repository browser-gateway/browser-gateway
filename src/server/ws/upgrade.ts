import { IncomingMessage } from "node:http";
import { Duplex } from "node:stream";
import { createConnection } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { Logger } from "pino";
import type { Gateway } from "../../core/index.js";
import type { ProviderState } from "../../core/types.js";
import type { ReconnectRegistry } from "../../core/proxy/reconnect.js";
import {
  LifecycleError,
  type ProfileLifecycle,
  type AcquiredProfile,
} from "../profile/lifecycle.js";
import { createLiveUpgradeHandler } from "../live/upgrade.js";

function safeTokenCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function extractBearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  if (!header.startsWith("Bearer ")) return undefined;
  return header.slice(7);
}

function respondError(socket: Duplex, status: number, body: Record<string, unknown>): void {
  const text = JSON.stringify(body);
  const statusText = HTTP_STATUS_TEXT[status] ?? "Error";
  socket.write(
    `HTTP/1.1 ${status} ${statusText}\r\n` +
      `Content-Type: application/json\r\n` +
      `Content-Length: ${Buffer.byteLength(text)}\r\n\r\n` +
      text,
  );
  socket.destroy();
}

const HTTP_STATUS_TEXT: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  404: "Not Found",
  409: "Conflict",
  500: "Internal Server Error",
  503: "Service Unavailable",
};

export function createWebSocketHandler(
  gateway: Gateway,
  logger: Logger,
  token?: string,
  reconnectRegistry?: ReconnectRegistry,
  profileLifecycle?: ProfileLifecycle,
) {

  const liveHandler = createLiveUpgradeHandler({ gateway, logger, token, profileLifecycle });

  async function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (url.pathname === "/v1/live") {
      await liveHandler.handle(req, socket, head);
      return;
    }

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

    // Profile acquisition — lock + decrypt happen BEFORE provider selection so we
    // fail-fast on contention. Inject happens after we have a wsUrl.
    const profileId = url.searchParams.get("profile");
    let acquired: AcquiredProfile | null = null;
    if (profileId !== null) {
      if (!profileLifecycle) {
        respondError(socket, 400, { error: "profiles are not enabled on this gateway" });
        return;
      }
      try {
        acquired = await profileLifecycle.acquire(profileId);
        logger.info(
          { profileId, isExisting: acquired.isExisting, cookies: acquired.cookies.length },
          "profile lifecycle: acquired",
        );
      } catch (err) {
        if (err instanceof LifecycleError) {
          if (err.reason === "INVALID_ID") {
            respondError(socket, 400, { error: err.message });
            return;
          }
          if (err.reason === "LOCK_HELD") {
            respondError(socket, 409, { error: err.message });
            return;
          }
          logger.error({ profileId, reason: err.reason, error: err.message }, "profile acquire failed");
          respondError(socket, 500, { error: "profile acquire failed" });
          return;
        }
        logger.error(
          { profileId, error: err instanceof Error ? err.message : String(err) },
          "profile acquire failed",
        );
        respondError(socket, 500, { error: "profile acquire failed" });
        return;
      }
    }

    // Session reconnection
    const reconnectSessionId = url.searchParams.get("sessionId");
    if (reconnectSessionId && reconnectRegistry) {
      const parked = reconnectRegistry.claim(reconnectSessionId);

      if (!parked) {
        logger.debug({ sessionId: reconnectSessionId }, "session reconnect: not found or expired");
        // Fall through to normal routing - not an error, just creates a new session
      } else {
        const provider = gateway.registry.get(parked.providerId);

        if (!provider) {
          logger.warn({ sessionId: reconnectSessionId, providerId: parked.providerId }, "session reconnect: provider no longer exists");
        } else if (!gateway.acquireSlot(provider.id, reconnectSessionId)) {
          logger.warn({ sessionId: reconnectSessionId, providerId: provider.id }, "session reconnect: provider at capacity");
        } else {
          logger.info({ sessionId: reconnectSessionId, providerId: provider.id }, "session reconnecting to same provider");

          const connected = await pipeToProvider(
            gateway, logger, socket, head, req, reconnectSessionId, provider, reconnectRegistry,
            profileLifecycle, acquired,
          );

          if (connected) {
            acquired = null;
            return;
          }

          gateway.releaseSlot(reconnectSessionId, provider.id);
          gateway.recordFailure(provider.id);
          logger.warn({ sessionId: reconnectSessionId }, "session reconnect: failed to connect to provider");
        }
      }
    }

    // Normal routing (new session or failed reconnect)
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
          gateway, logger, socket, head, req, sessionId, provider, reconnectRegistry,
          profileLifecycle, acquired,
        );

        if (connected) {
          acquired = null;
          return true;
        }

        gateway.releaseSlot(sessionId, provider.id);
        gateway.recordFailure(provider.id);
      }

      return false;
    };

    try {
      if (await tryConnect()) return;

      const slotAvailable = await gateway.waitForSlot();
      if (slotAvailable && await tryConnect()) return;

      logger.warn({ sessionId, queueSize: gateway.queueSize }, "connection failed, all providers exhausted");
      respondError(socket, 503, { error: "All providers unavailable" });
    } finally {
      // If the profile was acquired but never handed off to a successful pipe, release it.
      if (acquired && profileLifecycle) {
        await profileLifecycle.release(acquired);
        acquired = null;
      }
    }
  }

  return { handleUpgrade };
}

import { resolveWsUrl, isHttpUrl } from "../../core/providers/cdp.js";

// L1 fix: bounded LRU. If you remove and re-add providers many times the cache
// would otherwise grow forever; in practice the cap is reached by anyone using
// many distinct provider URLs, so the bound is defense-in-depth.
const cdpUrlCache = new Map<string, { wsUrl: string; resolvedAt: number }>();
const CDP_CACHE_TTL = 30000;
const CDP_CACHE_MAX = 256;

async function cachedResolveWsUrl(providerUrl: string, timeoutMs: number): Promise<string> {
  if (!isHttpUrl(providerUrl)) return providerUrl;

  const cached = cdpUrlCache.get(providerUrl);
  if (cached && Date.now() - cached.resolvedAt < CDP_CACHE_TTL) {
    // Refresh LRU position
    cdpUrlCache.delete(providerUrl);
    cdpUrlCache.set(providerUrl, cached);
    return cached.wsUrl;
  }

  const resolved = await resolveWsUrl(providerUrl, Math.min(timeoutMs, 3000));
  if (resolved !== providerUrl) {
    if (cdpUrlCache.size >= CDP_CACHE_MAX) {
      // Evict oldest entry (Map iteration order = insertion order)
      const oldestKey = cdpUrlCache.keys().next().value;
      if (oldestKey !== undefined) cdpUrlCache.delete(oldestKey);
    }
    cdpUrlCache.set(providerUrl, { wsUrl: resolved, resolvedAt: Date.now() });
  }
  return resolved;
}

async function pipeToProvider(
  gateway: Gateway,
  logger: Logger,
  clientSocket: Duplex,
  head: Buffer,
  req: IncomingMessage,
  sessionId: string,
  provider: ProviderState,
  reconnectRegistry?: ReconnectRegistry,
  profileLifecycle?: ProfileLifecycle,
  acquired?: AcquiredProfile | null,
): Promise<boolean> {
  // L4 fix: do the awaited setup OUTSIDE the Promise constructor so async
  // errors don't get silently swallowed by a missing reject path.
  let resolvedUrl: string;
  try {
    resolvedUrl = await cachedResolveWsUrl(provider.config.url, gateway.config.gateway.connectionTimeout);
  } catch {
    resolvedUrl = provider.config.url;
  }

  // Inject the profile via a transient CDP connection BEFORE handing the user's
  // pipe over. If inject fails, treat as a provider failure (retryable).
  if (acquired && profileLifecycle && acquired.cookies.length > 0) {
    try {
      await profileLifecycle.inject(acquired, resolvedUrl);
    } catch (err) {
      logger.warn(
        {
          sessionId,
          providerId: provider.id,
          error: err instanceof Error ? err.message : String(err),
        },
        "profile inject failed, trying next provider",
      );
      return false;
    }
  }

  return new Promise((resolve) => {
    const providerUrl = new URL(resolvedUrl);
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

        // Inject X-Session-Id header into the 101 response
        const headerPart = responseBuffer.subarray(0, headerEnd).toString();
        const afterHeaders = responseBuffer.subarray(headerEnd + 4); // skip \r\n\r\n
        const modifiedResponse = `${headerPart}\r\nX-Session-Id: ${sessionId}\r\n\r\n`;

        clientSocket.write(modifiedResponse);
        if (afterHeaders.length > 0) {
          clientSocket.write(afterHeaders);
        }

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
        cdpUrlCache.delete(provider.config.url);
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

      // Park session for reconnection
      if (reconnectRegistry && session) {
        reconnectRegistry.park(
          sessionId,
          provider.id,
          provider.config.url,
          session.connectedAt,
          session.messageCount,
        );
        logger.info({ sessionId, providerId: provider.id, durationMs }, "session parked for reconnection");
      }

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

      // Capture latest cookies, encrypt, save, release the profile lock.
      // Fire-and-forget: don't block socket cleanup on remote CDP work.
      if (acquired && profileLifecycle) {
        const capturedAcquired = acquired;
        profileLifecycle.commit(capturedAcquired, resolvedUrl).catch((err) => {
          logger.warn(
            {
              profileId: capturedAcquired.profileId,
              error: err instanceof Error ? err.message : String(err),
            },
            "profile commit failed",
          );
        });
      }
    };

    clientSocket.on("close", cleanup("client"));
    clientSocket.on("error", cleanup("client-error"));
    providerSocket.on("close", cleanup("provider"));

    // L5 fix: defensive watchdog — if neither socket emits a close/error event
    // (rare but real for abrupt destruction or VM suspend), poll periodically
    // and force cleanup once both sockets are destroyed. Stops the profile lock
    // and provider slot from being held indefinitely.
    const watchdog = setInterval(() => {
      if (cleanedUp) {
        clearInterval(watchdog);
        return;
      }
      if (clientSocket.destroyed && providerSocket.destroyed) {
        clearInterval(watchdog);
        cleanup("watchdog")();
      }
    }, 5_000);
    watchdog.unref();

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
