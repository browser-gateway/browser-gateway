import { describe, expect, it, vi } from "vitest";
import pino from "pino";
import { createAdminRoutes } from "../../src/server/rest/admin.js";

describe("POST /admin/restart", () => {
  it("returns 200 + accepted: true", async () => {
    const triggerRestart = vi.fn();
    const app = createAdminRoutes({ logger: pino({ level: "silent" }), triggerRestart });
    const res = await app.request("/admin/restart", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json() as { accepted: boolean };
    expect(body.accepted).toBe(true);
  });

  it("invokes triggerRestart asynchronously (after the response is sent)", async () => {
    const triggerRestart = vi.fn();
    const app = createAdminRoutes({ logger: pino({ level: "silent" }), triggerRestart });
    await app.request("/admin/restart", { method: "POST" });
    expect(triggerRestart).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 150));
    expect(triggerRestart).toHaveBeenCalledOnce();
  });
});
