import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import type { Logger } from "pino";
import type { Gateway } from "../../core/index.js";
import type { ProviderState } from "../../core/types.js";
import type { ReconnectRegistry } from "../../core/proxy/reconnect.js";
import { resolveWsUrl } from "../../core/providers/cdp.js";
import { Pipeline, type PipelineSocket } from "../../pipeline/pipeline.js";
import type { CdpPlugin } from "../../pipeline/types.js";

export interface PipelineRelayOpts {
  gateway: Gateway;
  logger: Logger;
  req: IncomingMessage;
  socket: Duplex;
  head: Buffer;
  provider: ProviderState;
  sessionId: string;
  plugins: CdpPlugin[];
  reconnectRegistry?: ReconnectRegistry;
}

/** Two-phase pipeline handoff for `/v1/connect`:
 *  1. Open upstream WS and run every plugin's `onSessionStart` (which may
 *     dispatch inject commands). If any plugin fails, upstream is closed
 *     and the client socket is NEVER upgraded — the caller retries with
 *     the next provider.
 *  2. Upgrade the client, attach it to the pipeline, run the byte relay. */
export async function handlePipelineRelay(opts: PipelineRelayOpts): Promise<boolean> {
  const { gateway, logger, req, socket, head, provider, sessionId, plugins } = opts;

  let upstreamUrl: string;
  try {
    upstreamUrl = await resolveWsUrl(provider.config.url, gateway.config.gateway.connectionTimeout);
  } catch {
    upstreamUrl = provider.config.url;
  }

  logger.info(
    { sessionId, providerId: provider.id, plugins: plugins.map((p) => p.name) },
    "pipeline: connecting to provider",
  );

  const upstream = new WebSocket(upstreamUrl, {
    handshakeTimeout: gateway.config.gateway.connectionTimeout,
    perMessageDeflate: false,
  });

  const upstreamOpen = await new Promise<{ ok: true } | { ok: false; err: string }>((resolve) => {
    const timeout = setTimeout(() => {
      try { upstream.close(); } catch { /* ignore */ }
      resolve({ ok: false, err: "upstream-timeout" });
    }, gateway.config.gateway.connectionTimeout);
    upstream.once("open", () => { clearTimeout(timeout); resolve({ ok: true }); });
    upstream.once("error", (err) => { clearTimeout(timeout); resolve({ ok: false, err: err.message }); });
  });
  if (!upstreamOpen.ok) {
    logger.warn({ sessionId, providerId: provider.id, error: upstreamOpen.err }, "provider connection failed");
    return false;
  }

  const pipeline = new Pipeline(
    upstream as unknown as PipelineSocket,
    upstreamUrl,
    {
      plugins,
      logger: (event) => {
        if (event.kind === "plugin-error") {
          logger.warn({ sessionId, providerId: provider.id, ...event.data }, "pipeline plugin error");
        }
      },
    },
  );

  // Phase 1 — plugin setup. On failure, upstream is already closed and
  // the client socket is untouched; caller retries with next provider.
  const startResult = await pipeline.start();
  if (!startResult.ok) {
    logger.warn(
      { sessionId, providerId: provider.id, plugin: startResult.plugin },
      "pipeline plugin setup failed, trying next provider",
    );
    return false;
  }

  // Phase 2 — commit. Upgrade client and pump bytes.
  const wss = new WebSocketServer({ noServer: true });
  const client = await new Promise<WebSocket>((resolve) => {
    wss.handleUpgrade(req, socket, head, (ws) => resolve(ws));
  });

  const startTime = Date.now();
  gateway.sessions.create(sessionId, provider.id);
  gateway.emit("session.created", { sessionId, providerId: provider.id });
  logger.info({ sessionId, providerId: provider.id }, "session established");

  client.on("message", () => gateway.sessions.recordActivity(sessionId));

  const result = await pipeline.run(client as unknown as PipelineSocket);

  const durationMs = Date.now() - startTime;
  gateway.sessions.remove(sessionId);
  gateway.releaseSlot(sessionId, provider.id);
  gateway.recordSuccess(provider.id, durationMs);

  if (opts.reconnectRegistry) {
    opts.reconnectRegistry.park(
      sessionId,
      provider.id,
      provider.config.url,
      startTime,
      result.counters.messageCount,
    );
  }

  gateway.emit("session.ended", { sessionId, providerId: provider.id, durationMs });
  logger.info(
    { sessionId, providerId: provider.id, durationMs, reason: result.reason, ...result.counters },
    "pipeline session ended",
  );

  return true;
}

/** Generate a fresh session id for a pipeline session. */
export function newPipelineSessionId(): string {
  return randomUUID();
}
