import { Hono } from "hono";
import { existsSync, readFileSync, statSync } from "node:fs";
import type { Logger } from "pino";
import type { ReplayStore } from "../replay/index.js";
import type { GatewayConfig } from "../../core/types.js";

const SESSION_ID_REGEX = /^[A-Za-z0-9._-]{1,128}$/;
const PART_NAME_REGEX = /^([0-9]{3,6})\.bin$/;

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
  config?: GatewayConfig;
  dataDir?: string;
}

export function createReplayRoutes(deps: ReplayRoutesDeps): Hono {
  const app = new Hono();

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

  app.get("/replays/:id/manifest", (c) => {
    const id = c.req.param("id");
    if (!SESSION_ID_REGEX.test(id)) return c.json({ error: "Invalid session id" }, 400);
    const manifest = deps.store.readManifest(id);
    if (!manifest) return c.json({ error: "Manifest not found" }, 404);
    return c.json(manifest);
  });

  app.get("/replays/:id/parts/:part", (c) => {
    const id = c.req.param("id");
    const part = c.req.param("part");
    if (!SESSION_ID_REGEX.test(id)) return c.json({ error: "Invalid session id" }, 400);
    const m = PART_NAME_REGEX.exec(part);
    if (!m) return c.json({ error: "Invalid part name" }, 400);
    const path = deps.store.partPath(id, parseInt(m[1], 10));
    if (!existsSync(path)) return c.json({ error: "Part not found" }, 404);
    return serveFile(path, "application/octet-stream", "public, max-age=31536000, immutable");
  });

  app.get("/replays/:id/frames/:frame", (c) => {
    const id = c.req.param("id");
    const frameParam = c.req.param("frame");
    if (!SESSION_ID_REGEX.test(id)) return c.json({ error: "Invalid session id" }, 400);
    const m = /^([0-9]+)\.(png|jpeg)$/.exec(frameParam);
    if (!m) return c.json({ error: "Invalid frame request" }, 400);
    const frameNumber = parseInt(m[1], 10);
    const ext = m[2] as "png" | "jpeg";
    const bytes = deps.store.readFrame(id, frameNumber);
    if (!bytes) return c.json({ error: "Frame not found" }, 404);
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": ext === "png" ? "image/png" : "image/jpeg",
        "Content-Length": String(bytes.length),
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  });

  return app;
}
