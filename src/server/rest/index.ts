import { Hono } from "hono";
import type { Logger } from "pino";
import { z } from "zod";
import type { Gateway } from "../../core/index.js";
import type { SessionPool } from "../../core/pool/index.js";
import { RestApiError } from "./schemas.js";
import { handleScreenshot } from "./screenshot.js";
import { handleContent } from "./content.js";
import { handleScrape } from "./scrape.js";

export function createRestRoutes(pool: SessionPool, gateway: Gateway, logger: Logger) {
  const rest = new Hono();

  rest.use("*", async (c, next) => {
    // No providers configured at all
    if (gateway.registry.size() === 0) {
      return c.json({
        success: false,
        error: "No providers configured",
        message: "Add browser providers to gateway.yml or via the dashboard at /web/providers",
      }, 503);
    }

    // Gateway is shutting down
    if (gateway.shuttingDown) {
      return c.json({
        success: false,
        error: "Gateway is shutting down",
      }, 503);
    }

    // All providers are in cooldown or unhealthy
    const providers = gateway.registry.getAll();
    const now = Date.now();
    const allDown = providers.every(
      (p) => (p.cooldownUntil && p.cooldownUntil > now) || !p.healthy,
    );

    if (allDown) {
      const soonest = providers
        .filter((p) => p.cooldownUntil)
        .map((p) => p.cooldownUntil!)
        .sort((a, b) => a - b)[0];

      const retryAfterSec = soonest ? Math.ceil((soonest - now) / 1000) : 10;

      c.header("Retry-After", String(retryAfterSec));
      return c.json({
        success: false,
        error: "All providers unavailable",
        message: `All ${providers.length} provider(s) are in cooldown or unhealthy`,
        retryAfter: retryAfterSec,
        providers: providers.map((p) => ({
          id: p.id,
          healthy: p.healthy,
          cooldownUntil: p.cooldownUntil ? new Date(p.cooldownUntil).toISOString() : null,
        })),
      }, 503);
    }

    return next();
  });

  rest.post("/screenshot", async (c) => {
    return handleScreenshot(c, pool, logger);
  });

  rest.post("/content", async (c) => {
    return handleContent(c, pool, logger);
  });

  rest.post("/scrape", async (c) => {
    return handleScrape(c, pool, logger);
  });

  rest.onError((err, c) => {
    if (err instanceof RestApiError) {
      return c.json({ success: false, error: err.message }, err.status as any);
    }

    if (err instanceof z.ZodError) {
      const details = err.issues.map(
        (i) => `${i.path.join(".")}: ${i.message}`,
      );
      return c.json({ success: false, error: "Validation error", details }, 400);
    }

    logger.error({ err }, "rest: unexpected error");
    return c.json({ success: false, error: "Internal error" }, 500);
  });

  return rest;
}
