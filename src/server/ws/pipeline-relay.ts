import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import type { Logger } from "pino";
import type { Gateway } from "../../core/index.js";
import type { ProviderState } from "../../core/types.js";
import type { ReconnectRegistry } from "../../core/proxy/reconnect.js";
import { resolveWsUrl } from "../../core/providers/cdp.js";
import { resolveProviderOutbound } from "../../core/transport.js";
import { Pipeline, type PipelineSocket } from "../../pipeline/pipeline.js";
import type { CdpPlugin } from "../../pipeline/types.js";
import { ProfileResidueError } from "../../pipeline/plugins/profile.js";
import { openUpstream } from "./upstream-open.js";

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

export type PipelineRelayResult =
  | { connected: true }
  | { connected: false; residue?: ProfileResidueError };

/** Two-phase pipeline handoff for `/v1/connect`:
 *  1. Open upstream WS and run every plugin's `onSessionStart` (which may
 *     dispatch inject commands). If any plugin fails, upstream is closed
 *     and the client socket is NEVER upgraded — the caller retries with
 *     the next provider. A {@link ProfileResidueError} is surfaced back
 *     so the caller can convert it to HTTP 409 instead of a generic 503.
 *  2. Upgrade the client, attach it to the pipeline, run the byte relay. */
export async function handlePipelineRelay(opts: PipelineRelayOpts): Promise<PipelineRelayResult> {
  const { gateway, logger, req, socket, head, provider, sessionId, plugins } = opts;

  let upstreamUrl: string;
  try {
    upstreamUrl = await resolveWsUrl(
      provider.config.url,
      gateway.config.gateway.connectionTimeout,
      provider.config.headers,
    );
  } catch {
    upstreamUrl = provider.config.url;
  }

  const outbound = resolveProviderOutbound(upstreamUrl, provider.config.headers);

  logger.info(
    { sessionId, providerId: provider.id, plugins: plugins.map((p) => p.name) },
    "pipeline: connecting to provider",
  );

  const upstreamOpen = await openUpstream(
    outbound.upstreamUrl,
    gateway.config.gateway.connectionTimeout,
    outbound.upstreamHeaders,
  );
  if (!upstreamOpen.ok) {
    logger.warn({ sessionId, providerId: provider.id, error: upstreamOpen.err }, "provider connection failed");
    return { connected: false };
  }
  const upstream = upstreamOpen.ws;

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
    if (startResult.error instanceof ProfileResidueError) {
      logger.warn(
        {
          sessionId,
          providerId: provider.id,
          currentProfile: startResult.error.currentProfile,
          requestedProfile: startResult.error.requestedProfile,
        },
        "pipeline: residue detected on provider, trying next",
      );
      return { connected: false, residue: startResult.error };
    }
    logger.warn(
      { sessionId, providerId: provider.id, plugin: startResult.plugin },
      "pipeline plugin setup failed, trying next provider",
    );
    return { connected: false };
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

  return { connected: true };
}

