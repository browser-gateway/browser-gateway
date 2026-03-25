import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Gateway } from "../core/index.js";

export function createApp(gateway: Gateway) {
  const app = new Hono();

  app.use("*", cors());

  app.get("/health", (c) => {
    return c.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  app.get("/v1/status", (c) => {
    const status = gateway.getStatus();

    const backends = status.backends.map((b) => ({
      id: b.id,
      healthy: b.healthy,
      active: b.active,
      maxConcurrent: b.config.limits?.maxConcurrent ?? null,
      cooldownUntil: b.cooldownUntil
        ? new Date(b.cooldownUntil).toISOString()
        : null,
      avgLatencyMs: Math.round(b.avgLatencyMs),
      totalConnections: b.totalConnections,
      priority: b.config.priority,
    }));

    return c.json({
      status: "ok",
      activeSessions: status.activeSessions,
      strategy: status.strategy,
      backends,
    });
  });

  app.get("/v1/sessions", (c) => {
    const sessions = gateway.sessions.getAll().map((s) => ({
      id: s.id,
      backendId: s.backendId,
      connectedAt: new Date(s.connectedAt).toISOString(),
      lastActivity: new Date(s.lastActivity).toISOString(),
      durationMs: Date.now() - s.connectedAt,
      messageCount: s.messageCount,
    }));

    return c.json({
      count: sessions.length,
      sessions,
    });
  });

  app.notFound((c) => {
    return c.json(
      {
        error: "Not found",
        message: "Connect via WebSocket at /v1/connect or check /v1/status",
      },
      404
    );
  });

  return app;
}
