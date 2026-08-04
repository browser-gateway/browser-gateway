/** WS /v1/live upgrade handler. Runs the CDP-aware pipeline in solo mode:
 *  no CDP client peer — the viewer speaks the LIVE protocol via
 *  ScreencastBridgePlugin, and profile inject/capture rides the same pipeline
 *  via ProfilePlugin when `?profile=` is present. */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { timingSafeEqual } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import type { Logger } from "pino";
import type { Gateway } from "../../core/index.js";
import { resolveWsUrl } from "../../core/providers/cdp.js";
import { LifecycleError, type ProfileLifecycle, type AcquiredProfile } from "../profile/lifecycle.js";
import { Pipeline, type PipelineSocket } from "../../pipeline/pipeline.js";
import { ScreencastBridgePlugin } from "../../pipeline/plugins/screencast-bridge.js";
import type { CdpPlugin } from "../../pipeline/types.js";
import { openUpstream } from "../ws/upstream-open.js";
import { makeProfilePluginFromAcquired } from "../profile/preloaded-profile-plugin.js";

function safeTokenCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function extractBearer(header: string | undefined): string | undefined {
  if (!header || !header.startsWith("Bearer ")) return undefined;
  return header.slice(7);
}

function writeHttpError(socket: Duplex, status: number, body: Record<string, unknown>): void {
  const text = JSON.stringify(body);
  socket.write(
    `HTTP/1.1 ${status} ${status === 400 ? "Bad Request" : status === 401 ? "Unauthorized" : status === 409 ? "Conflict" : status === 503 ? "Service Unavailable" : "Error"}\r\n` +
      `Content-Type: application/json\r\n` +
      `Content-Length: ${Buffer.byteLength(text)}\r\n\r\n` +
      text,
  );
  socket.destroy();
}

export interface CreateLiveHandlerDeps {
  gateway: Gateway;
  logger: Logger;
  token?: string;
  profileLifecycle?: ProfileLifecycle;
}

export function createLiveUpgradeHandler(deps: CreateLiveHandlerDeps) {
  const { gateway, logger, token, profileLifecycle } = deps;
  const wss = new WebSocketServer({ noServer: true });

  async function handle(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (token) {
      const reqToken =
        url.searchParams.get("token") ?? extractBearer(req.headers.authorization);
      if (!reqToken || !safeTokenCompare(reqToken, token)) {
        writeHttpError(socket, 401, { error: "Unauthorized" });
        return;
      }
    }

    if (gateway.shuttingDown) {
      writeHttpError(socket, 503, { error: "Gateway is shutting down" });
      return;
    }

    const providerId = url.searchParams.get("provider");
    if (!providerId) {
      writeHttpError(socket, 400, { error: "live view requires ?provider=<id>" });
      return;
    }

    const provider = gateway.registry.get(providerId);
    if (!provider) {
      writeHttpError(socket, 400, { error: `unknown provider: ${providerId}` });
      return;
    }
    if (!provider.healthy) {
      writeHttpError(socket, 503, { error: `provider not healthy: ${providerId}` });
      return;
    }

    let providerWsUrl: string;
    try {
      providerWsUrl = await resolveWsUrl(provider.config.url);
    } catch (err) {
      logger.warn(
        { providerId, error: err instanceof Error ? err.message : String(err) },
        "live: failed to resolve provider WS URL",
      );
      writeHttpError(socket, 503, { error: "could not reach provider" });
      return;
    }

    const profileId = url.searchParams.get("profile");
    let acquired: AcquiredProfile | null = null;
    if (profileId !== null) {
      if (!profileLifecycle) {
        writeHttpError(socket, 400, { error: "profiles are not enabled on this gateway" });
        return;
      }
      try {
        acquired = await profileLifecycle.acquire(profileId);
        logger.info(
          { profileId, isExisting: acquired.isExisting, cookies: acquired.cookies.length },
          "live: profile acquired",
        );
      } catch (err) {
        if (err instanceof LifecycleError) {
          if (err.reason === "INVALID_ID") { writeHttpError(socket, 400, { error: err.message }); return; }
          if (err.reason === "LOCK_HELD") { writeHttpError(socket, 409, { error: err.message }); return; }
        }
        logger.error(
          { profileId, error: err instanceof Error ? err.message : String(err) },
          "live: profile acquire failed",
        );
        writeHttpError(socket, 500, { error: "profile acquire failed" });
        return;
      }
    }

    const format = url.searchParams.get("format") === "png" ? "png" : "jpeg";
    const quality = clampInt(url.searchParams.get("quality"), 1, 100, 60);
    const maxWidth = clampInt(url.searchParams.get("maxWidth"), 320, 3840, 1280);
    const maxHeight = clampInt(url.searchParams.get("maxHeight"), 240, 2160, 720);
    const everyNthFrame = clampInt(url.searchParams.get("everyNthFrame"), 1, 10, 2);
    const keepAliveRaw = url.searchParams.get("keepAlive");
    const keepAliveSeconds = keepAliveRaw === null ? 0 : clampInt(keepAliveRaw, 60, 1200, 300);

    wss.handleUpgrade(req, socket, head, async (viewer) => {
      logger.info(
        { providerId, profileId, format, quality, maxWidth, maxHeight, everyNthFrame, keepAliveSeconds },
        "live: viewer connected",
      );

      const upstreamReady = await openUpstream(providerWsUrl, gateway.config.gateway.connectionTimeout);

      if (!upstreamReady.ok) {
        logger.warn({ providerId, error: upstreamReady.err }, "live: upstream connect failed");
        sendViewerError(viewer, "SETUP_FAILED", `upstream connect failed: ${upstreamReady.err}`);
        try { viewer.close(1011, "upstream connect failed"); } catch { /* ignore */ }
        if (acquired && profileLifecycle) await profileLifecycle.release(acquired).catch(() => undefined);
        return;
      }

      const bridge = new ScreencastBridgePlugin({
        viewer: viewer as unknown as PipelineSocket,
        format,
        quality,
        viewportWidth: maxWidth,
        viewportHeight: maxHeight,
        everyNthFrame,
        keepAliveSeconds,
        logger: (msg, data) => logger.info(data ?? {}, msg),
      });

      const plugins: CdpPlugin[] = [];
      if (acquired && profileLifecycle) {
        plugins.push(makeProfilePluginFromAcquired(acquired, profileLifecycle, logger));
      }
      plugins.push(bridge);

      const pipeline = new Pipeline(
        upstreamReady.ws as unknown as PipelineSocket,
        providerWsUrl,
        {
          plugins,
          logger: (event) => {
            if (event.kind === "plugin-error") {
              logger.warn({ providerId, ...event.data }, "live: pipeline plugin error");
            }
          },
        },
      );

      const startResult = await pipeline.start();
      if (!startResult.ok) {
        const errMsg = startResult.error instanceof Error ? startResult.error.message : String(startResult.error);
        logger.warn({ providerId, plugin: startResult.plugin, error: errMsg }, "live: pipeline setup failed");
        sendViewerError(viewer, "SETUP_FAILED", `${startResult.plugin}: ${errMsg}`);
        try { viewer.close(1011, "setup failed"); } catch { /* ignore */ }
        if (acquired && profileLifecycle) await profileLifecycle.release(acquired).catch(() => undefined);
        return;
      }

      const result = await pipeline.run(null);
      logger.info(
        { providerId, profileId, reason: result.reason, ...result.counters },
        "live: session ended",
      );
    });
  }

  return { handle };
}

function sendViewerError(viewer: WebSocket, code: string, message: string): void {
  try { viewer.send(JSON.stringify({ type: "error", code, message })); } catch { /* ignore */ }
}

function clampInt(raw: string | null, lo: number, hi: number, fallback: number): number {
  if (raw === null) return fallback;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}
