import { Hono } from "hono";
import { existsSync, readFileSync, statSync } from "node:fs";
import { Readable } from "node:stream";
import type { Logger } from "pino";
import type { ReplayStore } from "../replay/index.js";
import {
  FfmpegInstallError,
  FfmpegMissingError,
  NoFramesError,
  exportTargetAsMp4,
  findFfmpegBinary,
  installFfmpegStatic,
  isFfmpegStaticInstalled,
} from "../replay/export-mp4.js";
import type { GatewayConfig } from "../../core/types.js";
import { disableReplayFlow, enableReplayFlow } from "../setup/replay-setup.js";
import { makeToggleHandler } from "./toggle-handler.js";

const SESSION_ID_REGEX = /^[A-Za-z0-9._-]{1,128}$/;
const TARGET_ID_REGEX = /^[A-Za-z0-9._-]{1,128}$/;

function parseReplayIds(id: string, targetId: string): boolean {
  return SESSION_ID_REGEX.test(id) && TARGET_ID_REGEX.test(targetId);
}

function serveFile(path: string, contentType: string, cacheControl?: string): Response {
  const body = readFileSync(path);
  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "Content-Length": String(statSync(path).size),
  };
  if (cacheControl) headers["Cache-Control"] = cacheControl;
  return new Response(new Uint8Array(body), { status: 200, headers });
}

interface ReplayRoutesDeps {
  store: ReplayStore;
  logger: Logger;
  enabled: boolean;
  config?: GatewayConfig;
  dataDir: string;
}

const DISABLED_REASON = "Replay capture is disabled. Click 'Enable Replays' in the dashboard or set replay.enabled: true in gateway.yml, then restart.";

export function createReplayRoutes(deps: ReplayRoutesDeps): Hono {
  const app = new Hono();

  const MISSING_CONFIG = "Cannot toggle replays without a loaded config";
  app.post(
    "/replays/setup",
    makeToggleHandler(() => deps.config, enableReplayFlow, MISSING_CONFIG, "Setup failed"),
  );
  app.post(
    "/replays/disable",
    makeToggleHandler(() => deps.config, disableReplayFlow, MISSING_CONFIG, "Disable failed"),
  );

  if (!deps.enabled) {
    app.get("/replays", (c) => c.json({ enabled: false, replays: [], reason: DISABLED_REASON }));
    app.get("/replays/:id", (c) => c.json({ error: "Replay not found", reason: DISABLED_REASON }, 404));
    app.delete("/replays/:id", (c) => c.json({ error: "Replays disabled", reason: DISABLED_REASON }, 400));
    app.get("/replays/:id/manifest", (c) => c.json({ error: "Replays disabled", reason: DISABLED_REASON }, 400));
    app.get("/replays/:id/targets/:targetId/manifest", (c) =>
      c.json({ error: "Replays disabled", reason: DISABLED_REASON }, 400),
    );
    app.get("/replays/:id/targets/:targetId/frames/:frame{[0-9]+\\.(png|jpeg)}", (c) =>
      c.json({ error: "Replays disabled", reason: DISABLED_REASON }, 400),
    );
    return app;
  }

  app.get("/replays", (c) => {
    const sinceRaw = c.req.query("since");
    const limitRaw = c.req.query("limit");
    const sinceMs = sinceRaw ? Date.parse(sinceRaw) : undefined;
    const limit = limitRaw ? Math.max(1, Math.min(500, parseInt(limitRaw, 10))) : undefined;

    if (sinceRaw && (sinceMs === undefined || Number.isNaN(sinceMs))) {
      return c.json({ error: "since must be an ISO-8601 timestamp" }, 400);
    }

    const replays = deps.store.list({ sinceMs, limit });
    const rc = deps.config?.replay;
    return c.json({
      enabled: true,
      count: replays.length,
      replays,
      config: rc
        ? {
            retentionDays: rc.retentionDays,
            maxBytesPerSession: rc.maxBytesPerSession,
            format: rc.capture.format,
            quality: rc.capture.quality,
            everyNthFrame: rc.capture.everyNthFrame,
          }
        : undefined,
    });
  });

  app.get("/replays/:id", (c) => {
    const id = c.req.param("id");
    if (!SESSION_ID_REGEX.test(id)) {
      return c.json({ error: "Invalid session id" }, 400);
    }
    const detail = deps.store.get(id);
    if (!detail) {
      return c.json({ error: "Replay not found" }, 404);
    }
    return c.json(detail);
  });

  app.delete("/replays/:id", (c) => {
    const id = c.req.param("id");
    if (!SESSION_ID_REGEX.test(id)) {
      return c.json({ error: "Invalid session id" }, 400);
    }
    if (!deps.store.get(id)) {
      return c.json({ error: "Replay not found" }, 404);
    }
    deps.store.delete(id);
    deps.logger.info({ sessionId: id }, "replay deleted via REST");
    return c.json({ deleted: id });
  });

  app.get("/replays/:id/targets/:targetId/manifest", (c) => {
    const id = c.req.param("id");
    const targetId = c.req.param("targetId");
    if (!parseReplayIds(id, targetId)) return c.json({ error: "Invalid id" }, 400);
    const path = deps.store.manifestPath(id, targetId);
    if (!existsSync(path)) return c.json({ error: "Manifest not found" }, 404);
    return serveFile(path, "application/jsonlines");
  });

  app.get("/replays/:id/targets/:targetId/frames/:frame", (c) => {
    const id = c.req.param("id");
    const targetId = c.req.param("targetId");
    const frame = c.req.param("frame");
    const m = /^([0-9]+)\.(png|jpeg)$/.exec(frame);
    if (!m || !parseReplayIds(id, targetId)) return c.json({ error: "Invalid frame request" }, 400);
    const ext = m[2] as "png" | "jpeg";
    const path = deps.store.framePath(id, targetId, parseInt(m[1], 10), ext);
    if (!existsSync(path)) return c.json({ error: "Frame not found" }, 404);
    return serveFile(path, ext === "png" ? "image/png" : "image/jpeg", "public, max-age=31536000, immutable");
  });

  app.get("/replays/:id/targets/:targetId/export.mp4", async (c) => {
    const id = c.req.param("id");
    const targetId = c.req.param("targetId");
    if (!SESSION_ID_REGEX.test(id) || !TARGET_ID_REGEX.test(targetId)) {
      return c.json({ error: "Invalid id" }, 400);
    }
    const detail = deps.store.get(id);
    if (!detail) return c.json({ error: "Replay not found" }, 404);
    const target = detail.targets.find((t) => t.targetId === targetId);
    if (!target) return c.json({ error: "Target not found" }, 404);

    try {
      const result = await exportTargetAsMp4({
        store: deps.store,
        sessionId: id,
        targetId,
        format: detail.format,
        dataDir: deps.dataDir,
        logger: deps.logger,
      });
      return new Response(Readable.toWeb(result.readStream) as unknown as ReadableStream, {
        status: 200,
        headers: {
          "Content-Type": "video/mp4",
          "Content-Length": String(result.sizeBytes),
          "Content-Disposition": `attachment; filename="replay-${id.slice(0, 8)}-${targetId.slice(0, 8)}.mp4"`,
        },
      });
    } catch (err) {
      if (err instanceof FfmpegMissingError) {
        return c.json({
          error: "ffmpeg not installed",
          canAutoInstall: true,
          install: {
            macos: "brew install ffmpeg",
            debian: "apt install ffmpeg",
            redhat: "dnf install ffmpeg",
            windows: "https://ffmpeg.org/download.html",
          },
        }, 503);
      }
      if (err instanceof NoFramesError) {
        return c.json({ error: "No frames captured for this target" }, 404);
      }
      deps.logger.warn({ err: err instanceof Error ? err.message : String(err) }, "replay export failed");
      return c.json({ error: "Export failed" }, 500);
    }
  });

  app.get("/replays/ffmpeg/status", async (c) => {
    const bin = await findFfmpegBinary(deps.dataDir);
    const localInstalled = await isFfmpegStaticInstalled(deps.dataDir);
    return c.json({
      available: bin !== null,
      source: bin === null ? null : bin === "ffmpeg" ? "system" : "local",
      installing: ffmpegInstallInflight !== null,
      localInstalled,
    });
  });

  app.post("/replays/ffmpeg/install", async (c) => {
    if (ffmpegInstallInflight) {
      try {
        await ffmpegInstallInflight;
        return c.json({ ok: true, installed: true, alreadyInProgress: true });
      } catch (err) {
        return c.json({ ok: false, error: err instanceof Error ? err.message : "Install failed" }, 500);
      }
    }
    ffmpegInstallInflight = installFfmpegStatic({ dataDir: deps.dataDir, logger: deps.logger });
    try {
      await ffmpegInstallInflight;
      return c.json({ ok: true, installed: true });
    } catch (err) {
      const message = err instanceof FfmpegInstallError ? err.message : "Install failed";
      return c.json({ ok: false, error: message }, 500);
    } finally {
      ffmpegInstallInflight = null;
    }
  });

  return app;
}

let ffmpegInstallInflight: Promise<void> | null = null;
