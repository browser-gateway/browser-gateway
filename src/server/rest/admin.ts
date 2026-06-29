import { Hono } from "hono";
import type { Logger } from "pino";

export interface AdminRoutesDeps {
  logger: Logger;
  triggerRestart: (logger: Logger) => void;
}

export function createAdminRoutes(deps: AdminRoutesDeps): Hono {
  const app = new Hono();

  app.post("/admin/restart", (c) => {
    deps.logger.info("restart triggered via REST");
    setTimeout(() => deps.triggerRestart(deps.logger), 100);
    return c.json({
      accepted: true,
      message: "Gateway is restarting. Your supervisor (Docker, Railway, systemd) will bring it back up.",
    });
  });

  return app;
}

export function defaultTriggerRestart(logger: Logger): void {
  process.kill(process.pid, "SIGTERM");
  setTimeout(() => {
    logger.warn("SIGTERM did not exit cleanly within 5s, forcing exit");
    process.exit(0);
  }, 5_000).unref();
}
