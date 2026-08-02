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
import { ScreencastCapturePlugin } from "../../pipeline/plugins/screencast-capture.js";
import { NodeReplayStorage } from "../replay/node-storage.js";
import { CHUNK_MAX_BYTES, CHUNK_MAX_ELAPSED_MS } from "../replay/constants.js";
import type { ReplayConfig } from "../../core/types.js";

export interface PipelineRelayOpts {
  gateway: Gateway;
  logger: Logger;
  req: IncomingMessage;
  socket: Duplex;
  head: Buffer;
  provider: ProviderState;
  sessionId: string;
  storePath: string;
  replayConfig: ReplayConfig;
  reconnectRegistry?: ReconnectRegistry;
}

/** Handles a `/v1/connect?session_record=true` upgrade by upgrading the
 *  client to a Node WebSocket, opening a WebSocket to the upstream provider,
 *  and running a CDP-aware pipeline with the `ScreencastCapturePlugin`.
 *  Returns true on success (session ran), false on failure so the caller
 *  can try the next provider. */
export async function handlePipelineRelay(opts: PipelineRelayOpts): Promise<boolean> {
  const { gateway, logger, req, socket, head, provider, sessionId } = opts;

  let upstreamUrl: string;
  try {
    upstreamUrl = await resolveWsUrl(provider.config.url, gateway.config.gateway.connectionTimeout);
  } catch {
    upstreamUrl = provider.config.url;
  }

  logger.info({ sessionId, providerId: provider.id, mode: "pipeline-replay" }, "connecting to provider");

  const wss = new WebSocketServer({ noServer: true });
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
    try { socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n"); socket.destroy(); } catch { /* ignore */ }
    return false;
  }

  const client = await new Promise<WebSocket>((resolve) => {
    wss.handleUpgrade(req, socket, head, (ws) => resolve(ws));
  });

  const startTime = Date.now();
  gateway.sessions.create(sessionId, provider.id);
  gateway.emit("session.created", { sessionId, providerId: provider.id });
  logger.info({ sessionId, providerId: provider.id }, "session established");

  client.on("message", () => gateway.sessions.recordActivity(sessionId));

  const storage = new NodeReplayStorage(opts.storePath);
  const plugin = new ScreencastCapturePlugin({
    sessionId,
    providerId: provider.id,
    storage,
    format: opts.replayConfig.capture.format,
    quality: opts.replayConfig.capture.quality,
    everyNthFrame: opts.replayConfig.capture.everyNthFrame,
    maxBytesPerSession: opts.replayConfig.maxBytesPerSession,
    chunkMaxBytes: CHUNK_MAX_BYTES,
    chunkMaxElapsedMs: CHUNK_MAX_ELAPSED_MS,
    logger: (msg, data) => logger.warn(data ?? {}, msg),
  });

  const pipeline = new Pipeline(
    client as unknown as PipelineSocket,
    upstream as unknown as PipelineSocket,
    upstreamUrl,
    {
      plugins: [plugin],
      logger: (event) => {
        if (event.kind === "plugin-error") {
          logger.warn({ sessionId, providerId: provider.id, ...event.data }, "pipeline plugin error");
        }
      },
    },
  );

  const result = await pipeline.run();

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
